#!/usr/bin/env node
// mahas-execution-host — the reattachable local daemon that owns PTY and
// generic process incarnations (spec/architecture.md §1, spec/domains/
// execution.md). It must not die when a UI disconnects; mahasd reattaches
// to the same processes after a control-plane restart.
//
// IMP-01 delivers the ENTRYPOINT SHELL only — honest about what exists:
//   real:  argv/config-dir handling, host identity (hostId + fresh
//          incarnation per process), a unix-socket listener answering one
//          `hello` op, NDJSON lifecycle lines on stdout (same convention as
//          resources/pty-host.cjs), and clean shutdown on signal/stdin-end.
//   absent: process/PTY managers, spawn/stop/input primitives, Controller-
//          Lease verification (D-EXEC §3), execution-host.sqlite receipts.
//          IMP-17–IMP-23 inject those behind this socket; every unhandled
//          op answers {t:'error', code:'UNIMPLEMENTED'} — never a fake ok.

import { createServer, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** wire-format version of the ExecutionHost RPC — IMP-16+ owns its bumps */
const EXECUTION_HOST_PROTOCOL_VERSION = 0

interface HostIdentity {
  service: 'mahas-execution-host'
  hostId: string
  /** fresh per process — reattach equality is (hostId, incarnation) */
  hostIncarnation: string
  protocolVersion: number
  pid: number
  startedAt: number
}

const identity: HostIdentity = {
  service: 'mahas-execution-host',
  hostId: hostname(),
  hostIncarnation: randomUUID(),
  protocolVersion: EXECUTION_HOST_PROTOCOL_VERSION,
  pid: process.pid,
  startedAt: Date.now()
}

function usage(): never {
  process.stderr.write(
    'usage: mahas-execution-host [--endpoint <path>] [--config-dir <dir>] [--help]\n' +
      '  socket defaults to <config-dir>/execution-host.sock; config dir\n' +
      '  defaults to $MAHAS_CONFIG_DIR or ~/.config/mahas\n'
  )
  process.exit(2)
}

function parseArgs(argv: string[]): { endpoint: string } {
  const configDir =
    process.env.MAHAS_CONFIG_DIR ?? join(process.env.HOME ?? '/', '.config', 'mahas')
  let endpoint = join(configDir, 'execution-host.sock')
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--endpoint' && argv[i + 1]) endpoint = argv[++i]
    else if (a === '--config-dir' && argv[i + 1]) endpoint = join(argv[++i], 'execution-host.sock')
    else if (a === '--help' || a === '-h') usage()
    else usage()
  }
  return { endpoint }
}

function send(msg: object): void {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    /* stdout closed — a daemon stays quiet, never crashes on a dead pipe */
  }
}

const { endpoint } = parseArgs(process.argv.slice(2))
let server: Server | null = null
const conns = new Set<Socket>()
let stopping = false

// One op exists: `hello` → host identity. Anything else is honestly refused
// — accepting an op and silently doing nothing would be the lie REQ-14/27
// forbid. The line protocol matches the desktop's pty-host conventions so
// IMP-17 can grow it rather than replace it.
function onLine(conn: Socket, line: string): void {
  let m: { t?: string }
  try {
    m = JSON.parse(line)
  } catch {
    conn.write(JSON.stringify({ t: 'error', code: 'BAD_JSON' }) + '\n')
    return
  }
  if (m.t === 'hello') {
    conn.write(JSON.stringify({ t: 'hello', ...identity }) + '\n')
    return
  }
  if (m.t === 'quit') {
    conn.write(JSON.stringify({ t: 'bye' }) + '\n')
    shutdown(0)
    return
  }
  conn.write(JSON.stringify({ t: 'error', code: 'UNIMPLEMENTED', op: m.t ?? null }) + '\n')
}

function onConn(conn: Socket): void {
  conns.add(conn)
  conn.on('close', () => conns.delete(conn))
  const rl = createInterface({ input: conn, terminal: false })
  rl.on('line', (line) => onLine(conn, line))
}

// refuse a live endpoint — never unlink someone else's socket to take over
function start(path: string): void {
  if (existsSync(path)) {
    send({ t: 'error', code: 'ENDPOINT_IN_USE', endpoint: path })
    process.exit(1)
  }
  server = createServer(onConn)
  server.on('error', (err) => {
    send({ t: 'error', code: 'LISTEN_FAILED', msg: String(err.message ?? err) })
    process.exit(1)
  })
  server.listen(path, () => {
    send({ t: 'ready', ...identity, endpoint: path })
  })
}

function shutdown(code: number): void {
  if (stopping) return
  stopping = true
  send({ t: 'stopping', ...identity })
  for (const c of conns) c.destroy()
  server?.close(() => {
    try {
      if (existsSync(endpoint)) unlinkSync(endpoint)
    } catch {
      /* next start probes existence again */
    }
    process.exit(code)
  })
  // a wedged listener must not hold the exit forever
  setTimeout(() => process.exit(code), 1500).unref()
}

start(endpoint)
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
// stdin closing = launcher gone — the daemon exits like pty-host does today;
// IMP-17 revisits this once the service-manager path exists
process.stdin.on('end', () => shutdown(0))
