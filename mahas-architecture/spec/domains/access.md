# D-ACCESS — 주체·정책·위임·명령 표면

**소비 시점:** IMP-10~IMP-12, IMP-18/20의 admission 구현, REV-02/VER-03.

## 1. 객체

| 객체 | 필드 | 수명·관계 |
|---|---|---|
| Principal | id, kind: operator/member/service, status | worker가 payload로 선택하지 않음 |
| RolePolicy | policyId, revision, roleSelector, actionCeiling[], dataProjectionPolicy | role의 최대 action, 실제 배정 아님 |
| AssignmentGrant | grantId, principal/member, runId, boundary/task/contract targets, actions, expiry, revision, revokedAt | 실제 허용 범위. 새 경계가 생겨도 묵시 확대 안 함 |
| ProvisioningGrant | grantId, coordinator, allowedRoleIds, placementScope, maxMembers?, allowedPolicyRevision, profileAdmission: verified-only/documented-in-verification-run | 강한 role을 임의 spawn하여 권한 우회하지 못하게 함 |
| ContinuationGrant | id, memberId, task/coordination scope, allowedWakeRoute, budget, expiry | 현재 위임의 미처리 메시지 처리에만 사용. 새 Task/자동 재시도 금지 |
| ExecutionCredential | id, hash, principalId, memberId, executionId, generation, bootstrap/full scope, revocationRevision | secret은 context/argv/log에 넣지 않음; worker에게만 private 전달 |
| CommandSurface | digest, rolePolicyRevision, effectiveActions, schemas, visibilityScope | help/schema/completion/MCP/UI가 같은 projection 사용 |
| AuthorizationDecision | requestId, actualTargets, policy/grant revisions, allow/deny, reason | 서버 내부 진단. 타 대상 정보는 worker에게 누설하지 않음 |

## 2. 권한 공식

현재 유효한 principal ∩ role ceiling ∩ 실제 AssignmentGrant ∩ current execution generation ∩ 요청 대상의 domain 전제조건이다. provisioning은 별도 grant이며 `requiredActions`나 role 이름이 권한을 만들지 않는다. actor의 role이 변경되면 기존 credential을 갱신하지 않고 새 명시 배정/실행을 만든다. 권한 축소는 즉시 서버에서 적용하며 이미 agent가 본 설명을 잊었다고 가정하지 않는다.

actualTargets는 DB의 Task→Role→Boundary, Delivery→recipient, Artifact→Dispatch, ChangeSet의 before/after touched set에서 구한다. request의 roleId/boundaryId/from은 요청 intent이지 인증 근거가 아니다. 읽기에도 적용하여 list counts, 검색 snippets, receipt body, output artifact를 타 scope로 유출하지 않는다.

## 3. 비노출과 집행

operation registry의 정본 schema에서 `surface.describe`를 구성한다. worker binary에는 관리자 전체 schema를 별도로 포함하지 않는다. 새 프로세스에 제공하는 commands instruction에도 허용 action만 넣는다. bootstrap surface는 execution.join, assignment.show, surface.describe, operation.get(자기 것)만 허용하고 join 후 역할의 정상 surface를 활성화한다.

숨겨진 operation을 raw RPC로 호출하면 같은 authorization을 거치며 `UNAVAILABLE_OPERATION`으로 거부한다. CLI env를 지웠다고 operator 연결로 fallback하지 않는다. operator socket/credential은 별도 명시 실행 경로다. credential scope가 명령 노출보다 항상 최종 판단이다.

## 4. 권한 경합과 effect

DB mutation은 같은 transaction에서 current grant revision을 다시 읽는다. 외부 spawn 직전에 plan에 대한 current permission을 확인하고 effect key를 기록한다. 그 직후 revoke가 발생하면 이미 시작했을 수 있는 process를 미실행으로 돌리지 않는다. 새 worker API 호출은 거부하고 실행 정지/잔여 자원은 C-RECOVERY에 따라 처리한다.

native 하네스의 tool allowlist/permission은 mahas API policy와 다르다. 이중 집행 대상은 mahas tool/action의 비노출과 서버 인가다. shell 프로세스의 OS 접근은 추가 sandbox 없이 완전 통제되지 않는다. 이 범위를 수락 시험의 위협 모델에 그대로 기록한다.
