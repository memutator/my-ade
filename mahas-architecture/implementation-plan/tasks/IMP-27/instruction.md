# IMP-27 — 모델·context 변경 후보와 별도 유지 작업 흐름 구현

**종류:** 구현 Task

**담당 역할:** 유지관리 구현자 · **구현 경계:** `model/realization`

## 1. 배정받는 순간의 지시

당신은 model/realization 경계에서 **모델·context 변경 후보와 별도 유지 작업 흐름 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-21, REQ-22 — 구현 시작 전 |
| [model.md](../../../spec/contracts/model.md) | model.impact.list/classify — 구현 시작 전 |
| [resources-observation.md](../../../spec/domains/resources-observation.md) | §3, §6 — 구현 시작 전 |
| [role-realization.md](../../../spec/domains/role-realization.md) | §5 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-05](../IMP-05/instruction.md) | `handoff:IMP-05`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-07](../IMP-07/instruction.md) | `handoff:IMP-07`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-13](../IMP-13/instruction.md) | `handoff:IMP-13`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-21](../IMP-21/instruction.md) | `handoff:IMP-21`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. 모델 publication/contractEffects/context snapshot 변경에서 IMP-05의 후보 계산을 호출하고 before/after 이유를 저장한다.

2. direct-child 번역, 이전·새 consumer, horizontal role 참조와 implementation maintenance basis를 따라 target 후보를 만든다.

3. 해당 책임자가 confirmed/dismissed/resolved를 rationale와 실제 resolution ref로 분류하게 한다.

4. 유지 작업이 필요하면 팀장의 명시 Plan/Task 연산으로 연결하고 runtime이 자기 판단으로 내용을 다시 쓰지 않는다.

5. 기존 실행의 bundle pin은 유지하고 새 실행의 stale interface/required context 정책만 적용한다. agent의 자기 지침 갱신 요청은 current scope로 거부한다.

## 5. 수정 범위와 하지 않을 일

runtime/maintenance

RoleImplementation 본문 수정 판단은 별도 책임자

보고 이력/ADR를 role instruction에 무한 append하지 않는다.

file hash 변경만으로 의미 영향의 크기를 판정하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/maintenance/{impact-service,basis-observer,classification,task-link}.ts
- ImpactCandidate와 유지 Task의 명시 연결

인계 identity는 `handoff:IMP-27`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `model.impact.list`, `model.impact.classify`.

직접 소비하는 후속 구현 Task: [IMP-30](../IMP-30/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
