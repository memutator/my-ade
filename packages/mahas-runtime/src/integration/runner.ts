import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type {
  AdapterPackRevisionRef,
  CapabilityImplementation,
  CapabilityRequestEnvelope,
  CapabilityResultEnvelope,
  IntegrationContractRef,
  IntegrationCapability,
  IntegrationDiagnostic,
  IntegrationTargetRef,
  PackCollectionRequestEnvelope,
  PackCollectionResultEnvelope,
  PackSourceDiscoveryEnvelope,
  PackSourceDiscoveryResultEnvelope
} from '../../../mahas-contracts/src/integration/index.ts'
import {
  validateCapabilityPayload,
  validatePackBoundaryPayload
} from '../../../mahas-contracts/src/integration/index.ts'
import { packEntrypoint, PackRegistry } from './registry.ts'
import { canonicalJson, redactText } from './safety.ts'

export type PackRunRequest =
  CapabilityRequestEnvelope | PackSourceDiscoveryEnvelope | PackCollectionRequestEnvelope

/**
 * Identity echoed onto every action result (discover-sources / collect).
 *
 * A Pack MAY echo these fields back; a Pack that echoes something else than
 * the pinned request fails the invocation ('pack.invalid-result') exactly like
 * a capability envelope whose target/contract/pack identity disagrees. What
 * the runner returns is NEVER the Pack's claim: the values below are copied
 * from the pinned request, so a consumer can attribute the batch to the exact
 * revision that produced it without re-reading the request that was sent.
 *
 * Contract note (flagged to the mahas-contracts owner): the published
 * PackSourceDiscoveryResultEnvelope / PackCollectionResultEnvelope do not
 * declare these fields yet — this module pins the echo locally until the
 * envelopes carry them.
 */
export interface PackActionResultIdentity {
  capability: IntegrationCapability
  target: IntegrationTargetRef
  contract: IntegrationContractRef
  pack: AdapterPackRevisionRef
}

export type PackActionRunResult = (
  PackSourceDiscoveryResultEnvelope | PackCollectionResultEnvelope
) &
  PackActionResultIdentity

export type PackRunResult = CapabilityResultEnvelope | PackActionRunResult

export interface PackRunnerOptions {
  signal?: AbortSignal
  /** Conformance never exercises capabilities whose normal result may describe an effect. */
  purpose?: 'invoke' | 'conformance'
  now?: () => number
}

export class PackRunnerError extends Error {
  // no parameter property: these modules run under Node strip-only types
  readonly code:
    'INVALID_REQUEST' | 'UNSUPPORTED' | 'EFFECTFUL_CHECK_FORBIDDEN' | 'RUNNER_UNSUPPORTED'

  constructor(
    code: 'INVALID_REQUEST' | 'UNSUPPORTED' | 'EFFECTFUL_CHECK_FORBIDDEN' | 'RUNNER_UNSUPPORTED',
    message: string
  ) {
    super(message)
    this.name = 'PackRunnerError'
    this.code = code
  }
}

const EFFECTFUL_CAPABILITIES = new Set<IntegrationCapability>([
  'launch',
  'resume',
  'wake',
  'maintenance',
  'auth'
])

function diagnostic(code: string, message: string): IntegrationDiagnostic {
  return { code, severity: 'error', message: redactText(message) }
}

function isActionRequest(
  request: PackRunRequest
): request is PackSourceDiscoveryEnvelope | PackCollectionRequestEnvelope {
  return 'action' in request
}

