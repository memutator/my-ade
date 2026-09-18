// mahas-runtime/composition.ts — the mahasd composition root (IMP-30).
//
// Everything the control plane actually runs is assembled here: one
// OperationRegistry with every implemented C-* handler registered, the
// kernel boundaries (storage/access), the cross-domain makeCaller, the
// execution-host session (hello + controller lease), and the file-backed
// secrets the operator/desktop clients share.
//
// Design rules this file obeys:
//   · domains never import sibling internals — this root is the one place
//     that sees them all, and it wires them through their published seams;
//   · every host mutation travels with the CURRENT controller epoch and
//     lease fence token (host.ts requireLeaseProof) — the session wrapper
//     is the only place those are attached;
//   · an absent execution-host is an honest degraded start (log + null),
//     never a fabricated host row;
//   · unimplemented operations are never registered, so the surface cannot
//     advertise them (instruction §4.3).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../mahas-contracts/src/index.ts'
import {
  OPERATION_NAMES,
  createOperationRegistry,
  makeCaller,
  type OperationRegistry
} from './api/registry.ts'
import * as accessBoundary from './access/authorize.ts'
import { registerAccessOperations } from './access/operations.ts'
import * as storage from './storage/db.ts'
import { registerModelOps } from './model/ops.ts'
import { registerDiscoveryOps } from './discovery/index.ts'
import { registerRealizationOps } from './realization/index.ts'
import { registerContextOps } from './realization/compiler.ts'
import { registerMaterializeOps } from './realization/effective-context.ts'
import { materializeBundle } from './realization/materializer.ts'
import {
  registerCoordinationOps,
  registerDispatchOps,
  buildTaskEnvelope,
  buildCoordinationEnvelope
} from './coordination/index.ts'
import { registerMailOps } from './mail/index.ts'
import { registerLaunchOps, registerJoinOps } from './launch/index.ts'
import { registerRecoveryOps } from './recovery/index.ts'
import { registerResourceOps } from './resources/mod.ts'
import { registerObservationOps } from './observation/index.ts'
import { registerMaintenanceOps } from './maintenance/impact-service.ts'
import { registerClientOps } from './client/ops.ts'
import type { ClientOpsRegistry } from './client/types.ts'
import { registerBackupOps } from './operations/backup.ts'
import { registerOperationGet } from './rpc/operation-get.ts'
import {
  HOST_PROTOCOL_VERSION,
  helloHost,
  readHostEndpoint,
  type HostClient
} from './hostClient.ts'

export interface ComposeOptions {
  db: DatabaseSync
  /** config dir that namespaces sockets, secrets and backups */
  configDir: string
  /** this mahasd's socket (advertised to workers/CLI via connection files) */
  endpoint: string
  /** controller epoch already claimed by MahasdLifecycle.acquireControllerEpoch */
  controllerEpoch: number
  /** process identity of this mahasd (lease claimant + endpoint publication) */
  controllerIdentity: {
    pid: number
    birthEvidence?: string
    bootId?: string
    label?: string
  }
  /** default <configDir>/execution-host.sock */
  hostEndpoint?: string
  log?: (line: Record<string, unknown>) => void
}

export interface ComposedRuntime {
  registry: OperationRegistry
  /** local execution-host attachment, or null when none verifiably exists */
  localHost: { hostId: string; endpoint: string } | null
  /** register the local host (hello + acquire) — safe to call more than once */
  ensureLocalHost(): Promise<{ hostId: string; endpoint: string } | null>
  /** a lease-fenced client for one mirrored host; mutations carry the fence */
  hostClient(hostId: string): Promise<HostClient>
  /** the recovery boundary's raw-endpoint resolver */
  hostClientByEndpoint(endpoint: string): Promise<HostClient>
  close(): void
}

interface HostSession {
  hostId: string
  endpoint: string
  client: HostClient
  controllerEpoch: number
  leaseProof: string
}

/** wrap a raw host client so every mutation carries epoch + lease fence */
function fenced(session: HostSession): HostClient {
  return {
    call<T = unknown>(
      operation: string,
      payload?: unknown,
      opts?: { [key: string]: unknown }
    ): Promise<T> {
      return session.client.call<T>(operation, payload, {
        ...(opts as object),
        controllerEpoch: session.controllerEpoch,
        leaseProof: session.leaseProof
      })
    },
    close: () => session.client.close()
  }
}

