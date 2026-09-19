// rollup.smoke.ts — exact-shape rollup selection over stored summary rows.
//
// Run:  node src/renderer/src/features/usage/rollup.smoke.ts
//
// Synthetic-only: plain in-memory UsageSummary rows — no store, no IPC, no
// database, no provider API. Proves the projections never double-count:
// every axis family reads exactly its own stored shapes, a null value is a
// grouping bucket (not an absent axis), and requested/served model rollups
// stay separate.

import assert from 'node:assert/strict'
import type {
  UsageDimensions,
  UsageSummary,
  UsageValues
} from '../../../../../packages/mahas-contracts/src/index.ts'
import {
  dimensionAxes,
  displayTotal,
  exactShape,
  globalSummary,
  harnessTotals,
  modelBreakdown,
  offeringTotals,
  poolShares,
  providerTotals,
  sumAttribution,
  sumCoverage,
  sumValues
} from './rollup.ts'

let seq = 0
const values = (total: number | null, over: Partial<UsageValues> = {}): UsageValues => ({
  inputTotal: null,
  outputTotal: null,
  total,
  cacheReadInput: null,
  cacheWriteInput: null,
  reasoningOutput: null,
  ...over
})

const sum = (
  dimensions: UsageDimensions,
  total: number | null,
  over: Partial<UsageSummary> = {}
): UsageSummary => ({
  key: `k${seq++}`,
  dimensions,
  totals: values(total),
  coverage: {
    completeness: 'complete',
    knownTokens: total ?? 0,
    unknownTokens: 0,
    unallocatedTimeTokens: 0,
    coverageIds: []
  },
  attributionCoverage: { attributedTokens: total ?? 0, unattributedTokens: 0, status: 'complete' },
  definitionRevision: 1,
  ledgerWatermark: '0',
  attributionWatermark: '0',
  aggregateGeneration: 'g1',
  pending: false,
  computedAt: 1,
  ...over
})

const totalOf = (row: { totals: UsageValues }): number | null => displayTotal(row.totals)

// ── presence, not value: {providerId:null} is a grouped row, {} is not ──────
{
  const rows = [sum({}, 100), sum({ providerId: null }, 40), sum({ providerId: 'p1' }, 60)]
  assert.deepEqual(dimensionAxes(rows[0]!), [])
  assert.deepEqual(dimensionAxes(rows[1]!), ['providerId'], 'a null value is still a grouping axis')
  assert.equal(exactShape(rows, []).length, 1, 'only the {} row matches the empty shape')
  assert.equal(globalSummary(rows), rows[0])
  const providers = providerTotals(rows)
  assert.equal(providers.length, 2, 'the unattributed bucket stays its own group')
  assert.equal(totalOf(providers.find((v) => v.id === null)!), 40)
  assert.equal(totalOf(providers.find((v) => v.id === 'p1')!), 60)
}

// ── one consistent store: every family partitions the same 100 tokens ───────
// e1: 60 tokens provider p1 / offering o1 / harness codex / machine m1 / req A / served B
// e2: 40 tokens unattributed, same harness+machine, no models
{
  const pool = { providerPoolKey: 'pool-1', scope: 'team' }
  const reqA = { namespace: 'anthropic', nativeName: 'a-model' }
  const srvB = { namespace: 'anthropic', nativeName: 'b-model' }
  const rows = [
    sum({}, 100),
    sum({ machineId: 'm1', harnessId: 'codex' }, 100),
    sum({ machineId: 'm1', providerId: 'p1' }, 60),
    sum({ machineId: 'm1', providerId: null }, 40),
    sum({ machineId: 'm1', harnessId: 'codex', offeringId: 'o1' }, 60),
    sum({ machineId: 'm1', harnessId: 'codex', offeringId: null }, 40),
    sum({ machineId: 'm1', harnessId: 'codex', offeringId: 'o1', connectionId: 'c1' }, 60),
    sum({ machineId: 'm1', harnessId: 'codex', offeringId: null, connectionId: null }, 40),
    sum({ requestedModel: reqA }, 60),
    sum({ requestedModel: null }, 40),
    sum({ servedModel: srvB }, 60),
    sum({ servedModel: null }, 40),
    sum({ machineId: 'm1', harnessId: 'codex', requestedModel: reqA }, 60),
    sum({ machineId: 'm1', harnessId: 'codex', requestedModel: null }, 40),
    sum({ machineId: 'm1', harnessId: 'codex', servedModel: srvB }, 60),
    sum({ machineId: 'm1', harnessId: 'codex', servedModel: null }, 40),
    sum({ verifiedPool: pool }, 80),
    sum({ machineId: 'm1', harnessId: 'codex', verifiedPool: pool }, 50),
    sum({ machineId: 'm1', harnessId: 'claude', verifiedPool: pool }, 30)
  ]
  const global = globalSummary(rows)!
  assert.equal(totalOf(global), 100)

  // Each family sums back to the global total through its OWN shapes only —
  // folding a finer shape in (e.g. offering rows into provider totals) would
  // double-count and break every one of these equalities.
  const familySum = (views: readonly { totals: UsageValues }[]): number =>
    views.reduce((t, v) => t + (displayTotal(v.totals) ?? 0), 0)
  assert.equal(familySum(providerTotals(rows)), 100)
  assert.equal(familySum(harnessTotals(rows)), 100)
  assert.equal(familySum(offeringTotals(rows)), 100)

  // harnessTotals drops a null harnessId — it is not a harness.
  const withNullHarness = [...rows, sum({ machineId: 'm1', harnessId: null }, 7)]
  assert.equal(familySum(harnessTotals(withNullHarness)), 100)

  // Requested and served are different rollups over the same entries: two
  // side-by-side lists, never one summed number.
  const models = modelBreakdown(rows)
  assert.equal(models.requested.length, 2)
  assert.equal(models.served.length, 2)
  assert.equal(totalOf(models.requested.find((v) => v.ref?.nativeName === 'a-model')!), 60)
  assert.equal(totalOf(models.served.find((v) => v.ref?.nativeName === 'b-model')!), 60)
  assert.equal(
    models.requested.find((v) => v.ref === null)!.totals.total,
    40,
    'entries with no requested model keep a visible group'
  )
  // a {requestedModel} row is never selected by the served axis even when the
  // native names collide
  assert.equal(
    models.served.every((v) => v.ref?.nativeName !== 'a-model'),
    true
  )

  // Verified-pool observed shares: the {verifiedPool} row is the denominator,
  // {machineId?,harnessId,verifiedPool} rows are per-harness numerators.
  const shares = poolShares(rows)
  assert.equal(shares.length, 1)
  assert.equal(shares[0]!.denominator, 80)
  assert.equal(shares[0]!.denominatorCoverage, 'complete')
  const byHarness = new Map(shares[0]!.shares.map((s) => [s.harnessId, s]))
  assert.equal(byHarness.get('codex')!.numerator, 50)
  assert.ok(Math.abs(byHarness.get('codex')!.share! - 0.625) < 1e-9)
  assert.equal(byHarness.get('claude')!.share, 0.375)
  // the 20 tokens outside every pool are a remainder for the caller, not a share
  assert.equal(shares[0]!.shares.length, 2)
}

