// mahas-runtime / lifecycle — restart + on-demand reconciliation.
//
// spec/contracts/recovery-operations.md "재시작 알고리즘" is the normative
// sequence this implements for the mahasd side:
//   2. read the active/unknown effects and executions the DB still claims —
//      screen state is never live evidence;
//   3. verify each execution-host's actual endpoint + incarnation, prove the
//      previous controller's death/hand-off, acquire the lease;
//   4. 대조 effectKey / spawnNonce / process birth / terminal inventory —
//      matching processes reattach, conflicting or orphaned ones are
//      quarantined or kept unknown;
//   6. unknown executions keep their writer claims; the startup receipt and
//      the unresolved list are published honestly. Held-out outbox entries
//      are settled by the SAME effect key — never by inventing a new spawn.
//
// Phase discipline (spec/storage.md §4): host probes are network I/O and run
// OUTSIDE any DB transaction; only the decision-application step runs inside
// deps.withTx.

import type {
  ConnectHostFn,
  ControllerLeaseRow,
  DatabaseSync,
  EffectIntentRow,
  ExecutionHostRow,
  ExecutionRow,
  HostClient,
  ProcessIdentity,
  ReconcileDecision,
  ReconcileReport,
  ResourceClaimRow,
  RuntimeInstanceRow,
  RuntimeShutdownRow,
  WithTxFn
} from './types.ts'

export interface ReconcileScope {
  hostId?: string
  executionId?: string
}

