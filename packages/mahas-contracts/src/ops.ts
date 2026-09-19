// mahas-contracts — operation-name 정본 (IMP-02, spec/operations.md).
//
// The 92 entries of spec/operations.md, grouped by contract so a surface or
// help projection can be generated without re-reading the spec table. The
// C-HOST 15 live in their OWN namespace (`HOST_OPERATION_NAMES`): they are
// execution-plane service-only operations and are never registered in a
// worker-facing registry (IMP-11).
//
// Constants only — no schemas are duplicated here beyond the name lists; the
// owning contract defines payload/result semantics.

export const MODEL_OPERATION_NAMES = [
  'project.create',
  'project.get',
  'model.snapshot',
  'model.change.prepare',
  'model.change.commit',
  'model.impact.list',
  'model.impact.classify'
] as const

export const DISCOVERY_OPERATION_NAMES = [
  'responsibility.search',
  'responsibility.inspect',
  'responsibility.locate',
  'responsibility.collaborators',
  'role.implementations',
  'assignment.preview'
] as const

export const REALIZATION_OPERATION_NAMES = [
  'interface.get',
  'implementation.prepare',
  'implementation.publish',
  'implementation.retire',
  'harness.profile.register',
  'harness.profile.inspect',
  'harness.profile.admit',
  'context.build',
  'context.inspect'
] as const

export const ACCESS_OPERATION_NAMES = [
  'surface.describe',
  'access.policy.publish',
  'access.grant',
  'access.revoke',
  'access.inspect'
] as const

export const WORK_OPERATION_NAMES = [
  'run.create',
  'run.get',
  'run.close',
  'plan.prepare',
  'plan.commit',
  'team.assign',
  'team.retire',
  'assignment.show',
  'task.accept',
  'task.report',
  'outcome.decide',
  'task.dispatch'
] as const

export const MAIL_OPERATION_NAMES = [
  'inbox.check',
  'inbox.wait',
  'delivery.ack',
  'message.send',
  'message.replyAndAck',
  'artifact.publish',
  'artifact.read',
  'operation.get'
] as const

export const LAUNCH_OPERATION_NAMES = [
  'worker.prepare',
  'worker.start',
  'worker.inspect',
  'execution.join',
  'execution.heartbeat',
  'worker.stop',
  'worker.resume',
  'worker.release',
  'execution.wake'
] as const

/**
 * C-HOST — execution-plane service contract, separate namespace. These
 * operations are answered by the execution-host daemon; a worker-facing
 * registry answers UNAVAILABLE_OPERATION for them.
 */
export const HOST_OPERATION_NAMES = [
  'host.hello',
  'host.acquire',
  'host.inventory',
  'host.effect.get',
  'host.process.spawn',
  'host.process.probe',
  'host.process.stop',
  'host.terminal.attach',
  'host.terminal.input',
  'host.terminal.resize',
  'host.terminal.snapshot',
  'host.terminal.detach',
  'host.workspace.prepare',
  'host.workspace.probe',
  'host.workspace.release'
] as const

export const RESOURCE_OPERATION_NAMES = [
  'workspace.prepare',
  'workspace.inspect',
  'claim.handoff',
  'claim.release'
] as const

export const RECOVERY_OPERATION_NAMES = [
  'runtime.status',
  'runtime.reconcile',
  'runtime.shutdown',
  'backup.create',
  'backup.restore'
] as const

export const OBSERVATION_OPERATION_NAMES = [
  'observation.ingest',
  'intervention.raise',
  'intervention.resolve',
  'runtime.snapshot',
  'runtime.subscribe'
] as const

export const CLIENT_OPERATION_NAMES = [
  'terminal.attach',
  'terminal.input',
  'terminal.resize',
  'terminal.snapshot',
  'terminal.detach',
  'client.view.bind',
  'client.view.unbind'
] as const

/** every worker/operator-facing name — C-HOST deliberately excluded */
export const OPERATION_NAMES: readonly string[] = [
  ...MODEL_OPERATION_NAMES,
  ...DISCOVERY_OPERATION_NAMES,
  ...REALIZATION_OPERATION_NAMES,
  ...ACCESS_OPERATION_NAMES,
  ...WORK_OPERATION_NAMES,
  ...MAIL_OPERATION_NAMES,
  ...LAUNCH_OPERATION_NAMES,
  ...RESOURCE_OPERATION_NAMES,
  ...RECOVERY_OPERATION_NAMES,
  ...OBSERVATION_OPERATION_NAMES,
  ...CLIENT_OPERATION_NAMES
]

export type ModelOperationName = (typeof MODEL_OPERATION_NAMES)[number]
export type DiscoveryOperationName = (typeof DISCOVERY_OPERATION_NAMES)[number]
export type RealizationOperationName = (typeof REALIZATION_OPERATION_NAMES)[number]
export type AccessOperationName = (typeof ACCESS_OPERATION_NAMES)[number]
export type WorkOperationName = (typeof WORK_OPERATION_NAMES)[number]
export type MailOperationName = (typeof MAIL_OPERATION_NAMES)[number]
export type LaunchOperationName = (typeof LAUNCH_OPERATION_NAMES)[number]
export type HostOperationName = (typeof HOST_OPERATION_NAMES)[number]
export type ResourceOperationName = (typeof RESOURCE_OPERATION_NAMES)[number]
export type RecoveryOperationName = (typeof RECOVERY_OPERATION_NAMES)[number]
export type ObservationOperationName = (typeof OBSERVATION_OPERATION_NAMES)[number]
export type ClientOperationName = (typeof CLIENT_OPERATION_NAMES)[number]
