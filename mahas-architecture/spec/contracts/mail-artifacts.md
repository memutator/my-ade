# C-MAIL — 공통 mailbox·회신·artifact 인계


**소비 시점:** IMP-15/21, 협업 CLI 담당자. 아래 API는 하네스의 native send/turn protocol을 사용하지 않는다. Message는 immutable, Delivery는 수신자별 상태다. wake는 C-LAUNCH에 별도로 있다.

`inbox.wait`는 실행 중 agent의 bounded tool call이다. 대기 중 CLI 프로세스가 종료되어도 메시지 원장은 남는다. wait timeout은 오류나 task failure가 아니라 empty result다. waiting을 위한 connection 수/최대 시간은 서버 자원 설정이고 업무 의미 제약이 아니다.


## 연산별 계약

### `inbox.check`

**주체/범위:** 현재 Member

**입력:** cursor?, limit?

**반환:** FIFO outstanding Delivery batch, message/artifact refs, cursor

**전제·인가:** current consumer generation과 본인 mailbox

**저장·실행 효과:** 읽기 only; ack 안 함. 읽은 batch는 다시 받을 수 있음

**거부·불명:** STALE_EXECUTION, SCOPE_DENIED

### `inbox.wait`

**주체/범위:** 현재 Member

**입력:** cursor?, maxWaitMs, limit?

**반환:** 새/기존 outstanding batch 또는 empty, cursor

**전제·인가:** 본인 권한. connection 재검증과 bounded wait

**저장·실행 효과:** 메시지 생성/ack 없음; timeout에서 자동 wake/spawn 안 함

**거부·불명:** CONTROL_UNAVAILABLE; 원장에는 전달 계속 보존

### `delivery.ack`

**주체/범위:** Delivery의 현재 recipient

**입력:** deliveryId, expectedDeliveryRevision, handling: completed|durably-deferred, followupRef?

**반환:** ackRevision

**전제·인가:** recipient/current generation; durably-deferred는 실제 후속 기록 요구

**저장·실행 효과:** ack + receipt transaction

**거부·불명:** STALE_EXECUTION, STALE_REVISION; 타 inbox ack 거부

### `message.send`

**주체/범위:** peer messaging grant

**입력:** recipientMemberIds[], body, kind, task/contractRefs?, artifactRefs?

**반환:** messageId, deliveryIds, durable receipt

**전제·인가:** 허용 관계/Run 범위·artifact read share 권한; sender는 서버 결정

**저장·실행 효과:** Message+모든 Delivery+event/receipt 원자 enqueue

**거부·불명:** SCOPE_DENIED, ARTIFACT_MISMATCH; wake 성공과 무관

### `message.replyAndAck`

**주체/범위:** 현재 recipient

**입력:** originalDeliveryId/revision, replyBody, recipients?, artifactRefs?, handling

**반환:** replyMessageId, deliveryIds, ackRevision

**전제·인가:** 원문 처리권과 회신 상대 scope 모두 확인

**저장·실행 효과:** 회신 enqueue와 원문 ack를 같은 transaction으로 저장

**거부·불명:** STALE_EXECUTION, OPERATION_CONFLICT; 부분 commit 금지

### `artifact.publish`

**주체/범위:** 현재 producer Dispatch

**입력:** dispatchId, outputSlot, source: file|git-commit, sourcePath/commit, mediaType, expectedDigest?

**반환:** immutable ArtifactRef

**전제·인가:** 자기 작업/checkout 읽기 범위; 파일 변경 시 digest 재확인

**저장·실행 효과:** snapshot/retention intent 후 artifact metadata commit; 부분 file copy는 effect 추적

**거부·불명:** ARTIFACT_MISMATCH, RESOURCE_BUSY; live path 자체로 accepted 아님

### `artifact.read`

**주체/범위:** 정확한 artifact를 읽도록 허용된 참여자

**입력:** artifactId, revision, expectedDigest, range?

**반환:** metadata/bytes 또는 scoped local path

**전제·인가:** Task/Delivery 공유 범위, actual blob identity 확인

**저장·실행 효과:** query; bytes가 없으면 명시 unavailable

**거부·불명:** SCOPE_DENIED, ARTIFACT_MISMATCH

### `operation.get`

**주체/범위:** 자기 요청 또는 관리 범위

**입력:** operation, operationId

**반환:** current receipt with effects/residuals

**전제·인가:** 원래 principal scope와 현재 읽기 권한

**저장·실행 효과:** 재호출 없이 상태 조회

**거부·불명:** UNAVAILABLE_OPERATION; timeout을 새 mutation으로 바꾸지 않음
