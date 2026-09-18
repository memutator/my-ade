# IMP-06 — 팀장의 책임 탐색·관계 조회 API 구현

**종류:** 구현 Task

**담당 역할:** 팀 배정 탐색 구현자 · **구현 경계:** `discovery`

## 1. 배정받는 순간의 지시

당신은 discovery 경계에서 **팀장의 책임 탐색·관계 조회 API 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-04, REQ-06, REQ-09 — 구현 시작 전 |
| [discovery-assignment.md](../../../spec/contracts/discovery-assignment.md) | assignment.preview 제외 전체 — 구현 시작 전 |
| [role-realization.md](../../../spec/domains/role-realization.md) | 공개 구현 조회 필드 — 구현 시작 전 |
| [access.md](../../../spec/domains/access.md) | 읽기 scope — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-05](../IMP-05/instruction.md) | `handoff:IMP-05`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-07](../IMP-07/instruction.md) | `handoff:IMP-07`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-10](../IMP-10/instruction.md) | `handoff:IMP-10`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-11](../IMP-11/instruction.md) | `handoff:IMP-11`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. query/paths/contracts/horizontal role/scope 필터를 권한 있는 snapshot에 적용한다. 호출자가 임의 modelVersion을 섞지 못하게 cursor를 binding한다.

2. CandidateCard에 책임·기준·책무·matchReasons·관계 이유·구현 지원 상태·현재 Member 상태를 넣고 구현 내부 문구와 비허용 count/snippet은 제외한다.

3. coordination inspect는 하위 책임 간 긴장을 읽는 상위 view를 사용한다. view가 없으면 missing을 반환하고 agent에게 하위 문서 전체를 자동 전송하지 않는다.

4. selectionToken의 model/role/interface/implementation pins를 무결성 보호하여 발급한다. 이 token을 권한으로 취급하지 않는 verifier를 team.assign에 제공한다.

5. no-match/unassigned/ambiguous와 implementation-missing을 구별해 반환한다. 자동 역할 생성·자동 팀장 배정 fallback을 구현하지 않는다.

## 5. 수정 범위와 하지 않을 일

runtime/discovery

assignment.preview/실제 Member 생성은 IMP-13

검색 결과 반환은 배정이나 spawn이 아니다.

리스트 이후 바뀐 grant/모델은 실제 배정에서 재검사한다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/discovery/{search,inspect,locate,collaborators,implementation-availability}.ts
- CandidateCard와 selectionToken 발급/확인 함수

인계 identity는 `handoff:IMP-06`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `responsibility.search`, `responsibility.inspect`, `responsibility.locate`, `responsibility.collaborators`, `role.implementations`.

직접 소비하는 후속 구현 Task: [IMP-13](../IMP-13/instruction.md), [IMP-31](../IMP-31/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
