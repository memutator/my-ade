// observation/attention.ts — the attention data port.
//
// Instruction §4.5: the legacy attention dedupe/settle policy
// (src/renderer/src/attention.ts) is ported here as a clear DATA port —
// dedupe verdicts, burst coalescing, pending-needs-input tracking and the
// working fold, with all UI concepts (window focus, OS banners, badges,
// toasts) removed. Whether a notification reaches the user is a renderer
// decision (IMP-28/31/32); this port only answers "is this signal a dup,
// and what is the target's attention-relevant state".
//
// REQ-23/REQ-24 honesty boundary: a verdict here NEVER settles a Task, acks
// a Delivery, or changes an input owner. The fold is derivable from stored
// facts — the only volatile state is the dedupe/burst timing map.

import {
  NOTIFY_FACT_TYPES,
  SETTLE_FACT_TYPES,
  WORKING_CLEAR_FACT_TYPES,
  WORKING_SET_FACT_TYPES
} from './facts.ts'
import type { ObservationRow } from './facts.ts'

export type AttentionVerdict = 'full' | 'quiet' | 'drop'

export interface AttentionSignal {
  factId: string
  factType: string
  source: string
  /** provider id from identity evidence (claude/codex/grok/…) */
  provider?: string
  /** provider-native session id — dedupe key component, not an authority */
  sessionId?: string
  /** message payload — distinguishes real consecutive turn-completes */
  message?: string
  /**
   * stable key of the thing the signal is about: `exec:<id>` when bound,
   * an evidence key otherwise. Same shape the fold uses, so dedupe and
   * projected state can never disagree about what "the target" is.
   */
  targetKey: string
}

export interface AttentionDecision {
  verdict: AttentionVerdict
  /** true when the fact type can demand attention at all (NOTIFY set) */
  notify: boolean
  reason: string
}

/**
 * What the fold derives per target — the attention-relevant projection the
 * snapshot/stream carry. `pendingInputSince` records when the open ask
 * appeared so clients can order/age it; it settles on the next settle-type
 * fact for the same target.
 */
export interface TargetAttention {
  targetKey: string
  working: boolean
  workingSince?: number
  pendingInput: boolean
  pendingInputSince?: number
  pendingFactId?: string
  lastActivityFactId?: string
}

/**
 * Second-layer dedupe — the port of the legacy renderer windows (the
 * transport-level identical-payload collapse stays ingress-side). Windows
 * span re-emit latency (compat double-registration, forwarded notify);
 * two REAL turns can finish within seconds and must not collapse, so
 * turn-complete keys on sessionId+message while needs-input stays
 * payload-blind (a re-asked permission is the same ask).
 */
export const ATTENTION_DEDUPE_MS: Readonly<Record<string, number>> = {
  'turn-complete': 15_000,
  'needs-input': 60_000,
  error: 20_000
}

/** turn-completes for one provider+target inside the burst window coalesce */
export const ATTENTION_BURST_MS = 3_000

const DEDUPE_DEFAULT_MS = 10_000
const DEDUPE_MAP_CAP = 500
const DEDUPE_MAP_EVICT_MS = 120_000

export interface AttentionTrackerOptions {
  now?: () => number
}

export class AttentionTracker {
  private readonly recent = new Map<string, number>()
  private readonly lastBurst = new Map<string, number>()
  private readonly now: () => number

