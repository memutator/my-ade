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
import {
  HOST_OPERATION_NAMES,
  type AuthenticatedContext
} from '../../mahas-contracts/src/index.ts'
import {
  OPERATION_NAMES,
  createOperationRegistry,
  makeCaller,
  type OperationRegistry
} from './api/registry.ts'
import * as accessBoundary from './access/authorize.ts'
import { currentGrantRevisions } from './access/grant.ts'
import { registerAccessOperations } from './access/operations.ts'
import * as storage from './storage/db.ts'
import { registerModelOps } from './model/ops.ts'
import { registerDiscoveryOps, verifySelectionToken } from './discovery/index.ts'
import { registerRealizationOps } from './realization/index.ts'
import { registerContextOps } from './realization/compiler.ts'
import { registerMaterializeOps } from './realization/effective-context.ts'
import { materializeBundle } from './realization/materializer.ts'
import {
  registerCoordinationOps,
  registerDispatchOps,
  buildTaskEnvelope,
  buildCoordinationEnvelope,
  type VerifySelectionToken
} from './coordination/index.ts'
import { registerMailOps } from './mail/index.ts'
import { registerLaunchOps, registerJoinOps } from './launch/index.ts'
import { registerRecoveryOps } from './recovery/index.ts'
import type { RecoveryDeps } from './recovery/ports.ts'
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
  recoveryDeps: RecoveryDeps
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
  dead: boolean
}

/** wrap a raw host client so every mutation carries epoch + lease fence.
 *  close is a no-op — recovery/lifecycle must not drop the composition-owned socket. */
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
    close() {
      /* composition owns the socket; borrows must not close it */
    }
  }
}

/** syscall errnos that prove the socket died (never a host verdict). */
const TRANSPORT_ERRNOS: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOENT',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTCONN',
  'EBADF',
  'EIO'
])

/** transport-death phrasing from hostClient.ts ('host client closed',
 *  'execution-host connection closed', 'cannot connect …: connect
 *  ECONNREFUSED …') plus raw socket errors. */
const TRANSPORT_MESSAGE_RE =
  /ECONNREFUSED|ECONNRESET|EPIPE|ENOENT|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTCONN|socket hang up|connection (closed|reset|refused)|client closed|not connected|ended by the other party|closed/i

/**
 * True when the call failed because the transport died — the session's socket
 * can never succeed again. A named host verdict (STALE_EXECUTION,
 * SCOPE_DENIED, …) is a decision about this call, not the socket, so it never
 * counts: only the client-synthesized CONTROL_UNAVAILABLE transport code and
 * syscall errnos fall through to message matching.
 */
function isTransportError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message?: unknown }).message)
        : String(err)
  if (typeof code === 'string' && code !== 'CONTROL_UNAVAILABLE' && !TRANSPORT_ERRNOS.has(code)) {
    return false
  }
  if (typeof code === 'string' && TRANSPORT_ERRNOS.has(code)) return true
  return TRANSPORT_MESSAGE_RE.test(message)
}

