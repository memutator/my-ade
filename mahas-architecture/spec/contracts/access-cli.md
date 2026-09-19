# C-ACCESS — 역할별 CLI·인증·인가


**소비 시점:** IMP-10~IMP-12. CLI는 mahasd의 authenticated API facade이며 workflow를 소유하지 않는다. 로컬 transport는 POSIX Unix domain socket / Windows named pipe를 대상으로 version handshake, requestId, length-delimited JSON framing을 정의한다. worker와 operator의 endpoint/credential 경로를 분리하고 worker mode에 fallback-admin 경로를 두지 않는다.

## API와 CLI 표면

operation의 dot segment는 `mahas responsibility search` 같은 명령 계층으로 노출한다. 인자는 operation schema에서 생성하고 복합 입력은 `--input <json-file>`로 받는다. `--json`은 구조화 출력을 선택한다. `--help`, completion, schema 요청은 현재 surface에서만 생성한다. secret은 인자에 넣지 않고 승인된 실행 전용 connection 파일/handle로 전달한다. connection 파일은 실행 소유 디렉터리에서 읽는다. 파일 path 자체를 인증으로 쓰지 않고 credential proof를 별도로 검사한다.

서버 registry가 operation ID·input/output schema·target resolver·authorizer·handler·event contract를 한곳에 가진다. CLI/UI/MCP에 독립 명령 사전을 복제하지 않는다. 권한 없는 raw operation 호출은 registry 존재 여부를 드러내지 않는 오류다. service-only host RPC는 worker registry에 들어가지 않는다.

## 도구 호출 결과

JSON receipt를 stdout에 출력하고 진단은 stderr로 보낸다. 오류는 nonzero exit다. 협업 실패를 항상 exit 0으로 감추는 hook shim을 만들지 않는다. `operation.get`은 명령 타임아웃 뒤 같은 ID를 확인하는 경로이며 현재 읽기 권한을 계속 요구한다. command payload에는 `fromRole`이 없어도 서버가 Member/Execution을 안다.


## 연산별 계약

### `surface.describe`

**주체/범위:** bootstrap 또는 current Member/operator

**입력:** optional operation name, expectedSurfaceDigest?

**반환:** 허용 command summary/schema와 surfaceDigest

**전제·인가:** credential status·정상 scope만; bootstrap은 join/assignment/receipt 정도

**저장·실행 효과:** query only; stale surface면 새 digest 반환

**거부·불명:** UNAUTHENTICATED, UNAVAILABLE_OPERATION

### `access.policy.publish`

**주체/범위:** operator policy administrator

**입력:** roleSelector, expectedRevision, actionCeiling, projectionPolicy

**반환:** policyRevision, affected bindings

**전제·인가:** role와 policy 변경 권한을 분리; 유지 담당자 자동 admin 아님

**저장·실행 효과:** policy revision + invalidation event 저장

**거부·불명:** STALE_REVISION, SCOPE_DENIED

### `access.grant`

**주체/범위:** operator 또는 제한된 delegator

**입력:** kind: assignment|provisioning|continuation, subject, scope, actions, expiry, parentGrant?

**반환:** grantId/revision

**전제·인가:** 상위 grant보다 넓은 대상/actions/기간을 금지; provisioning 별도

**저장·실행 효과:** grant와 audit/receipt 저장. component requiredActions는 입력 근거일 뿐

**거부·불명:** SCOPE_DENIED, INVALID_TRANSITION

### `access.revoke`

**주체/범위:** 해당 grant 발급/폐기 권한자

**입력:** grantId, expectedRevision, reason

**반환:** revocationRevision, affectedExecutions, inFlightEffects

**전제·인가:** current 범위와 인가; 이미 시작한 effect 구별

**저장·실행 효과:** 즉시 서버 admission 폐기 + event. 실행 정지는 별도 effect 계약

**거부·불명:** STALE_REVISION; inFlight 존재시 gone/never-started로 표시 금지

### `access.inspect`

**주체/범위:** 자기 binding 또는 관리 범위

**입력:** memberId? 또는 grantId

**반환:** effective action names, scope summary, expiry, revocation status

**전제·인가:** 본인/관리 대상만; 타 secret/hash 미노출

**저장·실행 효과:** query only

**거부·불명:** SCOPE_DENIED
