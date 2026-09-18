# IMP-19 — 고정 LaunchPlan과 단계별 worker.start coordinator 구현

**종류:** 구현 Task

**담당 역할:** 스폰 조율 구현자 · **구현 경계:** `launch`

## 1. 배정받는 순간의 지시

당신은 launch 경계에서 **고정 LaunchPlan과 단계별 worker.start coordinator 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-07, REQ-11, REQ-13, REQ-14, REQ-16 — 구현 시작 전 |
| [launch.md](../../../spec/contracts/launch.md) | stage 및 worker.prepare/start/inspect — 구현 시작 전 |
| [injection.md](../../../spec/injection.md) | §3~4, §7 — 구현 시작 전 |
| [execution-lifecycle.md](../../../spec/execution-lifecycle.md) | §1, §3 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-09](../IMP-09/instruction.md) | `handoff:IMP-09`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-14](../IMP-14/instruction.md) | `handoff:IMP-14`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-16](../IMP-16/instruction.md) | `handoff:IMP-16`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-18](../IMP-18/instruction.md) | `handoff:IMP-18`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-11](../IMP-11/instruction.md) | `handoff:IMP-11`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. 배정/interface/implementation/profile/command surface/grant/input/resource pins에서 immutable LaunchPlan을 만든다. Task 또는 coordination 예약 identity를 고정한다.

2. worker.start admission transaction에서 current authority와 Dispatch reservation을 확정한 뒤 resources→materialize→host spawn→initial attachment를 stable effect key로 수행한다.

3. 실제 role 본문과 task 본문이 S-INJECTION의 명시 route에 연결되는지 확인하고 unsupported/missing/collision은 process 시작 전에 실패시킨다.

4. process 확인 이후 join/accept는 별도 상태로 둔다. initial attachment 응답 유실을 새 prompt로 자동 재전송하지 않는다.

5. 각 stage와 failedStage/effects/residualResources/nextAllowedActions를 저장·조회하게 한다. controller crash 뒤 IMP-22가 같은 plan/effect를 대조할 수 있게 한다.

## 5. 수정 범위와 하지 않을 일

runtime/launch

agent join/auth 승격은 IMP-20; native formatting은 IMP-24/25

부분 실패를 단일 failed boolean으로 덮지 않는다.

실행 설정이 바뀌면 기존 plan을 조용히 수정하지 말고 재계획한다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/launch/{planner,start-coordinator,stage-receipts,initial-attachment}.ts
- worker.prepare/start/inspect API 및 cumulative stage receipt

인계 identity는 `handoff:IMP-19`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `worker.prepare`, `worker.start`, `worker.inspect`.

직접 소비하는 후속 구현 Task: [IMP-20](../IMP-20/instruction.md), [IMP-22](../IMP-22/instruction.md), [IMP-24](../IMP-24/instruction.md), [IMP-25](../IMP-25/instruction.md), [IMP-32](../IMP-32/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
