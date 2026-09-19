// api/registry.smoke.ts — self-check for the IMP-11 registry kernel.
//
// Run:  node packages/mahas-runtime/src/api/registry.smoke.ts
//
// Peers IMP-02/03/10 are in flight, so this file injects boundary doubles
// (real node:sqlite storage + a configurable access boundary) into the REAL
// OperationRegistry class — the same code paths createOperationRegistry()
// will bind to the landed peers. It is an implementation self-check, not the
// formal verification task's harness.

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  CommandReceipt,
  CommandRequest
} from '../../../mahas-contracts/src/index.ts'
import { OperationRegistry, makeCaller, OPERATION_NAMES, OPERATION_TABLE } from './registry.ts'
import type {
  AccessBoundary,
  AdmissionTrace,
  OperationRegistryDeps,
  StorageBoundary
} from './handler-ports.ts'
import { mahasError } from './handler-ports.ts'

// ── minimal schema (only what the registry boundary touches) ─────────────────

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE operation_receipts (
      principal_scope TEXT NOT NULL,
      operation TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(principal_scope, operation, operation_id)
    );
    CREATE TABLE domain_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate_id TEXT NOT NULL,
      aggregate_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE effect_intents (
      id TEXT PRIMARY KEY,
      operation_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      host_id TEXT,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      residuals_json TEXT NOT NULL
    );
    CREATE TABLE effect_outbox (
      effect_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      next_attempt_at INTEGER
    );
    CREATE TABLE command_surfaces (
      digest TEXT PRIMARY KEY,
      actions_and_schemas_json TEXT NOT NULL,
      policy_pins_json TEXT NOT NULL
    );
  `)
  return db
}

// ── boundary doubles ─────────────────────────────────────────────────────────

function storageDouble(): StorageBoundary {
  return {
    sha256Hex: (data) =>
      createHash('sha256')
        .update(typeof data === 'string' ? data : Buffer.from(data))
        .digest('hex'),
    insertReceipt: (db, receipt, principalScope) => {
      db.prepare(
        `INSERT OR REPLACE INTO operation_receipts
           (principal_scope, operation, operation_id, fingerprint, status, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        principalScope,
        (receipt as CommandReceipt & { operation?: string }).operation ?? '',
        receipt.operationId,
        receipt.fingerprint,
        receipt.status,
        JSON.stringify(receipt),
        Date.now()
      )
    },
    findReceipt: (db, principalScope, operation, operationId) => {
      const row = db
        .prepare(
          `SELECT result_json FROM operation_receipts
           WHERE principal_scope=? AND operation=? AND operation_id=?`
        )
        .get(principalScope, operation, operationId) as { result_json: string } | undefined
      return row ? (JSON.parse(row.result_json) as CommandReceipt) : null
    },
    appendDomainEvent: (db, aggregateId, aggregateRevision, eventType, scope, payload) => {
      db.prepare(
        `INSERT INTO domain_events (aggregate_id, aggregate_revision, event_type, scope_json, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        aggregateId,
        aggregateRevision,
        eventType,
        JSON.stringify(scope),
        JSON.stringify(payload)
      )
    }
  }
}

function accessDouble(visible: ReadonlySet<string>, denied?: ReadonlySet<string>): AccessBoundary {
  return {
    authorize: (_ctx, operation) => {
      if (denied?.has(operation)) {
        throw mahasError('SCOPE_DENIED', `${operation} outside current grant`, 'none')
      }
    },
    surfaceFor: () =>
      ({
        digest: 'granted-surface',
        rolePolicyRevision: 1,
        effectiveActions: [...visible],
        schemas: {},
        visibilityScope: 'test'
      }) as never,
    isOperationVisible: (surface, operation): boolean =>
      (surface as unknown as { effectiveActions: string[] }).effectiveActions.includes(operation)
  }
}

// ── test scaffolding ─────────────────────────────────────────────────────────

const ctx: AuthenticatedContext = {
  principalId: 'principal-1' as AuthenticatedContext['principalId'],
  controllerEpoch: 1 as AuthenticatedContext['controllerEpoch'],
  grantRevisions: {},
  transportSessionId: 'session-1'
}

function req(
  operation: string,
  operationId: string,
  payload?: unknown,
  expectedRevisions?: Record<string, number>
): CommandRequest {
  return { protocolVersion: 'test/1', operation, operationId, payload, expectedRevisions }
}

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`, detail ?? '')
  }
}