function validateRequest(
  request: PackRunRequest,
  impl: CapabilityImplementation,
  protocol: string
): void {
  if (request.protocolVersion !== protocol)
    throw new PackRunnerError(
      'INVALID_REQUEST',
      'request protocolVersion does not match the pinned Pack revision'
    )
  if (request.capability !== impl.capability)
    throw new PackRunnerError(
      'INVALID_REQUEST',
      'request capability does not match the selected implementation'
    )
  if (
    request.contract.id !== impl.contract.id ||
    request.contract.revision !== impl.contract.revision
  )
    throw new PackRunnerError(
      'INVALID_REQUEST',
      'request contract does not match the selected implementation'
    )
  let issues
  if ('action' in request) {
    issues = validatePackBoundaryPayload(
      request.action === 'collect' ? 'collection' : 'sourceDiscovery',
      'request',
      request.payload
    )
    if (
      request.action === 'discover-sources' &&
      request.payload.installationId !== request.target.installationId
    )
      throw new PackRunnerError(
        'INVALID_REQUEST',
        'source discovery installation does not match target'
      )
    if (request.action === 'collect') {
      if (
        request.target.kind === 'installation' &&
        request.payload.installationId !== request.target.installationId
      )
        throw new PackRunnerError(
          'INVALID_REQUEST',
          'collection installation does not match target'
        )
      if (impl.limits.maxBatchRecords && request.payload.maxRecords > impl.limits.maxBatchRecords)
        throw new PackRunnerError(
          'INVALID_REQUEST',
          'collection maxRecords exceeds implementation limit'
        )
      if (request.payload.maxBytes > impl.limits.maxOutputBytes)
        throw new PackRunnerError(
          'INVALID_REQUEST',
          'collection maxBytes exceeds implementation output limit'
        )
    }
  } else {
    issues = validateCapabilityPayload(request.capability, 'request', request.payload)
  }
  if (issues.length > 0)
    throw new PackRunnerError(
      'INVALID_REQUEST',
      `request payload violates schema at ${issues[0]?.path ?? '$'}`
    )
}

function failureEnvelope(
  request: PackRunRequest,
  status: 'failed' | 'cancelled' | 'timed-out',
  startedAt: number,
  completedAt: number,
  diag: IntegrationDiagnostic
): PackRunResult {
  const common = {
    protocolVersion: request.protocolVersion,
    operationId: request.operationId,
    status,
    diagnostics: [diag],
    startedAt,
    completedAt
  }
  // a failing invocation still echoes the pinned identity, so an operator can
  // attribute the failure to the revision that was asked for
  if ('action' in request)
    return { ...common, action: request.action, ...actionIdentity(request) } as PackRunResult
  return {
    ...common,
    capability: request.capability,
    target: request.target,
    contract: request.contract,
    pack: request.pack
  } as CapabilityResultEnvelope
}

/** the pinned identity of an action request — never the Pack's own claim */
function actionIdentity(
  request: PackSourceDiscoveryEnvelope | PackCollectionRequestEnvelope
): PackActionResultIdentity {
  return {
    capability: request.capability,
    target: request.target,
    contract: request.contract,
    pack: request.pack
  }
}

/**
 * A Pack's echoed identity must agree with the pinned request; an absent echo
 * is normal (the envelopes do not require it). A LYING echo is a hard failure
 * — identity is not something a Pack gets to assert.
 */
