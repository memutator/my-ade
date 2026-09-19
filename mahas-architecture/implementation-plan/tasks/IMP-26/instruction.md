# IMP-26 — 관측 출처·개입·snapshot/event projection 구현

**종류:** 구현 Task

**담당 역할:** 관측 구현자 · **구현 경계:** `observation`

## 1. 배정받는 순간의 지시

당신은 observation 경계에서 **관측 출처·개입·snapshot/event projection 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-11, REQ-18, REQ-23, REQ-24 — 구현 시작 전 |
| [resources-observation.md](../../../spec/domains/resources-observation.md) | §2, §5 — 구현 시작 전 |
| [observation-client.md](../../../spec/contracts/observation-client.md) | 전체 — 구현 시작 전 |
| [client-terminal.md](../../../spec/contracts/client-terminal.md) | client 권한 경계 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-11](../IMP-11/instruction.md) | `handoff:IMP-11`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-13](../IMP-13/instruction.md) | `handoff:IMP-13`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-15](../IMP-15/instruction.md) | `handoff:IMP-15`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-18](../IMP-18/instruction.md) | `handoff:IMP-18`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-21](../IMP-21/instruction.md) | `handoff:IMP-21`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. 기존 hook/process/출력 활동을 source와 identity evidence가 있는 ObservationFact로 수용한다. unbound/foreign 사실은 정산 채널과 구별한다.

2. stored status는 restored-unconfirmed로 projection하고 live/working/Task outcome을 각각 유지한다.

3. Intervention의 open/claim/resolve/obsolete 상태와 실제 terminal evidence를 저장한다. generic permission prompt에 자동 응답하지 않는다.

4. snapshot/subscribe에 epoch·sequence·visibilityDigest·gap/expired cursor 처리를 구현한다. 이벤트 원장 commit 이후 publication을 보장한다.

5. 기존 attention dedupe/settle 정책을 명확한 데이터 포트로 이관한다. 알림 수신 여부가 업무 정산이나 input owner를 바꾸지 않게 한다.

## 5. 수정 범위와 하지 않을 일

runtime/observation과 projection API

renderer UI 표현은 IMP-28/31/32

event log EOF tail를 durable inbox로 사용하지 않는다.

다른 client socket의 capability를 현재 연결에 가정하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/observation/{ingress,facts,intervention,attention,projection,subscriptions}.ts
- domain outbox cursor와 role-aware snapshot/stream

인계 identity는 `handoff:IMP-26`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `observation.ingest`, `intervention.raise`, `intervention.resolve`, `runtime.snapshot`, `runtime.subscribe`.

직접 소비하는 후속 구현 Task: [IMP-28](../IMP-28/instruction.md), [IMP-31](../IMP-31/instruction.md), [IMP-32](../IMP-32/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