// ── pool coverage degrades honestly ──────────────────────────────────────────
{
  const pool = { providerPoolKey: 'p', scope: 's' }
  const gap = poolShares([
    sum({ verifiedPool: pool }, 50, {
      coverage: {
        completeness: 'gap',
        knownTokens: 50,
        unknownTokens: null,
        unallocatedTimeTokens: 0,
        coverageIds: []
      }
    }),
    sum({ machineId: 'm1', harnessId: 'h1', verifiedPool: pool }, 50)
  ])
  assert.equal(gap[0]!.denominatorCoverage, 'partial', 'a denominator gap reads as partial')
  const noDenominator = poolShares([
    sum({ machineId: 'm1', harnessId: 'h1', verifiedPool: pool }, 50)
  ])
  assert.equal(noDenominator[0]!.denominatorCoverage, 'unknown')
  assert.equal(noDenominator[0]!.shares[0]!.share, null, 'no denominator, no share — never 100%')
}

// ── sumValues: unknown stays null, partially-known is a marked lower bound ──
{
  const mixed = sumValues([values(10, { inputTotal: null }), values(5, { inputTotal: 3 })])
  assert.equal(mixed.values.total, 15)
  assert.equal(mixed.values.inputTotal, 3)
  assert.deepEqual(mixed.partialComponents, ['inputTotal'])
  assert.deepEqual(
    [...mixed.unknownComponents].sort(),
    ['cacheReadInput', 'cacheWriteInput', 'outputTotal', 'reasoningOutput'],
    'components no entry reported are unknown — inputTotal is partial, not unknown'
  )
  const none = sumValues([values(null), values(null)])
  assert.equal(none.values.total, null)
  assert.ok(none.unknownComponents.includes('total'))
}

// ── coverage sums over disjoint partitions ───────────────────────────────────
{
  const complete = sum({}, 10)
  const gapRow = sum({}, 5, {
    coverage: {
      completeness: 'gap',
      knownTokens: 5,
      unknownTokens: null,
      unallocatedTimeTokens: 2,
      coverageIds: ['c2']
    },
    attributionCoverage: { attributedTokens: 3, unattributedTokens: 2, status: 'partial' }
  })
  const coverage = sumCoverage([complete, gapRow])
  assert.equal(coverage.completeness, 'gap', 'the worst partition decides')
  assert.equal(coverage.knownTokens, 15)
  assert.equal(coverage.unknownTokens, null, 'one unquantified partition keeps the sum unknown')
  const attribution = sumAttribution([complete, gapRow])
  assert.equal(attribution.status, 'partial')
  assert.equal(attribution.attributedTokens, 13)
}

// ── displayTotal: stored total wins; input+output synthesize a lower bound ──
{
  assert.equal(displayTotal(values(42, { inputTotal: 1, outputTotal: 1 })), 42)
  assert.equal(displayTotal(values(null, { inputTotal: 30, outputTotal: 10 })), 40)
  assert.equal(displayTotal(values(null, { inputTotal: 30 })), null)
}

console.log('usage rollup smoke: ok')
