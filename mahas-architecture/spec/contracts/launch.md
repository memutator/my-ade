# C-LAUNCH — 스폰·초기 입력·인수·계속 수행


**소비 시점:** IMP-19~IMP-21/IMP-24/25. D-EXEC와 S-INJECTION을 함께 적용한다. CLI 하네스는 PTY 또는 pipes process로 시작하며 App Server는 전제하지 않는다.

## 스폰의 권위 있는 stage

`admitted → inputs_pinned → resources_claimed → components_materialized → process_attempting → process_confirmed → initial_attached → awaiting_join → joined → task_accepted`.

Dispatch phase 정본은 D-WORK의 `reserved/starting/awaiting_join/awaiting_accept/running/reported/settled/revoked`다. `worker.start`가 기록하는 첫 Dispatch phase는 `awaiting_join`이다. `assigned`는 이 열거에 없다.

각 stage는 cumulative receipt에 남고 failedStage/effects/residualResources/nextAllowedActions를 반환한다. coordination assignment는 task_accepted 대신 coordination_ready로 끝난다. process 생성 성공은 agent join과 다르며 join은 의미 이해 증명이 아니다.

`worker.start`는 같은 launchPlanId/operationId를 재호출하면 같은 receipt를 조회/이어간다. 재계획 없이 새 ID를 만들어 실패 구간을 다시 실행하지 않는다. host process.spawn은 별도 안정 effect key를 사용하여 제어면 응답 유실에서도 process 중복 생성 위험을 다룬다.

## 실제 하네스 검증을 위한 제한된 launch

기본 `purpose=work`는 verified HarnessProfile만 사용한다. 설치 검증 자체가 profile activation보다 먼저 실행돼야 하므로 operator는 purpose=verification인 격리 Run에 한정하여 `profileAdmission=documented-in-verification-run`인 ProvisioningGrant를 발급할 수 있다. 이 grant는 role 구현 작성자에게 자동 주어지지 않고 실제 경로·계정/비용·사용할 profile revision에 제한된다. verification Run의 성공으로 profile이 자동 활성화되지 않으며 SupportAttestation과 별도 admit이 필요하다. 이 경로는 production launch의 권한·필수 context·receipt 검사를 우회하지 않는다.

## 입력 전달 상태

materialized는 로컬 파일 생성, initial_attached는 검증된 recipe로 argv/stdin/추가지침 로딩 설정에 bytes 또는 그 설정이 가리키는 불변 파일을 연결, joined는 agent의 명시 참여다. provider-specific 내부 prompt를 볼 수 없으면 unknown inherited input을 유지한다. initial_attached를 모델의 완전한 이해로 부르지 않는다.


## 연산별 계약

### `worker.prepare`

**주체/범위:** provisioning 권한을 가진 팀장/launch service

**입력:** assignmentId/revision, implementationRevision, taskRevision?, placementIntent, harnessProfileRevision, purpose: work|verification

**반환:** LaunchPlan, pins, exact processSpec, blockers, planned surface/required components

**전제·인가:** Member 배정/role/interface/policy/provisioning/입력/실행 가능 profile 검사

**저장·실행 효과:** 고정 plan/reservation ID 저장. actual process/worktree 생성 없음

**거부·불명:** INPUT_NOT_READY, INTERFACE_STALE, REQUIRED_ACTION_DENIED, INJECTION_UNSUPPORTED

### `worker.start`

**주체/범위:** 해당 LaunchPlan 실행 권한자

**입력:** launchPlanId, planDigest, operationId, generation? (native-resume/fresh가 같은 plan으로 새 generation을 시작할 때; 생략하면 terminal receipt를 replay)

**반환:** stage receipt, executionId, dispatchId?, join state, residuals

**전제·인가:** 현재 grant/model/plan/claim 다시 확인. 조용한 fallback 금지

**저장·실행 효과:** Task assignment이면 Dispatch/current pointer + WorkEnvelope를 가리키는 assignment Message/Delivery + intent를 같은 transaction에 저장한 뒤 Workspace/Materialize/Host spawn/initial attachment 단계를 수행. system sender principal을 사용하며 task.accept가 이 Delivery를 ack

