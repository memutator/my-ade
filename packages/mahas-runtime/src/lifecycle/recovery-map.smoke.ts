// Recovery reconcile names vs runtime.reconcile report names.
//
// Run: node packages/mahas-runtime/src/lifecycle/recovery-map.smoke.ts

import assert from 'node:assert/strict'
import { mapRecoveryReconcileDecision } from './recovery-map.ts'

assert.equal(mapRecoveryReconcileDecision('reattached'), 'reattached')
assert.equal(mapRecoveryReconcileDecision('exited'), 'confirmed-exited')
assert.equal(mapRecoveryReconcileDecision('conflict'), 'quarantined')
assert.equal(mapRecoveryReconcileDecision('unverifiable'), 'left-unknown')
assert.equal(mapRecoveryReconcileDecision('stopping-outstanding'), 'left-unknown')
assert.equal(mapRecoveryReconcileDecision('unchanged'), 'left-unknown')
assert.equal(mapRecoveryReconcileDecision(undefined), 'left-unknown')
assert.equal(mapRecoveryReconcileDecision('lease-acquired'), 'left-unknown')

console.log('recovery reconcile mapping: ok')
