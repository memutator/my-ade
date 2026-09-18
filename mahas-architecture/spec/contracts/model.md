# C-MODEL — 모델 공개와 변경 영향


**소비 시점:** IMP-03~IMP-05/IMP-27. D-RDD와 S-COMMON의 불변식/receipt 규칙을 적용한다. 모든 모델 관리 mutation은 model-maintainer 또는 operator의 명시 scope를 요구한다. 일반 worker에게 기본 노출하지 않는다.

SQLite snapshot이 유일한 활성 정본이다. 구조 오류와 전문가의 의미 판단을 분리한다. typed edit의 완전한 종류와 필수 payload는 D-RDD §3이며 이 계약에서 임의 JSON patch로 우회하지 않는다.


## 연산별 계약

### `project.create`

**주체/범위:** operator

**입력:** name:string, repositoryRoot:absolute local path, goal:string

**반환:** projectId, revision, draftModelVersion

**전제·인가:** 등록 가능한 로컬 root와 중복 project identity 확인

**저장·실행 효과:** Project와 초기 draft ModelVersion, receipt 저장. process 생성 없음

**거부·불명:** SCOPE_DENIED, OPERATION_CONFLICT; root probe 미확인은 등록 pending이며 임의 성공 아님

### `project.get`

**주체/범위:** project.read 허용 주체

**입력:** projectId

**반환:** 현재 목표·activeModelVersion·접근 가능한 root metadata

**전제·인가:** project 범위 읽기 검사

**저장·실행 효과:** query only; credential/타 프로젝트 경로 미노출

**거부·불명:** UNAVAILABLE_OPERATION, SCOPE_DENIED

### `model.snapshot`

**주체/범위:** model.read 허용 주체

**입력:** projectId, modelVersion?, projection: structural|coordination|role, roleId?

**반환:** 버전된 구조 또는 역할/팀장 projection, digest

**전제·인가:** projection 범위 인가; role 없는 전역 dump는 operator/model-maintainer만

**저장·실행 효과:** 지정 snapshot 조회. 현재 버전을 결과에 명시

**거부·불명:** STALE_REVISION, SCOPE_DENIED

### `model.change.prepare`

**주체/범위:** model.maintain grant

**입력:** projectId, baseVersion, edits:TypedModelEdit[]

**반환:** changeId, candidateDigest, touchedTargets, structuralErrors, semanticReviewItems

**전제·인가:** before/after 대상의 수정 권한. 새 경계의 부모 scope 포함

**저장·실행 효과:** 후보/진단만 저장; active pointer는 유지

**거부·불명:** MODEL_INVALID 진단 반환; 타 범위 포함 시 SCOPE_DENIED

### `model.change.commit`

**주체/범위:** model.maintain grant

**입력:** changeId, candidateDigest, expectedActiveVersion, semanticDecision:string

**반환:** publishedVersion, digest, impactBatchId

**전제·인가:** candidate 불변성·scope·root/tree/FK/criterion·현재 active CAS

**저장·실행 효과:** snapshot 공개 + active pointer + receipt/event/impact intent 원자 commit

**거부·불명:** STALE_REVISION, MODEL_INVALID; 외부 지침 변경은 자동 덮어쓰지 않음

### `model.impact.list`

**주체/범위:** 해당 책임자 또는 유지 담당자

**입력:** projectId, status?, roleId?, cursor?

**반환:** reason과 before/after refs를 가진 ImpactCandidate[]

**전제·인가:** 조회 대상 role/interface scope

**저장·실행 효과:** 후보 조회 only

**거부·불명:** SCOPE_DENIED, STALE_REVISION cursor

### `model.impact.classify`

**주체/범위:** 지정 유지 판단 주체

**입력:** candidateId, expectedRevision, decision: confirmed|dismissed|resolved, rationale, resolutionRef?

**반환:** 갱신 후보 revision

**전제·인가:** 직접 대상의 유지 책임과 resolutionRef 존재 확인

**저장·실행 효과:** 분류 + receipt. 지침/Task 생성 자동 실행 없음

**거부·불명:** INVALID_TRANSITION, SCOPE_DENIED; 미확인 의미를 자동 resolved 처리 금지
