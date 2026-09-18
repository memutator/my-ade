# C-WORK — Run·META DAG·배정·작업 인수


**소비 시점:** IMP-13/14/21. D-WORK의 state와 S-COMMON을 따른다. role은 재사용 책임, Member는 이번 참여자, Task는 업무, Dispatch는 시도다. 팀장은 coordinator assignment로 Task 없이도 실행할 수 있다.

## Plan 문법

`PlanPatch={basePlanRevision,tasks:[TaskSpecRevision],edges:[{fromTask,toTask,requiredOutputs,settlementRequirement}],retireTaskIds,activeAttemptDisposition[]}`. 모든 endpoint는 같은 Run에 속한다. edge는 실행 순서이며 '서로 대화함'을 cycle edge로 표현하지 않는다. pending task-output은 후행 Dispatch 준비 시 resolve한다. active TaskSpec의 변경은 새 revision과 기존 attempt disposition을 명시해야 한다.


## 연산별 계약

### `run.create`

**주체/범위:** run.create 위임 또는 operator

**입력:** projectId, modelVersion, goalText, coordinatorRoleId, purpose: work|verification

**반환:** runId, revision

**전제·인가:** 프로젝트 및 coordinator role 범위, 공개 model version

**저장·실행 효과:** Run draft 생성, process 없음

**거부·불명:** SCOPE_DENIED, MODEL_INVALID

### `run.get`

**주체/범위:** Run 참여자/조율자

**입력:** runId, projection: coordinator|member

**반환:** Run/Plan 상태와 허용 관계 표현

**전제·인가:** 자기 과업 또는 전체 조율 범위에 따라 내용 선택

**저장·실행 효과:** query only; 전체 history 자동 전송 금지

**거부·불명:** SCOPE_DENIED

### `run.close`

**주체/범위:** Run 결합 책임자

**입력:** runId, expectedPlanRevision, decision, compositionRationale, resourceDisposition

**반환:** RunDecision, unresolved resources/tasks 목록

**전제·인가:** 결합 판정 권한; 진행 Task와 자원을 어떻게 처리할지 명시

**저장·실행 효과:** decision 저장; worker 자동 kill/GC는 별도 승인한 effect로만

**거부·불명:** STALE_REVISION, INVALID_TRANSITION

### `plan.prepare`

**주체/범위:** 팀장 plan.write 범위

**입력:** runId, PlanPatch

**반환:** candidatePlanId, digest, structuralErrors, unresolvedInputs

**전제·인가:** 실제 Task/role/contract scope; 그래프 검증

**저장·실행 효과:** 후보만 저장; worker 배치 안 함

**거부·불명:** MODEL_INVALID, SCOPE_DENIED

### `plan.commit`

**주체/범위:** 팀장 plan.write 범위

**입력:** candidatePlanId, digest, expectedPlanRevision

**반환:** published PlanRevision, eligibility projection

**전제·인가:** CAS, DAG/FK, active attempt disposition 확인

**저장·실행 효과:** Plan/TaskSpec/edges + event/receipt 원자 저장

**거부·불명:** STALE_REVISION, INPUT_NOT_READY는 정상 pending 가능

### `team.assign`

**주체/범위:** 제한된 provisioning 권한을 가진 팀장

**입력:** runId, selectionToken, implementationRevision, assignmentKind, mandateText, taskId/revision?, placementIntent, expectedPlanRevision

**반환:** memberId, assignmentId, effectiveGrantBinding, state

**전제·인가:** C-DISCOVERY token 버전과 current role/profile/ceiling/provisioning 모두 재검사

**저장·실행 효과:** Member+Assignment+grant binding 저장; 아직 process 없음

**거부·불명:** STALE_REVISION, SCOPE_DENIED, IMPLEMENTATION_MISSING

### `team.retire`

**주체/범위:** 해당 Member의 조율 책임자

