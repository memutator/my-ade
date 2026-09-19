#!/usr/bin/env node
// mahasd — the mahas control-plane daemon (single writer over mahas.sqlite).
//
// spec/architecture.md §1 + §5: mahasd is a SERVICE entrypoint — it must
// survive every UI exit (UI close = client detach, never daemon stop) and it
// must never die because a parent IPC pipe closed. The desktop and the CLI
// are clients of its versioned RPC; the only stop paths are the explicit
// operator modes drain-and-stop / leave-executions (or an OS-level signal,
// which is honestly recorded as leave-executions — processes are never
// killed by a mode the operator did not choose).
//
// IMP-23 delivers the daemon's LIFETIME: single-writer lock, endpoint
// publication, startup readiness sequence (open DB → new controller epoch →
// host/process reconcile → only then writable), restart reconciliation, and
// the staged shutdown record. IMP-30 wires the full domain registry into
// `startMahasd(opts)` — see MahasdOptions for exactly what it needs.
//
// Run directly:  node packages/mahas-runtime/src/main.ts [--config-dir DIR]
//                [--endpoint PATH] [--db PATH]

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  CommandReceipt,
  CommandRequest
} from '../../mahas-contracts/src/index.ts'
import {
  BootstrapError,
  DEFAULT_CRASH_LOOP,
  MAHASD_PROTOCOL_VERSION,
  acquireServiceLock,
  assessExistingService,
  buildEndpointFile,
  checkCrashLoop,
  collectProcessIdentity,
  lifecyclePaths,
  publishEndpointFile,
  readEndpointFile,
  recordBootMarker,
  removeEndpointFile,
  singleWriterLockPath,
  verdictForProcess,
  type CrashLoopPolicy,
  type ServiceLock
} from './lifecycle/service-bootstrap.ts'
import { MahasdLifecycle } from './lifecycle/lifecycle.ts'
import { registerRuntimeOps } from './lifecycle/operations.ts'
import { reconcileExecutions } from './recovery/index.ts'
import type { ReadinessSnapshot } from './lifecycle/readiness.ts'
import type {
  ConnectHostFn,
  CrossDomainCaller,
  ProcessIdentity,
  ReconcileReport,
  RuntimeStatusReport,
  ServiceEndpointFile,
  ShutdownMode,
  WithTxFn
} from './lifecycle/types.ts'
import type { ReconcileScope } from './lifecycle/reconcile.ts'
import { mahasError } from './api/handler-ports.ts'
import {
  OPERATION_NAMES,
  makeCaller,
  type OperationHandler,
  type OperationSpec,
  type TxnContext
} from './api/registry.ts'
import type { ComposedRuntime } from './composition.ts'
import { currentGrantRevisions } from './access/grant.ts'
import {
  authenticateWorkerCredential,
  bindingToContextFields
} from './launch/bootstrap-credential.ts'
import { mahasdWorkerEndpoint } from './rpc/endpoints.ts'

// ---------------------------------------------------------------------------
// injectable dependency surface — IMP-30 wires the real implementations
// ---------------------------------------------------------------------------

/** minimal registry shape this boundary needs — IMP-11's OperationRegistry satisfies it */
export interface RegistryLike {
  register(spec: OperationSpec, handler: OperationHandler): void
  dispatch(ctx: AuthenticatedContext, req: CommandRequest): Promise<CommandReceipt>
  describe?(ctx: AuthenticatedContext): unknown
}

export interface RpcServerLike {
  endpoint: string
  /** resolves once the listener actually accepts connections (IMP-12's
   *  serveRpc binds asynchronously; publishing the endpoint file before this
   *  is a race that makes a live daemon look refused) */
  ready?: Promise<void>
  close(): Promise<void>
}

export type OpenDbFn = (path: string) => DatabaseSync
export type ServeRpcFn = (
  registry: RegistryLike,
  endpoint: string,
  authenticate: (credential: unknown) => AuthenticatedContext
) => RpcServerLike
export type AuthenticateFn = (credential: unknown) => AuthenticatedContext