function assertActionIdentityEcho(
  request: PackSourceDiscoveryEnvelope | PackCollectionRequestEnvelope,
  result: Record<string, unknown>
): void {
  if (result.capability !== undefined && result.capability !== request.capability) {
    throw new Error('runner result capability does not match request')
  }
  if (result.target !== undefined && !sameJson(result.target, request.target)) {
    throw new Error('runner result target does not match the pinned request')
  }
  if (result.contract !== undefined && !sameJson(result.contract, request.contract)) {
    throw new Error('runner result contract does not match the pinned request')
  }
  if (result.pack !== undefined && !sameJson(result.pack, request.pack)) {
    throw new Error('runner result pack does not match the pinned request')
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function validateAndNormalizeResult(
  request: PackRunRequest,
  raw: unknown,
  startedAt: number,
  completedAt: number
): PackRunResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('runner output must be one JSON object')
  const result = raw as Record<string, unknown>
  if (
    result.protocolVersion !== request.protocolVersion ||
    result.operationId !== request.operationId
  )
    throw new Error('runner result does not correlate to the request')
  if (!['success', 'partial', 'failed', 'cancelled', 'timed-out'].includes(String(result.status)))
    throw new Error('runner result has an invalid status')
  if (!Array.isArray(result.diagnostics)) throw new Error('runner result is missing diagnostics')
  const safeDiagnostics = (result.diagnostics as unknown[]).map((item) => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    return {
      code: typeof row.code === 'string' ? row.code : 'pack.diagnostic',
      severity: ['info', 'warning', 'error'].includes(String(row.severity))
        ? row.severity
        : 'error',
      message: redactText(row.message)
    } as IntegrationDiagnostic
  })
  const status = result.status as PackRunResult['status']
  if (isActionRequest(request)) {
    if (result.action !== request.action)
      throw new Error('runner result action does not match request')
    assertActionIdentityEcho(request, result)
    if (result.payload !== undefined && (status === 'success' || status === 'partial')) {
      const issues = validatePackBoundaryPayload(
        request.action === 'collect' ? 'collection' : 'sourceDiscovery',
        'response',
        result.payload
      )
      if (issues.length > 0)
        throw new Error(`runner payload violates schema at ${issues[0]?.path ?? '$'}`)
    }
    return {
      protocolVersion: request.protocolVersion,
      operationId: request.operationId,
      action: request.action,
      // pinned, not echoed: see PackActionResultIdentity
      ...actionIdentity(request),
      status,
      ...(result.payload !== undefined ? { payload: result.payload } : {}),
      diagnostics: safeDiagnostics,
      startedAt,
      completedAt
    } as PackRunResult
  }
  if (result.capability !== request.capability)
    throw new Error('runner result capability does not match request')
  if (
    !sameJson(result.target, request.target) ||
    !sameJson(result.contract, request.contract) ||
    !sameJson(result.pack, request.pack)
  )
    throw new Error('runner result identity does not match the pinned request')
  if (result.payload !== undefined && (status === 'success' || status === 'partial')) {
    const issues = validateCapabilityPayload(request.capability, 'response', result.payload)
    if (issues.length > 0)
      throw new Error(`runner payload violates schema at ${issues[0]?.path ?? '$'}`)
  }
  return {
    protocolVersion: request.protocolVersion,
    operationId: request.operationId,
    capability: request.capability,
    target: request.target,
    contract: request.contract,
    pack: request.pack,
    status,
    ...(result.payload !== undefined ? { payload: result.payload } : {}),
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    diagnostics: safeDiagnostics,
    startedAt,
    completedAt
  } as CapabilityResultEnvelope
}

function capRecords(result: PackRunResult, impl: CapabilityImplementation): void {
  const cap = impl.limits.maxBatchRecords
  if (!cap || !('action' in result) || result.action !== 'collect' || !result.payload) return
  const payload = result.payload as unknown as Record<string, unknown>
  for (const key of [
    'observations',
    'sessions',
    'handles',
    'attachments',
    'events',
    'usageReadings',
    'usageAttributionHints',
    'quotaReadings'
  ]) {
    if (Array.isArray(payload[key]) && payload[key].length > cap)
      throw new Error(`runner result exceeds maxBatchRecords in ${key}`)
  }
}

