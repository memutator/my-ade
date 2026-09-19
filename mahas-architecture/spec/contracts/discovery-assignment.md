# C-DISCOVERY — 팀장의 책임 탐색·조회·배정 준비


**소비 시점:** IMP-06/IMP-13, 팀장 UI/CLI 담당자. REQ-04의 정식 API다. 검색과 실제 배정을 한 operation으로 합치지 않는다.

## 검색 표현과 알고리즘

SearchRequest는 `projectId, modelVersion?, query?, paths[], contractIds[], horizontalRoleNames[], scopeBoundaryId?, cursor?, limit`이다. 최소한 query 또는 구조 필터 하나를 요구한다. 기본 limit=20, 상한=100은 조회 자원 제약이며 책임의 합격 기준이 아니다. plain query는 parameter binding한 tokenizer/FTS 인덱스로 처리하고 query 문자열을 SQL/FTS 문법으로 직접 실행하지 않는다. URI·경로는 normalize 후 territory 인덱스로 조회한다.

우선 구조 필터와 권한으로 후보집합을 제한하고, 코드 경로 exact/longest-prefix 일치·계약 연결·책임/역할/criterion 텍스트 일치 이유를 반환한다. lexical ordering은 탐색 편의일 뿐 전문성 점수/담당자 자동 선정이 아니다. 한국어 부분검색은 정상화된 부분 문자열 경로를 함께 제공한다. FTS tokenization만으로 한글 의미를 이해한다고 주장하지 않는다. query가 모호하거나 결과가 없으면 `unassigned/ambiguous/no-match`를 반환하고 임의 role을 만들지 않는다.

CandidateCard에는 `boundary{id,name,responsibility,criteria}`, `role{id,name,description,horizontalRole}`, `matchReasons[]`, `relationshipRefs[]`, `implementationAvailability[]`, `memberAvailability[]`, `scopeCoverage`, `selectionToken`이 있다. implementation의 내부 파일 본문은 없다. 팀장은 가치·긴장을 읽고 구현자는 자기 작업의 상세 지침을 받는다. Availability는 관측 시각을 가진 현재 정보이며 미래 실행 성공 보장이 아니다.

selectionToken은 project/modelVersion/roleId/roleRevision/implementation 후보 digest와 scope를 묶는 무결성 보호 opaque 값이다. bearer authorization이 아니다. team.assign에서 현재 권한과 version을 다시 검사한다.


## 연산별 계약

### `responsibility.search`

**주체/범위:** 팀장 discovery.search / 위임된 범위

**입력:** SearchRequest

**반환:** CandidateCard[], unmatchedPaths[], ambiguityGroups[], nextCursor, modelVersion

**전제·인가:** server-side visibility 필터; 숨겨진 count/snippet 제외

**저장·실행 효과:** query only. 검색 projection은 model snapshot에서 재생성 가능

**거부·불명:** NO_RESPONSIBLE_ROLE/no-match는 정상 진단, 권한 초과는 SCOPE_DENIED

### `responsibility.inspect`

**주체/범위:** discovery.read 범위

**입력:** projectId, modelVersion, boundaryId, perspective: coordination|owner

**반환:** 해당 책임/기준, 직접 자식 책임, contract 긴장, non-goals, role 목록

**전제·인가:** coordination은 caller가 조율하는 scope만; 모든 자식 context 본문 제외

**저장·실행 효과:** 읽기 only; 작성된 상위 view가 없으면 missing-view를 명시

**거부·불명:** SCOPE_DENIED, INTERFACE_STALE; 즉석 요약으로 missing 은폐 금지

### `responsibility.locate`

**주체/범위:** discovery.locate 범위

**입력:** projectId, modelVersion?, paths[]

**반환:** path별 deepest boundary/roles 또는 ambiguous/unassigned

**전제·인가:** 정규화와 scope 검사, symlink escape 제외

**저장·실행 효과:** query only. 부모/자식 관계가 아닌 중첩은 모두 보여줌

**거부·불명:** AMBIGUOUS_TERRITORY 또는 진단; 무작위 tie-break 금지

### `responsibility.collaborators`

**주체/범위:** 자기 역할 또는 팀장 scope

**입력:** projectId, modelVersion, roleId, runId?

**반환:** role/member별 relationReason: same-boundary|contract|contains, contract direction

**전제·인가:** role 읽기 scope와 해당 Run 참여 공개 범위

**저장·실행 효과:** 정적 관계를 Run Member 주소로 resolve; 미배정이면 role만 반환

**거부·불명:** SCOPE_DENIED; 실제 Member 없는데 주소 발명 금지

### `role.implementations`

**주체/범위:** role 읽기와 discovery 권한

**입력:** modelVersion, roleId, hostId?, componentNeeds?

**반환:** implementationRevision/interfaceDigest/profile/support/blockers 목록

**전제·인가:** 공개된 해당 interface 구현만, secret launch data 제외

**저장·실행 효과:** query only; documented/verified 상태 구별

**거부·불명:** IMPLEMENTATION_MISSING은 결과 상태; fallback 하네스 자동 선택 없음

### `assignment.preview`

**주체/범위:** team.plan 위임 범위

**입력:** runId, selectionToken, implementationRevision, assignmentKind, mandateText, taskId/revision?, placementIntent

**반환:** proposed Member/Assignment, requiredActions, grantCoverage, contextBlockers, resourceConditions

**전제·인가:** provisioning grant의 role allowlist/대상 범위; 검색 version 재검사

**저장·실행 효과:** preview receipt만, Member/Dispatch/process/권한 발급 없음

**거부·불명:** STALE_REVISION, REQUIRED_ACTION_DENIED, IMPLEMENTATION_MISSING, RESOURCE_BUSY
