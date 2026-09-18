# IMP-20 — worker bootstrap·join·명시 Task 인수 연결 구현

**종류:** 구현 Task

**담당 역할:** 실행 인수 프로토콜 구현자 · **구현 경계:** `launch/access`

## 1. 배정받는 순간의 지시

당신은 launch/access 경계에서 **worker bootstrap·join·명시 Task 인수 연결 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-07, REQ-09, REQ-10, REQ-13, REQ-15, REQ-17 — 구현 시작 전 |
| [launch.md](../../../spec/contracts/launch.md) | execution.join/heartbeat — 구현 시작 전 |
| [work.md](../../../spec/contracts/work.md) | task.accept — 구현 시작 전 |
| [injection.md](../../../spec/injection.md) | §7 — 구현 시작 전 |
| [access.md](../../../spec/domains/access.md) | bootstrap/full credential — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-12](../IMP-12/instruction.md) | `handoff:IMP-12`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-19](../IMP-19/instruction.md) | `handoff:IMP-19`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. execution 전용 bootstrap credential을 발급하고 join/assignment/surface/자기 receipt만 허용한다. operator credential은 전달하지 않는다.

2. initial text에 역할 및 이번 요구사항의 실제 본문과 exact join/accept invocation을 넣는다. raw secret 대신 connection handle을 사용한다.

3. agent가 호출한 join에서 executionGeneration과 bundle/surface/envelope digest를 비교하고 current grant로 정상 scope를 활성화한다. launcher의 대리 호출을 허용하지 않는다.

4. task.accept는 active Dispatch/TaskRevision/WorkEnvelopeDigest를 검사하고 assignment Delivery ack와 함께 commit한다. coordination은 Task 없는 ready로 처리한다.

5. heartbeat는 사실 관측만 저장하며 완료나 lease takeover 증거가 되지 않게 한다. restart/rebind 시 consumer generation 조정 포트를 제공한다.

## 5. 수정 범위와 하지 않을 일

runtime launch/access bootstrap handlers

역할별 전문 지침 작성이나 Task 품질 판단은 제외

join digest 일치를 모델의 이해 증명으로 부르지 않는다.

과거 실행의 accept/heartbeat가 현재 authority를 갱신하지 못하게 한다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/launch/{bootstrap-credential,join,acceptance}.ts
- 초기 join/accept 지시 생성기와 execution-scope CLI connection

인계 identity는 `handoff:IMP-20`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `execution.join`, `execution.heartbeat`, `task.accept`.

직접 소비하는 후속 구현 Task: [IMP-21](../IMP-21/instruction.md), [IMP-22](../IMP-22/instruction.md), [IMP-24](../IMP-24/instruction.md), [IMP-25](../IMP-25/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
