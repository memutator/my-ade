// Hook-stream wire contract.
//
// The NDJSON transport that harness hooks invoke (builtin.harness-runtime →
// hooks/mahas-hook.cjs) writes one AgentHookEvent per line; the desktop tails
// that file and hands records to the daemon through session.hook.ingest, which
// validates against these types. Main, preload and renderer re-export them
// instead of declaring their own copies.

import type { JsonObject } from '../common.ts'

/** Notification-exclusion hints recorded by the transport and applied later. */
export interface AgentHookEventPolicy {
  /** demote to a tracking-only kind for user-facing consumers */
  demote?: boolean
  /** never claim a resume record for this event */
  stripSession?: boolean
}

/**
 * One normalized harness event. Identity fields (nativeEvent, sessionId,
 * parentSessionId, child, internalRun, external) are preserved exactly as the
 * harness reported them — an exclusion is expressed by `policy`, never by
 * deleting identity.
 */
export interface AgentHookEvent {
  /** line format version (2 = identity + policy fields present) */
  v?: number
  provider: string
  event: string
  /** native hook event name as the harness reported it */
  nativeEvent?: string
  /** classification this line was demoted from, when policy demoted it */
  demotedFrom?: string
  /** subagent run (native parent session or harness subagent marker) */
  child?: boolean
  /** internal catch-up thread — observed, never a resumable target */
  internalRun?: boolean
  parentSessionId?: string
  /** emitted by a process without this instance's MAHAS_SESSION */
  external?: boolean
  policy?: AgentHookEventPolicy
  cwd?: string
  sessionId?: string
  message?: string
  mahasSession?: string
  /** set by the tailer: true when the event carries this instance's session */
  ours?: boolean
  /** session-rename payload: the new session name */
  name?: string
  /** bypass attention gating — hooks:test synthetic events always deliver at
   *  full level (the point of the test is seeing the banner) */
  force?: boolean
  /** pty-stamped hosting pane/tab (exact attribution) */
  paneId?: string
  tabId?: string
  /** installation/machine identity when the spawning shell knew it; without it
   *  the daemon records an unknown installation and the hook namespace */
  installationId?: string
  machineId?: string
  /** namespace the native session key belongs to (hook streams: 'hook') */
  namespace?: string
  /** the harness's resume verdict for this session, when it is known */
  resumeSupport?: 'supported' | 'unsupported' | 'unknown'
  ts?: number
  /** durable record key of this event in the hook stream */
  sourceRecordKey?: string
}

/** One durable record inside the hook stream. */
export interface AgentHookIngestRecord {
  /** stable key: stream + generation + byte offset (`<path>#<gen>:<offset>`) */
  sourceRecordKey: string
  offset: number
  /** increments when the stream is truncated/rotated, so offsets cannot collide */
  generation: number
  /** the line exactly as written by the transport */
  raw: string
  event: AgentHookEvent
}

export interface AgentHookIngestSource {
  sourceKey: string
  kind: 'hook-stream'
  locator: { path: string; harnessId?: string }
  generation: string
}

/** Request of the daemon operation `session.hook.ingest`. */
export interface AgentHookIngestRequest {
  source: AgentHookIngestSource
  records: AgentHookIngestRecord[]
}

/**
 * Verdict of `session.hook.ingest`. `unavailable` is not a failure of the
 * transport: it says the daemon cannot take hook events yet, so the desktop
 * commits locally and records the degradation.
 */
export interface AgentHookIngestResult {
  committed: boolean
  recordKeys?: string[]
  reason?: string
  retryable?: boolean
  unavailable?: boolean
}

/** Extra metadata the desktop may attach; never required by the daemon. */
export interface AgentHookIngestMeta extends JsonObject {
  desktop?: { version?: number }
}
