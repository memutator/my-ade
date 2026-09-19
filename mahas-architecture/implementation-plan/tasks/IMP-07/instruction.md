# IMP-07 — RoleInterface와 RoleImplementation 저작·공개 서비스 구현

**종류:** 구현 Task

**담당 역할:** 역할 실현 구현자 · **구현 경계:** `realization`

## 1. 배정받는 순간의 지시

당신은 realization 경계에서 **RoleInterface와 RoleImplementation 저작·공개 서비스 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-05, REQ-06, REQ-07, REQ-08, REQ-21, REQ-22 — 구현 시작 전 |
| [role-realization.md](../../../spec/domains/role-realization.md) | 전체 — 구현 시작 전 |
| [realization.md](../../../spec/contracts/realization.md) | interface/implementation/harness.profile operations — 구현 시작 전 |
| [injection.md](../../../spec/injection.md) | §1, §2 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-04](../IMP-04/instruction.md) | `handoff:IMP-04`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-10](../IMP-10/instruction.md) | `handoff:IMP-10`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-11](../IMP-11/instruction.md) | `handoff:IMP-11`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. role+필요 context를 의미 인터페이스 snapshot으로 만드는 builder를 구현한다. RDD role에는 provider 설정·Task requirement를 추가하지 않는다.

2. instruction/skill/subagent/tool-config/launch-config component graph와 coverageBindings를 저장하고 publication lifecycle을 만든다.

3. 원문 대신 역할 문법으로 재표현한 clause binding을 지원한다. required 의미가 conditional-only component에 놓이면 미충족을 반환한다.

4. 구현 작성자의 semanticDecision, maintainer scope, interfaceDigest, profileRevision을 고정해 publish한다. helper subagent가 독립 Member로 암묵 변환되는 경로를 만들지 않는다.

5. harness profile 등록·조회·admit API를 구현하되 documentation-only profile을 verified로 승격하지 않는다. 설치 evidence와 typed capability를 보존한다.

## 5. 수정 범위와 하지 않을 일

runtime/realization 의미 모델과 authoring 서비스

actual native 파일 formatting은 IMP-24/25

컴파일러에 즉석 LLM 요약을 넣지 않는다.

active worker가 자신에게 부여되지 않은 구현 공개 권한을 쓰지 못한다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/realization/{interfaces,implementation-repository,component-graph,publisher,profile-registry}.ts
- role 구현 authoring API와 clause coverage 모델

인계 identity는 `handoff:IMP-07`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `interface.get`, `implementation.prepare`, `implementation.publish`, `implementation.retire`, `harness.profile.register`, `harness.profile.inspect`, `harness.profile.admit`.

직접 소비하는 후속 구현 Task: [IMP-06](../IMP-06/instruction.md), [IMP-08](../IMP-08/instruction.md), [IMP-24](../IMP-24/instruction.md), [IMP-25](../IMP-25/instruction.md), [IMP-27](../IMP-27/instruction.md), [IMP-32](../IMP-32/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
