# IMP-10 — 주체·정책·grant·폐기 인가 코어 구현

**종류:** 구현 Task

**담당 역할:** 권한 구현자 · **구현 경계:** `access`

## 1. 배정받는 순간의 지시

당신은 access 경계에서 **주체·정책·grant·폐기 인가 코어 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-09, REQ-10, REQ-14, REQ-15 — 구현 시작 전 |
| [access.md](../../../spec/domains/access.md) | 전체 — 구현 시작 전 |
| [access-cli.md](../../../spec/contracts/access-cli.md) | access operations — 구현 시작 전 |
| [common.md](../../../spec/common.md) | 인증 context와 admission — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-03](../IMP-03/instruction.md) | `handoff:IMP-03`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. operator/member/service Principal, role ceiling, assignment/provisioning/continuation grant 저장소를 구현한다.

2. grant child가 parent보다 actions·대상·기간을 확장하지 못하게 하고 role 이름/contains/requiredActions의 자동 승격을 제거한다.

3. actual target resolver 인터페이스를 구현해 Task→Role→Boundary와 Delivery/Artifact/ChangeSet 관계를 DB에서 확인한다.

4. read와 mutation 모두 current grant revision·expiry·revocation을 적용하고 scope가 없는 env/credential에 관리자 fallback을 제공하지 않는다.

5. 권한 폐기와 inFlight effect를 분리한다. revoke event와 invalidation을 내보내며 이미 수행했을 수 있는 spawn을 미실행으로 되돌리지 않는다.

## 5. 수정 범위와 하지 않을 일

runtime/access

worker credential 발급 연결은 IMP-12/20; domain state 판정은 각 handler

기능 비노출만을 보안 집행으로 삼지 않는다.

native shell/OS sandbox 보장을 이 모듈에 주장하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/access/{principal,policy,grant,provisioning,revocation,actual-targets}.ts
- authorizeTargets와 grantSnapshot/recheck 함수

인계 identity는 `handoff:IMP-10`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `access.policy.publish`, `access.grant`, `access.revoke`, `access.inspect`.

직접 소비하는 후속 구현 Task: [IMP-04](../IMP-04/instruction.md), [IMP-06](../IMP-06/instruction.md), [IMP-07](../IMP-07/instruction.md), [IMP-11](../IMP-11/instruction.md), [IMP-13](../IMP-13/instruction.md), [IMP-16](../IMP-16/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
