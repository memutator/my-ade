// Renderer client for the canonical domain reads and auth actions.
//
// Everything the usage/tokens UI shows comes through here, and every call is a
// request for STORED data:
//   · no call scans a harness directory, parses a session log or probes a
//     provider — that work belongs to the daemon's collection scheduler;
//   · a manual refresh is `requestCollection()` (a mutation that queues work per
//     source) followed by a normal re-read, so the UI never conflates "show me"
//     with "go collect";
//   · a transport failure is `{ ok: false, error }` and a partial stored answer
//     is `{ ok: true, value.readiness }` — different states on screen ("cannot
//     reach the store" vs "the store only covers part of this").

import type {
  ControlError,
  ControlResult
} from '../../../../../packages/mahas-contracts/src/index.ts'
import type {
  DomainAuthFlow,
  DomainAuthFileImportRequest,
  DomainAuthFileImportResult,
  DomainAuthOutcome,
  DomainAuthRefreshRequest,
  DomainCollectionRequest,
  DomainCollectionRequestResult,
  DomainCollectionSourcesResult,
  DomainLegacySource,
  DomainSessionDetailResult,
  DomainSessionsRequest,
  DomainSessionsResult,
  DomainSourceRemovalResult,
  DomainUsageLedgerRequest,
  DomainUsageLedgerResult,
  DomainUsageSourcesResult,
  DomainUsageStatisticsRequest,
  DomainUsageStatisticsResult,
  DomainUsageSummariesResult,
  DomainUsageSummaryRequest
} from '../../../../preload/domain'

/** Result of one domain read: a stored answer (which may itself carry a partial
 *  or unavailable readiness) or a transport-level error. */
export type DomainLoad<T> = { ok: true; value: T } | { ok: false; error: ControlError }

async function load<T>(call: () => Promise<ControlResult<T>>): Promise<DomainLoad<T>> {
  try {
    return await call()
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'CONTROL_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
        retryable: true
      }
    }
  }
}

export interface UsageSourcesRequest {
  legacySources?: DomainLegacySource[]
  limit?: number
}

export function loadUsageSources(
  request: UsageSourcesRequest = {}
): Promise<DomainLoad<DomainUsageSourcesResult>> {
  return load(() => window.mahas.domain.usageSources(request))
}

export function loadUsageLedger(
  request: DomainUsageLedgerRequest = {}
): Promise<DomainLoad<DomainUsageLedgerResult>> {
  return load(() => window.mahas.domain.usageLedger(request))
}

export function loadUsageSummaries(
  request: DomainUsageSummaryRequest = {}
): Promise<DomainLoad<DomainUsageSummariesResult>> {
  return load(() => window.mahas.domain.usageSummaries(request))
}

export function loadUsageStatistics(
  request: DomainUsageStatisticsRequest = {}
): Promise<DomainLoad<DomainUsageStatisticsResult>> {
  return load(() => window.mahas.domain.usageStatistics(request))
}

export function loadStoredSessions(
  request: DomainSessionsRequest = {}
): Promise<DomainLoad<DomainSessionsResult>> {
  return load(() => window.mahas.domain.sessions(request))
}

export function loadSessionDetail(
  sessionId: string
): Promise<DomainLoad<DomainSessionDetailResult>> {
  return load(() => window.mahas.domain.sessionDetail(sessionId))
}

export function loadCollectionSources(): Promise<DomainLoad<DomainCollectionSourcesResult>> {
  return load(() => window.mahas.domain.collectionSources())
}

/** Close a canonical source. Stored usage history stays; the connection stops
 *  being offered and its config bindings end. */
export function removeUsageSource(
  connectionId: string
): Promise<ControlResult<DomainSourceRemovalResult>> {
  return window.mahas.domain.removeSource({ connectionId, sourceRef: 'usage-widget' })
}

/** Ask the daemon's scheduler for collection work. Separate from every read
 *  above on purpose: opening or re-reading a view never starts collection. */
export function requestCollection(
  request: DomainCollectionRequest = {}
): Promise<ControlResult<DomainCollectionRequestResult>> {
  return window.mahas.domain.requestCollection(request)
}

// ── provider sign-in (dedicated auth channel) ──────────────────────────────

export function startAuth(
  offeringId: string,
  connectionId?: string
): Promise<ControlResult<DomainAuthFlow>> {
  return window.mahas.domain.authStart({
    offeringId,
    ...(connectionId ? { connectionId } : {})
  })
}

export function submitAuthCode(
  flowId: string,
  code: string
): Promise<ControlResult<DomainAuthOutcome>> {
  return window.mahas.domain.authSubmitCode({ flowId, code })
}

export function saveAuthSecret(
  flowId: string,
  secret: string
): Promise<ControlResult<DomainAuthOutcome>> {
  return window.mahas.domain.authSaveSecret({ flowId, secret })
}

export function pollAuthFlow(flowId: string): Promise<ControlResult<DomainAuthFlow>> {
  return window.mahas.domain.authPoll(flowId)
}

export function cancelAuthFlow(flowId: string): Promise<ControlResult<null>> {
  return window.mahas.domain.authCancel(flowId)
}

export function refreshCredential(
  request: DomainAuthRefreshRequest
): Promise<ControlResult<DomainAuthOutcome>> {
  return window.mahas.domain.authRefresh(request)
}

/** Import one existing credential file into the canonical inventory: the daemon
 *  registers it as a read-only locator connection (the Pack catalog decides the
 *  format from the offering). The request carries a path, never file content —
 *  the material stays where the user put it. */
export function importAuthFile(
  request: DomainAuthFileImportRequest
): Promise<ControlResult<DomainAuthFileImportResult>> {
  return window.mahas.domain.authImportFile(request)
}
