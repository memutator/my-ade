# S-COMMON — 공통 타입·버전·오류·트랜잭션 규칙

**소비 시점:** 모든 프로토콜/저장/도메인 담당자는 구현 전에 읽는다. 일반 실행 agent에게 자동 주입하지 않는다.

## 1. identity와 version

`Id`는 opaque UTF-8 identifier이며 label/path/provider native ID와 구분한다. `Revision`은 1부터 증가하는 정수다. `ModelVersionId`, `RoleInterfaceDigest`, `ImplementationRevision`, `BundleDigest`, `TaskRevision`, `PlanRevision`, `ExecutionGeneration`, `ControllerEpoch`, `HostIncarnation`은 다른 타입이며 서로 대입하지 않는다. UTC instant는 RFC3339로 RPC에 내보내고 DB는 정수 epoch-ms다. DB 만료는 authority clock으로 판단하고, heartbeat timeout만으로 process 사망을 결정하지 않는다.

`ContentRef = {digest,mediaType,sizeBytes}`이며 digest는 실제 byte의 SHA-256이다. `ArtifactRef={artifactId,revision,digest}`는 작업 산출물의 권한 있는 레코드를 가리킨다. `PathRef={projectId,checkoutId?,repoRelativePath}`의 path는 NUL·절대 경로·.. escape를 금지한다. symlink와 canonical checkout identity를 별도로 확인한다.

## 2. 명령 envelope

```text
CommandRequest {
  protocolVersion, operation, operationId,
  expectedRevisions: {entityId: revision}, payload
}
AuthenticatedContext {
  principalId, roleBindingId?, memberId?, executionId?, executionGeneration?,
  controllerEpoch, grantRevisions, transportSessionId
} // 서버가 credential에서 구성, payload의 from/role을 신뢰하지 않음
CommandReceipt {
  operationId, fingerprint, status: committed|rejected|pending|unknown,
  result?, error?, effects[], domainRevision, eventCursor
}
Error {code, message, retry: none|same-operation|reconcile|replan, details?}
```

조회는 `QueryResult={snapshotRevision,items,nextCursor?,visibility}`다. 서버는 authorization 전 타 대상의 존재를 공개하지 않는다. 숨긴 operation 이름에 대한 worker 응답은 `UNAVAILABLE_OPERATION`이며 관리자 trace에는 denied/unknown을 구별할 수 있다. 출력 stdout은 JSON 하나/명시 stream만, stderr는 진단, nonzero exit는 오류다. terminal transcript와 CLI JSON을 혼합하지 않는다.

## 3. idempotency와 admission

mutation은 `(principalScope,operation,operationId)` unique + canonical payload fingerprint를 가진다. 동일 key·동일 payload는 저장된 receipt, 동일 key·다른 payload는 `OPERATION_CONFLICT`다. 기존 receipt 반환에도 현재 읽기 권한을 확인한다. `expectedRevisions`는 authorization 후 actual target을 확인한 같은 write transaction에서 비교한다. side effect 직전에는 현재 grant를 다시 확인하며 이미 시작한 effect는 폐기로 되돌아갔다고 간주하지 않는다.

원자 단위는 객체 revision 변경 + receipt + domain event + effect intent/outbox다. side effect 실행은 별도다. query는 지정 모델 snapshot과 권한 필터에 묶여 cursor를 이어가며 그 사이 active model이 바뀌어도 한 결과집합을 섞지 않는다. 전체 workflow exactly-once 주장을 하지 않는다.

## 4. 오류 코드

`UNAUTHENTICATED`, `UNAVAILABLE_OPERATION`, `SCOPE_DENIED`, `GRANT_REVOKED`, `STALE_REVISION`, `STALE_EXECUTION`, `OPERATION_CONFLICT`, `MODEL_INVALID`, `AMBIGUOUS_TERRITORY`, `NO_RESPONSIBLE_ROLE`, `IMPLEMENTATION_MISSING`, `INTERFACE_STALE`, `MANDATORY_COMPONENT_MISSING`, `INJECTION_UNSUPPORTED`, `INPUT_NOT_READY`, `RESOURCE_BUSY`, `PROCESS_UNVERIFIABLE`, `START_UNKNOWN`, `STOP_UNKNOWN`, `HOST_PROTOCOL_MISMATCH`, `CONTROL_UNAVAILABLE`, `ARTIFACT_MISMATCH`, `INVALID_TRANSITION`, `REQUIRED_ACTION_DENIED`, `SNAPSHOT_REQUIRED`를 공통 목록으로 고정한다. domain-specific details는 해당 operation에서 정한다.

## 5. 실행 effect와 domain 상태

`EffectIntent.state = prepared|attempting|confirmed|rejected|unknown`. unknown은 terminal business failure가 아니며 reconcile 대상으로 남는다. resource hold를 유지한다. retry 정책은 이미 승인된 같은 effect key의 receipt 조회 또는 긍정적인 미실행 증거가 있는 동일 operation continuation만 허용한다. 새로운 Dispatch 생성은 별도 권한자의 판단이다.

## 6. 변경 불가능한 결과와 인계

공개된 ModelVersion/RoleImplementationRevision/ContextBundle/TaskSpecRevision/PlanRevision/ArtifactRevision은 수정 대신 새 revision을 만든다. active pointer만 CAS한다. 작은 현재 지침과 구조 anchor를 snapshot에 저장하는 것은 재현용이지 별도 수정 정본을 만드는 것이 아니다. 삭제는 참조 검사 후 tombstone/retention 정책으로 처리하며 cascade로 작업 이력을 지우지 않는다.