**거부·불명:** START_UNKNOWN, RESOURCE_BUSY, MANDATORY_COMPONENT_MISSING; 실패했다고 자원 없는 것으로 간주 금지

### `worker.inspect`

**주체/범위:** 자기 Member 또는 조율 범위

**입력:** executionId 또는 memberId

**반환:** execution phase, liveness, process evidence, task authority, current receipt/residuals

**전제·인가:** own/composition detail 권한

**저장·실행 효과:** 조회와 필요시 명시 host probe. side effect 재실행 없음

**거부·불명:** PROCESS_UNVERIFIABLE는 유효 상태

### `execution.join`

**주체/범위:** bootstrap credential의 agent

**입력:** executionId, generation, bundleDigest, surfaceDigest, envelopeDigest

**반환:** full scoped credential binding(비밀이 아닌 상태 식별자), joined receipt, effective surface

**전제·인가:** bootstrap credential·exact pins·current host/process binding 검사. launcher 대리 join 불가

**저장·실행 효과:** WorkerJoin+서버의 credential mode 승격+execution phase+receipt 저장. 동일 private credential을 사용할 수 있으며 secret을 모델/CLI stdout으로 반환하지 않음

**거부·불명:** STALE_EXECUTION, ARTIFACT_MISMATCH, GRANT_REVOKED

### `execution.heartbeat`

**주체/범위:** 현재 실행의 Member

**입력:** executionId, generation, activityHint, activeDispatchId?

**반환:** observedAt, current control status

**전제·인가:** 현재 credential과 generation

**저장·실행 효과:** ObservationFact 저장; task outcome이나 process death 판정 없음

**거부·불명:** STALE_EXECUTION, CONTROL_UNAVAILABLE

### `worker.stop`

**주체/범위:** 해당 실행 정지 권한자

**입력:** executionId, expectedGeneration, expectedProcessIncarnation, mode: graceful|escalate, reason

**반환:** stop effect receipt, liveness, residual resources

**전제·인가:** 정확한 실행/프로세스 대상, escalation 별도 권한

**저장·실행 효과:** stop intent commit→host stop→positive exit 확인. 권한 fence와 물리 stop 구별

**거부·불명:** STOP_UNKNOWN; 새 process/turn에 과거 stop 재적용 금지

### `worker.resume`

**주체/범위:** 해당 Member 재개 권한자

**입력:** memberId, priorExecutionId, resumeKind: reattach|native-resume|fresh, newAssignment?, nativeHandle?, expectedPins

**반환:** 기존 execution 연결 또는 새 execution generation/LaunchPlan

**전제·인가:** reattach는 same process proof, native-resume는 old exited/quiescent+같은 role/interface/profile의 검증 route. changed role이면 fresh

**저장·실행 효과:** reattach는 spawn 없음. native/fresh는 별도 start intent와 신규 credential. old ack fence

**거부·불명:** PROCESS_UNVERIFIABLE, INTERFACE_STALE, INJECTION_UNSUPPORTED

### `worker.release`

**주체/범위:** 정산 이후 자원 처분 권한자

**입력:** executionId, resourceDisposition: retain|transfer|release, expectedClaims

**반환:** 잔여 자원별 결과

**전제·인가:** release는 cancel 아님. process 상태와 인계/retention 참조 확인

**저장·실행 효과:** C-RESOURCE 연산으로 명시 인계/정리; Task outcome 유지

**거부·불명:** RESOURCE_BUSY, STOP_UNKNOWN; dirty 자동 삭제 없음

### `execution.wake`

**주체/범위:** 현재 continuation grant 또는 operator

**입력:** memberId, deliveryIds, continuationGrantId?, expectedExecutionGeneration

**반환:** wake receipt: sent|unsupported|pending|unknown

**전제·인가:** 검증된 safe route, budget, current member/task scope

**저장·실행 효과:** attention pointer만 전달. Message/Delivery는 이미 저장된 상태; 새 Task 선택 안 함

**거부·불명:** INJECTION_UNSUPPORTED이면 수동 개입 표시, Delivery 유지
