# IMP-21 — 결과 선언·지정 수용·직접 인계와 안전 wake 연결 구현

**종류:** 구현 Task

**담당 역할:** 협업 정산 구현자 · **구현 경계:** `coordination`

## 1. 배정받는 순간의 지시

당신은 coordination 경계에서 **결과 선언·지정 수용·직접 인계와 안전 wake 연결 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-01, REQ-18, REQ-19, REQ-20 — 구현 시작 전 |
| [messaging-outcomes.md](../../../spec/domains/messaging-outcomes.md) | §4~5 — 구현 시작 전 |
| [work.md](../../../spec/contracts/work.md) | task.report/outcome.decide — 구현 시작 전 |
| [launch.md](../../../spec/contracts/launch.md) | execution.wake — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-15](../IMP-15/instruction.md) | `handoff:IMP-15`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-20](../IMP-20/instruction.md) | `handoff:IMP-20`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. 현재 Dispatch가 제출한 result/rationale/criteria assessment/outputRefs/contractEffects를 Outcome revision으로 기록한다.

2. owner-declaration은 자기 settlement를 함께 확정하고 designated-acceptance는 지정 수용자가 해당 outcome revision을 결정하게 한다.

3. accepted output을 Task input resolver가 쓰도록 exact artifact binding과 handoff event를 만든다. 단순 terminal turn 완료 event를 report로 변환하지 않는다.

4. 미처리 Delivery를 current Member에 알리는 wake는 ContinuationGrant·safe recipe·budget·same operation key를 요구한다. 미지원이면 수동 재개/notification을 남긴다.

5. Task 후에도 Member inbox 회신을 허용하되 정산된 Dispatch 결과 변조는 거부한다. Run 결합 판단과 자원 처분은 별도 operation으로 유지한다.

6. `task.dispatch`를 구현하여 이미 joined된 동일 역할 실행에 새 Task를 배정한다. WorkEnvelope/Dispatch/current pointer/assignment Message·Delivery를 같은 transaction으로 만들고 새로운 task.accept를 요구한다. 이 경로는 새 process나 native turn을 만들지 않으며 wake는 별도다. 아직 active Dispatch가 있거나 bundle/role이 바뀌면 재사용을 거부한다.

## 5. 수정 범위와 하지 않을 일

runtime coordination result 및 wake 연결

작업 자동 계획·자동 새 시도 생성은 제외

모든 결과가 팀장 승인을 거쳐야 하도록 강제하지 않는다.

wake 실패로 Message/Delivery를 지우거나 새 Task를 만들지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/coordination/{outcome,settlement,handoff}.ts
- packages/mahas-runtime/src/mail/{wake-service,continuation}.ts

인계 identity는 `handoff:IMP-21`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `task.report`, `outcome.decide`, `execution.wake`, `task.dispatch`.

직접 소비하는 후속 구현 Task: [IMP-22](../IMP-22/instruction.md), [IMP-26](../IMP-26/instruction.md), [IMP-27](../IMP-27/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
