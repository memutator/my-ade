// mahas-contracts — view ↔ execution/terminal binding (C-CLIENT).
//
// client.view.bind / client.view.unbind attach a UI view (today: a pane/tab
// in a workspace window) to a managed Execution or Terminal the control
// plane owns. The binding is a separate record with its own revision — it
// never rewrites the view's identity and never creates a Task. A persisted
// tab that predates the control plane simply has no binding (REQ-27:
// observation data is not retro-converted into managed executions).

import type { ExecutionId, OperationId, TerminalId, ViewId } from './identity.ts'

/**
 * What a view stores to remember the managed identities it is bound to.
 * Carried on the renderer's tab record as an optional field — plain
 * pty-host terminals never get one.
 */
export interface ExecutionBinding {
  executionId: ExecutionId
  terminalId?: TerminalId
  /** binding revision echoed by the control plane (CAS/lease semantics) */
  revision?: number
  boundAt?: number
}

/** C-CLIENT `client.view.bind` input */
export interface BindViewRequest {
  operationId: OperationId
  viewId: ViewId
  executionId?: ExecutionId
  terminalId?: TerminalId
}

/** C-CLIENT `client.view.unbind` input */
export interface UnbindViewRequest {
  operationId: OperationId
  viewId: ViewId
  expectedRevision?: number
}

/** the stored server-side binding record returned by bind operations */
export interface ClientViewBinding extends ExecutionBinding {
  viewId: ViewId
}