  constructor(opts: AttentionTrackerOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  /**
   * Decide whether a notify-worthy signal should surface at full level.
   * Tracking-only fact types return verdict 'drop'/notify:false — they
   * still feed the fold (working/pending state) via foldFacts.
   *
   * `hookInstalled` ports the legacy process-idle suppression: when the
   * provider's hook is installed the hook owns completion, so a vanishing
   * process (usually the user quitting the CLI) never notifies.
   */
  decide(signal: AttentionSignal, opts: { hookInstalled?: boolean } = {}): AttentionDecision {
    if (signal.factType === 'process-idle' && opts.hookInstalled) {
      return { verdict: 'drop', notify: false, reason: 'hook-owned provider' }
    }
    if (signal.factType === 'process-idle') {
      // process fallback synthesizes completion only when no hook owns it —
      // it is still weaker evidence than a hook turn-complete (recorded as
      // 'process-idle', never re-typed — output silence is not completion)
      return this.dedupe(signal, 'pty-idle')
    }
    if (!NOTIFY_FACT_TYPES.has(signal.factType)) {
      return { verdict: 'drop', notify: false, reason: 'tracking' }
    }
    return this.dedupe(signal, 'fact')
  }

  private dedupe(signal: AttentionSignal, via: string): AttentionDecision {
    const now = this.now()
    const kind = signal.factType
    const key =
      kind === 'turn-complete'
        ? `${signal.provider ?? ''}|${signal.targetKey}|${kind}|${signal.sessionId ?? ''}|${signal.message ?? ''}`
        : `${signal.provider ?? ''}|${signal.targetKey}|${kind}`
    const last = this.recent.get(key)
    if (last !== undefined && now - last < (ATTENTION_DEDUPE_MS[kind] ?? DEDUPE_DEFAULT_MS)) {
      return { verdict: 'quiet', notify: true, reason: `dedupe ${via}` }
    }
    this.recent.set(key, now)
    if (kind === 'turn-complete') {
      const bkey = `${signal.provider ?? ''}|${signal.targetKey}`
      const blast = this.lastBurst.get(bkey)
      this.lastBurst.set(bkey, now)
      if (blast !== undefined && now - blast < ATTENTION_BURST_MS) {
        return { verdict: 'quiet', notify: true, reason: `burst ${via}` }
      }
    }
    if (this.recent.size > DEDUPE_MAP_CAP) {
      for (const [k, ts] of this.recent) if (now - ts > DEDUPE_MAP_EVICT_MS) this.recent.delete(k)
    }
    return { verdict: 'full', notify: true, reason: via }
  }
}

/**
 * Fold an execution's facts into its attention state. Pure and rebuildable
 * from the ledger — restart-safe because the authoritative inputs are the
 * stored ObservationFacts, not this process's memory.
 *
 * Ported rules:
 *  - turn-start lights working; WORKING_CLEAR types drop it.
 *  - needs-input opens a pending ask; SETTLE types close it (a re-asked
 *    needs-input re-keys the pending record to the newest fact).
 *  - idle/other/session-rename never settle a live prompt and never light
 *    working — sub-session churn isn't the user's turn ending.
 */
export function foldFacts(targetKey: string, facts: readonly ObservationRow[]): TargetAttention {
  const out: TargetAttention = { targetKey, working: false, pendingInput: false }
  for (const f of facts) {
    const t = f.factType
    if (SETTLE_FACT_TYPES.has(t) && t !== 'needs-input') {
      out.pendingInput = false
      out.pendingInputSince = undefined
      out.pendingFactId = undefined
    }
    if (WORKING_SET_FACT_TYPES.has(t)) {
      if (!out.working) out.workingSince = f.observedAt
      out.working = true
    } else if (WORKING_CLEAR_FACT_TYPES.has(t)) {
      out.working = false
      out.workingSince = undefined
    }
    if (t === 'needs-input') {
      out.pendingInput = true
      out.pendingInputSince = f.observedAt
      out.pendingFactId = f.id
    }
    out.lastActivityFactId = f.id
  }
  return out
}

/** projected activity for the snapshot — foldFacts over the stored facts */
export function activityOf(att: TargetAttention): 'working' | 'idle' | 'needs-input' | 'unknown' {
  if (att.pendingInput) return 'needs-input'
  if (att.working) return 'working'
  return att.lastActivityFactId ? 'idle' : 'unknown'
}

/** stable dedupe/fold key — bound facts key on execution, unbound on evidence */
export function targetKeyFor(
  executionId: string | null,
  evidence: Record<string, unknown>
): string {
  if (executionId) return `exec:${executionId}`
  const pane = typeof evidence.paneId === 'string' ? evidence.paneId : ''
  const tab = typeof evidence.tabId === 'string' ? evidence.tabId : ''
  if (pane || tab) return `view:${pane}:${tab}`
  const sid = typeof evidence.nativeSessionId === 'string' ? evidence.nativeSessionId : ''
  if (sid) return `native:${sid}`
  return 'unbound'
}
