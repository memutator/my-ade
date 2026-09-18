# IMP-04 — SQLite RDD aggregate와 원자적 모델 변경 구현

**종류:** 구현 Task

**담당 역할:** 책임 모델 구현자 · **구현 경계:** `model`

## 1. 배정받는 순간의 지시

당신은 model 경계에서 **SQLite RDD aggregate와 원자적 모델 변경 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-02, REQ-03, REQ-21, REQ-22 — 구현 시작 전 |
| [rdd.md](../../../spec/domains/rdd.md) | 전체 — 구현 시작 전 |
| [model.md](../../../spec/contracts/model.md) | project/model snapshot/change operations — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | projects, model_versions, rdd_*, boundary_*, horizontal_*, contract_consumers, model_changes — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-03](../IMP-03/instruction.md) | `handoff:IMP-03`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-10](../IMP-10/instruction.md) | `handoff:IMP-10`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-11](../IMP-11/instruction.md) | `handoff:IMP-11`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. versioned boundary/responsibility/criteria/contains/contract/role/context/non-goal repository를 구현한다. responsibility는 boundary 안의 단일 선언으로 유지한다.

2. TypedModelEdit의 split/reparent/retire/remap을 before/after candidate에 적용한다. parent·새 자식·role·계약 연결을 하나의 변경 단위로 계산한다.

3. root 하나, connected tree, FK, 최소 criterion, context path 형식과 retired 대상의 참조를 검사하는 publish rule을 구현한다. 기준 사이 trade-off를 수치 gate로 만들지 않는다.

4. actual touchedTargets를 후보의 실제 diff에서 계산해 access resolver에 전달한다. reparent는 이전·새 부모를 모두 포함한다.

5. active model CAS, candidateDigest, 권한 재검사 후 snapshot 전체와 search rebuild intent/event/receipt를 공개한다. 검색 인덱스의 동기 publication 포트는 IMP-05와 결합한다.

## 5. 수정 범위와 하지 않을 일

runtime/model

search UI·RoleImplementation 구성·실행 스폰은 제외

published version의 row를 수정하지 않는다.

전문 지침 파일 본문은 Context 행에 복제하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/model/{repository,change-set,publisher,structural-rules}.ts
- C-MODEL project/snapshot/change 핸들러
- 모델 publication event payload

인계 identity는 `handoff:IMP-04`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `project.create`, `project.get`, `model.snapshot`, `model.change.prepare`, `model.change.commit`.

직접 소비하는 후속 구현 Task: [IMP-05](../IMP-05/instruction.md), [IMP-07](../IMP-07/instruction.md), [IMP-13](../IMP-13/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
