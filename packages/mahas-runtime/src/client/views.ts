// mahas-runtime — C-CLIENT client.view.* handlers.
//
// A view (pane/tab in a workspace window, or a detached client's surface)
// is bound to a managed Execution/Terminal through a ClientViewBinding
// row — the binding is the ONLY thing these ops own. Binding never creates
// an Execution, never promotes a legacy pty tab into one, and unbinding
// never stops the worker (REQ-11/REQ-23/REQ-27: view delete ≠ execution
// delete; observation data is not retro-converted into managed work).
//
// Ownership: client_id = ctx.principalId — bindings are scoped to the
// authenticated client, so one client can never rewrite another's view
// ("cross-client binding 변조 금지").

import type { ClientViewBinding } from '../../../mahas-contracts/src/index.ts'
import { asRecord, optNumber, reqString, snapshotRequired, staleRevision } from './errors.ts'
import {
  deleteBinding,
  executionExists,
  getBinding,
  getTerminal,
  parseLayout,
  upsertBinding
} from './store.ts'
import { resolveDeps } from './terminal.ts'
import type { ClientOpsDeps, ClientTxn, ClientViewUnbindResult } from './types.ts'

// ── client.view.bind ────────────────────────────────────────────────────────

export function clientViewBind(
  txn: ClientTxn,
  payload: unknown,
  deps: ClientOpsDeps
): ClientViewBinding {
  const d = resolveDeps(deps)
  const p = asRecord(payload)
  const viewId = reqString(p.viewId, 'viewId')
  const executionId =
    p.executionId === undefined ? undefined : reqString(p.executionId, 'executionId')
  const terminalId = p.terminalId === undefined ? undefined : reqString(p.terminalId, 'terminalId')
  if (executionId === undefined && terminalId === undefined) {
    throw new TypeError('client.view.bind requires executionId or terminalId')
  }

  const ctx = txn.ctx
  const targets = [{ kind: 'view', id: viewId }]
  if (executionId !== undefined) targets.push({ kind: 'execution', id: executionId })
  if (terminalId !== undefined) targets.push({ kind: 'terminal', id: terminalId })
  d.authorize(ctx, 'client.view.bind', targets)

  // the target must be real managed state — binding to a phantom means the
  // client's projection is stale, so point it at the recovery path
  if (executionId !== undefined && !executionExists(txn.db, executionId)) {
    snapshotRequired(
      `client.view.bind: unknown execution ${executionId} — rebuild from runtime.snapshot`,
      { executionId }
    )
  }
  if (terminalId !== undefined && !getTerminal(txn.db, terminalId)) {
    snapshotRequired(
      `client.view.bind: unknown terminal ${terminalId} — rebuild from runtime.snapshot`,
      { terminalId }
    )
  }

  const binding = upsertBinding(
    txn.db,
    ctx.principalId,
    {
      viewId,
      executionId: executionId ?? null,
      terminalId: terminalId ?? null,
      keepSubscription: true
    },
    d.now()
  )

  d.appendDomainEvent(
    txn.db,
    viewId,
    binding.revision ?? 1,
    'client.view.bound',
    { clientId: ctx.principalId },
    { viewId, executionId: executionId ?? null, terminalId: terminalId ?? null }
  )

  return binding
}

// ── client.view.unbind ──────────────────────────────────────────────────────

export function clientViewUnbind(
  txn: ClientTxn,
  payload: unknown,
  deps: ClientOpsDeps
): ClientViewUnbindResult {
  const d = resolveDeps(deps)
  const p = asRecord(payload)
  const viewId = reqString(p.viewId, 'viewId')
  const expectedRevision = optNumber(p.expectedRevision, 'expectedRevision')

  const ctx = txn.ctx
  d.authorize(ctx, 'client.view.unbind', [{ kind: 'view', id: viewId }])

  const row = getBinding(txn.db, ctx.principalId, viewId)
  if (!row) {
    if (expectedRevision !== undefined) {
      staleRevision(
        `client.view.unbind: no binding for view ${viewId} at revision ${expectedRevision}`,
        { viewId, expectedRevision }
      )
    }
    // never bound or already unbound — idempotent (execution/resource
    // ownership was never ours to release anyway)
    return { unbound: true, viewId }
  }

  const layout = parseLayout(row)
  if (expectedRevision !== undefined && expectedRevision !== layout.revision) {
    staleRevision(
      `client.view.unbind: binding revision mismatch on ${viewId}: ` +
        `expected ${expectedRevision}, current ${layout.revision}`,
      { viewId, expectedRevision, currentRevision: layout.revision }
    )
  }

  deleteBinding(txn.db, row.id)
  d.appendDomainEvent(
    txn.db,
    viewId,
    layout.revision,
    'client.view.unbound',
    { clientId: ctx.principalId },
    {
      viewId,
      executionId: row.execution_id,
      terminalId: row.terminal_id,
      hadSubscription: Boolean(layout.subscriptionId)
    }
  )
  return { unbound: true, viewId }
}
