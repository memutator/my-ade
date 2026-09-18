// recovery/reconciler.ts — the reconciliation path: DB active/unknown
// effects and executions are compared against host receipts/inventory by
// stable effect key, spawnNonce and birth identity (instruction §4.1,
// C-RECOVERY restart algorithm steps 2–6). Also the residual-resource
// resolution port and the worker.release operation.
//
// Ground rules enforced here:
//   · screen state is never live evidence — only host receipts + probes
//   · an unreachable host makes its executions 'unverifiable', never dead
//   · matching spawnNonce + birth identity ⇒ reattach path; conflicting or
//     unclaimed processes ⇒ quarantine, never adoption
//   · writer claims of unknown executions are PRESERVED and reported, never
//     released; pending outbox rows are settled by the SAME effect key only
//   · every write re-checks the row revision inside one transaction — a
//     row that moved under the probe is left for the next pass, not
//     overwritten by stale evidence

import type { ProcessIncarnation } from '../../../mahas-contracts/src/index.ts'
import type { TxnContext } from '../api/registry.ts' // IMP-11 — type only
import type { OperationRegistry } from '../api/registry.ts' // IMP-11 — type only
import {
  activeExecutions,
  claimsOwnedBy,
  failure,
  isMahasError,
  loadEffectIntent,
  loadExecution,
  loadHost,
  optionalString,
  requireString,
  unresolvedEffectIntents,
  withTimeout,
  type AuthenticatedContext,
  type DatabaseSync,
  type ExecutionHostRow,
  type ExecutionRow,
  type RecoveryDeps,
  type ResidualResourceResult,
  type ResourceClaimRow
} from './ports.ts'
import { assertCurrentControllerEpoch, probeProcess } from './identity-probe.ts'
import { applyProbeVerdict } from './reattach.ts'
import { applyStopOutcome, type StopOutcomeVerdict } from './stop.ts'
import { classifyHostProcess, quarantineOrphan, type OrphanRecord } from './orphan.ts'

// ---------------------------------------------------------------------------
// shapes of what a host can tell us (C-HOST inventory/effect/probe results)
// ---------------------------------------------------------------------------

export interface HostInventoryProcess {
  spawnNonce?: string
  executionId?: string
  generation?: number
  pid?: number
  state?: string
  identity?: ProcessIncarnation
}

export interface HostEffectReceiptEntry {
  effectKey?: string
  key?: string
  state?: string
  outcome?: string
  receipt?: unknown
  evidence?: unknown
}

export interface HostInventory {
  processes: HostInventoryProcess[]
  terminals: unknown[]
  effectReceipts: HostEffectReceiptEntry[]
  raw: unknown
}

function normalizeInventory(raw: unknown): HostInventory {
  const r = (raw ?? {}) as Record<string, unknown>
  const processes = Array.isArray(r.processes) ? (r.processes as HostInventoryProcess[]) : []
  const terminals = Array.isArray(r.terminals) ? r.terminals : []
  const effectReceipts = Array.isArray(r.effectReceipts)
    ? (r.effectReceipts as HostEffectReceiptEntry[])
    : Array.isArray(r.effects)
      ? (r.effects as HostEffectReceiptEntry[])
      : []
  return { processes, terminals, effectReceipts, raw }
}

function receiptKey(e: HostEffectReceiptEntry): string | undefined {
  return e.effectKey ?? e.key
}

// ---------------------------------------------------------------------------
// report types
// ---------------------------------------------------------------------------

export interface ReconcileScope {
  hostId?: string
  executionId?: string
  evidenceRefs?: unknown[]
}

export interface ReconcileDecision {
  executionId: string
  previousState: string
  nextState: string
  liveness: string
  decision:
    'reattached' | 'exited' | 'unverifiable' | 'conflict' | 'stopping-outstanding' | 'unchanged'
  basis: string
}

export interface HostFinding {
  hostId: string
  reachable: boolean
  incarnation?: string
  detail?: string
}

export interface UnreconciledEffect {
  effectId: string
  kind: string
  state: string
  detail: string
}

export interface ReconcileReport {
  scope: ReconcileScope
  hostFindings: HostFinding[]
  decisions: ReconcileDecision[]
  orphans: OrphanRecord[]
  unreconciledEffects: UnreconciledEffect[]
  /** writer claims of still-unknown executions — preserved, reported, never released */
  unresolvedResources: Array<{
    claimId: string
    resourceId: string
    ownerId: string
    mode: string
    state: string
  }>
  nextAllowedActions: string[]
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

async function fetchInventory(
  deps: RecoveryDeps,
  host: ExecutionHostRow
): Promise<{ ok: true; inventory: HostInventory } | { ok: false; reason: string }> {
  const endpoint = host.identity.endpoint
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return { ok: false, reason: 'host row carries no endpoint' }
  }
  const timeout = deps.hostCallTimeoutMs ?? 10_000
  let client
  try {
    client = await withTimeout(deps.connectHost(endpoint), timeout)
  } catch (e) {
    return { ok: false, reason: `connect failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    const res = await withTimeout(
      client.call<Record<string, unknown>>('host.inventory', {
        hostId: host.id,
        expectedHostIncarnation: host.incarnation
      }),
      timeout
    )
    return { ok: true, inventory: normalizeInventory(res) }
  } catch (e) {
    return {
      ok: false,
      reason: isMahasError(e)
        ? `${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e)
    }
  } finally {
    try {
      client.close()
    } catch {
      /* ignore */
    }
  }
}

