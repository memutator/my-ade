// Legacy usage-ledger wire shape — a COMPATIBILITY PROJECTION, not a source.
//
// This file used to hold the desktop's own per-harness transcript scanners
// (grok/claude/codex/opencode/zcode/devin/cline readers running in a worker
// thread). Those scanners are gone: usage is collected, normalized and
// persisted by the daemon's adapter Packs, and the desktop only projects the
// stored ledger into the old `usage:ledger` wire shape for consumers that were
// written against it.
//
// The projection is deliberately lossy in one direction only: a token
// component the stored reading reports as UNKNOWN projects to 0 to keep the
// old numeric contract, and the component name is listed in
// `unknownComponents` so a caller can tell "unknown" from "measured zero".
// Nothing here reads a file, opens a database, or guesses a session's harness:
// entries carry their own harness/session identity from the daemon store.

import type {
  UsageAttribution,
  UsageEntry,
  UsageValues
} from '../../packages/mahas-contracts/src/index.ts'
// The wire DTOs live in the preload transport module; this projection only
// fills them in. Re-exported so main-side callers keep one import path.
import type {
  LedgerProfile,
  LedgerQuery,
  LedgerResult,
  LedgerSession,
  TokenUse
} from '../preload/index'

export type { LedgerProfile, LedgerQuery, LedgerResult, LedgerSession, TokenUse }

type TokenComponent =
  'inputTotal' | 'outputTotal' | 'total' | 'cacheReadInput' | 'cacheWriteInput' | 'reasoningOutput'

interface TokenAccumulator {
  input: number
  output: number
  cached: number
  reasoning: number
  total: number
  costUsd: number
  costKnown: boolean
  unknown: Set<string>
}

const emptyAccumulator = (): TokenAccumulator => ({
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  total: 0,
  costUsd: 0,
  costKnown: false,
  unknown: new Set<string>()
})

function accumulate(target: TokenAccumulator, values: UsageValues, entry: UsageEntry): void {
  const add = (
    key: TokenComponent,
    field: 'input' | 'output' | 'cached' | 'reasoning' | 'total'
  ): void => {
    const value = values[key]
    if (value === null) {
      target.unknown.add(field)
      return
    }
    target[field] += value
  }
  add('inputTotal', 'input')
  add('outputTotal', 'output')
  add('cacheReadInput', 'cached')
  add('reasoningOutput', 'reasoning')
  add('total', 'total')
  if (entry.cost && entry.cost.currency === 'USD') {
    target.costUsd += entry.cost.amount
    target.costKnown = true
  }
}

function accumulatorToTokenUse(target: TokenAccumulator): TokenUse {
  return {
    input: target.input,
    output: target.output,
    cached: target.cached,
    reasoning: target.reasoning,
    total: target.total || target.input + target.output,
    ...(target.costKnown ? { costUsd: target.costUsd } : {}),
    ...(target.unknown.size ? { unknownComponents: [...target.unknown].sort() } : {})
  }
}

const counted = (entry: UsageEntry): boolean =>
  entry.accountingStatus === 'counted' || entry.accountingStatus === 'unresolved'

/** Project stored ledger rows (`usage.entry.list` items: entry + its current
 *  attribution) into the legacy shapes. `tracked` supplies display metadata
 *  (name/cwd) only — harness and totals always come from the stored entry, never
 *  from the caller's guess. */
export function projectLedger(input: {
  tracked: LedgerQuery[]
  items: readonly { entry: UsageEntry; attribution: UsageAttribution | null }[]
  fetchedAt?: number
}): LedgerResult {
  const entries = input.items.map((item) => item.entry).filter(counted)
  const bySession = new Map<string, UsageEntry[]>()
  const byHarness = new Map<string, { accumulator: TokenAccumulator; sessions: Set<string> }>()
  for (const entry of entries) {
    if (entry.sessionId) {
      const list = bySession.get(entry.sessionId) ?? []
      list.push(entry)
      bySession.set(entry.sessionId, list)
    }
    const bucket = byHarness.get(entry.harnessId) ?? {
      accumulator: emptyAccumulator(),
      sessions: new Set<string>()
    }
    accumulate(bucket.accumulator, entry.normalizedTokens, entry)
    if (entry.sessionId) bucket.sessions.add(entry.sessionId)
    byHarness.set(entry.harnessId, bucket)
  }

  const attributionByEntry = new Map<string, UsageAttribution>()
  for (const item of input.items) {
    if (item.attribution) attributionByEntry.set(item.entry.id, item.attribution)
  }

  const sessions: LedgerSession[] = input.tracked.map((tracked) => {
    const rows = bySession.get(tracked.sessionId) ?? []
    const accumulator = emptyAccumulator()
    for (const entry of rows) accumulate(accumulator, entry.normalizedTokens, entry)
    const newest = rows.reduce<UsageEntry | null>(
      (latest, entry) => (!latest || entry.createdAt > latest.createdAt ? entry : latest),
      null
    )
    const attribution = newest ? attributionByEntry.get(newest.id) : undefined
    return {
      sessionId: tracked.sessionId,
      provider: newest?.harnessId ?? tracked.provider,
      ...(tracked.name ? { title: tracked.name } : {}),
      ...(tracked.cwd ? { cwd: tracked.cwd } : {}),
      tokens: accumulatorToTokenUse(accumulator),
      found: rows.length > 0,
      ...(attribution ? { attribution: attribution.status } : {})
    }
  })

  const profiles: LedgerProfile[] = [...byHarness.entries()]
    .map(([harnessId, bucket]) => ({
      provider: harnessId,
      sessionCount: bucket.sessions.size,
      tokens: accumulatorToTokenUse(bucket.accumulator)
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total)

  return { profiles, sessions, fetchedAt: input.fetchedAt ?? Date.now() }
}

/** Empty answer for a read that could not reach the store — every tracked
 *  session reports `found: false` and no totals, instead of a fabricated 0. */
export function emptyLedger(tracked: LedgerQuery[], fetchedAt = Date.now()): LedgerResult {
  return projectLedger({ tracked, items: [], fetchedAt })
}
