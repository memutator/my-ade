// mahas-runtime / coordination — accepted-output handoff (IMP-21).
//
// Downstream TaskSpecs consume outputs via exact ArtifactRef pins
// (outcome_outputs + an accepting Settlement). The handoffs row + domain
// event are the movement record; they are not a second artifact identity
// and they never copy a producer's live directory.

import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactRef } from '../../../mahas-contracts/src/common.ts'
import type { Handoff } from '../../../mahas-contracts/src/work.ts'
import { appendDomainEvent } from '../storage/db.ts'
import { newId, run } from './internal.ts'
import type { ReportedOutput } from './outcome.ts'

export interface RecordHandoffInput {
  fromDispatchId: string
  toTaskId?: string | null
  toMemberId?: string | null
  outputs: ReportedOutput[]
  acceptedOutcomeRevision: number
  outcomeId: string
}

export function recordAcceptedHandoff(db: DatabaseSync, input: RecordHandoffInput): Handoff {
  const artifactRefs: ArtifactRef[] = input.outputs.map((o) => ({
    artifactId: o.artifactId as ArtifactRef['artifactId'],
    revision: o.artifactRevision as ArtifactRef['revision'],
    digest: o.digest ?? ''
  }))
  const bindings = {
    artifactRefs,
    acceptedOutcomeRevision: input.acceptedOutcomeRevision,
    outcomeId: input.outcomeId
  }
  const id = newId('hnd') as string
  run(
    db,
    'INSERT INTO handoffs (id, from_dispatch, to_task, to_member, bindings_json) VALUES (?, ?, ?, ?, ?)',
    id,
    input.fromDispatchId,
    input.toTaskId ?? null,
    input.toMemberId ?? null,
    JSON.stringify(bindings)
  )
  appendDomainEvent(
    db,
    id,
    1,
    'handoff.recorded',
    { fromDispatchId: input.fromDispatchId, outcomeId: input.outcomeId },
    {
      acceptedOutcomeRevision: input.acceptedOutcomeRevision,
      slots: input.outputs.map((o) => o.slot)
    }
  )
  return {
    id: id as Handoff['id'],
    fromDispatchId: input.fromDispatchId as Handoff['fromDispatchId'],
    toTaskId: (input.toTaskId ?? undefined) as Handoff['toTaskId'],
    toMemberId: (input.toMemberId ?? undefined) as Handoff['toMemberId'],
    artifactRefs,
    acceptedOutcomeRevision: input.acceptedOutcomeRevision as Handoff['acceptedOutcomeRevision'],
    bindings
  }
}
