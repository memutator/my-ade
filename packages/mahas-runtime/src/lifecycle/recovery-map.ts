// Map recovery reconcile vocabulary onto the runtime.reconcile report.
// Recovery keeps host-probe names (exited/conflict/unverifiable); the
// operator report uses C-RECOVERY decision names. Unmapped names stay
// left-unknown — they are not fabricated as reattached or exited.

import type { ReconcileDecision } from './types.ts'

export function mapRecoveryReconcileDecision(
  decision: string | undefined
): ReconcileDecision['decision'] {
  if (decision === 'reattached') return 'reattached'
  if (decision === 'exited') return 'confirmed-exited'
  if (decision === 'conflict') return 'quarantined'
  return 'left-unknown'
}
