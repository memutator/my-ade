# D-MAIL — 메시지·수신·산출물·판정

**소비 시점:** IMP-14/15/21, 메시지와 결과 API 담당자.

## 1. 객체

| 객체 | 필드 | 불변식 |
|---|---|---|
| Message | id, runId, senderPrincipalId, senderMemberId?, kind, relatedTask/contract refs, body, artifactRefs, createdAt | 본문 immutable. system assignment는 service principal, 일반 peer message는 Member principal. kind는 assignment/question/reply/handoff/notice/report 등 설명적 구분 |
| Delivery | id, messageId, recipientMemberId, consumerGeneration, status, ackRevision, ackedAt | recipient별 outstanding/acknowledged/fenced. 읽기만으로 ack 아님 |
| InboxRead | memberId, executionGeneration, batchCursor, deliveryIds | FIFO snapshot; ack 전 재조회 가능 |
| Artifact | id, revision, runId, producerDispatchId, contentRef or commitRef, mediaType, size, outputSlot, retainedBy | exact revision immutable; dirty workspace 경로만을 결과로 제출하지 않음 |
| Outcome | id, taskId, taskRevision, dispatchId, revision, result: succeeded/failed/blocked, rationale, criterionAssessment, outputRefs | 현재 authoritative Dispatch의 명시 선언만 접수 |
| Settlement | id, outcomeId/revision, authorityMemberId, decision: accepted\|rejected\|revision-requested, reason, decidedAt | owner-declaration 또는 지정 수용자. 거부/수정요청도 명시. 별칭 `accept`→`accepted`만 허용 |
| RunDecision | runId, planRevision, coordinator, decision, compositionRationale | 모든 child Task success의 자동 합이 아님 |

## 2. 전달 계약

message.send는 Message와 recipient Delivery 및 receipt를 하나의 DB transaction에 저장한다. ACK success는 agent가 처리 또는 영속 후속 조치를 선언했다는 의미다. 읽거나 wake했거나 provider가 prompt를 받았다는 사실과 다르다. inbox.check는 consumer generation을 확인하고 outstanding batch를 FIFO로 반환한다.

같은 Member의 새 Execution이 실제로 시작되면 이전 consumer generation의 credential/read token을 fence하고 미처리 Delivery 행을 새 generation으로 재바인딩한다. outstanding 상태는 유지하며 message를 복제하지 않는다. fenced Delivery 상태는 retire 등으로 수신 자체를 닫는 경우에 사용한다. 이전 실행이 제출한 ack는 거부한다. Message를 복제하거나 새 전송으로 만들지 않는다. read cursor는 성능 도구이고 Delivery status가 정본이다.

message.replyAndAck는 회신 enqueue와 원문 Delivery ack를 같은 transaction으로 처리한다. 이미 같은 operation을 처리했으면 receipt를 replay한다. 새로운 답변을 기존 operationId로 보내면 conflict다. 타 Member의 Delivery ack는 scope denied다.

## 3. artifact와 contract

Contract.schema는 입출력 약속의 원본 위치다. Artifact는 이번에 생산한 내용이다. 소비자는 task-output binding을 정확한 ArtifactRef로 고정한다. producer의 live worktree를 공유 입력으로 암묵 이용하지 않는다. 파일 artifact는 실제 byte를 content-addressed store에 보존하고, Git commit ref는 object 존재와 retention claim을 유지한다. 둘 다 digest/identity를 확인한다.

## 4. 결과와 재수정

owner-declaration이면 report와 자기 settlement를 같은 transaction으로 확정할 수 있다. designated-acceptance이면 report는 pending이고 정해진 수용자의 outcome.decide가 해당 outcome revision을 결정한다. `decision` 정본은 `accepted` \| `rejected` \| `revision-requested`다. 입력 별칭 `accept`는 `accepted`로만 번역한다. old decision은 새 outcome revision에 적용되지 않는다. TaskSpec이 이미 바뀌었다면 이전 결과를 새 요구사항의 성공으로 옮기지 않는다. eligibility/resolver가 소비하는 accepting set도 같은 열거다.

자동 검사는 필수 필드·현재 dispatch·artifact 존재·권한·revision이다. criterion 충족과 trade-off는 책임자의 명시 판단이다. 보고 본문이 짧다는 이유로 자동 불합격시키거나 숫자 threshold를 새로 발명하지 않는다. 실패/blocked outcome의 후속 재시도는 팀장이 결정한다.

## 5. wake와 결과의 직교성

Delivery가 저장됐어도 idle TUI가 즉시 읽는다는 보장은 없다. bounded inbox.wait는 실행 중 tool call이며 timeout은 empty result다. 검증된 안전 wake와 ContinuationGrant가 있을 때만 attention pointer를 전달한다. unavailable/failed wake는 Delivery를 삭제하지 않는다. 이 경계를 UI에서도 구별한다.