export interface ReconcileDeps {
  db: DatabaseSync
  withTx: WithTxFn
  connectHost: ConnectHostFn
  controllerEpoch: number
  controllerIdentity: ProcessIdentity
  hostEndpoint: (host: ExecutionHostRow) => string | null
  hostProbeTimeoutMs: number
  now: () => number
  log: (line: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// DB reads (reconcile's view of the world — rows, never UI projection)
// ---------------------------------------------------------------------------

function rows<T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T[] {
  const stmt = db.prepare(sql)
  return stmt.all(...args) as T[]
}

export function loadRuntimeInstances(db: DatabaseSync): RuntimeInstanceRow[] {
  return rows<RuntimeInstanceRow>(
    db,
    `SELECT id, controller_epoch, state, process_identity_json, endpoint_incarnation
     FROM runtime_instances ORDER BY controller_epoch`
  )
}

export function loadHosts(db: DatabaseSync): ExecutionHostRow[] {
  return rows<ExecutionHostRow>(
    db,
    `SELECT id, incarnation, protocol_version, state, identity_json FROM execution_hosts`
  )
}

export function loadLeases(db: DatabaseSync): ControllerLeaseRow[] {
  return rows<ControllerLeaseRow>(
    db,
    `SELECT host_id, epoch, revision, expires_at, state, proof_json FROM controller_leases`
  )
}

export function loadOpenExecutions(db: DatabaseSync, scope?: ReconcileScope): ExecutionRow[] {
  const base = `SELECT id, member_id, generation, host_id, launch_plan_id, state, liveness,
       terminal_id, process_identity_json, native_conversation_json, revision
     FROM executions WHERE liveness <> 'exited'`
  if (scope?.executionId != null)
    return rows<ExecutionRow>(db, `${base} AND id = ?`, scope.executionId)
  if (scope?.hostId != null) return rows<ExecutionRow>(db, `${base} AND host_id = ?`, scope.hostId)
  return rows<ExecutionRow>(db, base)
}

export function loadPendingEffects(db: DatabaseSync): EffectIntentRow[] {
  return rows<EffectIntentRow>(
    db,
    `SELECT id, operation_key, kind, fingerprint, host_id, state, payload_json, receipt_json, residuals_json
     FROM effect_intents WHERE state IN ('prepared','attempting','unknown')`
  )
}

export function loadOpenClaims(db: DatabaseSync): ResourceClaimRow[] {
  return rows<ResourceClaimRow>(
    db,
    `SELECT id, resource_id, owner_kind, owner_id, mode, generation, state, revision
     FROM resource_claims WHERE state IN ('held','transferring','unknown')`
  )
}

export function loadOpenShutdowns(db: DatabaseSync): RuntimeShutdownRow[] {
  return rows<RuntimeShutdownRow>(
    db,
    `SELECT operation_id, mode, state, stages_json, residuals_json
     FROM runtime_shutdowns WHERE state NOT IN ('completed','interrupted')`
  )
}

// ---------------------------------------------------------------------------
// host probing — all network I/O lives here, outside transactions
// ---------------------------------------------------------------------------

interface HostProbeResult {
  host: ExecutionHostRow
  reachable: boolean
  protocolMismatch?: boolean
  hello?: Record<string, unknown>
  incarnationMatch: 'same' | 'changed' | 'unverifiable'
  lease?: Record<string, unknown>
  leaseError?: string
  inventory?: HostInventory
  /** per-effectKey receipt fetched while the client was still connected */
  effectReceipts: Map<string, { state?: string; receipt?: unknown; error?: string }>
  error?: string
}

interface HostProcessEntry {
  spawnNonce?: string
  executionId?: string
  generation?: number
  pid?: number
  state?: string
  identity?: Record<string, unknown>
  observedExit?: { code?: number; signal?: string; at?: number }
}

interface HostInventory {
  processes: HostProcessEntry[]
  terminals: Array<Record<string, unknown>>
  resources: Array<Record<string, unknown>>
  effectReceiptIds: string[]
  evidenceTime?: number
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_r, rej) => {
        timer = setTimeout(() => rej(new Error(`${what}: timed out after ${ms}ms`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Probe one host: hello → version/incarnation check → acquire lease under
 * the new controllerEpoch (takeover proof = previous controller death
 * evidence) → inventory. Any failure is captured, never thrown away —
 * an unreachable host is itself the reconcile datum.
 */
async function probeHost(
  deps: ReconcileDeps,
  host: ExecutionHostRow,
  takeoverProof: Record<string, unknown>,
  effectKeys: string[]
): Promise<HostProbeResult> {
  const endpoint = deps.hostEndpoint(host)
  const result: HostProbeResult = {
    host,
    reachable: false,
    incarnationMatch: 'unverifiable',
    effectReceipts: new Map()
  }
  if (!endpoint) {
    result.error = 'no endpoint recorded for host'
    return result
  }
  let client: HostClient | null = null
  try {
    client = await withTimeout(deps.connectHost(endpoint), deps.hostProbeTimeoutMs, 'connectHost')
    result.reachable = true

    const hello = await withTimeout(
      client.call<Record<string, unknown>>('host.hello', {
        supportedVersions: [0],
        controllerIdentity: {
          serviceId: 'mahasd',
          pid: deps.controllerIdentity.pid,
          controllerEpoch: deps.controllerEpoch
        },
        challenge: `reconcile-${deps.controllerEpoch}-${deps.now()}`
      }),
      deps.hostProbeTimeoutMs,
      'host.hello'
    )
    result.hello = hello
    const reportedIncarnation = (hello.hostIncarnation ?? hello.incarnation) as string | undefined
    result.incarnationMatch =
      reportedIncarnation == null
        ? 'unverifiable'
        : reportedIncarnation === host.incarnation
          ? 'same'
          : 'changed'
    if (
      (hello.protocolVersion as number | undefined) != null &&
      (hello.protocolVersion as number) !== 0
    ) {
      result.protocolMismatch = true
      return result // read-only verdict; never mutate across a major mismatch
    }

    const priorLease = deps.db
      .prepare(`SELECT epoch, revision FROM controller_leases WHERE host_id = ?`)
      .get(host.id) as { epoch: number; revision: number } | undefined

    try {
      result.lease = await withTimeout(
        client.call<Record<string, unknown>>('host.acquire', {
          controllerEpoch: deps.controllerEpoch,
          controllerProcessIdentity: deps.controllerIdentity,
          takeoverProof,
          priorLeaseRevision: priorLease?.revision
        }),
        deps.hostProbeTimeoutMs,
        'host.acquire'
      )
    } catch (err) {
      result.leaseError = err instanceof Error ? err.message : String(err)
    }

    result.inventory = await withTimeout(
      client.call<HostInventory>('host.inventory', {
        hostId: host.id,
        incarnation: reportedIncarnation ?? host.incarnation
      }),
      deps.hostProbeTimeoutMs,
      'host.inventory'
    )

    // settle pending effects by the SAME effect key while still connected —
    // a missing receipt is only meaningful as negative evidence, never a
    // reason to spawn anything new (spec restart step 6)
    for (const key of effectKeys) {
      try {
        const receipt = await withTimeout(
          client.call<Record<string, unknown>>('host.effect.get', { effectKey: key }),
          deps.hostProbeTimeoutMs,
          'host.effect.get'
        )
        result.effectReceipts.set(key, {
          state: (receipt as { state?: string } | null)?.state,
          receipt
        })
      } catch (err) {
        result.effectReceipts.set(key, {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    return result
  } finally {
    try {
      client?.close()
    } catch {
      /* closing a dead transport must not throw */
    }
  }
}

// ---------------------------------------------------------------------------
// decision application (inside deps.withTx — the only DB mutation region)
// ---------------------------------------------------------------------------

interface ExecVerdict {
  execution: ExecutionRow
  liveness: 'live' | 'exited' | 'unverifiable'
  nextState?: string
  decision: ReconcileDecision['decision']
  evidence: string
}

function judgeExecution(exec: ExecutionRow, probe: HostProbeResult | undefined): ExecVerdict {
  if (!probe || !probe.reachable) {
    return {
      execution: exec,
      liveness: 'unverifiable',
      decision: 'left-unknown',
      evidence: `host ${exec.host_id} unreachable — stored record is not death evidence`
    }
  }
  if (probe.protocolMismatch) {
    return {
      execution: exec,
      liveness: 'unverifiable',
      decision: 'host-protocol-mismatch',
      evidence: `host ${exec.host_id} speaks an incompatible protocol — no mutation attempted`
    }
  }
  const inv = probe.inventory
  if (!inv) {
    return {
      execution: exec,
      liveness: 'unverifiable',
      decision: 'left-unknown',
      evidence: `host ${exec.host_id} gave no inventory`
    }
  }
  const entry = inv.processes.find(
    (p) => p.executionId === exec.id && (p.generation == null || p.generation === exec.generation)
  )
  const identity = JSON.parse(exec.process_identity_json || '{}') as {
    spawnNonce?: string
    pid?: number
    birthEvidence?: string
  }
  if (!entry) {
    // host knows nothing of this process
    if (probe.incarnationMatch === 'same') {
      return {
        execution: exec,
        liveness: 'unverifiable',
        nextState: undefined,
        decision: 'left-unknown',
        evidence:
          `same-incarnation host ${exec.host_id} inventory lacks ${exec.id} — ` +
          `absence is not positive exit evidence; stays unverifiable, never adopted/respawned`
      }
    }
    return {
      execution: exec,
      liveness: 'unverifiable',
      decision: 'left-unknown',
      evidence: `host ${exec.host_id} restarted (incarnation changed) and lists no such process`
    }
  }
  // spawnNonce conflict → quarantine: the host holds a DIFFERENT process under
  // this execution id — never merge the two identities
  if (identity.spawnNonce && entry.spawnNonce && identity.spawnNonce !== entry.spawnNonce) {
    return {
      execution: exec,
      liveness: 'unverifiable',
      decision: 'quarantined',
      evidence:
        `spawnNonce mismatch (db ${identity.spawnNonce} vs host ${entry.spawnNonce}) — ` +
        `conflicting incarnations quarantined`
    }
  }
  if (entry.state === 'exited' || entry.observedExit) {
    return {
      execution: exec,
      liveness: 'exited',
      nextState: 'exited',
      decision: 'confirmed-exited',
      evidence: `host inventory records exit at ${entry.observedExit?.at ?? 'unknown'}`
    }
  }
  if (entry.state === 'live' || entry.state === 'running' || entry.pid != null) {
    const nextState =
      exec.state === 'starting' || exec.state === 'start_unknown' ? 'awaiting_join' : exec.state // stopping/stop_unknown keep their unresolved stop
    return {
      execution: exec,
      liveness: 'live',
      nextState,
      decision: 'reattached',
      evidence: `process birth matches host incarnation ${probe.hello?.hostIncarnation ?? probe.hello?.incarnation ?? ''}`
    }
  }
  return {
    execution: exec,
    liveness: 'unverifiable',
    decision: 'left-unknown',
    evidence: `host entry state '${entry.state ?? 'absent'}' is neither live proof nor exit proof`
  }
}

/**
 * Run a full reconcile pass. Pure read phase → network probe phase → ONE
 * write transaction applying every decision. Returns the report that
 * runtime.reconcile hands back and that runtime.status retains.
 */
export async function runReconcile(
  deps: ReconcileDeps,
  scope: ReconcileScope = {}
): Promise<ReconcileReport> {
  const startedAt = deps.now()
  const decisions: ReconcileDecision[] = []
  const unresolved: ReconcileReport['unresolvedResources'] = []

  // --- read phase -----------------------------------------------------------
  const hosts = loadHosts(deps.db).filter((h) => !scope.hostId || h.id === scope.hostId)
  const executions = loadOpenExecutions(deps.db, scope)
  const pendingEffects = loadPendingEffects(deps.db).filter(
    (e) => !scope.hostId || e.host_id === scope.hostId
  )
  const openClaims = loadOpenClaims(deps.db)
  const effectsByHost = new Map<string, string[]>()
  for (const e of pendingEffects) {
    if (!e.host_id) continue
    const list = effectsByHost.get(e.host_id) ?? []
    list.push(e.id)
    effectsByHost.set(e.host_id, list)
  }

  // --- probe phase (network, outside tx) -------------------------------------
  const probes = new Map<string, HostProbeResult>()
  for (const host of hosts) {
    const probe = await probeHost(
      deps,
      host,
      {
        priorRuntimeInstance: 'superseded-by-epoch',
        controllerEpoch: deps.controllerEpoch,
        controllerPid: deps.controllerIdentity.pid,
        birthEvidence: deps.controllerIdentity.birthEvidence
      },
      effectsByHost.get(host.id) ?? []
    )
    probes.set(host.id, probe)
    if (!probe.reachable) {
      decisions.push({
        targetKind: 'host',
        targetId: host.id,
        decision: 'host-unreachable',
        evidence: probe.error ?? 'connect failed'
      })
      unresolved.push({
        kind: 'host',
        id: host.id,
        reason: probe.error ?? 'unreachable — its processes may still be alive but uncontrollable'
      })
    } else if (probe.protocolMismatch) {
      decisions.push({
        targetKind: 'host',
        targetId: host.id,
        decision: 'host-protocol-mismatch',
        evidence: `endpoint ${endpointOf(host)} runs an incompatible host protocol`
      })
      unresolved.push({ kind: 'host', id: host.id, reason: 'HOST_PROTOCOL_MISMATCH' })
    } else if (probe.leaseError) {
      decisions.push({
        targetKind: 'host',
        targetId: host.id,
        decision: 'lease-failed',
        evidence: probe.leaseError
      })
      unresolved.push({ kind: 'host', id: host.id, reason: `lease refused: ${probe.leaseError}` })
    } else if (probe.lease) {
      decisions.push({
        targetKind: 'host',
        targetId: host.id,
        decision: 'lease-acquired',
        evidence: `epoch ${deps.controllerEpoch} lease over incarnation ${probe.hello?.hostIncarnation ?? probe.hello?.incarnation}`
      })
    }
  }

  // --- per-execution verdicts -------------------------------------------------
  const verdicts = executions.map((exec) => judgeExecution(exec, probes.get(exec.host_id)))

  // --- pending effect settlement by same effect key ---------------------------
  const effectVerdicts: Array<{
    row: EffectIntentRow
    state: string
    receipt: unknown
    decision: ReconcileDecision
  }> = []
  for (const eff of pendingEffects) {
    const probe = eff.host_id ? probes.get(eff.host_id) : undefined
    if (!eff.host_id || !probe?.reachable || !probe.inventory) {
      // an 'attempting' intent whose controller died mid-call is the spec's
      // crash gap → 'unknown'; a never-attempted 'prepared' intent stays
      // prepared for the outbox pump to settle by the same key
      effectVerdicts.push({
        row: eff,
        state: eff.state === 'attempting' ? 'unknown' : eff.state,
        receipt: null,
        decision: {
          targetKind: 'effect',
          targetId: eff.id,
          decision: 'left-unknown',
          evidence: 'host unreachable — intent preserved, NOT marked unexecuted'
        }
      })
      continue
    }
    const got = probe.effectReceipts.get(eff.id)
    const st = got?.state
    if (got && !got.error && (st === 'confirmed' || st === 'rejected')) {
      effectVerdicts.push({
        row: eff,
        state: st,
        receipt: got.receipt,
        decision: {
          targetKind: 'effect',
          targetId: eff.id,
          decision: 'effect-settled',
          evidence: `host receipt for ${eff.id}: ${st}`
        }
      })
    } else {
      effectVerdicts.push({
        row: eff,
        state: 'unknown',
        receipt: got?.receipt ?? null,
        decision: {
          targetKind: 'effect',
          targetId: eff.id,
          decision: 'left-unknown',
          evidence: got?.error
            ? `effect.get failed (${got.error}) — intent preserved`
            : `host receipt state '${st ?? 'absent'}' is not conclusive — intent preserved as unknown`
        }
      })
    }
  }
  for (const ev of effectVerdicts) decisions.push(ev.decision)

  // --- apply phase (single write tx) ------------------------------------------
  deps.withTx(deps.db, (db) => {
    const nowMs = deps.now()

    // host mirror rows + lease mirror
    for (const [hostId, probe] of probes) {
      if (probe.reachable && !probe.protocolMismatch) {
        db.prepare(
          `UPDATE execution_hosts SET state = ?, incarnation = ?, identity_json = json_patch(identity_json, ?) WHERE id = ?`
        ).run(
          probe.lease ? 'leased' : 'reachable',
          String(
            probe.hello?.hostIncarnation ?? probe.hello?.incarnation ?? probe.host.incarnation
          ),
          JSON.stringify({ lastReconcileAt: nowMs, endpoint: endpointOf(probe.host) }),
          hostId
        )
        if (probe.lease) {
          const lease = probe.lease as { epoch?: number; revision?: number; expiresAt?: number }
          db.prepare(
            `INSERT INTO controller_leases(host_id, epoch, revision, expires_at, state, proof_json)
             VALUES(?,?,?,?,?,?)
             ON CONFLICT(host_id) DO UPDATE SET epoch=excluded.epoch, revision=excluded.revision,
               expires_at=excluded.expires_at, state=excluded.state, proof_json=excluded.proof_json`
          ).run(
            hostId,
            deps.controllerEpoch,
            (lease.revision as number | undefined) ?? 1,
            (lease.expiresAt as number | undefined) ?? nowMs + 30_000,
            'held',
            JSON.stringify({ acquiredAt: nowMs, proof: probe.lease })
          )
        }
      } else {
        db.prepare(`UPDATE execution_hosts SET state = ? WHERE id = ?`).run(
          probe.protocolMismatch ? 'protocol-mismatch' : 'unreachable',
          hostId
        )
      }
    }

    // executions — liveness + state transitions only; never spawn/resume.
    // every verdict is recorded as a decision, changed or not.
    for (const v of verdicts) {
      if (
        v.liveness !== v.execution.liveness ||
        (v.nextState && v.nextState !== v.execution.state)
      ) {
        db.prepare(
          `UPDATE executions SET liveness = ?, state = COALESCE(?, state), revision = revision + 1 WHERE id = ?`
        ).run(v.liveness, v.nextState ?? null, v.execution.id)
      }
      decisions.push({
        targetKind: 'execution',
        targetId: v.execution.id,
        decision: v.decision,
        evidence: v.evidence
      })
    }

    // pending effects — settle only by the host's own receipt
    for (const ev of effectVerdicts) {
      if (ev.state === ev.row.state) continue
      db.prepare(`UPDATE effect_intents SET state = ?, receipt_json = ? WHERE id = ?`).run(
        ev.state,
        JSON.stringify(ev.receipt ?? {}),
        ev.row.id
      )
    }
  })

  // claims: preserved — release is an explicit resource-domain op, not ours
  for (const claim of openClaims) {
    decisions.push({
      targetKind: 'claim',
      targetId: claim.id,
      decision: 'claim-preserved',
      evidence:
        `claim on ${claim.resource_id} (owner ${claim.owner_kind}:${claim.owner_id}) kept — ` +
        `unknown/live writers are never stripped by reconcile`
    })
    if (!executions.some((e) => e.id === claim.owner_id)) {
      unresolved.push({
        kind: 'claim',
        id: claim.id,
        reason: `owner ${claim.owner_id} is not an open execution — needs claim.release decision`
      })
    }
  }

  const report: ReconcileReport = {
    controllerEpoch: deps.controllerEpoch,
    startedAt,
    finishedAt: deps.now(),
    decisions,
    unresolvedResources: unresolved,
    nextAllowedActions: nextActions(unresolved)
  }
  return report
}

function endpointOf(host: ExecutionHostRow): string | null {
  try {
    const id = JSON.parse(host.identity_json) as { endpoint?: string; socket?: string }
    return id.endpoint ?? id.socket ?? null
  } catch {
    return null
  }
}

function nextActions(unresolved: ReconcileReport['unresolvedResources']): string[] {
  const actions = new Set<string>(['runtime.status'])
  if (unresolved.some((u) => u.kind === 'host')) actions.add('runtime.reconcile')
  if (unresolved.some((u) => u.kind === 'claim')) actions.add('claim.release')
  if (unresolved.length > 0) actions.add('operator escalation')
  return [...actions]
}

// ---------------------------------------------------------------------------
// startup bookkeeping applied BEFORE the reconcile pass (prior-instance and
// prior-shutdown honesty) — pure DB work, single tx
// ---------------------------------------------------------------------------

export function markPriorInstancesStopped(
  db: DatabaseSync,
  withTx: WithTxFn,
  ownId: string,
  verdictFor: (identity: {
    pid: number
    birthEvidence?: string
    bootId?: string
  }) => 'alive' | 'dead' | 'unverifiable',
  decisions: ReconcileDecision[]
): void {
  withTx(db, (tx) => {
    const rows = loadRuntimeInstances(tx).filter(
      (r) => r.id !== ownId && !['stopped', 'crashed', 'interrupted'].includes(r.state)
    )
    for (const r of rows) {
      let verdict: 'alive' | 'dead' | 'unverifiable' = 'unverifiable'
      try {
        verdict = verdictFor(JSON.parse(r.process_identity_json))
      } catch {
        /* corrupt identity → unverifiable */
      }
      // an "alive" prior runtime cannot coexist with our held lock — that is a
      // bootstrap-level refusal, handled before this runs. Here it can only be
      // stale evidence, so record honestly.
      const state =
        verdict === 'dead' ? 'crashed' : verdict === 'alive' ? 'interrupted' : 'interrupted'
      tx.prepare(`UPDATE runtime_instances SET state = ? WHERE id = ?`).run(state, r.id)
      decisions.push({
        targetKind: 'runtime-instance',
        targetId: r.id,
        decision: verdict === 'dead' ? 'marked-crashed' : 'marked-interrupted',
        evidence: `prior controller epoch ${r.controller_epoch} process verdict: ${verdict}`
      })
    }
    const shutdowns = loadOpenShutdowns(tx)
    for (const s of shutdowns) {
      tx.prepare(`UPDATE runtime_shutdowns SET state = 'interrupted' WHERE operation_id = ?`).run(
        s.operation_id
      )
      decisions.push({
        targetKind: 'shutdown',
        targetId: s.operation_id,
        decision: 'marked-interrupted',
        evidence: 'previous runtime died mid-shutdown — record closed honestly'
      })
    }
  })
}
