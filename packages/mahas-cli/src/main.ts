#!/usr/bin/env node
// mahas — the thin collaboration CLI (IMP-12).
//
// spec/architecture.md §1 + C-ACCESS: the CLI is a CLIENT of mahasd's
// command handler. Verb words map to registry operation names
// (`mahas inbox check` → `inbox.check`); the allowed verb set is generated
// from surface.describe for the authenticated principal — there is no
// static command dictionary to drift out of sync (REQ-09).
//
// Output rules (spec/common.md §2): stdout carries exactly one JSON value
// (the CommandReceipt — or the status verdict); stderr carries diagnostics;
// nonzero exit marks failure. A timeout/disconnect keeps the operationId
// and points at `mahas operation get` — the CLI never resends a mutation
// under a fresh id (REQ-14).

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { MahasError } from '../../mahas-contracts/src/index.ts'
import { connectRpc, isMahasError, mahasError } from '../../mahas-runtime/src/rpc/index.ts'
import { defaultConfigDir, resolveConnection, type CliRole } from './connection.ts'
import {
  describeOutcome,
  emitReceipt,
  exitCodeFor,
  invokeOperation,
  EXIT
} from './command-client.ts'
import {
  formatCompletion,
  formatOpHelp,
  formatSurfaceHelp,
  matchOperation,
  parseSurface,
  type SurfaceView
} from './dynamic-help.ts'

/**
 * The version the CLI reports. The packaged bundle gets it injected at build
 * time (see tools/build-services.mjs `define`), because a service bundle has no
 * package.json next to it. A direct source run (`npm run mahas`, which Node
 * executes with type stripping) falls back to the repo manifest, so the number
 * is never a hardcoded placeholder that drifts from package.json.
 */
declare const __MAHAS_CLI_VERSION__: string | undefined
const CLI_VERSION =
  typeof __MAHAS_CLI_VERSION__ === 'string'
    ? __MAHAS_CLI_VERSION__
    : ((): string => {
        try {
          const manifest = JSON.parse(
            readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
          ) as { version?: string }
          return typeof manifest.version === 'string' && manifest.version
            ? manifest.version
            : '0.0.0-unknown'
        } catch {
          return '0.0.0-unknown'
        }
      })()

// ── argv parsing ────────────────────────────────────────────────────────────

interface ParsedArgs {
  words: string[] // positional verb words
  payloadFields: Record<string, unknown> // --set / unknown --key value
  positionalRest: string[] // leftovers after verb match (filled by schema if possible)
  inputFile?: string
  expectedRevisions?: Record<string, number>
  operationId?: string
  timeoutMs?: number
  role?: CliRole
  connectionFile?: string
  json: boolean
  help: boolean
  version: boolean
  error?: string
}

const CONTROL_FLAGS = new Set([
  'json',
  'input',
  'set',
  'expect',
  'operation-id',
  'id',
  'timeout',
  'as',
  'connection-file',
  'help',
  'h'
])

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function setField(fields: Record<string, unknown>, key: string, value: unknown): void {
  const prev = fields[key]
  if (prev === undefined) fields[key] = value
  else if (Array.isArray(prev)) prev.push(value)
  else fields[key] = [prev, value]
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    words: [],
    payloadFields: {},
    positionalRest: [],
    json: false,
    help: false,
    version: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version' || a === '-v') {
      out.version = true
      continue
    }
    if (a === '--help' || a === '-h') {
      out.help = true
      continue
    }
    if (a === '--json') {
      out.json = true
      continue
    }
    if (a === '--as') {
      const v = argv[++i]
      if (v === 'worker' || v === 'operator') out.role = v
      else out.error = `--as expects worker|operator`
      continue
    }
    if (a === '--connection-file') {
      out.connectionFile = argv[++i]
      continue
    }
    if (a === '--input') {
      out.inputFile = argv[++i]
      continue
    }
    if (a === '--operation-id' || a === '--id') {
      out.operationId = argv[++i]
      continue
    }
    if (a === '--timeout') {
      out.timeoutMs = Number(argv[++i])
      if (!Number.isFinite(out.timeoutMs)) out.error = '--timeout expects milliseconds'
      continue
    }
    if (a === '--set') {
      const kv = argv[++i] ?? ''
      const eq = kv.indexOf('=')
      if (eq <= 0) {
        out.error = '--set expects key=value'
        continue
      }
      setField(out.payloadFields, kv.slice(0, eq), parseValue(kv.slice(eq + 1)))
      continue
    }
    if (a === '--expect') {
      const kv = argv[++i] ?? ''
      const eq = kv.indexOf('=')
      if (eq <= 0) {
        out.error = '--expect expects entityId=revision'
        continue
      }
      const rev = Number(kv.slice(eq + 1))
      if (!Number.isInteger(rev) || rev < 1) {
        out.error = '--expect revision must be an integer ≥ 1'
        continue
      }
      ;(out.expectedRevisions ??= {})[kv.slice(0, eq)] = rev
      continue
    }
    if (a.startsWith('--')) {
      // unknown long flag → payload field (--key value | --key=value | --key)
      const eq = a.indexOf('=')
      if (eq > 0) {
        setField(out.payloadFields, a.slice(2, eq), parseValue(a.slice(eq + 1)))
        continue
      }
      const key = a.slice(2)
      if (CONTROL_FLAGS.has(key)) {
        out.error = `unhandled flag ${a}`
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        setField(out.payloadFields, key, parseValue(next))
        i++
      } else {
        setField(out.payloadFields, key, true)
      }
      continue
    }
    out.words.push(a)
  }
  return out
}