export interface MahasdOptions {
  /** state dir — defaults $MAHAS_CONFIG_DIR or ~/.config/mahas */
  configDir?: string
  /** mahas.sqlite path — defaults <configDir>/mahas.sqlite */
  dbPath?: string
  /** unix socket path — defaults <configDir>/mahasd.sock */
  endpoint?: string
  protocolVersion?: number
  crashLoop?: CrashLoopPolicy
  hostProbeTimeoutMs?: number
  defaultDrainBudgetMs?: number

  /**
   * IMP-30 wiring points. Absent = lazy dynamic import of the promised path
   * (storage/db.ts, rpc/index.ts, hostClient.ts); a missing layer fails
   * honestly at boot, never silently.
   */
  openDb?: OpenDbFn
  withTx?: WithTxFn
  registry?: RegistryLike
  /** integrator hook — register the OTHER domains' ops into the same registry */
  registerDomainOps?: (registry: RegistryLike) => void
  serveRpc?: ServeRpcFn
  authenticate?: AuthenticateFn
  connectHost?: ConnectHostFn
  /** makeCaller(registry, serviceCtx) product — used for worker.stop in drains */
  caller?: CrossDomainCaller | null
  /** widen the pre-ready read allowlist (defaults: runtime.status/reconcile/shutdown, surface.describe, operation.get) */
  preReadyAllowedExtra?: string[]

  /** false → return after the endpoint is published, reconcile in background */
  awaitReady?: boolean
  installSignalHandlers?: boolean
  /** test seams */
  exitProcess?: (code: number) => void
  log?: (line: Record<string, unknown>) => void
  collectionEnabled?: boolean
  packsRoot?: string
}

export interface MahasdHandle {
  readonly endpoint: string
  readonly endpointFile: ServiceEndpointFile
  readonly lifecycle: MahasdLifecycle
  readiness(): ReadinessSnapshot
  status(): RuntimeStatusReport
  reconcile(scope?: ReconcileScope): Promise<ReconcileReport>
  /** programmatic operator shutdown — same record the runtime.shutdown op writes */
  shutdown(
    mode: ShutdownMode,
    opts?: { timeoutBudgetMs?: number; reason?: string }
  ): { operationId: string; mode: string; state: string }
  /** drop this service leaving executions running (leave-executions) */
  close(): Promise<void>
}

function defaultLog(line: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify(line) + '\n')
  } catch {
    /* a daemon stays quiet on a dead stdout — never crashes on logging */
  }
}

function credentialFields(credential: unknown): {
  kind?: string
  credentialId?: string
  secret?: string
} {
  if (typeof credential !== 'object' || credential === null) return {}
  return credential as { kind?: string; credentialId?: string; secret?: string }
}

function unauthenticated(message: string): never {
  throw mahasError('UNAUTHENTICATED', message)
}

