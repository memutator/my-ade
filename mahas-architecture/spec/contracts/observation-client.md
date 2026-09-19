# C-OBSERVATION — 관측·개입·UI projection


**소비 시점:** IMP-26/IMP-28의 관측·UI 담당자. hook/process facts와 authoritative Task/Delivery 상태를 섞지 않는다. runtime snapshot/subscribe는 controller가 소유하는 현재 사실의 읽기 인터페이스다.

## client 계약

snapshot은 `epoch,sequence,visibilityDigest,entities`를 반환한다. subscribe는 `afterSequence,epoch,visibilityDigest`를 받는다. gap·retention 초과·권한 변경·epoch 불일치는 `SNAPSHOT_REQUIRED`다. renderer와 detached client는 동일 API를 사용한다. clientViewBinding은 pane/tab에 execution/terminal을 연결하지만 view 삭제가 실행 삭제를 뜻하지 않는다.

terminal attach/input/resize/detach UI 요청은 C-HOST를 직접 호출하지 않고 mahasd가 읽기/입력 lease 권한을 검사한 뒤 proxy한다. operator의 raw terminal 타이핑이 무엇을 승인했는지 서버가 자동 의미 판정하지 않는다.


## 연산별 계약

### `observation.ingest`

**주체/범위:** trusted hook ingress/service 또는 제한된 self reporter

**입력:** execution hint, source, type, payload, identityEvidence

**반환:** factId, projection cursor

**전제·인가:** source별 인증/귀속 강도 기록; 외부 log 내용을 completion으로 신뢰 금지

**저장·실행 효과:** ObservationFact 저장; Task/Delivery 정산 안 함

**거부·불명:** foreign/unbound facts는 separate/untrusted

### `intervention.raise`

**주체/범위:** 자기 담당자/관측 service

**입력:** execution/member/task ref, kind, evidence, requestedHumanAction

**반환:** Intervention id/state

**전제·인가:** 해당 작업·실행 연결 scope

**저장·실행 효과:** 개입 항목과 notification event 저장

**거부·불명:** SCOPE_DENIED

### `intervention.resolve`

**주체/범위:** 지정 responder/operator

**입력:** interventionId, expectedRevision, responseNote, evidenceRef?

**반환:** resolved/obsolete revision

**전제·인가:** prompt/실행 identity 현재성 확인; 오래된 요청 다른 prompt에 적용 금지

**저장·실행 효과:** 의미 판정 기록. generic PTY permission 자동 approval API 아님

**거부·불명:** STALE_REVISION, STALE_EXECUTION

### `runtime.snapshot`

**주체/범위:** 허용 client/조율자

**입력:** scope, projectionPurpose

**반환:** Snapshot

**전제·인가:** role-aware read filter/metadata redaction

**저장·실행 효과:** read only

**거부·불명:** SCOPE_DENIED

### `runtime.subscribe`

**주체/범위:** 허용 client

**입력:** scope, epoch, afterSequence, visibilityDigest

**반환:** event stream 또는 SNAPSHOT_REQUIRED

**전제·인가:** physical transport마다 capability와 visibility 확인

**저장·실행 효과:** subscription 생성, domain mutation 없음

**거부·불명:** cursor gap/expired 권한이면 재조회 요청