/** mark the session dead when the underlying transport dies so callers re-attach */
function watchClient(
  raw: HostClient,
  session: HostSession,
  onDead?: (session: HostSession) => void
): HostClient {
  const markDead = (): void => {
    session.dead = true
    try {
      raw.close()
    } catch {
      /* already gone */
    }
    try {
      onDead?.(session)
    } catch {
      /* eviction is best-effort */
    }
  }
  return {
    async call<T = unknown>(
      operation: string,
      payload?: unknown,
      opts?: { [key: string]: unknown }
    ): Promise<T> {
      try {
        return await raw.call<T>(operation, payload, opts)
      } catch (err) {
        // Transport death kills the session (eager evict + close) so the next
        // lookup re-dials via attachHost. Host verdicts leave it live.
        if (isTransportError(err)) markDead()
        throw err
      }
    },
    close() {
      markDead()
    }
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

const OPERATOR_PRINCIPAL_ID = 'operator-local'
const OPERATOR_ASSIGNMENT_GRANT_ID = 'grant-operator-local'
const OPERATOR_PROVISIONING_GRANT_ID = 'grant-operator-local-provisioning'
const SERVICE_PRINCIPAL_ID = 'service:mahasd'
const SERVICE_GRANT_ID = 'grant-service-mahasd'

/** C-HOST names are execution-plane only — never part of an operator grant. */
function operatorActions(): string[] {
  const host = new Set<string>(HOST_OPERATION_NAMES as readonly string[])
  return OPERATION_NAMES.filter((n) => !host.has(n) && !n.startsWith('host.'))
}

/** internal makeCaller surface — workspace/context/claim ops materialize and launch need. */
const SERVICE_ACTIONS: readonly string[] = [
  'workspace.inspect',
  'workspace.prepare',
  'context.build',
  'context.inspect',
  'claim.handoff',
  'claim.release',
  'surface.describe',
  'operation.get'
]

function ensurePrincipal(db: DatabaseSync, id: string, kind: string): void {
  const existing = db.prepare('SELECT id FROM principals WHERE id=?').get(id) as
    | { id: string }
    | undefined
  if (!existing) {
    db.prepare('INSERT INTO principals(id,kind,status) VALUES(?,?,?)').run(id, kind, 'active')
  }
}

function upsertSeedGrant(
  db: DatabaseSync,
  row: { id: string; kind: string; principalId: string; scope: unknown; actions: readonly string[] }
): void {
  const existing = db.prepare('SELECT id, revoked_at FROM grants WHERE id=?').get(row.id) as
    | { id: string; revoked_at: number | null }
    | undefined
  if (existing?.revoked_at != null) return
  if (!existing) {
    db.prepare(
      `INSERT INTO grants(id, revision, kind, principal_id, parent_grant_id, policy_id, policy_revision, expires_at, revoked_at, scope_json, actions_json)
       VALUES(?, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
    ).run(row.id, row.kind, row.principalId, JSON.stringify(row.scope), JSON.stringify(row.actions))
    return
  }
  db.prepare('UPDATE grants SET kind=?, scope_json=?, actions_json=? WHERE id=?').run(
    row.kind,
    JSON.stringify(row.scope),
    JSON.stringify(row.actions),
    row.id
  )
}

/**
 * Deployment bootstrap: local operator principal + assignment grant (no
 * C-HOST names), a ProvisioningGrant so team.assign's checkProvisioning
 * finds a covering row, and a narrow service:mahasd principal/grant for
 * internal makeCaller. Idempotent; revoked seeds are never re-created.
 */
function seedLocalOperator(db: DatabaseSync): void {
  ensurePrincipal(db, OPERATOR_PRINCIPAL_ID, 'operator')
  ensurePrincipal(db, SERVICE_PRINCIPAL_ID, 'service')

  const wildcard = { targets: [{ kind: '*', id: '*' }] }
  upsertSeedGrant(db, {
    id: OPERATOR_ASSIGNMENT_GRANT_ID,
    kind: 'assignment',
    principalId: OPERATOR_PRINCIPAL_ID,
    scope: wildcard,
    actions: operatorActions()
  })
  // checkProvisioning reads grant.scope as ProvisioningScope (top-level
  // allowedRoleIds / placementScope). Nested `provisioning` satisfies the
  // access kernel. Empty placementScope.hostIds means any placement.
  upsertSeedGrant(db, {
    id: OPERATOR_PROVISIONING_GRANT_ID,
    kind: 'provisioning',
    principalId: OPERATOR_PRINCIPAL_ID,
    scope: {
      ...wildcard,
      placementScope: {},
      provisioning: {
        allowedRoleIds: ['*'],
        placementScope: [{ kind: '*', id: '*' }]
      }
    },
    // must be a superset of member assignment actions (child-within-parent)
    actions: operatorActions()
  })
  upsertSeedGrant(db, {
    id: SERVICE_GRANT_ID,
    kind: 'assignment',
    principalId: SERVICE_PRINCIPAL_ID,
    scope: wildcard,
    actions: SERVICE_ACTIONS
  })
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
      const prev = sessions.get(hello.hostId)
      if (prev) {
        prev.dead = true
        try {
          prev.client.close()
        } catch {
          /* replaced */
        }
        sessions.delete(hello.hostId)
      }
      const session: HostSession = {
        hostId: hello.hostId,
        endpoint,
        client: raw,
        controllerEpoch,
        leaseProof: lease.leaseProof,
        dead: false
      }
      session.client = watchClient(raw, session, (s) => {
        // Eager eviction: a transport-dead session must not linger as a
        // live-looking entry. Identity-checked so a late failure on a
        // superseded socket can never evict its replacement.
        if (sessions.get(s.hostId) === s) sessions.delete(s.hostId)
      })
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
      // A failed dial is never cached as a live session (nothing is inserted
      // above before success). When the dial died at the transport — or got
      // far enough to hold a fresh socket — whatever is parked at this
      // endpoint is a corpse on the same dead socket, so evict it and the next
      // call re-dials instead of reusing it. Verdict failures (auth/lease
      // rejections with no fresh socket) leave a parked session alone: the
      // socket may still be good and killing it would destroy live transport.
      if (client != null || isTransportError(err)) {
        const parked = [...sessions.values()].find((s) => s.endpoint === endpoint)
        if (parked) {
          parked.dead = true
          if (sessions.get(parked.hostId) === parked) sessions.delete(parked.hostId)
          try {
            parked.client.close()
          } catch {
            /* already gone */
          }
        }
      }
      try {
        client?.close()
      } catch {
        /* fresh dial socket — never published, just release it */
      }
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
    principalId: SERVICE_PRINCIPAL_ID as never,
    controllerEpoch: controllerEpoch as never,
    grantRevisions: currentGrantRevisions(db, SERVICE_PRINCIPAL_ID),
    transportSessionId: `mahasd:${process.pid}`
  })
  const caller = (
    ctx: AuthenticatedContext,
    operation: string,
    payload?: unknown
  ): Promise<unknown> => makeCaller(registry, ctx)(operation, payload)

  function dropDead(session: HostSession | undefined): HostSession | undefined {
    if (!session) return undefined
    if (!session.dead) return session
    sessions.delete(session.hostId)
    try {
      session.client.close()
    } catch {
      /* already gone */
    }
    return undefined
  }

  async function hostClient(hostId: string): Promise<HostClient> {
    const existing = dropDead(sessions.get(hostId))
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
    const known = dropDead([...sessions.values()].find((s) => s.endpoint === endpoint))
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

  // discovery verifies the token's signature; the composition maps its
  // claims into the C-WORK pin shape (the token proves what was SHOWN — the
  // handlers still re-check role/implementation/grant state themselves)
  const verifyToken: VerifySelectionToken = (raw) => {
    const v = verifySelectionToken(token.secret, raw)
    if (!v.ok) return null
    return {
      tokenId: v.claims.tokenId,
      projectId: v.claims.projectId,
      modelVersion: v.claims.modelVersion,
      roleId: v.claims.roleId,
      roleDigest: v.claims.roleDigest,
      interfaceDigest: v.claims.interfaceDigest,
      implementationId: v.claims.implementationId,
      implementationCandidateDigest: v.claims.implementationCandidateDigest,
      scope: v.claims.scope,
      issuedAt: v.claims.issuedAt
    }
  }
  registerCoordinationOps(registry, { verifySelectionToken: verifyToken })
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
    // Launch orchestration is an internal service workflow. The initiating
    // member is authorized for worker.prepare/start at admission, while its
    // cross-domain context.build/workspace.prepare calls run under the
    // deliberately narrow service grant.
    call: (_ctx, operation, payload) => caller(serviceCtx(), operation, payload),
    host: (hostId: string) => hostClient(hostId),
    materialize: async (req) => {
      const extra = req as typeof req & {
        envelope?: {
          digest: string
          initialText: string
          envelopeJson: unknown
        }
        memberId?: string
        launchPlanId?: string
        cli?: { executablePath: string; endpoint: string; extraEnv?: Record<string, string> }
        operationKey?: string
        connection?: { files: { name: string; bytes: Uint8Array }[] }
      }
      const connection =
        extra.connection ??
        (req.secretFiles && req.secretFiles.length > 0
          ? {
              files: req.secretFiles.map((f) => ({
                name: f.path.replace(/^connection\//, ''),
                bytes: f.bytes
              }))
            }
          : undefined)
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
          ...(req.workspaceId ? { workspaceId: req.workspaceId as never } : {}),
          ...(extra.memberId ? { memberId: extra.memberId as never } : {}),
          ...(extra.launchPlanId ? { launchPlanId: extra.launchPlanId as never } : {}),
          ...(extra.envelope ? { envelope: extra.envelope } : {}),
          ...(connection ? { connection } : {}),
          ...(extra.cli ? { cli: extra.cli } : {}),
          ...(extra.operationKey ? { operationKey: extra.operationKey } : {})
        }
      )
      const want = new Set(req.wantBytes ?? [])
      const files = result.files.map((f) => {
        const rec: {
          path: string
          digest: string
          byteLength: number
          bytes?: Uint8Array
          verified?: boolean
        } = {
          path: f.path,
          digest: f.digest ?? '',
          byteLength: 0,
          verified: true
        }
        if (want.has(f.path) || f.private) {
          try {
            const bytes = readFileSync(join(result.executionRoot, f.path))
            rec.byteLength = bytes.byteLength
            if (want.has(f.path)) rec.bytes = bytes
          } catch {
            rec.verified = false
          }
        }
        return rec
      })
      for (const p of want) {
        if (files.some((f) => f.path === p)) continue
        try {
          const bytes = readFileSync(join(result.executionRoot, p))
          files.push({
            path: p,
            digest: '',
            byteLength: bytes.byteLength,
            bytes,
            verified: true
          })
        } catch {
          /* wantBytes path not on disk — caller sees it missing */
        }
      }
      return {
        executionRoot: result.executionRoot,
        manifestDigest: result.manifestDigest,
        files: files as never,
        residuals: result.residualResources as never
      }
    },
    // F-027: launch/planner.ts passes raw snake_case storage rows cast as
    // domain objects (AssignmentRow.task_id, MemberRow.role_id, …), so read
    // both conventions — camelCase-first, snake_case fallback. Without the
    // fallback taskId resolves to '' and every task-kind worker.prepare dies
    // with INVALID_TRANSITION "assignment does not cover task".
    ensureEnvelope: (txnDb, req) => {
      const asg = req.assignment as unknown as Record<string, unknown>
      const mem = req.member as unknown as Record<string, unknown>
      return (
        req.assignment.kind === 'task'
          ? buildTaskEnvelope(txnDb, {
              assignmentId: req.assignment.id,
              assignmentRevision: req.assignment.revision,
              taskId: ((asg.taskId ?? asg.task_id ?? '') as string) || '',
              taskRevision: ((asg.taskRevision ?? asg.task_revision ?? 0) as number) || 0
            })
          : buildCoordinationEnvelope(txnDb, {
              assignmentId: req.assignment.id,
              assignmentRevision: req.assignment.revision,
              roleContext: {
                roleId: (mem.roleId ?? mem.role_id) as string,
                implementationId: (mem.implementationId ?? mem.implementation_id) as string,
                implementationRevision: (mem.implementationRevision ??
                  mem.implementation_revision) as number
              }
            })
      ) as never
    },
    appendDomainEvent: storage.appendDomainEvent,
    digest: storage.sha256Hex,
    newId: (kind: string) => `${kind}-${randomUUID()}`,
    now: () => Date.now(),
    endpoint: opts.endpoint
  })
  registerJoinOps(registry, { now: () => Date.now() })
  const recoveryDeps: RecoveryDeps = {
    withTx: storage.withTx,
    appendDomainEvent: storage.appendDomainEvent,
    sha256Hex: storage.sha256Hex,
    authorize: (ctx, operation, targets) => accessBoundary.authorize(ctx, operation, targets),
    connectHost: (endpoint: string) => hostClientByEndpoint(endpoint),
    makeCaller: (reg, ctx) => makeCaller(reg, ctx) as never,
    now: () => Date.now(),
    newId: () => randomUUID()
  }
  registerRecoveryOps(registry, recoveryDeps)

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
        return (await hostClientByEndpoint(hostEndpoint)).call<T>(operation, payload)
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
    recoveryDeps,
    localHost: localSession
      ? { hostId: localSession.hostId, endpoint: localSession.endpoint }
      : null,
    async ensureLocalHost() {
      const live = dropDead(
        [...sessions.values()].find((s) => s.endpoint === hostEndpoint) ?? localSession ?? undefined
      )
      if (live) return { hostId: live.hostId, endpoint: live.endpoint }
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
