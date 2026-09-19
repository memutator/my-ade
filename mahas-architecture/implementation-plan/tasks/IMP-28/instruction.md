# IMP-28 — Desktop·detached client·terminal view의 정본 분리 구현

**종류:** 구현 Task

**담당 역할:** 작업대 통합 구현자 · **구현 경계:** `workbench`

## 1. 배정받는 순간의 지시

당신은 workbench 경계에서 **Desktop·detached client·terminal view의 정본 분리 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-11, REQ-12, REQ-23, REQ-24, REQ-27 — 구현 시작 전 |
| [client-terminal.md](../../../spec/contracts/client-terminal.md) | 전체 — 구현 시작 전 |
| [observation-client.md](../../../spec/contracts/observation-client.md) | client 계약 — 구현 시작 전 |
| [architecture.md](../../../spec/architecture.md) | §5 — 구현 시작 전 |
| [execution-lifecycle.md](../../../spec/execution-lifecycle.md) | §4 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-12](../IMP-12/instruction.md) | `handoff:IMP-12`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-23](../IMP-23/instruction.md) | `handoff:IMP-23`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-26](../IMP-26/instruction.md) | `handoff:IMP-26`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. renderer와 detached renderer가 동일 snapshot/subscribe를 읽게 하고 orchestration 상태를 zustand/local file의 writer로 유지하지 않는다.

2. pane/tab을 Execution/Terminal의 표시 binding으로 전환하고 managed tab close는 view detach, worker stop은 별도 명령으로 만든다.

3. terminal input/resize는 현재 InputLease를 획득한 operator만 proxy하고 passive viewer의 attach가 크기를 훔치지 않게 한다.

4. 기존 layout/개인 설정은 유지하고 session/resume 관측은 unconfirmed로 import한다. 기존 탭을 가짜 Task나 accepted outcome으로 변환하지 않는다.

5. control unavailable, start/stop unknown, residual resource, permission intervention을 서로 다른 상태로 표시한다. retry 버튼이 새 worker를 자동 만드는 경로를 제거한다.

## 5. 수정 범위와 하지 않을 일

기존 desktop renderer/preload와 client proxy

책임 탐색/DAG UI는 IMP-31, context inspector는 IMP-32

runtime DB 또는 execution-host socket을 renderer에 직접 노출하지 않는다.

구독 해제와 실행 종료·대화 삭제를 같은 버튼 동작으로 묶지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- Desktop runtime client/projection store와 managed terminal view
- terminal attach/input/resize/detach proxy 핸들러
- 기존 session/resume 관측 import 및 UI layout 보존 연결

인계 identity는 `handoff:IMP-28`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `terminal.attach`, `terminal.input`, `terminal.resize`, `terminal.snapshot`, `terminal.detach`, `client.view.bind`, `client.view.unbind`.

직접 소비하는 후속 구현 Task: [IMP-30](../IMP-30/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