async function fetchHostEffect(
  deps: RecoveryDeps,
  host: ExecutionHostRow,
  effectKey: string
): Promise<{
  found: boolean
  entry?: HostEffectReceiptEntry
  negativeEvidence?: boolean
  reason?: string
}> {
  const endpoint = host.identity.endpoint
  if (typeof endpoint !== 'string' || endpoint.length === 0)
    return { found: false, reason: 'no endpoint' }
  const timeout = deps.hostCallTimeoutMs ?? 10_000
  let client
  try {
    client = await withTimeout(deps.connectHost(endpoint), timeout)
  } catch (e) {
    return { found: false, reason: `connect failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    const res = await withTimeout(
      client.call<Record<string, unknown>>('host.effect.get', { effectKey }),
      timeout
    )
    if (res == null) return { found: false }
    const state = (res.state ?? res.outcome) as string | undefined
    if (state === 'not-found' || res.found === false) {
      // C-HOST: not found must carry the negative-evidence conditions
      return {
        found: false,
        negativeEvidence: res.negativeEvidence === true || res.negative === true,
        entry: res as HostEffectReceiptEntry
      }
    }
    return { found: true, entry: res as HostEffectReceiptEntry }
  } catch (e) {
    return {
      found: false,
      reason: isMahasError(e) ? e.message : e instanceof Error ? e.message : String(e)
    }
  } finally {
    try {
      client.close()
    } catch {
      /* ignore */
    }
  }
}

function markLivenessOnly(
  deps: RecoveryDeps,
  db: DatabaseSync,
  exec: ExecutionRow,
  liveness: 'unverifiable',
  reason: string
): ExecutionRow {
  if (exec.liveness === liveness) return exec
  const nextRevision = exec.revision + 1
  db.prepare('UPDATE executions SET liveness=?, revision=? WHERE id=?').run(
    liveness,
    nextRevision,
    exec.id
  )
  deps.appendDomainEvent(
    db,
    exec.id,
    nextRevision,
    'execution.probe-unverifiable',
    { operation: 'runtime.reconcile' },
    { generation: exec.generation, reason }
  )
  return { ...exec, liveness, revision: nextRevision }
}

/**
 * The reconciliation engine. Consumed by IMP-23's runtime.reconcile op and
 * the mahasd restart sequence (C-RECOVERY "재시작 알고리즘" steps 4–6):
 * DB effects/executions are compared against host inventory by stable key,
 * spawnNonce and birth identity; unknowns stay unknown.
 */
export async function reconcileExecutions(
  deps: RecoveryDeps,
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  scope: ReconcileScope
): Promise<ReconcileReport> {
  assertCurrentControllerEpoch(db, ctx)
  void ctx

  const report: ReconcileReport = {
    scope,
    hostFindings: [],
    decisions: [],
    orphans: [],
    unreconciledEffects: [],
    unresolvedResources: [],
    nextAllowedActions: []
  }

  // phase 1 — snapshot rows (reads need no write tx under WAL)
  let executions: ExecutionRow[]
  if (scope.executionId) {
    const e = loadExecution(db, scope.executionId)
    executions = e && e.state !== 'exited' ? [e] : []
    if (e && !executions.length) {
      report.decisions.push({
        executionId: e.id,
        previousState: e.state,
        nextState: e.state,
        liveness: e.liveness,
        decision: 'unchanged',
        basis: 'execution is already exited — its record stays untouched'
      })
    }
  } else {
    executions = activeExecutions(db, scope.hostId)
  }
  const intents = unresolvedEffectIntents(db, scope.hostId)
  const hostIds = new Set<string>()
  for (const e of executions) hostIds.add(e.hostId)
  for (const i of intents) if (i.hostId) hostIds.add(i.hostId)

  // phase 2 — per-host evidence collection (no writes while awaiting)
  const hostEvidence = new Map<
    string,
    { host: ExecutionHostRow; inventory: HostInventory | null; unreachableReason?: string }
  >()
  for (const hostId of hostIds) {
    const host = loadHost(db, hostId)
    if (!host) {
      report.hostFindings.push({
        hostId,
        reachable: false,
        detail: 'no execution_hosts mirror row'
      })
      continue
    }
    const inv = await fetchInventory(deps, host)
    if (inv.ok) {
      hostEvidence.set(hostId, { host, inventory: inv.inventory })
      report.hostFindings.push({ hostId, reachable: true, incarnation: host.incarnation })
    } else {
      hostEvidence.set(hostId, { host, inventory: null, unreachableReason: inv.reason })
      report.hostFindings.push({ hostId, reachable: false, detail: inv.reason })
    }
  }

  // phase 3 — apply decisions inside one immediate transaction per write,
  // re-checking each row revision so evidence gathered mid-flight can never
  // overwrite a row that moved (CAS honesty)
  for (const exec of executions) {
    const evidence = hostEvidence.get(exec.hostId)
    const apply = (fn: (fresh: ExecutionRow) => ExecutionRow | null): ExecutionRow => {
      let out = exec
      deps.withTx(db, (tx) => {
        const fresh = loadExecution(tx, exec.id)
        if (!fresh || fresh.revision !== exec.revision) return // moved under us — next pass
        const applied = fn(fresh)
        if (applied) out = applied
      })
      return out
    }

    if (!evidence) {
      report.decisions.push({
        executionId: exec.id,
        previousState: exec.state,
        nextState: exec.state,
        liveness: exec.liveness,
        decision: 'unchanged',
        basis: 'host mirror row missing — nothing provable'
      })
      continue
    }
    if (!evidence.inventory) {
      const after = apply((fresh) =>
        markLivenessOnly(
          deps,
          db,
          fresh,
          'unverifiable',
          `host unreachable: ${evidence.unreachableReason}`
        )
      )
      report.decisions.push({
        executionId: exec.id,
        previousState: exec.state,
        nextState: after.state,
        liveness: after.liveness,
        decision: 'unverifiable',
        basis: `host unreachable: ${evidence.unreachableReason} — not dead, not alive`
      })
      // writer claims of unknown executions are preserved + reported
      for (const c of claimsOwnedBy(db, 'execution', exec.id)) {
        report.unresolvedResources.push({
          claimId: c.id,
          resourceId: c.resourceId,
          ownerId: c.ownerId,
          mode: c.mode,
          state: c.state
        })
      }
      continue
    }

    const inv = evidence.inventory
    const claimed = inv.processes.find(
      (p) => p.spawnNonce && p.spawnNonce === exec.processIdentity.spawnNonce
    )
    const classification = claimed
      ? classifyHostProcess([exec], {
          ...(claimed.identity ?? {}),
          spawnNonce: claimed.spawnNonce,
          pid: claimed.pid ?? (claimed.identity?.pid as number | undefined)
        })
      : { kind: 'orphan' as const }

    if (classification.kind === 'conflict') {
      let orphan: OrphanRecord | null = null
      const after = apply((fresh) => {
        orphan = quarantineOrphan(
          deps,
          db,
          exec.hostId,
          { ...(claimed?.identity ?? {}), spawnNonce: claimed?.spawnNonce, pid: claimed?.pid },
          'conflicting-identity',
          exec.id
        )
        return markLivenessOnly(
          deps,
          db,
          fresh,
          'unverifiable',
          'spawnNonce collides with a different process birth — conflict quarantined'
        )
      })
      if (orphan) report.orphans.push(orphan)
      report.decisions.push({
        executionId: exec.id,
        previousState: exec.state,
        nextState: after.state,
        liveness: after.liveness,
        decision: 'conflict',
        basis: 'spawnNonce matches but birth identity conflicts — never silently re-pointed'
      })
      continue
    }

    // probe is authoritative for the execution's own incarnation
    const verdict = await probeProcess(deps, db, evidence.host, exec)
    const after = apply((fresh) => applyProbeVerdict(deps, db, fresh, verdict).exec)
    const decision: ReconcileDecision['decision'] =
      verdict.liveness === 'live'
        ? claimed
          ? 'reattached'
          : 'reattached' // host probe verified the incarnation even if inventory missed it
        : verdict.liveness === 'exited'
          ? 'exited'
          : 'unverifiable'
    const reportedDecision: ReconcileDecision['decision'] =
      decision === 'reattached' && hasOutstandingStop(db, exec) ? 'stopping-outstanding' : decision
    report.decisions.push({
      executionId: exec.id,
      previousState: exec.state,
      nextState: after.state,
      liveness: after.liveness,
      decision: reportedDecision,
      basis:
        verdict.liveness === 'live'
          ? 'host probe verified stored incarnation — same process re-bound'
          : verdict.liveness === 'exited'
            ? 'host returned positive exit evidence'
            : `no definitive verdict: ${verdict.unverifiableReason ?? 'unknown'}`
    })
    if (reportedDecision === 'unverifiable' || reportedDecision === 'stopping-outstanding') {
      for (const c of claimsOwnedBy(db, 'execution', exec.id)) {
        report.unresolvedResources.push({
          claimId: c.id,
          resourceId: c.resourceId,
          ownerId: c.ownerId,
          mode: c.mode,
          state: c.state
        })
      }
    }
  }

  // orphan sweep — host processes claimed by no execution
  for (const [, evidence] of hostEvidence) {
    if (!evidence.inventory) continue
    const execsOnHost = executions.filter((e) => e.hostId === evidence.host.id)
    for (const proc of evidence.inventory.processes) {
      const identity: ProcessIncarnation = {
        ...(proc.identity ?? {}),
        spawnNonce: proc.spawnNonce ?? proc.identity?.spawnNonce,
        pid: proc.pid ?? proc.identity?.pid
      }
      if (!identity.spawnNonce) continue
      const cls = classifyHostProcess(execsOnHost, identity)
      if (cls.kind === 'orphan') {
        const rec = deps.withTx(db, (tx) =>
          quarantineOrphan(deps, tx, evidence.host.id, identity, 'unmatched-process')
        )
        if (!report.orphans.some((o) => o.observationId === rec.observationId))
          report.orphans.push(rec)
      }
    }
    // host effect receipts we never recorded — foreign residue evidence
    for (const receipt of inv_effects(evidence.inventory)) {
      const key = receiptKey(receipt)
      if (!key) continue
      if (!loadEffectIntent(db, key)) {
        const rec = deps.withTx(db, (tx) =>
          quarantineOrphan(
            deps,
            tx,
            evidence.host.id,
            { spawnNonce: key },
            'unmatched-effect-receipt'
          )
        )
        if (!report.orphans.some((o) => o.observationId === rec.observationId))
          report.orphans.push(rec)
      }
    }
  }

  // effect intent reconciliation — same key lookup, never a new effect
  for (const intent of intents) {
    if (!intent.hostId) {
      report.unreconciledEffects.push({
        effectId: intent.id,
        kind: intent.kind,
        state: intent.state,
        detail: 'no host binding'
      })
      continue
    }
    const evidence = hostEvidence.get(intent.hostId)
    if (!evidence || !evidence.inventory) {
      report.unreconciledEffects.push({
        effectId: intent.id,
        kind: intent.kind,
        state: intent.state,
        detail: 'host unreachable — intent stays open'
      })
      continue
    }
    const invReceipt = evidence.inventory.effectReceipts.find((e) => receiptKey(e) === intent.id)
    const res = invReceipt
      ? { found: true, entry: invReceipt }
      : await fetchHostEffect(deps, evidence.host, intent.id)
    if (res.found && res.entry) {
      const state = res.entry.state ?? res.entry.outcome
      const mapped =
        state === 'confirmed' || state === 'exited' || state === 'done'
          ? 'confirmed'
          : state === 'rejected' || state === 'failed'
            ? 'rejected'
            : 'unknown'
      deps.withTx(db, (tx) => {
        const fresh = loadEffectIntent(tx, intent.id)
        if (!fresh) return
        tx.prepare('UPDATE effect_intents SET state=?, receipt_json=? WHERE id=?').run(
          mapped,
          JSON.stringify({ adopted: true, hostReceipt: res.entry, at: deps.now() }),
          intent.id
        )
        if (mapped === 'confirmed' || mapped === 'rejected') {
          tx.prepare('DELETE FROM effect_outbox WHERE effect_id=?').run(intent.id)
        }
      })
      if (mapped === 'unknown') {
        report.unreconciledEffects.push({
          effectId: intent.id,
          kind: intent.kind,
          state: 'unknown',
          detail: 'host receipt reports unknown — kept for retry via same key'
        })
      }
    } else {
      report.unreconciledEffects.push({
        effectId: intent.id,
        kind: intent.kind,
        state: intent.state,
        detail: res.negativeEvidence
          ? 'host has confirmed-negative evidence for this key — owner may retry the SAME operation'
          : `host has no receipt for this key${res.reason ? ` (${res.reason})` : ''} — intent stays unknown`
      })
    }
  }

  const actions = new Set<string>()
  if (report.decisions.some((d) => d.decision === 'unverifiable' || d.decision === 'conflict'))
    actions.add('runtime.reconcile')
  if (report.decisions.some((d) => d.decision === 'reattached')) actions.add('worker.inspect')
  if (report.unresolvedResources.length > 0) actions.add('worker.release')
  if (report.orphans.length > 0) actions.add('operator: resolveOrphan')
  report.nextAllowedActions = [...actions]
  return report
}

function hasOutstandingStop(db: DatabaseSync, exec: ExecutionRow): boolean {
  const r = db
    .prepare(
      `SELECT 1 AS s FROM effect_intents
       WHERE kind='process.stop' AND state IN ('attempting','unknown')
         AND json_extract(payload_json,'$.executionId')=? AND json_extract(payload_json,'$.generation')=? LIMIT 1`
    )
    .get(exec.id, exec.generation) as { s?: number } | undefined
  return r?.s === 1
}

function inv_effects(inv: HostInventory): HostEffectReceiptEntry[] {
  return inv.effectReceipts
}

// ---------------------------------------------------------------------------
// outbox drain — settle pending effects by the SAME key, never new effects
// ---------------------------------------------------------------------------

export interface DrainReport {
  processed: Array<{
    effectId: string
    kind: string
    action: 'adopted' | 'reissued' | 'pending' | 'skipped-foreign' | 'resolved'
    detail: string
  }>
}

/**
 * effect_outbox pump for recovery-owned effects. Only 'process.stop' is
 * driven here — other kinds belong to their owner services and are skipped,
 * never hijacked. A held-back outbox row is settled by host.effect.get on
 * the SAME key; a confirmed-negative gets ONE re-issue of the same keyed
 * stop (the host dedups); nothing ever spawns anew (C-RECOVERY step 6).
 */
export async function drainEffectOutbox(
  deps: RecoveryDeps,
  db: DatabaseSync,
  scope?: { hostId?: string }
): Promise<DrainReport> {
  const report: DrainReport = { processed: [] }
  const rows = db
    .prepare(
      `SELECT eo.effect_id AS effect_id FROM effect_outbox eo
       JOIN effect_intents ei ON ei.id = eo.effect_id
       WHERE ei.state IN ('prepared','attempting','unknown')
         AND (eo.next_attempt_at IS NULL OR eo.next_attempt_at <= ?)`
    )
    .all(deps.now()) as Array<{ effect_id: string }>

  for (const row of rows) {
    const intent = loadEffectIntent(db, row.effect_id)
    if (!intent) {
      db.prepare('DELETE FROM effect_outbox WHERE effect_id=?').run(row.effect_id)
      report.processed.push({
        effectId: row.effect_id,
        kind: '?',
        action: 'resolved',
        detail: 'intent row missing — outbox cleared'
      })
      continue
    }
    if (scope?.hostId && intent.hostId !== scope.hostId) continue
    if (intent.kind !== 'process.stop') {
      report.processed.push({
        effectId: intent.id,
        kind: intent.kind,
        action: 'skipped-foreign',
        detail: 'owned by another service — never hijacked'
      })
      continue
    }
    const payload = intent.payload as {
      executionId?: string
      generation?: number
      mode?: 'graceful' | 'escalate'
      graceBudgetMs?: number
      reason?: string
    }
    const exec = payload.executionId ? loadExecution(db, payload.executionId) : null
    const host = intent.hostId
      ? loadHost(db, intent.hostId)
      : exec
        ? loadHost(db, exec.hostId)
        : null
    if (!exec || !host) {
      report.processed.push({
        effectId: intent.id,
        kind: intent.kind,
        action: 'pending',
        detail: 'execution or host mirror missing'
      })
      continue
    }
    // 1) adopt an existing host receipt for the same key
    const found = await fetchHostEffect(deps, host, intent.id)
    let verdict: StopOutcomeVerdict | null = null
    if (found.found && found.entry) {
      const st = found.entry.state ?? found.entry.outcome
      if (st === 'confirmed' || st === 'exited' || st === 'stopped' || st === 'done') {
        verdict = { kind: 'exited', evidence: found.entry.receipt ?? found.entry }
      } else if (st === 'rejected' || st === 'failed') {
        // the host refused the stop — definitive for THIS intent
        deps.withTx(db, (tx) => {
          tx.prepare(`UPDATE effect_intents SET state='rejected', receipt_json=? WHERE id=?`).run(
            JSON.stringify({ adopted: true, hostReceipt: found.entry, at: deps.now() }),
            intent.id
          )
          tx.prepare('DELETE FROM effect_outbox WHERE effect_id=?').run(intent.id)
        })
        report.processed.push({
          effectId: intent.id,
          kind: intent.kind,
          action: 'adopted',
          detail: 'host rejected the stop — receipt adopted'
        })
        continue
      } else {
        report.processed.push({
          effectId: intent.id,
          kind: intent.kind,
          action: 'pending',
          detail: 'host receipt still in-flight — kept pending'
        })
        continue
      }
    } else if (found.negativeEvidence) {
      // 2) confirmed-negative → ONE re-issue of the same keyed stop
      const endpoint = host.identity.endpoint
      if (typeof endpoint !== 'string' || endpoint.length === 0) {
        report.processed.push({
          effectId: intent.id,
          kind: intent.kind,
          action: 'pending',
          detail: 'host endpoint missing'
        })
        continue
      }
      const timeout = deps.hostCallTimeoutMs ?? 10_000
      try {
        const client = await withTimeout(deps.connectHost(endpoint), timeout)
        try {
          const res = await withTimeout(
            client.call<Record<string, unknown>>('host.process.stop', {
              effectKey: intent.id,
              expectedProcessIncarnation: exec.processIdentity,
              mode: payload.mode ?? 'graceful',
              graceBudget: payload.graceBudgetMs,
              reason: payload.reason,
              executionId: exec.id,
              generation: payload.generation ?? exec.generation
            }),
            timeout
          )
          const oc = res?.outcome ?? res?.state
          verdict =
            oc === 'exited' || oc === 'already-exited' || oc === 'stopped' || oc === 'confirmed'
              ? { kind: 'exited', evidence: res }
              : {
                  kind: 'unknown',
                  reason: 're-issued stop returned no positive exit evidence',
                  evidence: res
                }
        } finally {
          try {
            client.close()
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        verdict = {
          kind: 'unknown',
          reason: `re-issue failed: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      if (verdict) {
        const resolvedVerdict: StopOutcomeVerdict = verdict
        deps.withTx(db, (tx) => {
          const freshExec = loadExecution(tx, exec.id)
          const freshIntent = loadEffectIntent(tx, intent.id)
          if (!freshExec || !freshIntent) return
          applyStopOutcome(deps, tx, freshExec, freshIntent, resolvedVerdict)
        })
        report.processed.push({
          effectId: intent.id,
          kind: intent.kind,
          action: verdict.kind === 'exited' ? 'resolved' : 'reissued',
          detail:
            verdict.kind === 'exited'
              ? 'stop confirmed after re-issue'
              : `re-issued, outcome unknown: ${verdict.reason ?? ''}`
        })
        continue
      }
    } else {
      report.processed.push({
        effectId: intent.id,
        kind: intent.kind,
        action: 'pending',
        detail: `no host receipt for this key${found.reason ? ` (${found.reason})` : ''} — kept unknown; a retry must reuse the same key`
      })
      // backoff so a flapping host isn't hammered
      db.prepare('UPDATE effect_outbox SET next_attempt_at=? WHERE effect_id=?').run(
        deps.now() + 30_000,
        intent.id
      )
      continue
    }
    if (verdict) {
      deps.withTx(db, (tx) => {
        const freshExec = loadExecution(tx, exec.id)
        const freshIntent = loadEffectIntent(tx, intent.id)
        if (!freshExec || !freshIntent) return
        applyStopOutcome(deps, tx, freshExec, freshIntent, verdict)
      })
      report.processed.push({
        effectId: intent.id,
        kind: intent.kind,
        action: 'adopted',
        detail: `host receipt adopted → ${verdict.kind}`
      })
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// residual resource resolution port — what CAN be done with leftovers
// ---------------------------------------------------------------------------

export interface ResidualResolution {
  executionId: string
  executionState: string
  liveness: string
  residuals: Array<{
    claimId: string
    resourceId: string
    mode: 'read' | 'write'
    claimState: string
    revision: number
    disposition: 'releasable' | 'retain-required' | 'needs-evidence' | 'blocked'
    reason: string
  }>
  terminalIds: string[]
  retentionPinned: string[]
}

/**
 * The residual-resolution port (§6 handoff item): a pure read that maps an
 * execution's leftover claims to what policy allows. worker.release uses it
 * per-claim; runtime.reconcile/status renders it. NOTHING is mutated here —
 * release/transfer are explicit operations, never sweep-ups.
 */
export function resolveResidualResources(
  deps: RecoveryDeps,
  db: DatabaseSync,
  executionId: string
): ResidualResolution {
  void deps
  const exec = loadExecution(db, executionId)
  const claims = claimsOwnedBy(db, 'execution', executionId)
  const pins = db
    .prepare(
      `SELECT target_id FROM retention_pins WHERE target_kind='resource' OR target_kind='claim' OR target_kind='process'`
    )
    .all() as Array<{ target_id: string }>
  const pinned = new Set(pins.map((p) => p.target_id))

  const base: ResidualResolution = {
    executionId,
    executionState: exec?.state ?? 'missing',
    liveness: exec?.liveness ?? 'unverifiable',
    residuals: [],
    terminalIds: exec?.terminalId ? [exec.terminalId] : [],
    retentionPinned: [...pinned]
  }
  for (const c of claims) {
    let disposition: ResidualResolution['residuals'][number]['disposition']
    let reason: string
    if (pinned.has(c.resourceId) || pinned.has(c.id)) {
      disposition = 'retain-required'
      reason = 'a retention pin covers this resource — release requires explicit pin removal'
    } else if (!exec || exec.state === 'exited') {
      disposition = 'releasable'
      reason = 'execution exited with evidence — claim is releasable via worker.release'
    } else if (
      exec.liveness === 'unverifiable' ||
      exec.state === 'stop_unknown' ||
      exec.state === 'start_unknown' ||
      exec.state === 'abandoned'
    ) {
      disposition = 'needs-evidence'
      reason =
        'execution is not proven dead — claim preserved until positive exit/quiescence evidence'
    } else {
      disposition = 'blocked'
      reason = 'execution is active — its writer claim cannot be touched'
    }
    base.residuals.push({
      claimId: c.id,
      resourceId: c.resourceId,
      mode: c.mode,
      claimState: c.state,
      revision: c.revision,
      disposition,
      reason
    })
  }
  return base
}

// ---------------------------------------------------------------------------
// worker.release — retain/transfer/release policy over residual resources
// ---------------------------------------------------------------------------

export interface WorkerReleasePayload {
  executionId: string
  resourceDisposition: 'retain' | 'transfer' | 'release'
  expectedClaims: Array<{ claimId: string; expectedRevision: number }>
  toOwner?: { ownerKind: string; ownerId: string }
  quiescenceEvidence?: unknown
  dirtyDecision?: string
  reason?: string
}

export interface WorkerReleaseResult {
  executionId: string
  disposition: string
  results: ResidualResourceResult[]
  overallOutcome: 'complete' | 'partial' | 'blocked'
  code?: string
  basis: string
}

function readReleasePayload(payload: unknown): WorkerReleasePayload {
  const p = (payload ?? {}) as Record<string, unknown>
  const disp = p.resourceDisposition
  if (disp !== 'retain' && disp !== 'transfer' && disp !== 'release') {
    throw failure(
      'INVALID_TRANSITION',
      "resourceDisposition must be 'retain' | 'transfer' | 'release'",
      'none'
    )
  }
  const expectedClaims = Array.isArray(p.expectedClaims)
    ? (p.expectedClaims as Array<{ claimId: string; expectedRevision: number }>)
    : []
  const toOwner =
    typeof p.toOwner === 'object' && p.toOwner !== null
      ? (p.toOwner as { ownerKind: string; ownerId: string })
      : undefined
  return {
    executionId: requireString(p.executionId, 'executionId'),
    resourceDisposition: disp,
    expectedClaims,
    toOwner,
    quiescenceEvidence: p.quiescenceEvidence,
    dirtyDecision: optionalString(p.dirtyDecision),
    reason: optionalString(p.reason)
  }
}

function claimById(db: DatabaseSync, claimId: string): ResourceClaimRow | null {
  const r = db.prepare('SELECT * FROM resource_claims WHERE id=?').get(claimId) as
    Record<string, unknown> | undefined
  if (!r) return null
  return {
    id: r.id as string,
    resourceId: r.resource_id as string,
    ownerKind: r.owner_kind as string,
    ownerId: r.owner_id as string,
    mode: r.mode as 'read' | 'write',
    generation: r.generation as number,
    state: r.state as ResourceClaimRow['state'],
    revision: r.revision as number
  }
}

export function makeReleaseHandler(deps: RecoveryDeps, registry: OperationRegistry) {
  return async function workerRelease(
    txn: TxnContext,
    payload: unknown
  ): Promise<WorkerReleaseResult> {
    const { db, ctx } = txn
    const input = readReleasePayload(payload)

    deps.authorize(ctx, 'worker.release', [{ kind: 'execution', id: input.executionId }])
    assertCurrentControllerEpoch(db, ctx)

    const exec = loadExecution(db, input.executionId)
    if (!exec) {
      throw failure('INVALID_TRANSITION', `execution ${input.executionId} does not exist`, 'none')
    }

    const caller = deps.makeCaller(registry, ctx)
    const results: ResidualResourceResult[] = []
    const exitProven =
      exec.state === 'exited' ||
      (exec.state === 'abandoned' && input.quiescenceEvidence !== undefined)

    for (const expected of input.expectedClaims) {
      const claim = claimById(db, expected.claimId)
      if (!claim) {
        results.push({
          claimId: expected.claimId,
          resourceId: '?',
          mode: 'read',
          outcome: 'unknown',
          reason: 'claim not found'
        })
        continue
      }
      if (claim.ownerId !== exec.id || claim.ownerKind !== 'execution') {
        results.push({
          claimId: claim.id,
          resourceId: claim.resourceId,
          mode: claim.mode,
          outcome: 'skipped',
          reason: 'claim is not owned by this execution'
        })
        continue
      }
      if (claim.revision !== expected.expectedRevision) {
        results.push({
          claimId: claim.id,
          resourceId: claim.resourceId,
          mode: claim.mode,
          outcome: 'stale',
          reason: `claim revision ${claim.revision} ≠ expected ${expected.expectedRevision}`
        })
        continue
      }

      if (input.resourceDisposition === 'retain') {
        db.prepare(
          `INSERT OR IGNORE INTO retention_pins (id, target_kind, target_id, holder_kind, holder_id, reason)
           VALUES (?,?,?,?,?,?)`
        ).run(
          `retain:${claim.id}`,
          'claim',
          claim.id,
          'operation',
          'worker.release',
          input.reason ?? 'explicit retain disposition'
        )
        results.push({
          claimId: claim.id,
          resourceId: claim.resourceId,
          mode: claim.mode,
          outcome: 'retained',
          reason: input.reason ?? 'explicit retain'
        })
        continue
      }

      if (input.resourceDisposition === 'transfer') {
        if (!input.toOwner) {
          results.push({
            claimId: claim.id,
            resourceId: claim.resourceId,
            mode: claim.mode,
            outcome: 'skipped',
            reason: 'transfer requires toOwner'
          })
          continue
        }
        if (!exitProven && exec.liveness !== 'exited') {
          results.push({
            claimId: claim.id,
            resourceId: claim.resourceId,
            mode: claim.mode,
            outcome: 'busy',
            reason: 'old writer is not proven stopped/quiescent — handoff requires evidence'
          })
          continue
        }
        try {
          const receipt = await caller('claim.handoff', {
            claimId: claim.id,
            expectedRevision: expected.expectedRevision,
            fromOwner: { ownerKind: claim.ownerKind, ownerId: claim.ownerId },
            toOwner: input.toOwner,
            quiescenceEvidence:
              input.quiescenceEvidence ?? exec.processIdentity.observedExit ?? null
          })
          results.push({
            claimId: claim.id,
            resourceId: claim.resourceId,
            mode: claim.mode,
            outcome: 'transferred',
            receipt
          })
        } catch (e) {
          results.push(mapSiblingFailure(claim, e))
        }
        continue
      }

      // release — requires positive exit/quiescence (D-EXEC §5: no exit
      // evidence → the claim is never released; "release는 cancel 아님")
      if (!exitProven) {
        results.push({
          claimId: claim.id,
          resourceId: claim.resourceId,
          mode: claim.mode,
          outcome: exec.liveness === 'unverifiable' ? 'unknown' : 'busy',
          reason:
            exec.liveness === 'unverifiable'
              ? 'execution is not proven dead — STOP_UNKNOWN territory, claim preserved'
              : 'execution still active — release requires exited state or quiescence evidence'
        })
        continue
      }
      try {
        const receipt = await caller('claim.release', {
          claimId: claim.id,
          expectedRevision: expected.expectedRevision,
          disposition: 'release',
          dirtyDecision: input.dirtyDecision
        })
        results.push({
          claimId: claim.id,
          resourceId: claim.resourceId,
          mode: claim.mode,
          outcome: 'released',
          receipt
        })
      } catch (e) {
        results.push(mapSiblingFailure(claim, e))
      }
    }

    const bad = results.filter(
      (r) => r.outcome === 'busy' || r.outcome === 'unknown' || r.outcome === 'stale'
    )
    return {
      executionId: exec.id,
      disposition: input.resourceDisposition,
      results,
      overallOutcome:
        bad.length === 0
          ? 'complete'
          : results.every((r) => r.outcome === 'busy' || r.outcome === 'unknown')
            ? 'blocked'
            : 'partial',
      code: results.some((r) => r.outcome === 'unknown')
        ? 'STOP_UNKNOWN'
        : results.some((r) => r.outcome === 'busy')
          ? 'RESOURCE_BUSY'
          : undefined,
      basis:
        'per-resource results — release is not cancel, and Task settlement is a separate operation; ' +
        'process death or cleanup success is never inferred from this receipt'
    }
  }
}

function mapSiblingFailure(claim: ResourceClaimRow, e: unknown): ResidualResourceResult {
  if (isMahasError(e)) {
    const outcome =
      e.code === 'RESOURCE_BUSY'
        ? 'busy'
        : e.code === 'STOP_UNKNOWN' ||
            e.code === 'PROCESS_UNVERIFIABLE' ||
            e.code === 'CONTROL_UNAVAILABLE'
          ? 'unknown'
          : e.code === 'STALE_REVISION' || e.code === 'STALE_EXECUTION'
            ? 'stale'
            : 'unknown'
    return {
      claimId: claim.id,
      resourceId: claim.resourceId,
      mode: claim.mode,
      outcome,
      reason: `${e.code}: ${e.message}`
    }
  }
  return {
    claimId: claim.id,
    resourceId: claim.resourceId,
    mode: claim.mode,
    outcome: 'unknown',
    reason: e instanceof Error ? e.message : String(e)
  }
}
