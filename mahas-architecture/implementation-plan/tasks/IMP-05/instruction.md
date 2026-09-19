# IMP-05 — 책임 관계 인덱스·territory·변경 영향 계산 구현

**종류:** 구현 Task

**담당 역할:** 책임 조회 기반 구현자 · **구현 경계:** `model/discovery`

## 1. 배정받는 순간의 지시

당신은 model/discovery 경계에서 **책임 관계 인덱스·territory·변경 영향 계산 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-03, REQ-04, REQ-21 — 구현 시작 전 |
| [rdd.md](../../../spec/domains/rdd.md) | §2, §4 — 구현 시작 전 |
| [discovery-assignment.md](../../../spec/contracts/discovery-assignment.md) | 검색 알고리즘과 CandidateCard — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | role_search_rows, role_search_fts와 관계 인덱스 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-04](../IMP-04/instruction.md) | `handoff:IMP-04`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. boundary별 role, child/parent, contract endpoints, context 사용처를 SQLite relation에서 조회하는 repository 인덱스를 만든다. owners 필드를 별도 정본으로 저장하지 않는다.

2. file/directory prefix의 가장 구체적인 ancestor를 찾고 비조상 중첩은 ambiguous로 반환한다. 입력 경로를 정규화하고 unassigned를 유지한다.

3. modelVersion마다 normalized search text와 FTS projection을 만든다. 한국어 부분검색 fallback에 LIKE escaping을 적용한다.

4. model publication transaction에서 새 인덱스가 준비된 버전만 검색 가능하게 한다. 오래된 cursor는 같은 snapshot으로 계속하거나 명시 재조회로 처리한다.

5. 부모 responsibility 변경은 직접 자식 번역, contract 변경은 before/after consumer 합집합, horizontal context 변경은 참조 role을 후보로 계산한다. 의미적 실제 영향은 확정하지 않는다.

## 5. 수정 범위와 하지 않을 일

model indices와 discovery query repository

후보 분류/유지 Task 발행 UI는 IMP-27

검색이나 FTS score를 책임자의 전문성 점수로 표현하지 않는다.

line number 변화 자체를 의미적 지침 변화로 확정하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/model/{indices,territory,impact-candidates}.ts
- model publication 안에서 호출하는 SearchProjectionWriter
- scope-aware before/after impact 계산 포트

인계 identity는 `handoff:IMP-05`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: [IMP-06](../IMP-06/instruction.md), [IMP-08](../IMP-08/instruction.md), [IMP-27](../IMP-27/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
