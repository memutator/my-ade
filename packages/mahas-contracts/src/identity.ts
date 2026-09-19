// mahas-contracts — shared identity model.
//
// REQ-11 / spec/domains/execution.md §1: Member, Execution,
// ProcessIncarnation, Terminal, NativeConversation, Task, Dispatch and UI
// View are SEPARATE identities. These types give every boundary the same
// vocabulary without letting any of them collapse into one another — a
// pane/tab is a View, never an Execution; a Terminal is host-owned, never
// a pane.
//
// Ids are plain strings on the wire. Branding is deliberately not applied:
// the honesty rule is structural (separate fields), not nominal.

// The canonical persistent identity of a native conversation lives in
// ./sessions/index.ts (HarnessSession + SessionHandle). This module imports
// those id aliases type-only so an Execution can carry the canonical
// reference without a second session identity being defined here.
import type { HarnessSessionId, SessionHandleId } from './sessions/index.ts'

export type MemberId = string
export type ExecutionId = string
export type TerminalId = string
export type TaskId = string
export type DispatchId = string
export type NativeConversationId = string
/** a client-side view: today a pane/tab inside a workspace window */
export type ViewId = string
export type HostId = string
export type OperationId = string

/**
 * D-EXEC §2 — liveness is evidence about the process, not a stored status.
 * `unverifiable` is the honest middle state: neither confirmed live nor
 * confirmed exited (controller restart, lost receipt, unreachable host).
 */
export type ExecutionLiveness = 'live' | 'unverifiable' | 'exited'

/**
 * D-EXEC §2 — execution lifecycle. `start_unknown`/`stop_unknown` record
 * lost responses, never assumed success or death (REQ-14/REQ-15).
 */
export type ExecutionState =
  | 'preparing'
  | 'starting'
  | 'start_unknown'
  | 'awaiting_join'
  | 'ready'
  | 'stopping'
  | 'stop_unknown'
  | 'exited'
  | 'abandoned'

/** D-EXEC §2 — observation projection; never task completion evidence */
export type AgentActivity = 'working' | 'idle' | 'needs-input' | 'unknown'

/**
 * D-EXEC §1 — one OS-process birth of an execution. pid alone is not an
 * identity (reuse is real); birthEvidence records what this host could prove.
 */
export interface ProcessIncarnation {
  hostId?: HostId
  spawnNonce?: string
  pid?: number
  /** OS-specific birth proof (e.g. Linux /proc starttime, kqueue ident) */
  birthEvidence?: string
  bootId?: string
  processGroupIdentity?: string
  observedExit?: { code?: number; signal?: string; at: number }
}

/**
 * D-EXEC §1 — the logical execution. Fields stay optional where the
 * control plane may legitimately not know them yet (pre-spawn states,
 * unverifiable hosts). Task linkage lives in the coordination domain —
 * deliberately absent here so an Execution is never silently a Task.
 */
export interface Execution {
  id: ExecutionId
  memberId?: MemberId
  generation?: number
  hostId?: HostId
  launchPlanId?: string
  processIncarnation?: ProcessIncarnation
  terminalId?: TerminalId
  /**
   * Legacy native-conversation id. Kept for migration compatibility only —
   * `sessionId`/`sessionHandleId` below are the canonical reference, and no
   * second authoritative copy of a session lives in the execution domain.
   */
  nativeConversationId?: NativeConversationId
  /** canonical HarnessSession this execution runs — absent while unresolved */
  sessionId?: HarnessSessionId
  /** canonical SessionHandle (resume locator) for that session, when known */
  sessionHandleId?: SessionHandleId
  state: ExecutionState
  liveness?: ExecutionLiveness
}

/**
 * D-EXEC §1 — a host-owned terminal: bounded screen/history behind a PTY,
 * independent of any pane/tab view. `ptyId` is the host-local session id
 * (today's `paneId:tabId:uuid` shape), not a TerminalId.
 */
export interface Terminal {
  terminalId: TerminalId
  hostId?: HostId
  hostIncarnation?: string
  ptyId?: string
  processIncarnation?: ProcessIncarnation
  outputEpoch?: number
  lastSequence?: number
  state?: 'open' | 'closed' | 'unknown'
}
