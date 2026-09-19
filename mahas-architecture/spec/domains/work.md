# D-WORK — 팀·배정·META DAG·작업 시도

**소비 시점:** IMP-13/14/20/21/26, 팀장의 작업 모델 구현 담당자.

## 1. 객체

| 객체 | 필드 | 관계·불변식 |
|---|---|---|
| Run | id, projectId, modelVersion, goalText, purpose: work/verification, coordinatorMemberId?, state, currentPlanRevision | draft/active/settled/archived. scheduler 아님 |
| Member | id, runId, roleId, modelVersion, implementationId/revision, currentExecutionId?, generation, state | pending/assigned/active/retired. 지속 mailbox 주소 |
| Assignment | id, memberId, kind: coordination/task, mandateText, scope, grantId, revision | coordination은 Task 없이 팀장 스폰을 가능하게 함 |
| PlanRevision | runId, revision, taskSpecs, edges, decisionText? | immutable DAG; edit는 새 revision+CAS |
| TaskSpec | taskId, revision, runId, title, requirementText, ownerRoleId, assignedMemberId?, inputBindings[], outputSlots[], settlementPolicy | 이번 업무 정본. Role.description과 구별 |
| TaskEdge | planRevision, predecessorTaskId, successorTaskId, requiredOutputNames[], settlementRequirement | 순환 거부, 메시지 왕복은 edge 아님 |
| InputBinding | slot, kind: artifact/task-output/contract, identity+revision, required | future output은 dispatch 시작 때 immutable ArtifactRef로 resolve |
| Dispatch | id, taskId, taskRevision, memberId, executionId, generation, envelopeDigest, assignmentDeliveryId?, phase, authorityState | 한 Task의 authoritative attempt는 동시에 1개. phase와 OS 생존 구별 |
| AttemptObservation | dispatchId, source, fact, observedAt, identityEvidence | 판단 근거; authoritative result 아님 |
| Handoff | id, fromDispatch, toTask/member, artifactRefs, acceptedOutcomeRevision | 결과와 자원의 이동을 별도로 연결 |

## 2. 시작과 상태

Task의 표시 상태 `unassigned/blocked/eligible/active/reported/accepted/failed/cancelled`는 최신 TaskSpec과 current Dispatch/Settlement에서 투영한다. 저장된 UI 문자열을 전제조건에 사용하지 않는다. Dispatch의 authoritative phase는 `reserved/starting/awaiting_join/awaiting_accept/running/reported/settled/revoked`이며 execution의 `start_unknown/stop_unknown`은 별도 축이다.

worker.prepare는 assignment와 입력을 고정할 LaunchPlan을 만든다. worker.start의 첫 DB transaction이 Dispatch와 current attempt 포인터를 확정한다. join은 execution의 구성 확인, task.accept는 특정 WorkEnvelope 인수다. generic turn-start는 둘 다 대체하지 않는다.

coordination assignment의 팀장은 task 없이도 자기 역할 구현·Run mandate를 받아 spawn된다. 구현 task를 수행할 때는 별도 TaskSpec/Dispatch를 만든다. 협의가 필요한 양측은 선행 output에 잠긴 implementation task가 아니라 초기 협의 task로 시작하도록 Plan을 작성한다.

## 3. 배정과 계획 수정

팀장은 C-DISCOVERY 결과의 version token으로 assignment.preview를 요청한다. preview는 role·구현·policy·자원 조건을 보여주고 아직 Member/Execution을 만들지 않는다. team.assign은 실제 provisioning 권한과 expected modelVersion을 재검사해 Member/Assignment/Grant binding을 만든다.

active Dispatch가 참조하는 TaskSpec은 수정하지 않는다. 요구사항 변경은 새 revision을 작성하고 기존 attempt의 유지/중단을 팀장이 명시한다. 새 revision이 생겼다는 이유로 기존 작업의 결과를 새 요구사항의 성공으로 받아들이지 않는다. 모델 버전을 Run에 바꾸는 것도 별도 plan revision과 영향 확인을 요구한다.

## 같은 실행에 다음 Task를 배정

처음 Task는 worker.start가 Dispatch와 assignment Delivery를 만든다. 이후 같은 role/interface/bundle의 joined 실행을 재사용할 때는 `task.dispatch`가 새 WorkEnvelope/Dispatch/Delivery를 만들고 별도의 task.accept를 요구한다. 이 연산은 process를 만들거나 provider turn API를 부르지 않는다. 아직 실행되지 않은 Member는 worker.prepare/start로 시작한다. 역할 변경은 fresh execution이다.

## 4. 병렬·합류·결과 재사용

선행 Task가 settled라는 사실만으로 후행 입력이 준비된 것이 아니다. 필요한 output slot의 정확한 ArtifactRef가 있어야 한다. 여러 predecessor를 기다리는 join은 각 edge의 settlementRequirement를 충족해야 eligible이다. 자동 dispatch는 하지 않는다. 팀장이 결정한 제한된 continuation은 기존 Task를 계속하는 것이며 새 edge를 만들지 않는다.

Task 종료 뒤 Member mailbox는 남는다. 후속 질문은 Member 권한으로 응답 가능하지만 정산된 Dispatch 결과를 임의 수정할 수 없다. 결과 수정은 새 revision/새 작업의 명시된 계약을 따른다.