const traces: AdmissionTrace[] = []
const visible = new Set<string>([
  'test.ping',
  'test.read',
  'surface.describe',
  'test.fail',
  'test.deny',
  'test.inner',
  'test.outer'
])

async function main(): Promise<void> {
  const db = openDb()
  const deps: OperationRegistryDeps = {
    db,
    access: accessDouble(visible, new Set(['test.deny'])),
    storage: storageDouble(),
    trace: (t) => traces.push(t)
  }
  const registry = new OperationRegistry(deps)

  // ── 1. mutation dispatch → committed receipt, persisted ──
  let pingCalls = 0
  registry.register(
    { name: 'test.ping', visibility: 'member', mutation: true, summary: 'ping' },
    (txn, payload) => {
      pingCalls++
      txn.emitEvent({ aggregateId: 'agg-1', aggregateRevision: 3, eventType: 'Pinged', payload })
      txn.intendEffect({ kind: 'notify', payload: { to: 'ops' } })
      return { pong: payload }
    }
  )
  const r1 = await registry.dispatch(ctx, req('test.ping', 'op-1', { a: 1 }))
  check(
    'dispatch commits',
    r1.status === 'committed' && (r1.result as { pong: { a: number } }).pong.a === 1,
    r1
  )
  check(
    'receipt fingerprint present',
    typeof r1.fingerprint === 'string' && r1.fingerprint.length === 64
  )
  check(
    'event appended',
    (db.prepare('SELECT COUNT(*) c FROM domain_events').get() as { c: number }).c === 1
  )
  check(
    'effect intent+outbox written',
    (db.prepare('SELECT COUNT(*) c FROM effect_intents').get() as { c: number }).c === 1 &&
      (db.prepare('SELECT COUNT(*) c FROM effect_outbox').get() as { c: number }).c === 1
  )
  check(
    'receipt.effects carries intent',
    r1.effects.length === 1 && r1.effects[0]!.kind === 'notify'
  )
  check('eventCursor advanced', r1.eventCursor === 1)
  check('domainRevision from event', r1.domainRevision === 3)

  // ── 2. idempotent replay → stored receipt, handler NOT re-run ──
  const r2 = await registry.dispatch(ctx, req('test.ping', 'op-1', { a: 1 }))
  check(
    'replay returns stored receipt',
    r2.status === 'committed' && r2.fingerprint === r1.fingerprint
  )
  check('handler not re-run on replay', pingCalls === 1, { pingCalls })
  check(
    'replay traced',
    traces.some((t) => t.outcome === 'replayed' && t.operation === 'test.ping')
  )

  // ── 3. same key, different payload → OPERATION_CONFLICT ──
  const r3 = await registry.dispatch(ctx, req('test.ping', 'op-1', { a: 2 }))
  check(
    'conflict rejected',
    r3.status === 'rejected' && r3.error?.code === 'OPERATION_CONFLICT',
    r3
  )
  check(
    'conflict traced',
    traces.some((t) => t.outcome === 'conflict')
  )

  // ── 4. unknown operation → UNAVAILABLE_OPERATION ──
  const r4 = await registry.dispatch(ctx, req('no.such.op', 'op-x', {}))
  check(
    'unknown → UNAVAILABLE_OPERATION',
    r4.status === 'rejected' && r4.error?.code === 'UNAVAILABLE_OPERATION'
  )
  check(
    'unknown traced distinctly',
    traces.some((t) => t.reason === 'unknown-operation')
  )

  // ── 5. registered but hidden → same worker error, distinct trace ──
  registry.register({ name: 'test.hidden', visibility: 'member', mutation: true }, () => ({}))
  const r5 = await registry.dispatch(ctx, req('test.hidden', 'op-h', {}))
  check(
    'hidden → UNAVAILABLE_OPERATION',
    r5.status === 'rejected' && r5.error?.code === 'UNAVAILABLE_OPERATION'
  )
  check(
    'hidden traced distinctly',
    traces.some((t) => t.reason === 'hidden-operation' && t.operation === 'test.hidden')
  )

  // ── 6. spec-only registration → not surfaced, dispatches UNAVAILABLE ──
  registry.register({ name: 'test.unimplemented', visibility: 'member', mutation: true })
  const surf = registry.describe(ctx)
  const surfRec = surf as unknown as {
    effectiveActions: string[]
    schemas: Record<string, unknown>
    digest: string
  }
  check('unimplemented not in surface', !surfRec.effectiveActions.includes('test.unimplemented'))
  check('hidden not in surface', !surfRec.effectiveActions.includes('test.hidden'))
  check('visible op in surface', surfRec.effectiveActions.includes('test.ping'))
  check(
    'builtin surface.describe in surface',
    surfRec.effectiveActions.includes('surface.describe')
  )
  const r6 = await registry.dispatch(ctx, req('test.unimplemented', 'op-u', {}))
  check(
    'unimplemented → UNAVAILABLE_OPERATION',
    r6.status === 'rejected' && r6.error?.code === 'UNAVAILABLE_OPERATION'
  )
  check(
    'unimplemented traced',
    traces.some((t) => t.reason === 'unimplemented-operation')
  )

  // ── 7. expectedRevisions → STALE_REVISION ──
  registry.register(
    {
      name: 'test.read',
      visibility: 'member',
      mutation: false,
      resolveRevisions: () => ({ 'entity-1': 7 })
    },
    () => ({ ok: true })
  )
  const r7 = await registry.dispatch(ctx, req('test.read', 'op-r1', {}, { 'entity-1': 5 }))
  check(
    'stale revision rejected',
    r7.status === 'rejected' && r7.error?.code === 'STALE_REVISION',
    r7
  )
  const r7b = await registry.dispatch(ctx, req('test.read', 'op-r2', {}, { 'entity-1': 7 }))
  check('matching revision commits', r7b.status === 'committed')
  const r7c = await registry.dispatch(ctx, req('test.read', 'op-r3', {}, { 'entity-9': 1 }))
  check(
    'unresolvable expected entity → STALE_REVISION',
    r7c.status === 'rejected' && r7c.error?.code === 'STALE_REVISION'
  )

  // ── 8. handler MahasError → rejected receipt, NOT persisted ──
  let failCalls = 0
  registry.register({ name: 'test.fail', visibility: 'member', mutation: true }, () => {
    failCalls++
    throw mahasError('INPUT_NOT_READY', 'missing input', 'same-operation')
  })
  const r8 = await registry.dispatch(ctx, req('test.fail', 'op-f', {}))
  check(
    'handler error → rejected receipt',
    r8.status === 'rejected' && r8.error?.code === 'INPUT_NOT_READY'
  )
  const r8b = await registry.dispatch(ctx, req('test.fail', 'op-f', {}))
  check('rejected not persisted (retry re-executes)', failCalls === 2 && r8b.status === 'rejected')

  // ── 9. scope denial ──
  registry.register({ name: 'test.deny', visibility: 'member', mutation: true }, () => ({}))
  const r9 = await registry.dispatch(ctx, req('test.deny', 'op-d', {}))
  check('denied → SCOPE_DENIED', r9.status === 'rejected' && r9.error?.code === 'SCOPE_DENIED')

  // ── 10. query op: committed receipt but nothing persisted ──
  const before = (db.prepare('SELECT COUNT(*) c FROM operation_receipts').get() as { c: number }).c
  const r10 = await registry.dispatch(ctx, req('test.read', 'op-q', {}))
  const after = (db.prepare('SELECT COUNT(*) c FROM operation_receipts').get() as { c: number }).c
  check('query commits without receipt row', r10.status === 'committed' && before === after)

  // ── 11. surface.describe through dispatch ──
  const r11 = await registry.dispatch(ctx, req('surface.describe', 'op-s', {}))
  const sd = r11.result as { surfaceDigest: string; stale: boolean; operations: { name: string }[] }
  check(
    'surface.describe commits',
    r11.status === 'committed' && typeof sd.surfaceDigest === 'string'
  )
  check(
    'surface.describe lists visible ops',
    sd.operations.some((o) => o.name === 'test.ping')
  )
  check(
    'surface.describe hides unimplemented',
    !sd.operations.some((o) => o.name === 'test.unimplemented')
  )
  const r11b = await registry.dispatch(
    ctx,
    req('surface.describe', 'op-s2', { expectedSurfaceDigest: 'bogus' })
  )
  check('stale digest flagged', (r11b.result as { stale: boolean }).stale === true)
  const r11c = await registry.dispatch(
    ctx,
    req('surface.describe', 'op-s3', { operation: 'test.hidden' })
  )
  check(
    'describe hidden op → UNAVAILABLE',
    r11c.status === 'rejected' && r11c.error?.code === 'UNAVAILABLE_OPERATION'
  )
  const r11d = await registry.dispatch(
    ctx,
    req('surface.describe', 'op-s4', { operation: 'test.ping' })
  )
  check(
    'describe single visible op',
    r11d.status === 'committed' &&
      (r11d.result as { operations: { name: string }[] }).operations[0]?.name === 'test.ping'
  )
  // derived snapshot persisted for FK targets
  check(
    'command_surfaces snapshot persisted',
    (db.prepare('SELECT COUNT(*) c FROM command_surfaces').get() as { c: number }).c >= 1
  )

  // ── 12. makeCaller — nested cross-domain call joins ambient tx ──
  registry.register({ name: 'test.inner', visibility: 'member', mutation: false }, () => ({
    inner: 42
  }))
  registry.register({ name: 'test.outer', visibility: 'member', mutation: true }, (txn) => {
    const caller = makeCaller(registry, txn.ctx)
    return caller('test.inner', {}).then((v) => ({ wrapped: v }))
  })
  const r12 = await registry.dispatch(ctx, req('test.outer', 'op-o', {}))
  check(
    'makeCaller nested result',
    r12.status === 'committed' &&
      (r12.result as { wrapped: { inner: number } }).wrapped.inner === 42,
    r12
  )

  // makeCaller surfaces business failures as OperationCallError
  const caller = makeCaller(registry, ctx)
  let threw = false
  try {
    await caller('test.fail', {})
  } catch (e) {
    threw = (e as { mahasError?: { code: string } }).mahasError?.code === 'INPUT_NOT_READY'
  }
  check('makeCaller throws OperationCallError', threw)

  // ── 13. OPERATION_NAMES is exactly the central metadata table ──
  // The count is deliberately NOT hardcoded: the central table grows with each
  // domain that registers its operations (catalog/inventory/integration/
  // metering/…). What must stay true is that the projection covers the
  // metadata table 1:1, that names are unique and well-formed, and that the
  // frozen spec operations are still indexed.
  check(
    'OPERATION_NAMES projects OPERATION_TABLE 1:1',
    OPERATION_NAMES.length === OPERATION_TABLE.length &&
      OPERATION_TABLE.every((entry) => OPERATION_NAMES.includes(entry.name)),
    { names: OPERATION_NAMES.length, table: OPERATION_TABLE.length }
  )
  check(
    'operation names are unique',
    new Set(OPERATION_NAMES).size === OPERATION_NAMES.length,
    OPERATION_NAMES.length
  )
  check(
    'operation names are dotted lowerCamel segments',
    OPERATION_NAMES.every((name) => /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(name))
  )
  check(
    'every metadata entry carries contract + owner',
    OPERATION_TABLE.every((entry) => entry.contract.length > 0 && entry.owner.length > 0)
  )
  const requiredSpecOperations = [
    'surface.describe',
    'access.grant',
    'run.create',
    'plan.commit',
    'task.dispatch',
    'inbox.wait',
    'worker.start',
    'host.process.spawn',
    'runtime.reconcile'
  ]
  check(
    'frozen spec operations stay indexed',
    requiredSpecOperations.every((name) => OPERATION_NAMES.includes(name)),
    requiredSpecOperations.filter((name) => !OPERATION_NAMES.includes(name))
  )
  check('surface.describe indexed', OPERATION_NAMES.includes('surface.describe'))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
