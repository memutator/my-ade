// Legacy usage/quota IPC — a COMPATIBILITY ADAPTER over the domain store.
//
// This module used to hold nine provider probes (grok/claude/codex/gemini/
// copilot/zai/opencode/devin/cline): each one unlocked that CLI's credential
// file, refreshed its OAuth token and called the same undocumented endpoint the
// CLI's own usage screen uses. Opening the usage widget therefore performed
// credential I/O and provider HTTP from the desktop.
//
// That is gone. Quota now arrives the same way every other stored fact does:
// daemon-side collection writes typed QuotaReadings into the control DB, and
// `usage:fetch` projects the newest stored reading for a connection into the
// old wire shape. The rules that follow are deliberate:

//   · a query never touches a credential file, a session log or a network
//     endpoint — if the store has no reading, the answer says so;
//   · the last SUCCESS and the current FAILURE stay separate facts, so a failing
//     probe never erases the numbers a user was looking at;
//   · `null` stays unknown: a meter without a known limit is reported as
//     unknown rather than 0%.
//
// The migrated UI reads `window.mahas.domain.*`; this adapter exists so the
// older channels keep their shape while consumers move.

import { ipcMain } from 'electron'
import type { QuotaMeter, QuotaReading } from '../../packages/mahas-contracts/src/index.ts'
import type { LedgerQuery, LedgerResult, UsageResult, UsageWindow } from '../preload/index'
import { emptyLedger, projectLedger } from './ledger'
import { readUsageLedger, readUsageSources, requestCollection } from './runtime/domainIpc'

/** Meter utilization → the legacy 0–100 percentage. A ratio is used only when
 *  used/limit is not derivable, and it is read as a fraction of the limit. */
function usedPercent(meter: QuotaMeter): number | undefined {
  if (meter.used != null && meter.limit != null && meter.limit > 0) {
    return Math.max(0, Math.min(100, (meter.used / meter.limit) * 100))
  }
  if (meter.utilization != null) {
    return Math.max(0, Math.min(100, meter.utilization * 100))
  }
  return undefined
}

function meterDetail(meter: QuotaMeter): string | undefined {
  if (meter.availability === 'unlimited') return 'unlimited'
  const bits: string[] = []
  if (meter.remaining != null && meter.limit != null) {
    bits.push(`${meter.remaining}/${meter.limit} ${meter.unit} left`)
  } else if (meter.remaining != null) {
    bits.push(`${meter.remaining} ${meter.unit} left`)
  }
  if (meter.availability === 'unknown' && !bits.length) return 'unknown'
  const period = meter.period
  if (period?.kind && period.kind !== 'unknown') bits.push(period.kind)
  return bits.join(' · ') || undefined
}

function quotaWindows(reading: QuotaReading): UsageWindow[] {
  return reading.payload.meters.map((meter) => {
    const usedPct = usedPercent(meter)
    const resetAt = meter.period?.resetAt ?? meter.period?.endsAt ?? undefined
    const detail = meterDetail(meter)
    return {
      id: meter.key,
      label: meter.label,
      ...(usedPct === undefined ? {} : { usedPct }),
      ...(resetAt == null ? {} : { resetAt }),
      ...(detail ? { detail } : {})
    }
  })
}

function accountOf(reading: QuotaReading | null): string | undefined {
  if (!reading) return undefined
  const claims = reading.payload.identityClaims
  const preferred = claims.find((claim) => claim.kind === 'email') ?? claims[0]
  return preferred?.value
}

function planOf(reading: QuotaReading | null): string | undefined {
  if (!reading) return undefined
  const claim = reading.payload.planClaims[0]
  return claim ? (claim.label ?? claim.value) : undefined
}

function extrasOf(reading: QuotaReading | null): string | undefined {
  if (!reading) return undefined
  const bits = reading.payload.planClaims
    .slice(1)
    .map((claim) => `${claim.label ?? claim.key}: ${claim.value}`)
  const entitlements = reading.payload.entitlements.map((entry) => entry.key)
  return [...bits, ...entitlements].join(' · ') || undefined
}