async function buildPayload(
  parsed: ParsedArgs,
  schema: unknown
): Promise<{ ok: true; payload: unknown } | { ok: false; message: string }> {
  let base: Record<string, unknown> = {}
  if (parsed.inputFile !== undefined) {
    let raw: string
    try {
      raw = await readFile(parsed.inputFile, 'utf8')
    } catch {
      return { ok: false, message: `cannot read --input ${parsed.inputFile}` }
    }
    let v: unknown
    try {
      v = JSON.parse(raw)
    } catch {
      return { ok: false, message: `--input ${parsed.inputFile} is not valid JSON` }
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      if (Object.keys(parsed.payloadFields).length > 0 || parsed.positionalRest.length > 0) {
        return { ok: false, message: '--input must be a JSON object to combine with other fields' }
      }
      return { ok: true, payload: v }
    }
    base = v as Record<string, unknown>
  }
  const payload = { ...base, ...parsed.payloadFields }

  // leftover positionals fill schema properties in declaration order
  if (parsed.positionalRest.length > 0) {
    const props =
      typeof schema === 'object' && schema !== null
        ? (schema as Record<string, unknown>).properties
        : undefined
    if (typeof props !== 'object' || props === null) {
      return {
        ok: false,
        message:
          `positional arguments need a schema or --set/--input: ` + parsed.positionalRest.join(' ')
      }
    }
    const names = Object.keys(props).filter((n) => payload[n] === undefined)
    if (parsed.positionalRest.length > names.length) {
      return { ok: false, message: `too many positional arguments for ${names.join(', ')}` }
    }
    parsed.positionalRest.forEach((v, i) => {
      payload[names[i]!] = parseValue(v)
    })
  }
  return { ok: true, payload: Object.keys(payload).length ? payload : undefined }
}

// ── output helpers ──────────────────────────────────────────────────────────

function out(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n')
}

function diag(s: string): void {
  process.stderr.write(s + '\n')
}

