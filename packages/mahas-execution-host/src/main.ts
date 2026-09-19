#!/usr/bin/env node
// mahas-execution-host — the reattachable local daemon that owns PTY and
// generic process incarnations (spec/architecture.md §1, spec/domains/
// execution.md). It must not die when a UI disconnects; mahasd reattaches
// to the same processes after a control-plane restart.
//
// IMP-17 turned the IMP-01 entrypoint shell into the real bootstrap:
//   real:  argv/config-dir handling, exclusive endpoint claim (a live host
//          is never killed/adopted — only a verifiably-dead endpoint is
//          taken over), execution-host.sqlite open, host identity
//          publication (hostId + fresh incarnation + birth evidence +
//          launchNonce + endpointIncarnation) via temp+atomic rename, an
//          authenticated NDJSON RPC socket serving host.hello / acquire /
//          inventory / effect.get, and identity-matched cleanup on exit.
//   absent: process/PTY managers and workspace ops — IMP-18/IMP-16
//          register them through host.ts's registerHostOp() seam.
//
// Lifecycle lines on stdout follow the resources/pty-host.cjs convention.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bootstrapHost, type HostService } from './host.ts'
import { HostOpError } from './lease.ts'
import { registerProcessOps, type ProcessOpsHandle } from './process-manager.ts'
import { registerWorkspaceHostOps } from './workspaces/mod.ts'
import type { WorkspaceOpEnvelope } from './workspaces/common.ts'

function usage(): never {
  process.stderr.write(
    'usage: mahas-execution-host [--endpoint <path>] [--config-dir <dir>] [--db <path>] [--help]\n' +
      '  socket defaults to <config-dir>/execution-host.sock; db to\n' +
      '  <config-dir>/execution-host.sqlite; config dir defaults to\n' +
      '  $MAHAS_CONFIG_DIR or ~/.config/mahas\n'
  )
  process.exit(2)
}

function parseArgs(argv: string[]): { endpoint: string; dbPath: string } {
  const configDir =
    process.env.MAHAS_CONFIG_DIR ?? join(process.env.HOME ?? '/', '.config', 'mahas')
  let endpoint = join(configDir, 'execution-host.sock')
  let dbPath = join(configDir, 'execution-host.sqlite')
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--endpoint' && argv[i + 1]) endpoint = argv[++i]
    else if (a === '--config-dir' && argv[i + 1]) {
      const dir = argv[++i]
      endpoint = join(dir, 'execution-host.sock')
      dbPath = join(dir, 'execution-host.sqlite')
    } else if (a === '--db' && argv[i + 1]) dbPath = argv[++i]
    else if (a === '--help' || a === '-h') usage()
    else usage()
  }
  return { endpoint, dbPath }
}

function send(msg: object): void {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    /* stdout closed — a daemon stays quiet, never crashes on a dead pipe */
  }
}

const { endpoint, dbPath } = parseArgs(process.argv.slice(2))
let service: HostService | null = null
let processOps: ProcessOpsHandle | null = null
let stopping = false

async function shutdown(code: number): Promise<void> {
  if (stopping) return
  stopping = true
  if (service) {
    send({
      t: 'stopping',
      hostId: service.identity.hostId,
      hostIncarnation: service.identity.hostIncarnation
    })
    // drop subscriptions/timers; owned processes stay alive for reattach —
    // killing them is a drain-and-stop decision the controller makes
    processOps?.dispose()
    await service.close()
  }
  process.exit(code)
}

async function main(): Promise<void> {
  for (const p of [dirname(endpoint), dbPath === ':memory:' ? null : dirname(dbPath)]) {
    if (p) mkdirSync(p, { recursive: true })
  }
  try {
    service = await bootstrapHost({ endpoint, dbPath })
  } catch (err) {
    // refusal is honest — a live host or unverifiable takeover is reported,
    // never worked around (no kill, no adopt, no parallel second daemon).
    const code = err instanceof HostOpError ? err.code : 'BOOTSTRAP_FAILED'
    send({ t: 'error', code, msg: err instanceof Error ? err.message : String(err), endpoint })
    process.exit(1)
  }
  const { identity } = service
  // Owned primitives registered into the daemon's op table (IMP-16/18):
  // process/PTY + terminal stream ops, and the workspace.* primitives.
  processOps = registerProcessOps(service.registerHostOp, {
    db: service.db,
    hostId: identity.hostId,
    hostIncarnation: identity.hostIncarnation,
    pushEvent: (connectionId, event) => {
      service!.pushEvent({ connectionId, event } as never)
    },
    assertMutationAllowed: (op, ctx) => service!.assertMutationAllowed(op, ctx)
  })
  // F-041: socket close drops that connection's terminal subscriptions —
  // without this, subs owned by dead conns are permanent orphans.
  service.setDropConnection((id) => processOps!.manager.terminals.dropConnection(id))
  registerWorkspaceHostOps(
    (spec, handler) =>
      service!.registerHostOp(
        spec.name,
        (payload, ctx) =>
          handler(
            {
              db: ctx.db,
              envelope: ctx.envelope as unknown as WorkspaceOpEnvelope
            },
            payload
          ),
        { mutation: spec.mutation }
      ),
    {}
  )
  send({
    t: 'ready',
    hostId: identity.hostId,
    hostIncarnation: identity.hostIncarnation,
    protocolVersion: identity.protocolVersion,
    endpoint,
    endpointFile: service.endpointFile,
    dbPath,
    pid: identity.processIdentity.pid,
    endpointIncarnation: identity.processIdentity.endpointIncarnation
  })
}

void main()
process.on('SIGTERM', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))
// stdin closing = launcher gone. The daemon exits like pty-host does today;
// the service-manager path (which owns a no-stdin lifetime) is IMP-23's.
process.stdin.on('end', () => void shutdown(0))