function failureText(reading: QuotaReading | null): string | undefined {
  if (!reading || reading.payload.status === 'success') return undefined
  return (
    reading.payload.diagnostics[0]?.message ?? `quota collection reported ${reading.payload.status}`
  )
}

/** Project one connection's stored quota state into the legacy result. */
function projectQuota(input: {
  harnessId: string
  view: {
    latest: QuotaReading | null
    lastSuccess: QuotaReading | null
    failure: QuotaReading | null
  } | null
}): UsageResult {
  const base = { provider: input.harnessId }
  const view = input.view
  // What the user should see is the newest reading that succeeded; a later
  // failure is reported alongside it instead of replacing it.
  const shown = view?.lastSuccess ?? view?.latest ?? null
  const failure = failureText(
    view?.lastSuccess ? view.failure : (view?.failure ?? view?.latest ?? null)
  )
  if (!shown) {
    return {
      ...base,
      ok: false,
      windows: [],
      error: failure ?? 'no stored quota reading for this harness yet',
      fetchedAt: view?.failure?.observedAt ?? Date.now()
    }
  }
  const account = accountOf(shown)
  const plan = planOf(shown)
  const extra = extrasOf(shown)
  return {
    ...base,
    ok: !failure,
    ...(plan ? { plan } : {}),
    ...(account ? { account } : {}),
    windows: quotaWindows(shown),
    ...(extra ? { extra } : {}),
    ...(failure ? { error: failure } : {}),
    fetchedAt: shown.observedAt
  }
}

async function fetchUsage(harnessId: string, credPath?: string): Promise<UsageResult> {
  const sources = await readUsageSources({
    ...(credPath ? { legacySources: [{ id: credPath, path: credPath, harnessId }] } : {})
  })
  if (!sources.ok) {
    return {
      provider: harnessId,
      ok: false,
      windows: [],
      error: sources.error.message,
      fetchedAt: Date.now()
    }
  }
  const wanted = credPath
    ? sources.value.sources.find((source) => source.materialRef === credPath)
    : undefined
  const source =
    wanted ??
    sources.value.sources.find(
      (candidate) => candidate.origin === 'domain' && candidate.harnessId === harnessId
    )
  if (!source || source.origin !== 'domain' || !source.connectionId) {
    return {
      provider: harnessId,
      ok: false,
      windows: [],
      error: sources.value.readiness.diagnostics[0] ?? 'this harness has no stored connection yet',
      fetchedAt: Date.now()
    }
  }
  const view =
    sources.value.quota.find((entry) => entry.connectionId === source.connectionId) ?? null
  return projectQuota({ harnessId, view })
}

async function readLedger(tracked: LedgerQuery[], force: boolean): Promise<LedgerResult> {
  if (force) {
    // The old `force` re-read the source files. Refresh now means "queue
    // collection work for the daemon scheduler", which is a separate
    // operation; a refusal is not an error for the caller — the stored answer
    // simply stays current.
    await requestCollection({ capability: 'usage', reason: 'usage-ledger-refresh' })
  }
  const result = await readUsageLedger({ limit: 2_000 })
  if (!result.ok) return emptyLedger(tracked)
  return projectLedger({
    tracked,
    items: result.value.items,
    fetchedAt: result.value.freshness.asOf
  })
}

export function registerUsageIpc(): void {
  ipcMain.handle('usage:fetch', (_e, harnessId: string, credPath?: string): Promise<UsageResult> =>
    fetchUsage(
      String(harnessId ?? ''),
      typeof credPath === 'string' && credPath ? credPath : undefined
    )
  )
  ipcMain.handle(
    'usage:ledger',
    async (_e, tracked: LedgerQuery[], force?: boolean): Promise<LedgerResult> => {
      const list = Array.isArray(tracked)
        ? tracked.filter((entry) => entry && typeof entry.sessionId === 'string')
        : []
      return readLedger(list, !!force)
    }
  )
}