function runScript(
  path: string,
  cwd: string,
  runtime: string,
  request: PackRunRequest,
  impl: CapabilityImplementation,
  signal: AbortSignal | undefined
): Promise<{ raw?: unknown; failure?: 'failed' | 'cancelled' | 'timed-out'; message?: string }> {
  if (runtime !== 'node')
    throw new PackRunnerError('RUNNER_UNSUPPORTED', `unsupported Pack runtime: ${runtime}`)
  // capability envelopes carry deadlineAt at the top level; collection and
  // source-discovery carry it inside the payload (boundary schema).
  const deadlineAt =
    'deadlineAt' in request
      ? request.deadlineAt
      : (request.payload as { deadlineAt?: number } | undefined)?.deadlineAt
  const deadlineBudget =
    typeof deadlineAt === 'number' ? Math.max(0, deadlineAt - Date.now()) : impl.limits.timeoutMs
  const timeoutMs = Math.min(impl.limits.timeoutMs, deadlineBudget)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        LANG: 'C.UTF-8',
        MAHAS_PACK_PROTOCOL: request.protocolVersion
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let stop: 'cancelled' | 'timed-out' | 'failed' | undefined
    const terminate = (reason: 'cancelled' | 'timed-out' | 'failed'): void => {
      if (stop) return
      stop = reason
      child.kill('SIGKILL')
    }
    const abort = (): void => terminate('cancelled')
    // the timer is created before `finish` so both can be const; every caller of
    // finish (child 'error'/'close', stdout cap) fires after this synchronous
    // block, so the binding is always initialised by then
    const timer = setTimeout(() => terminate('timed-out'), timeoutMs)
    const finish = (value: {
      raw?: unknown
      failure?: 'failed' | 'cancelled' | 'timed-out'
      message?: string
    }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const collect = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes <= impl.limits.maxOutputBytes) {
        if (which === 'stdout') stdoutChunks.push(chunk)
        else stderrChunks.push(chunk)
      }
      if (outputBytes > impl.limits.maxOutputBytes) terminate('failed')
    }
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.on('error', (error) => finish({ failure: 'failed', message: error.message }))
    child.on('close', (code) => {
      if (stop)
        return finish({
          failure: stop,
          message:
            stop === 'failed' ? 'Pack output exceeded its byte limit' : `Pack invocation ${stop}`
        })
      const stdout = Buffer.concat(stdoutChunks)
      const stderr = Buffer.concat(stderrChunks)
      if (code !== 0)
        return finish({
          failure: 'failed',
          message: `Pack process exited ${String(code)}: ${redactText(stderr)}`
        })
      try {
        finish({ raw: JSON.parse(stdout.toString('utf8')) })
      } catch {
        finish({
          failure: 'failed',
          message: 'Pack stdout was not exactly one JSON result envelope'
        })
      }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}

/**
 * Explicit invocation only. Registration and schema checks do not call this.
 * Returned data is pure Pack output; the scheduler owns ledger commits and effects.
 */
export async function runPack(
  registry: PackRegistry,
  request: PackRunRequest,
  options: PackRunnerOptions = {}
): Promise<PackRunResult> {
  const startedAt = (options.now ?? Date.now)()
  const revision = registry.resolve(request.pack.packId, request.pack.revision)
  if (revision.contentDigest !== request.pack.contentDigest)
    throw new PackRunnerError(
      'INVALID_REQUEST',
      'request Pack digest does not match the immutable registered revision'
    )
  const impl = registry.implementation(
    request.pack.packId,
    request.pack.revision,
    request.capability
  )
  if (!impl || impl.support.state === 'unsupported')
    throw new PackRunnerError(
      'UNSUPPORTED',
      `capability ${request.capability} is not implemented by this Pack revision`
    )
  if (options.purpose === 'conformance' && EFFECTFUL_CAPABILITIES.has(request.capability))
    throw new PackRunnerError(
      'EFFECTFUL_CHECK_FORBIDDEN',
      `conformance cannot invoke effectful capability ${request.capability}`
    )
  validateRequest(request, impl, revision.manifest.revision.runnerProtocol)
  const entrypoint = impl.entrypoint
  if (!entrypoint)
    throw new PackRunnerError('UNSUPPORTED', `capability ${request.capability} has no entrypoint`)
  let raw: unknown
  let failure: 'failed' | 'cancelled' | 'timed-out' | undefined
  let message: string | undefined
  if (entrypoint.mode === 'declarative') {
    try {
      raw = JSON.parse(readFileSync(packEntrypoint(revision, entrypoint.resource), 'utf8'))
    } catch (error) {
      failure = 'failed'
      message = error instanceof Error ? error.message : String(error)
    }
  } else {
    const ran = await runScript(
      packEntrypoint(revision, entrypoint.resource),
      revision.snapshotPath,
      entrypoint.runtime,
      request,
      impl,
      options.signal
    )
    raw = ran.raw
    failure = ran.failure
    message = ran.message
  }
  const completedAt = (options.now ?? Date.now)()
  if (failure)
    return failureEnvelope(
      request,
      failure,
      startedAt,
      completedAt,
      diagnostic(`pack.${failure}`, message ?? failure)
    )
  try {
    const result = validateAndNormalizeResult(request, raw, startedAt, completedAt)
    capRecords(result, impl)
    return result
  } catch (error) {
    return failureEnvelope(
      request,
      'failed',
      startedAt,
      completedAt,
      diagnostic('pack.invalid-result', error instanceof Error ? error.message : String(error))
    )
  }
}