/**
 * File-backed HMAC secret for selection tokens / page cursors. Created on
 * first boot with mode 0600; the file's path proves nothing — the token's
 * signature does. Rotating the value invalidates outstanding tokens.
 */
function selectionTokenSecret(configDir: string): { secret: Uint8Array; keyId: string } {
  const path = join(configDir, 'selection-token.key')
  mkdirSync(configDir, { recursive: true })
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort on exotic filesystems */
  }
  const raw = readFileSync(path, 'utf8').trim()
  return { secret: new TextEncoder().encode(raw), keyId: 'local-1' }
}

/**
 * Deployment bootstrap: the local operator principal + its standing grant.
 * The v1 trust boundary is the 0600 operator socket/credential file; this
 * seed only gives that authenticated operator principal a real grant row so
 * admission's "no grant covers this" rule stays honest (no special-case
 * bypass in authorize). Idempotent; revoked seeds are never re-created.
 */
function seedLocalOperator(db: DatabaseSync): void {
  const principalId = 'operator-local'
  const grantId = 'grant-operator-local'
  const existing = db.prepare('SELECT id FROM principals WHERE id=?').get(principalId) as
    | { id: string }
    | undefined
  if (!existing) {
    db.prepare("INSERT INTO principals(id,kind,status) VALUES(?,'operator','active')").run(principalId)
  }
  const grant = db.prepare('SELECT id FROM grants WHERE id=?').get(grantId) as
    | { id: string }
    | undefined
  if (!grant) {
    db.prepare(
      `INSERT INTO grants(id, revision, kind, principal_id, parent_grant_id, policy_id, policy_revision, expires_at, revoked_at, scope_json, actions_json)
       VALUES(?, 1, 'assignment', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
    ).run(
      grantId,
      principalId,
      JSON.stringify({ targets: [{ kind: '*', id: '*' }] }),
      JSON.stringify([...OPERATION_NAMES])
    )
  }
}

/** the same file the operator-auth RPC path reads (v1 local trust) */
function publishOperatorConnection(configDir: string, endpoint: string): void {
  const path = join(configDir, 'operator-connection.json')
  if (existsSync(path)) return
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ version: 1, endpoint, credential: { kind: 'operator' } }, null, 2),
    { mode: 0o600 }
  )
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort */
  }
}

export async function composeRuntime(opts: ComposeOptions): Promise<ComposedRuntime> {
  const { db, configDir, controllerEpoch, controllerIdentity } = opts
  const log = opts.log ?? (() => {})
  const hostEndpoint = opts.hostEndpoint ?? join(configDir, 'execution-host.sock')
  const sessions = new Map<string, HostSession>()

  /* ── execution-host attachment (before registration: resource placement
        needs the default host id) ─────────────────────────────────────── */

  async function attachHost(endpoint: string): Promise<HostSession | null> {
    const published = readHostEndpoint(endpoint)
    if (!published) {
      log({ t: 'mahasd.host-absent', endpoint, detail: 'no endpoint file — not attached' })
      return null
    }
    let client: HostClient | null = null
    try {
      const { client: raw, hello } = await helloHost(endpoint, {
        controllerIdentity,
        supportedVersions: [HOST_PROTOCOL_VERSION],
        endpointFile: published
      })
      client = raw
      const lease = (await raw.call('host.acquire', {
        controllerEpoch,
        controllerProcessIdentity: controllerIdentity,
        ttlMs: 120_000
      })) as { epoch: number; leaseProof: string }
      const session: HostSession = {
        hostId: hello.hostId,
        endpoint,
        client: raw,
        controllerEpoch,
        leaseProof: lease.leaseProof
      }
      sessions.set(session.hostId, session)
      // control mirror — upsert, never delete/reinsert (FKs point here)
      db.prepare(
        `INSERT INTO execution_hosts(id, incarnation, protocol_version, state, identity_json)
         VALUES(?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           incarnation=excluded.incarnation,
           protocol_version=excluded.protocol_version,
           state='live',
           identity_json=excluded.identity_json`
      ).run(
        session.hostId,
        hello.hostIncarnation,
        String(HOST_PROTOCOL_VERSION),
        'live',
        JSON.stringify({
          endpoint,
          hostIncarnation: hello.hostIncarnation,
          endpointIncarnation: published.endpointIncarnation,
          launchNonce: published.launchNonce,
          attachedAt: Date.now()
        })
      )
      log({ t: 'mahasd.host-attached', hostId: session.hostId, endpoint, leaseEpoch: lease.epoch })
      return session
    } catch (err) {
      client?.close()
      log({
        t: 'mahasd.host-attach-failed',
        endpoint,
        detail: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  }

  const localSession = await attachHost(hostEndpoint)

  /* ── registry + kernel ────────────────────────────────────────────────── */

  seedLocalOperator(db)
  // the access kernel must be bound to THIS control DB before any handler
  // calls authorize()/decide() (authorize.ts refuses unbound: CONTROL_UNAVAILABLE)
  accessBoundary.bindAccessDb(db)
  const registry = await createOperationRegistry(db)
  const serviceCtx = (): AuthenticatedContext => ({
    principalId: 'service:mahasd' as never,
    controllerEpoch: controllerEpoch as never,
    grantRevisions: {},
    transportSessionId: `mahasd:${process.pid}`
  })
  const caller = (
    ctx: AuthenticatedContext,
    operation: string,
    payload?: unknown
  ): Promise<unknown> => makeCaller(registry, ctx)(operation, payload)

  async function hostClient(hostId: string): Promise<HostClient> {
    const existing = sessions.get(hostId)
    if (existing) return fenced(existing)
    // not attached yet — the mirror tells us where it lives
    const row = db.prepare('SELECT identity_json FROM execution_hosts WHERE id=?').get(hostId) as
      { identity_json?: string } | undefined
    let endpoint: string | null = null
    try {
      endpoint = row?.identity_json
        ? ((JSON.parse(row.identity_json) as { endpoint?: string }).endpoint ?? null)
        : null
    } catch {
      endpoint = null
    }
    const session = await attachHost(endpoint ?? hostEndpoint)
    if (!session || session.hostId !== hostId) {
      throw {
        code: 'CONTROL_UNAVAILABLE',
        message: `execution host ${hostId} is not attachable${endpoint ? ` at ${endpoint}` : ''}`,
        retry: 'reconcile'
      }
    }
    return fenced(session)
  }

  async function hostClientByEndpoint(endpoint: string): Promise<HostClient> {
    const known = [...sessions.values()].find((s) => s.endpoint === endpoint)
    if (known) return fenced(known)
    const session = await attachHost(endpoint)
    if (!session) {
      throw {
        code: 'CONTROL_UNAVAILABLE',
        message: `execution host at ${endpoint} is not attachable`,
        retry: 'reconcile'
      }
    }
    return fenced(session)
  }

  /* ── model / discovery / realization / access ─────────────────────────── */

  registerModelOps(registry)
  const token = selectionTokenSecret(configDir)
  registerDiscoveryOps(registry, {
    authorize: (ctx, operation, targets) => accessBoundary.authorize(ctx, operation, targets),
    decide: (ctx, operation, targets) => accessBoundary.decide(ctx, operation, targets),
    tokenSecret: token.secret,
    tokenKeyId: token.keyId
  })
  registerRealizationOps(registry)
  registerContextOps(registry)
  registerMaterializeOps(registry, {
    caller: (operation, payload, expectedRevisions) =>
      makeCaller(registry, serviceCtx())(operation, payload, expectedRevisions)
  })
  registerAccessOperations(registry as unknown as Parameters<typeof registerAccessOperations>[0])

  /* ── coordination / mail ──────────────────────────────────────────────── */

  registerCoordinationOps(registry)
  registerDispatchOps(registry)
  registerMailOps(registry, {
    authorize: (ctx, operation, targets) => accessBoundary.authorize(ctx, operation, targets),
    putContentBlob: storage.putContentBlob,
    getContentBlob: storage.getContentBlob,
    appendDomainEvent: storage.appendDomainEvent,
    sha256Hex: storage.sha256Hex,
    caller: (operation, payload) => caller(serviceCtx(), operation, payload)
  })

  /* ── launch / recovery ────────────────────────────────────────────────── */

  registerLaunchOps(registry, {
    call: caller,
    host: (hostId: string) => hostClient(hostId),
    materialize: async (req) => {
      const result = await materializeBundle(
        {
          db,
          caller: (operation, payload, expectedRevisions) =>
            makeCaller(registry, serviceCtx())(operation, payload, expectedRevisions),
          executionRootsDir: join(configDir, 'executions')
        },
        {
          executionId: req.executionId as never,
          bundleDigest: req.bundleDigest as never,
          workspaceId: req.workspaceId as never
        }
      )
      return {
        executionRoot: result.executionRoot,
        manifestDigest: result.manifestDigest,
        files: result.files as never,
        residuals: result.residualResources as never
      }
    },
    ensureEnvelope: (txnDb, req) =>
      (req.assignment.kind === 'task'
        ? buildTaskEnvelope(txnDb, {
            assignmentId: req.assignment.id,
            assignmentRevision: req.assignment.revision,
            taskId: (req.assignment.taskId ?? '') as string,
            taskRevision: (req.assignment.taskRevision ?? 0) as number
          })
        : buildCoordinationEnvelope(txnDb, {
            assignmentId: req.assignment.id,
            assignmentRevision: req.assignment.revision,
            roleContext: {
              roleId: req.member.roleId,
              implementationId: req.member.implementationId,
              implementationRevision: req.member.implementationRevision
            }
          })) as never,
    appendDomainEvent: storage.appendDomainEvent,
    digest: storage.sha256Hex,
    newId: (kind: string) => `${kind}-${randomUUID()}`,
    now: () => Date.now(),
    endpoint: opts.endpoint
  })
  registerJoinOps(registry, { now: () => Date.now() })
  registerRecoveryOps(registry, {
    withTx: storage.withTx,
    appendDomainEvent: storage.appendDomainEvent,
    sha256Hex: storage.sha256Hex,
    authorize: (ctx, operation, targets) => accessBoundary.authorize(ctx, operation, targets),
    connectHost: (endpoint) => hostClientByEndpoint(endpoint),
    makeCaller: (reg, ctx) => makeCaller(reg, ctx) as never,
    now: () => Date.now(),
    newId: () => randomUUID()
  })

  /* ── resources / observation / maintenance / client / ops ─────────────── */

  registerResourceOps(registry, {
    hostClient: (hostId) => hostClient(hostId as string),
    defaultHostId: (localSession?.hostId ?? '') as never
  })
  registerObservationOps(registry, {
    now: () => Date.now(),
    epochStartedAt: Date.now(),
    sha256Hex: storage.sha256Hex,
    appendDomainEvent: storage.appendDomainEvent,
    authorize: (ctx, operation, targets) => accessBoundary.authorize(ctx, operation, targets)
  })
  registerMaintenanceOps(registry as never, {
    authorize: (ctx, operation, targets) => accessBoundary.authorize(ctx, operation, targets),
    call: (operation, payload) => caller(serviceCtx(), operation, payload)
  })
  registerClientOps(registry as unknown as ClientOpsRegistry, {
    host: {
      call: async <T>(operation: string, payload?: unknown): Promise<T> => {
        const session = localSession ?? (await attachHost(hostEndpoint)) ?? null
        if (!session) {
          throw {
            code: 'CONTROL_UNAVAILABLE',
            message: 'no execution-host attached',
            retry: 'reconcile'
          }
        }
        return fenced(session).call<T>(operation, payload)
      }
    },
    call: (operation, payload) => caller(serviceCtx(), operation, payload),
    authorize: (ctx, operation, targets) => accessBoundary.authorize(ctx, operation, targets),
    appendDomainEvent: storage.appendDomainEvent
  })
  registerBackupOps(registry, {
    openDb: storage.openControlDb,
    withTx: storage.withTx,
    sha256Hex: storage.sha256Hex,
    appendDomainEvent: storage.appendDomainEvent,
    putContentBlob: storage.putContentBlob,
    now: () => Date.now(),
    backupRoot: join(configDir, 'backups'),
    controlDbPath: join(configDir, 'mahas.sqlite'),
    hostDbPaths: () => [join(configDir, 'execution-host.sqlite')],
    externalBlobDir: join(configDir, 'content-blobs')
  })
  registerOperationGet(registry, {
    findReceipt: (txnDb, principalScope, operation, operationId) =>
      storage.findReceipt(txnDb, principalScope, operation, operationId)
  })

  publishOperatorConnection(configDir, opts.endpoint)

  return {
    registry,
    localHost: localSession
      ? { hostId: localSession.hostId, endpoint: localSession.endpoint }
      : null,
    async ensureLocalHost() {
      if (localSession) return { hostId: localSession.hostId, endpoint: localSession.endpoint }
      const session = await attachHost(hostEndpoint)
      return session ? { hostId: session.hostId, endpoint: session.endpoint } : null
    },
    hostClient,
    hostClientByEndpoint,
    close() {
      for (const s of sessions.values()) s.client.close()
      sessions.clear()
      accessBoundary.unbindAccessDb()
    }
  }
}