function staticHelp(): string {
  return [
    'mahas — collaboration CLI, client of mahasd',
    '',
    'usage: mahas <verb…> [flags]',
    '',
    'built-in verbs (no session needed):',
    '  status              probe mahasd via runtime.status (hello is not readiness)',
    '  help [op…]          list your allowed operations (surface.describe), or one op schema',
    '  completion          print allowed verb words for shell completion',
    '  --version, -v       print version',
    '  --help, -h          this text',
    '',
    'every other verb is generated from YOUR surface — e.g. `mahas inbox check`',
    'maps to inbox.check only when the server grants it to your credential.',
    '',
    'flags:',
    '  --input <file>          composite JSON payload',
    '  --set k=v               payload field (repeatable; JSON values)',
    '  --<key> <value>         same as --set (e.g. --operationId abc)',
    '  --expect id=rev         expectedRevisions (repeatable)',
    '  --operation-id <id>     reuse an idempotency id (reconcile a prior call)',
    '  --timeout <ms>          bound the wait; on timeout the operationId is printed',
    '  --as worker|operator    credential side (default: inferred from env).',
    '                          --as operator is refused when MAHAS_ROLE=worker',
    '                          or MAHAS_CONNECTION_FILE is set (no fallback-admin)',
    '  --connection-file <p>   credential file override',
    '  --json                  structured output (stdout is always JSON)',
    '',
    'exit codes: 0 committed · 1 rejected/failed · 2 usage/unavailable-op ·',
    '3 control unavailable · 4 unauthenticated · 5 outcome unknown (see operation.get)'
  ].join('\n')
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdStatus(parsed: ParsedArgs): Promise<number> {
  const env = process.env
  const configDir = defaultConfigDir(env)
  let endpoint: string | null = null
  try {
    const conn = await resolveConnection({
      configDir,
      role: parsed.role,
      connectionFile: parsed.connectionFile
    })
    endpoint = conn.endpoint
    const client = await connectRpc(conn.endpoint, conn.credential)
    try {
      const receipt = await client.call('runtime.status', {})
      const report =
        receipt.status === 'committed' && receipt.result && typeof receipt.result === 'object'
          ? (receipt.result as {
              service?: string
              state?: string
              writableReady?: boolean
            })
          : null
      const readiness = report
        ? report.writableReady
          ? 'ready'
          : (report.state ?? 'degraded')
        : 'degraded'
      out({
        service: report?.service ?? 'mahasd',
        readiness,
        endpoint: conn.endpoint,
        role: conn.role,
        principalId: client.principalId,
        transportSessionId: client.transportSessionId,
        protocolVersion: client.protocolVersion,
        source: conn.source,
        checkedAt: Date.now(),
        ...(report ? { runtime: receipt.result } : {}),
        ...(report
          ? {}
          : {
              detail: receipt.error
                ? `${receipt.error.code}: ${receipt.error.message}`
                : 'runtime.status not committed'
            })
      })
      return EXIT.OK
    } finally {
      client.close()
    }
  } catch (e) {
    const err = isMahasError(e)
      ? e
      : mahasError('CONTROL_UNAVAILABLE', String((e as Error).message ?? e))
    // unreachable socket → unavailable (nothing answered); a refused session
    // on an answering socket → degraded (serving, but not for us)
    const unavailable = err.code === 'CONTROL_UNAVAILABLE'
    out({
      service: 'mahasd',
      readiness: unavailable ? 'unavailable' : 'degraded',
      endpoint,
      detail: `${err.code}: ${err.message}`,
      checkedAt: Date.now()
    })
    return unavailable ? EXIT.CONTROL_UNAVAILABLE : EXIT.OK
  }
}

async function fetchSurface(
  parsed: ParsedArgs
): Promise<{ view: SurfaceView; close(): void } | { error: MahasError }> {
  const configDir = defaultConfigDir(process.env)
  const conn = await resolveConnection({
    configDir,
    role: parsed.role,
    connectionFile: parsed.connectionFile
  })
  const client = await connectRpc(conn.endpoint, conn.credential)
  try {
    const receipt = await client.call('surface.describe', {})
    if (receipt.status !== 'committed') {
      return {
        error: receipt.error ?? mahasError('UNAVAILABLE_OPERATION', 'surface.describe rejected')
      }
    }
    const result = receipt.result as { surface?: unknown } | undefined
    // the describe result may nest the surface under {surface} — accept both
    const view = parseSurface(result?.surface ?? result ?? {})
    return { view, close: () => client.close() }
  } catch (e) {
    client.close()
    return { error: isMahasError(e) ? e : mahasError('CONTROL_UNAVAILABLE', String(e)) }
  }
}

async function cmdHelp(parsed: ParsedArgs): Promise<number> {
  const surface = await fetchSurface(parsed).catch((e) => ({
    error: isMahasError(e) ? e : mahasError('CONTROL_UNAVAILABLE', String(e))
  }))
  if ('error' in surface) {
    diag(`surface unavailable: ${surface.error.code} — ${surface.error.message}`)
    process.stdout.write(staticHelp() + '\n')
    return EXIT.CONTROL_UNAVAILABLE
  }
  try {
    if (parsed.words.length === 0) {
      process.stdout.write(
        'mahas — your operation surface' +
          (surface.view.digest ? ` (digest ${surface.view.digest})` : '') +
          '\n\n'
      )
      process.stdout.write(formatSurfaceHelp(surface.view))
      return EXIT.OK
    }
    const { op, candidates } = matchOperation(surface.view, parsed.words)
    if (!op) {
      diag(`not in your surface: ${parsed.words.join(' ')}`)
      if (candidates.length) diag(`closest allowed: ${candidates.join(', ')}`)
      return EXIT.USAGE
    }
    process.stdout.write(formatOpHelp(op))
    return EXIT.OK
  } finally {
    surface.close()
  }
}

async function cmdCompletion(parsed: ParsedArgs): Promise<number> {
  const surface = await fetchSurface(parsed).catch((e) => ({
    error: isMahasError(e) ? e : mahasError('CONTROL_UNAVAILABLE', String(e))
  }))
  if ('error' in surface) {
    diag(`surface unavailable: ${surface.error.code} — ${surface.error.message}`)
    return EXIT.CONTROL_UNAVAILABLE
  }
  try {
    process.stdout.write(formatCompletion(surface.view))
    return EXIT.OK
  } finally {
    surface.close()
  }
}

async function cmdInvoke(parsed: ParsedArgs): Promise<number> {
  const configDir = defaultConfigDir(process.env)
  const conn = await resolveConnection({
    configDir,
    role: parsed.role,
    connectionFile: parsed.connectionFile
  })
  const client = await connectRpc(conn.endpoint, conn.credential)
  try {
    const receipt = await client.call('surface.describe', {})
    if (receipt.status !== 'committed') {
      emitReceipt(receipt)
      diag(`surface.describe: ${receipt.error?.code ?? 'rejected'}`)
      return EXIT.CONTROL_UNAVAILABLE
    }
    const result = receipt.result as { surface?: unknown } | undefined
    const view = parseSurface(result?.surface ?? result ?? {})
    const { op, rest, candidates } = matchOperation(view, parsed.words)
    if (!op) {
      diag(`not in your surface: ${parsed.words.join(' ')}`)
      if (candidates.length) diag(`closest allowed: ${candidates.join(', ')}`)
      return EXIT.USAGE
    }
    // words are pure positionals — flags were already consumed by parseArgs,
    // so everything after the matched verb is a positional payload argument
    parsed.positionalRest = rest
    const built = await buildPayload(parsed, op.inputSchema)
    if (!built.ok) {
      diag(`mahas ${op.name}: ${built.message}`)
      return EXIT.USAGE
    }
    const outcome = await invokeOperation(client, op.name, built.payload, {
      operationId: parsed.operationId,
      expectedRevisions: parsed.expectedRevisions,
      timeoutMs: parsed.timeoutMs
    })
    if (outcome.kind === 'receipt') emitReceipt(outcome.receipt)
    diag(describeOutcome(outcome, op.name))
    return exitCodeFor(outcome)
  } finally {
    client.close()
  }
}

// ── entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    diag(`mahas: ${parsed.error}`)
    return EXIT.USAGE
  }
  const [first] = parsed.words
  if (parsed.version) {
    process.stdout.write(CLI_VERSION + '\n')
    return EXIT.OK
  }
  if (parsed.help && parsed.words.length === 0) {
    process.stdout.write(staticHelp() + '\n')
    return EXIT.OK
  }
  switch (first) {
    case undefined:
      process.stdout.write(staticHelp() + '\n')
      return EXIT.USAGE
    case 'status':
      return cmdStatus(parsed)
    case 'help':
      parsed.words = parsed.words.slice(1)
      return cmdHelp(parsed)
    case 'completion':
      return cmdCompletion(parsed)
    default:
      break
  }
  // a surface verb — or --help after verb words → op help
  try {
    if (parsed.help) {
      return await cmdHelp(parsed)
    }
    return await cmdInvoke(parsed)
  } catch (e) {
    // connect/resolve failures — honest CONTROL_UNAVAILABLE / UNAUTHENTICATED,
    // never a fabricated "received"
    const err = isMahasError(e)
      ? e
      : mahasError('CONTROL_UNAVAILABLE', String((e as Error).message ?? e))
    diag(`mahas ${parsed.words.join(' ')}: ${err.code} — ${err.message}`)
    return err.code === 'UNAUTHENTICATED' ? EXIT.UNAUTHENTICATED : EXIT.CONTROL_UNAVAILABLE
  }
}

process.exitCode = await main()