**입력:** memberId, expectedRevision, pendingDeliveryDisposition, activeExecutionDisposition

**반환:** retired member, 잔여 실행/메시지 목록

**전제·인가:** 진행 작업·inbox를 버리지 않도록 disposition 명시

**저장·실행 효과:** 새 배정 방지; 중단/이관은 명시 effect

**거부·불명:** INVALID_TRANSITION, SCOPE_DENIED

### `assignment.show`

**주체/범위:** bootstrap/자기 Member

**입력:** assignmentId? 기본 self

**반환:** 역할별 현재 책무, 이번 requirement 본문, peers, contracts, input bindings, accept 계약

**전제·인가:** 정확한 execution binding의 본인 과업; 부모 전체 구현 제외

**저장·실행 효과:** query only; 필수 최초 주입을 이 명령 발견에 의존하지 않음

**거부·불명:** STALE_EXECUTION, INPUT_NOT_READY

### `task.accept`

**주체/범위:** 현재 Dispatch의 Member

**입력:** dispatchId, taskRevision, envelopeDigest

**반환:** acceptedRevision, acknowledgedAssignmentDelivery

**전제·인가:** join 완료, active Dispatch/generation, 정확한 input pin

**저장·실행 효과:** 인수 상태 + assignment delivery ack + receipt 원자 처리

**거부·불명:** STALE_REVISION, STALE_EXECUTION, ARTIFACT_MISMATCH

### `task.report`

**주체/범위:** 현재 Task 책임자

**입력:** dispatchId, taskRevision, envelopeDigest, result, rationale, criterionAssessment, outputs, contractEffects

**반환:** Outcome ref, settlement state, handoff events

**전제·인가:** 현재 active attempt, artifact identity·output slot 확인

**저장·실행 효과:** Outcome 저장; owner-declaration이면 자기 Settlement 함께 저장. process stop 안 함

**거부·불명:** STALE_EXECUTION, ARTIFACT_MISMATCH, INVALID_TRANSITION

### `outcome.decide`

**주체/범위:** TaskSpec에 지정된 수용 주체

**입력:** outcomeId, outcomeRevision, decision, reason, expectedTaskRevision

**반환:** Settlement, eligibility changes

**전제·인가:** 해당 outcome version에 대한 명시 권한; 새 결과로 승계 금지

**저장·실행 효과:** decision+event+receipt 원자 기록

**거부·불명:** STALE_REVISION, SCOPE_DENIED

### `task.dispatch`

**주체/범위:** 현재 Task와 Member에 대한 배정 권한을 가진 팀장.

**입력:** taskId, taskRevision, memberId, expectedExecutionId, expectedExecutionGeneration, expectedPlanRevision, inputBindings.

**반환:** 새 Dispatch id, WorkEnvelope digest, assignment Message/Delivery id, accepted=false.

**전제·인가:** 기존 Execution이 joined/ready이고 같은 role/interface/implementation/bundle을 사용한다. Task와 Execution에 다른 active Dispatch가 없어야 한다. current grant, 계획 revision, 선행 output/artifact를 재확인한다. 역할이 달라지거나 기존 실행이 미확인이면 fresh worker.prepare/start가 필요하다.

**저장·실행 효과:** 새 TaskSpec용 WorkEnvelope, Dispatch/current pointer, assignment Message/Delivery를 같은 DB transaction으로 만든다. process를 생성하거나 native turn을 호출하지 않는다. 담당자는 inbox에서 정확한 작업을 읽고 task.accept를 새 digest로 선언한다. initial WorkerJoin은 유지되며 새로운 Task가 initial join digest와 같아야 한다고 요구하지 않는다. idle 하네스의 깨우기는 별도 execution.wake 계약이다.

**거부·불명:** STALE_REVISION, STALE_EXECUTION, INPUT_NOT_READY, INVALID_TRANSITION, SCOPE_DENIED. 작업 배정 enqueue 성공은 agent의 수락이 아니다.
