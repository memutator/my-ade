# D-RDD — 책임 구조와 모델 변경

**읽는 시점:** IMP-02~IMP-06, 모델·책임 검색 담당자가 읽는다. 팀장은 C-DISCOVERY의 반환 표현을 사용하며 이 저장 명세를 모든 worker에게 전달하지 않는다.

## 1. 모델과 저장 권위

프로젝트의 활성 RDD는 `projects.active_model_version`이 가리키는 SQLite snapshot이다. `records`는 책임 구조를 구성하는 최소 선언·anchor 계층이라는 의미를 유지하되 파일명이 아니다. JSON import/export는 API의 입출력 형식일 뿐 다른 writer가 아니다. 공개 모델을 파일 watcher가 암묵적으로 덮어쓰지 않는다.

| 객체 / identity | 필수 데이터 | 관계·수명 |
|---|---|---|
| Project / projectId | name, goal, repositoryRoot, activeModelVersion?, revision | 목표는 root responsibility가 아니다. root 없는 draft 허용, published는 root 하나 |
| ModelVersion / versionId | projectId, parentVersion?, rootBoundaryId, goalSnapshot, status, digest | draft→published→superseded; published payload immutable |
| Boundary / (version,id) | name, responsibility.statement, paths | 책임 1개. 경로는 repo-relative file 또는 directory prefix |
| Criterion / (version,boundary,id) | criterion, description, ordinal | boundary당 1개 이상. 수치 임계값·자동 합격 없음 |
| Contains / (version,child) | parentBoundaryId | child당 부모 1개, root 제외 연결된 acyclic tree |
| Contract / (version,id) | name, schemaPath, providerBoundaryId | schema는 정본의 anchor; consumer는 1개 이상 별도 관계 |
| ContractConsumer / (version,contract,consumer) | consumerBoundaryId | 별도 dependency 필드를 중복 저장하지 않음 |
| Role / (version,id) | name, description, boundaryId, horizontalRoleName | description은 공동 책임 성립을 위한 전문적 책무, Task 지시가 아님 |
| HorizontalRole / (version,name) | context binding 목록 | 이름·전문 지침만, grant·agent/model 설정 없음 |
| Context / (version,id) | path | 도메인 payload는 path만. ID는 storage identity. 본문 정본은 해당 파일 |
| BoundaryContext / (version,boundary,context) | contextId | 해당 영토의 재사용 지침 연결 |
| HorizontalContext / (version,horizontalName,context) | contextId | 전문 지침 연결 |
| NonGoal / (version,id) | statement, boundaryId | 실제 경계에 위치시킴; 미배정 라벨을 책임 구조로 가장하지 않음 |
| ModelChange / changeId | baseVersion, typedEdits, candidateDigest, touchedTargets, state | prepared→committed/rejected; commit은 현재 base CAS |

## 2. 책임과 경로

경로는 책임 위치를 찾는 인덱스이지 보안 ACL이 아니다. 조상/자식의 경로 포함은 허용하고 비조상 경계의 같은 파일 소유는 모호성으로 반환한다. tree 오류는 publish를 거부한다. 경로 중첩은 `ambiguous` 진단을 붙여 책임자가 분할/contract를 재판단하게 하며 임의 한 경계를 우선 선택하지 않는다. child의 구체적 prefix를 우선하되 같은 깊이의 동률은 숨기지 않는다. 새 파일이 아직 없더라도 유효한 relative prefix 등록은 가능하다.

부모는 분할·결합을 책임진다. 자식은 부모 원문을 읽는 대신 자기 책임 문법으로 내려온 제약을 가진다. 부모 변경은 직접 자식의 responsibility 재검토 후보를 만든다. 자식 책임이 바뀌면 그 아래에 반복한다. 부모 context 자동 상속 규칙은 없다.

## 3. 구조 연산

C-MODEL의 `model.change.prepare`는 `boundary.create/revise/split/reparent/retire`, `contract.bind/revise/retire`, `role.define/revise/retire`, `horizontalRole.revise`, `context.register/link/unlink`, `goal.revise`, `nonGoal.revise` typed edit를 하나의 후보에 적용한다. 이 편집 이름들은 ChangeSet 안의 연산이며 worker CLI에 각각 전역 관리 명령을 노출할 필요는 없다.

split에는 새 자식들의 책임·기준·paths·role·계약 remap을 명시한다. 부모 책임과 결합 책무는 남는다. reparent의 touchedTargets에는 이전 부모와 새 부모, 이동 subtree 및 실제 변경 관계가 모두 들어간다. retirement는 기존 실행 snapshot을 지우지 않는다. 기존 FK가 끊어질 때는 같은 변경 안에서 detach/remap을 제공해야 한다.

commit은 authorization·baseVersion·candidateDigest·tree/FK/criterion 검사 후 전체 snapshot과 active pointer를 하나의 transaction으로 공개한다. 같은 transaction에서 `ModelPublished`와 stale 후보 생성 intent를 기록한다. 전문가의 trade-off 판단은 필드 유효성 검사로 대체하지 않는다.

## 4. 파생 값

ownersByBoundary는 Role의 역인덱스, collaborators는 same-boundary/contract/contains에서 계산한다. territory lookup, search text, impact closure, available role implementation은 재생성 가능한 projection이다. 독립 정본 필드로 복제하지 않는다. 검색을 위해 정규화한 텍스트는 모델 publication과 같은 버전으로 구축한다.

## 5. 유지 비용과 원본

코드·타입·테스트의 현재 사실은 직접 읽는다. Context 등록은 재구성보다 빠르고 여러 작업에 재사용되는 지침일 때만 책임자가 승인한다. DB content snapshot은 어떤 실행에 어떤 byte가 들어갔는지 확인할 때 사용한다. 그 snapshot을 새로운 지침 저작 창으로 제공하지 않는다.