async function lazyDefault<T>(label: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer()
  } catch (err) {
    throw new BootstrapError(
      'IO',
      `${label} is not linked yet (promised by a parallel IMP) — provide it via startMahasd opts: ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// ---------------------------------------------------------------------------
// startMahasd — the composition root IMP-30 calls
// ---------------------------------------------------------------------------

export async function startMahasd(opts: MahasdOptions = {}): Promise<MahasdHandle> {
  const log = opts.log ?? defaultLog
  const configDir =
    opts.configDir ??
    process.env.MAHAS_CONFIG_DIR ??
    join(process.env.HOME ?? '/', '.config', 'mahas')
  const paths = lifecyclePaths(configDir)
  const dbPath = opts.dbPath ?? paths.db
  const socketPath = opts.endpoint ?? paths.socket
  const protocolVersion = opts.protocolVersion ?? MAHASD_PROTOCOL_VERSION
  const launchNonce = randomUUID()
  const exitProcess = opts.exitProcess ?? ((code: number) => process.exit(code))

  // 1. crash-loop admission — recent failed boots throttle this start
  const cl = await checkCrashLoop(paths.bootJournal, opts.crashLoop ?? DEFAULT_CRASH_LOOP)
  if (!cl.admit) {
    throw new BootstrapError(
      'CRASH_LOOP',
      `mahasd refused to start: ${cl.recentFailures} failed boots in the admission window`
    )
  }
  await recordBootMarker(paths.bootJournal, 'boot', launchNonce)

  // F-008: a REFUSED start is not a crash. Every refusal from here until
  // readiness settles the boot marker ('refused'), so the crash-loop window
  // counts only real failures (a process that died before publishing ready).
  const refuseBoot = async (): Promise<void> => {
    await recordBootMarker(paths.bootJournal, 'refused', launchNonce).catch(() => {})
  }

  // 2. single-writer lock — refuses live duplicates and protocol mismatches.
  //    F-015: the lock belongs to the DB FILE (see singleWriterLockPath), so
  //    two config dirs aiming at one DB still exclude each other.
  const identity = collectProcessIdentity()
  const lockPath = singleWriterLockPath(dbPath)
  let lock: ServiceLock
  try {
    lock = await acquireServiceLock(lockPath, protocolVersion, identity)
  } catch (err) {
    await refuseBoot()
    throw err
  }

  const fail = async (err: unknown): Promise<never> => {
    await lock.release().catch(() => {})
    await refuseBoot()
    throw err
  }

  // 3. open the control DB (schema owned by IMP-03's openControlDb)
  const openDb =
    opts.openDb ??
    (await lazyDefault('mahas-runtime storage layer', async () => {
      const m = await import('./storage/db.ts')
      return m.openControlDb as OpenDbFn
    }).catch((e) => e as Error))
  if (openDb instanceof Error) return fail(openDb)
  const withTx =
    opts.withTx ??
    (await lazyDefault('mahas-runtime withTx', async () => {
      const m = await import('./storage/db.ts')
      return m.withTx as WithTxFn
    }).catch((e) => e as Error))
  if (withTx instanceof Error) return fail(withTx)

  let db: DatabaseSync
  try {
    db = openDb(dbPath)
  } catch (err) {
    return fail(new BootstrapError('IO', `cannot open control DB ${dbPath}: ${String(err)}`))
  }

  const closeDb = (): void => {
    try {
      db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
    } catch {
      /* checkpoint failure is logged by sqlite; close still proceeds */
    }
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }

  // 3.5 in-DB liveness fence (F-015 part 2) — belt & braces for different
  // path spellings of the same DB file (e.g. symlink): the file lock above
  // keys on a path string and can miss when two spellings resolve to one
  // inode. Any runtime_instances row in 'starting'/'ready' whose recorded
  // process is live or unverifiable means a writer may still be serving —
  // refuse instead of split-brain. Dead rows are stale history;
  // acquireControllerEpoch/markPriors below fences them.
  try {
    const actives = db
      .prepare(
        `SELECT id, controller_epoch, process_identity_json FROM runtime_instances WHERE state IN ('starting','ready')`
      )
      .all() as Array<{ id: string; controller_epoch: number; process_identity_json: string }>
    for (const row of actives) {
      let recorded: { pid: number; birthEvidence?: string; bootId?: string } | undefined
      try {
        recorded = JSON.parse(row.process_identity_json) as {
          pid: number
          birthEvidence?: string
          bootId?: string
        }
      } catch {
        recorded = undefined
      }
      if (!recorded || typeof recorded.pid !== 'number') {
        await fail(
          new BootstrapError(
            'LOCK_UNVERIFIABLE',
            `runtime instance ${row.id} (epoch ${row.controller_epoch}) has an unreadable process identity — refusing to start`,
            { instanceId: row.id }
          )
        )
        throw new Error('unreachable: fail() never returns')
      }
      const v = verdictForProcess(recorded as ProcessIdentity)
      if (v === 'alive') {
        await fail(
          new BootstrapError(
            'ALREADY_RUNNING',
            `runtime instance ${row.id} (epoch ${row.controller_epoch}) is live (pid ${recorded.pid}) — refusing to start a second writer on ${dbPath}`,
            { instanceId: row.id }
          )
        )
      }
      if (v === 'unverifiable') {
        await fail(
          new BootstrapError(
            'LOCK_UNVERIFIABLE',
            `runtime instance ${row.id} (epoch ${row.controller_epoch}) is unverifiable (pid ${recorded.pid} answers but birth evidence is inconclusive) — refusing to start`,
            { instanceId: row.id }
          )
        )
      }
    }
  } catch (err) {
    if (err instanceof BootstrapError) throw err
    // e.g. fresh DB without the table yet — not a fence signal; proceed.
  }

  // 4. endpoint assessment — a live same-service endpoint is never hijacked
  const existingEndpoint = await readEndpointFile(paths.endpointFile)
  const verdict = assessExistingService(existingEndpoint, protocolVersion)
  if (verdict === 'live-service' || verdict === 'version-mismatch' || verdict === 'unverifiable') {
    await fail(
      new BootstrapError(
        verdict === 'version-mismatch' ? 'VERSION_MISMATCH' : 'ALREADY_RUNNING',
        `endpoint file ${paths.endpointFile} verdict '${verdict}' — refusing to start`,
        { existing: existingEndpoint }
      )
    )
  }

  // 5. lifecycle + controller epoch (fences off past-generation acks/writes)
  const endpointFile = buildEndpointFile(socketPath, protocolVersion, identity, launchNonce)
  const connectHost =
    opts.connectHost ??
    (await lazyDefault('execution-host client', async () => {
      const m = await import('./hostClient.ts')
      return m.connectHost as ConnectHostFn
    }).catch((e) => e as Error))
  if (connectHost instanceof Error) {
    // no host client → hosts will simply be unreachable at reconcile time;
    // honest degraded start, not a boot failure
    log({ t: 'mahasd.host-client-missing', detail: String(connectHost.message) })
  }
  // host connector is replaced by the composition's lease-fenced session
  // once composeRuntime() has attached (see step 6) — lifecycle/reconcile
  // then shares the same authenticated connection instead of dialing anew.
  let hostConnector: ConnectHostFn =
    connectHost instanceof Error ? unreachableConnectHost(connectHost) : connectHost
  const lifecycle = new MahasdLifecycle({
    db,
    withTx,
    connectHost: (endpoint) => hostConnector(endpoint),
    caller: opts.caller ?? null,
    now: () => Date.now(),
    log,
    defaultDrainBudgetMs: opts.defaultDrainBudgetMs ?? 15_000,
    hostProbeTimeoutMs: opts.hostProbeTimeoutMs ?? 5_000,
    controllerIdentity: identity,
    endpointIncarnation: endpointFile.endpointIncarnation
  })
  lifecycle.acquireControllerEpoch(endpointFile.endpointIncarnation)
  lifecycle.readiness.mark('db-opened')
  lifecycle.markPriors((identity) => verdictForProcess(identity as ProcessIdentity))

  // 6. registry + ops + the readiness gate around dispatch
  // Default composition = the real domain registry (IMP-30). An injected
  // registry (tests, alternate harness) keeps the null-registry fallback.
  let registry: RegistryLike
  let composed: ComposedRuntime | null = null
  if (opts.registry) {
    registry = opts.registry
  } else {
    try {
      const { composeRuntime } = await import('./composition.ts')
      const runtime = await composeRuntime({
        db,
        configDir,
        endpoint: socketPath,
        controllerEpoch: lifecycle.epoch,
        controllerIdentity: identity,
        collectionEnabled: opts.collectionEnabled,
        packsRoot: opts.packsRoot,
        log
      })
      composed = runtime
      registry = runtime.registry as unknown as RegistryLike
      hostConnector = (endpoint) => runtime.hostClientByEndpoint(endpoint)
      lifecycle.deps.caller = (operation, payload, expectedRevisions) =>
        makeCaller(runtime.registry, {
          principalId: 'operator-local' as AuthenticatedContext['principalId'],
          controllerEpoch: lifecycle.epoch as AuthenticatedContext['controllerEpoch'],
          grantRevisions: currentGrantRevisions(db, 'operator-local'),
          transportSessionId: `mahasd-drain:${process.pid}`
        })(operation, payload, expectedRevisions)
      log({
        t: 'mahasd.composed',
        operations: [...OPERATION_NAMES].filter((name) => name !== 'host.hello').length,
        host: composed.localHost?.hostId ?? null
      })
    } catch (err) {
      closeDb()
      return fail(
        new BootstrapError(
          'IO',
          `runtime composition failed: ${err instanceof Error ? err.message : String(err)}`
        )
      )
    }
  }
  const opSpecs = new Map<string, OperationSpec>()
  const gated: RegistryLike = {
    register: (spec, handler) => {
      opSpecs.set(spec.name, spec)
      return registry.register(spec, handler)
    },
    dispatch: async (ctx, req) => {
      const spec = opSpecs.get(req.operation)
      lifecycle.readiness.check(req.operation, spec?.mutation ?? true)
      return registry.dispatch(ctx, req)
    },
    describe: registry.describe?.bind(registry)
  }
  const postCommitQueue: Array<() => void> = []
  const recoveryDeps = composed?.recoveryDeps
  registerRuntimeOps(gated, {
    lifecycle,
    enqueueAfterCommit: (fn) => {
      postCommitQueue.push(fn)
      setImmediate(() => {
        const job = postCommitQueue.shift()
        job?.()
      })
    },
    reconcileExecutions: recoveryDeps
      ? (db, ctx, scope) => reconcileExecutions(recoveryDeps, db, ctx, scope)
      : undefined
  })
  opts.registerDomainOps?.(gated)
  lifecycle.readiness.allowPreReady(opts.preReadyAllowedExtra ?? [])

  // 7. serve + publish endpoint file — mutation gate stays closed until reconcile
  // Two sockets, two authenticators (C-ACCESS). Client principalId/memberId/
  // executionId are never copied into context.
  const authenticateOperator: AuthenticateFn = (credential) => {
    const c = credentialFields(credential)
    if (c.kind !== 'operator') {
      unauthenticated('operator endpoint requires an operator credential')
    }
    return {
      principalId: 'operator-local' as AuthenticatedContext['principalId'],
      controllerEpoch: lifecycle.epoch as AuthenticatedContext['controllerEpoch'],
      grantRevisions: currentGrantRevisions(db, 'operator-local'),
      transportSessionId: randomUUID()
    }
  }
  const authenticateWorker: AuthenticateFn = (credential) => {
    const c = credentialFields(credential)
    if (c.kind !== 'worker') {
      unauthenticated('worker endpoint requires a worker credential')
    }
    if (typeof c.credentialId !== 'string' || typeof c.secret !== 'string') {
      unauthenticated('worker credential requires credentialId and secret')
    }
    const binding = authenticateWorkerCredential(db, c.credentialId, c.secret)
    if (!binding) unauthenticated('credential refused')
    return {
      ...bindingToContextFields(binding),
      controllerEpoch: lifecycle.epoch as AuthenticatedContext['controllerEpoch'],
      transportSessionId: randomUUID()
    }
  }
  const operatorAuth = opts.authenticate ?? authenticateOperator
  const workerAuth = opts.authenticate ?? authenticateWorker
  const serveRpc =
    opts.serveRpc ??
    (await lazyDefault('mahas-runtime rpc transport', async () => {
      const m = await import('./rpc/index.ts')
      return m.serveRpc as unknown as ServeRpcFn
    }).catch((e) => e as Error))
  if (serveRpc instanceof Error) {
    closeDb()
    return fail(serveRpc)
  }
  const workerSocket = mahasdWorkerEndpoint(configDir)
  let operatorServer: RpcServerLike | null = null
  let workerServer: RpcServerLike | null = null
  const bind = async (endpoint: string, auth: AuthenticateFn): Promise<RpcServerLike> => {
    const server = serveRpc(gated, endpoint, auth)
    if (server.ready) {
      try {
        await server.ready
      } catch (err) {
        await server.close().catch(() => {})
        throw new BootstrapError(
          'IO',
          `cannot bind mahasd endpoint ${endpoint}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    return server
  }
  try {
    operatorServer = await bind(socketPath, operatorAuth)
    if (workerSocket !== socketPath) {
      workerServer = await bind(workerSocket, workerAuth)
    }
  } catch (err) {
    await operatorServer?.close().catch(() => {})
    await workerServer?.close().catch(() => {})
    closeDb()
    return fail(err)
  }
  await publishEndpointFile(paths.endpointFile, endpointFile)
  lifecycle.readiness.mark('endpoint-published')
  log({
    t: 'mahasd.endpoint-published',
    endpoint: socketPath,
    workerEndpoint: workerServer?.endpoint ?? null,
    pid: identity.pid,
    epoch: lifecycle.epoch,
    incarnation: endpointFile.endpointIncarnation
  })

  // 8. teardown — the only way out after the shutdown record completes
  let tornDown = false
  let teardownFinished = false
  const teardown = async (): Promise<void> => {
    if (tornDown) return
    tornDown = true
    lifecycle.readiness.setState('stopping')
    await composed?.close()
    log({ t: 'mahasd.teardown', endpoint: socketPath })
    try {
      if (lifecycle.instanceId) {
        withTx(db, (tx) => {
          tx.prepare(`UPDATE runtime_instances SET state='stopped' WHERE id=?`).run(
            lifecycle.instanceId
          )
        })
      }
    } catch {
      /* instance row best-effort */
    }
    await operatorServer?.close().catch(() => {})
    await workerServer?.close().catch(() => {})
    // let the last response flush to the client before we vanish
    await new Promise((r) => setTimeout(r, 150))
    closeDb()
    await removeEndpointFile(paths.endpointFile, endpointFile.endpointIncarnation)
    await lock.release()
    await recordBootMarker(paths.bootJournal, 'stopped', launchNonce).catch(() => {})
    lifecycle.readiness.setState('stopped')
    log({ t: 'mahasd.stopped', endpoint: socketPath })
    teardownFinished = true
    exitProcess(0)
  }
  lifecycle.setTeardownHook(() => teardown())

  // 9. startup reconcile — blocks writable readiness until the pass FINISHES
  const reconcilePromise = lifecycle.startupReconcile().then(
    async (report) => {
      await composed?.start(operatorAuth)
      log({
        t: 'mahasd.ready',
        epoch: lifecycle.epoch,
        unresolved: report.unresolvedResources.length,
        blockers: report.unresolvedResources.map((u) => `${u.kind}:${u.id}`)
      })
      void recordBootMarker(paths.bootJournal, 'ready', launchNonce).catch(() => {})
      return report
    },
    (err) => {
      log({
        t: 'mahasd.reconcile-blocked',
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  )
  if (opts.awaitReady !== false) await reconcilePromise

  // 10. programmatic surface
  const handle: MahasdHandle = {
    endpoint: socketPath,
    endpointFile,
    lifecycle,
    readiness: () => lifecycle.readiness.snapshot(),
    status: () => lifecycle.statusReport(db),
    reconcile: (scope) => lifecycle.reconcile(scope ?? {}),
    shutdown: (mode, sopts) => {
      const { req, stages, residuals } = withTx(db, (tx) =>
        lifecycle.initiateShutdown(tx, {
          mode,
          timeoutBudgetMs: sopts?.timeoutBudgetMs,
          reason: sopts?.reason
        })
      )
      lifecycle.scheduleShutdown(req, stages, residuals, (fn) => setImmediate(fn))
      return { operationId: req.operationId, mode: req.mode, state: 'in-progress' }
    },
    close: async () => {
      if (!lifecycle.isDraining) {
        handle.shutdown('leave-executions', { reason: 'handle.close' })
      }
      // teardown resolves when the daemon has fully stopped
      while (!teardownFinished) await new Promise((r) => setTimeout(r, 10))
    }
  }

  // signals = an unrequested external stop — honestly recorded as
  // leave-executions (never drain: nobody chose to stop the executions)
  if (opts.installSignalHandlers !== false) {
    const onSignal = (sig: string): void => {
      if (lifecycle.isDraining || tornDown) return
      log({ t: 'mahasd.signal', signal: sig })
      try {
        handle.shutdown('leave-executions', { reason: `signal:${sig}` })
      } catch (err) {
        log({ t: 'mahasd.signal-shutdown-failed', error: String(err) })
      }
    }
    process.on('SIGTERM', () => onSignal('SIGTERM'))
    process.on('SIGINT', () => onSignal('SIGINT'))
  }

  log({ t: 'mahasd.started', endpoint: socketPath, pid: identity.pid, epoch: lifecycle.epoch })
  return handle
}

function unreachableConnectHost(cause: Error): ConnectHostFn {
  return () => Promise.reject(cause)
}

/**
 * placeholder registry when the integrator supplies none — registers ops and
 * dispatches them directly WITHOUT the admission pipeline (IMP-11 owns real
 * admission: authorize → idempotency → tx → receipt). Marked honestly: the
 * receipt it returns says 'committed' only because the handler committed;
 * there is no receipt persistence here. Smoke/dev path only.
 */
export function makeNullRegistry(): RegistryLike {
  const handlers = new Map<string, { spec: OperationSpec; handler: OperationHandler }>()
  return {
    register(spec, handler) {
      handlers.set(spec.name, { spec, handler })
    },
    async dispatch(_ctx, req) {
      const found = handlers.get(req.operation)
      if (!found) {
        return {
          operationId: req.operationId,
          fingerprint: '',
          status: 'rejected',
          error: {
            code: 'UNAVAILABLE_OPERATION',
            message: `${req.operation}: not registered`,
            retry: 'none'
          },
          effects: [],
          domainRevision: 0,
          eventCursor: 0
        }
      }
      try {
        const result = await found.handler(nullTxn(_ctx), req.payload)
        return {
          operationId: req.operationId,
          fingerprint: '',
          status: 'committed',
          result,
          effects: [],
          domainRevision: 0,
          eventCursor: 0
        }
      } catch (err) {
        const e = err as { code?: string; message?: string; retry?: string }
        return {
          operationId: req.operationId,
          fingerprint: '',
          status: 'rejected',
          error: {
            code: (e.code ?? 'UNKNOWN') as CommandReceipt['error'] extends { code: infer C }
              ? C
              : never,
            message: e.message ?? String(err),
            retry: (e.retry ?? 'none') as 'none'
          },
          effects: [],
          domainRevision: 0,
          eventCursor: 0
        }
      }
    }
  }
}

/** dev/smoke path only: handlers get a TxnContext-shaped double whose DB is
 *  a poisoned null — any real SQL access throws instead of corrupting data. */
function nullTxn(_ctx: AuthenticatedContext): TxnContext {
  return {
    db: nullDb,
    ctx: _ctx,
    emitEvent: (): void => {},
    intendEffect: (): string => ''
  }
}

const nullDb = null as unknown as DatabaseSync

// ---------------------------------------------------------------------------
// direct execution — the daemon entrypoint
// ---------------------------------------------------------------------------

function usage(): never {
  process.stderr.write(
    'usage: mahasd [--config-dir <dir>] [--endpoint <path>] [--db <path>] [--help]\n' +
      '  defaults: config-dir $MAHAS_CONFIG_DIR or ~/.config/mahas\n' +
      '  socket    <config-dir>/mahasd.sock · db <config-dir>/mahas.sqlite\n'
  )
  process.exit(2)
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url.endsWith(entry) || entry.endsWith('main.ts') || entry.endsWith('main.js')
}

if (isDirectRun()) {
  const argv = process.argv.slice(2)
  const opts: MahasdOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config-dir' && argv[i + 1]) opts.configDir = argv[++i]
    else if (a === '--endpoint' && argv[i + 1]) opts.endpoint = argv[++i]
    else if (a === '--db' && argv[i + 1]) opts.dbPath = argv[++i]
    else if (a === '--help' || a === '-h') usage()
    else usage()
  }
  try {
    await startMahasd(opts)
  } catch (err) {
    const e = err as BootstrapError
    defaultLog({
      t: 'mahasd.boot-failed',
      code: e instanceof BootstrapError ? e.code : 'IO',
      error: e instanceof Error ? e.message : String(err)
    })
    process.exit(e instanceof BootstrapError && e.code === 'ALREADY_RUNNING' ? 3 : 1)
  }
}
