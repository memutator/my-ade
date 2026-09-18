# IMP-15 — durable inbox·회신·artifact 저장 API 구현

**종류:** 구현 Task

**담당 역할:** 메시지 구현자 · **구현 경계:** `coordination/mail`

## 1. 배정받는 순간의 지시

당신은 coordination/mail 경계에서 **durable inbox·회신·artifact 저장 API 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-14, REQ-18, REQ-19, REQ-20 — 구현 시작 전 |
| [messaging-outcomes.md](../../../spec/domains/messaging-outcomes.md) | §1~3, §5 — 구현 시작 전 |
| [mail-artifacts.md](../../../spec/contracts/mail-artifacts.md) | operation.get 제외 전체 — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | messages/deliveries/artifacts/retention_pins/content_blobs — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-12](../IMP-12/instruction.md) | `handoff:IMP-12`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-14](../IMP-14/instruction.md) | `handoff:IMP-14`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-16](../IMP-16/instruction.md) | `handoff:IMP-16`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. Message와 recipient별 Delivery를 원자적으로 저장하고 sender/recipient/contract/artifact scope를 서버에서 해석한다.

2. inbox.check는 FIFO outstanding batch를 반환하고 읽기만으로 ack하지 않는다. consumerGeneration과 이전 실행의 ack fence를 구현한다.

3. replyAndAck의 회신 enqueue·원문 ack·receipt/event를 하나의 transaction으로 저장한다. 같은 operation을 다시 요청하면 기존 결과를 반환한다.

4. bounded inbox.wait를 구현하고 connection 종료/timeout에서 Message 상태를 바꾸지 않는다. wake와 별도 service interface를 둔다.

5. artifact.publish는 자기 checkout의 file snapshot 또는 보존할 Git commit을 digest/revision으로 고정한다. read는 actual Artifact scope/digest를 확인하고 live workspace path를 그대로 신뢰 가능한 결과로 내보내지 않는다.

## 5. 수정 범위와 하지 않을 일

runtime/mail과 artifacts

Task result 판단·wake 실행은 IMP-21

pty.write와 hook log를 메시지 접수 정본으로 사용하지 않는다.

ack는 읽기 확인이 아니라 처리/영속 후속 조치 선언이다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/mail/{message-service,inbox,ack,wait}.ts
- packages/mahas-runtime/src/artifacts/{publisher,reader,retention}.ts

인계 identity는 `handoff:IMP-15`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `inbox.check`, `inbox.wait`, `delivery.ack`, `message.send`, `message.replyAndAck`, `artifact.publish`, `artifact.read`.

직접 소비하는 후속 구현 Task: [IMP-21](../IMP-21/instruction.md), [IMP-26](../IMP-26/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
