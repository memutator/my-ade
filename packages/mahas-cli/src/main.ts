#!/usr/bin/env node
// mahas — the operator/agent CLI. Per spec/architecture.md §1 it is a CLIENT
// of mahasd's collaboration API: worker shells reach the control plane
// through `mahas <op>`, never by opening mahas.sqlite or an execution-host
// socket themselves.
//
// IMP-01 shell — what is real today:
//   `mahas status`   resolves the mahasd endpoint (config-dir convention or
//                    $MAHASD_ENDPOINT) and reports the VERIFIED verdict —
//                    reachable-but-unnegotiated prints 'degraded', not ok.
//   `mahas <op>`     every other operation routes through the runtime client
//                    and is honestly CONTROL_UNAVAILABLE until IMP-02/17/23
//                    land the collaboration surface. Exit 3 = control plane
//                    unavailable, 2 = usage error.

import { bootstrapRuntime } from '../../mahas-runtime/src/index.ts'
import { join } from 'node:path'

const CLI_VERSION = '0.0.0-imp01'

function usage(): never {
  process.stderr.write(
    [
      'mahas — control-plane client CLI (IMP-01 shell)',
      '',
      'usage: mahas <command> [args]',
      '',
      'commands that work today:',
      '  status            probe the mahasd endpoint and print the readiness verdict',
      '  --version, -v     print version',
      '  --help, -h        this text',
      '',
      'everything else is routed to the runtime client and currently answers',
      'CONTROL_UNAVAILABLE — the collaboration API lands with the control',
      'plane (IMP-02 / IMP-17 / IMP-23).'
    ].join('\n') + '\n'
  )
  process.exit(2)
}

function configDir(): string {
  return process.env.MAHAS_CONFIG_DIR ?? join(process.env.HOME ?? '/', '.config', 'mahas')
}

async function cmdStatus(): Promise<number> {
  const handle = bootstrapRuntime({ configDir: configDir() })
  try {
    const status = await handle.refresh()
    process.stdout.write(JSON.stringify(status, null, 2) + '\n')
    // 'degraded'/'unavailable' are both reported honestly — exit code marks
    // whether ANYTHING answered, not whether the control plane works
    return status.readiness === 'degraded' ? 0 : 3
  } finally {
    await handle.disconnect()
  }
}

async function cmdPassthrough(op: string): Promise<number> {
  const handle = bootstrapRuntime({ configDir: configDir() })
  try {
    // the route exists — the operation does not. Honest refusal, exit 3.
    const res = await handle.client.listExecutions()
    if (!res.ok) {
      process.stderr.write(`mahas ${op}: ${res.error.code} — ${res.error.message}\n`)
      return 3
    }
    return 0
  } finally {
    await handle.disconnect()
  }
}

async function main(): Promise<number> {
  const [op] = process.argv.slice(2)
  switch (op) {
    case undefined:
    case '--help':
    case '-h':
      return usage()
    case '--version':
    case '-v':
      process.stdout.write(CLI_VERSION + '\n')
      return 0
    case 'status':
      return cmdStatus()
    default:
      return cmdPassthrough(op)
  }
}

process.exitCode = await main()
