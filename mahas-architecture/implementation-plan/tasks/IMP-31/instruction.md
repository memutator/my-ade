# IMP-31 — 책임 탐색·배정·META DAG 작업대 구현

**종류:** 구현 Task

**담당 역할:** 팀장 작업대 구현자 · **구현 경계:** `workbench`

## 1. 배정받는 순간의 지시

당신은 workbench 경계에서 **책임 탐색·배정·META DAG 작업대 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-04, REQ-06, REQ-09, REQ-17, REQ-23 — 구현 시작 전 |
| [discovery-assignment.md](../../../spec/contracts/discovery-assignment.md) | 전체 — 구현 시작 전 |
| [work.md](../../../spec/contracts/work.md) | preview/assign/plan — 구현 시작 전 |
| [observation-client.md](../../../spec/contracts/observation-client.md) | snapshot/subscribe — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-06](../IMP-06/instruction.md) | `handoff:IMP-06`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-13](../IMP-13/instruction.md) | `handoff:IMP-13`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-26](../IMP-26/instruction.md) | `handoff:IMP-26`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. 팀장의 query/path/contract/전문성 필터를 제공하고 CandidateCard의 책임·기준·긴장을 우선 표시한다.

2. 상위 구현 원문을 자동 펼치지 않고 관계 이유와 role 구현 가능성·현재 Member 상태를 구별한다.

3. 검색 token으로 preview를 호출한 뒤 사용자/팀장 명시 선택으로 team.assign을 실행한다. no-match/ambiguous/stale을 다른 상태로 다룬다.

4. META DAG 편집은 Task requirement/input/output/settlement를 다루고 메시지 대화를 edge로 강제하지 않는다.

5. 같은 초기 협의에 참여할 제공자/소비자를 각각 배정할 수 있게 하여 선행 output을 기다리는 Task 때문에 상대가 시작되지 않는 순환 대기를 피한다.

## 5. 수정 범위와 하지 않을 일

desktop responsibility/team/plan views

모델 의미 저작과 실제 실행 protocol은 서비스에 위임

검색 순위가 자동 배정 버튼의 기본 확정으로 이어지지 않게 한다.

직접 협업을 모든 메시지의 팀장 중계 UI로 바꾸지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- 책임 검색/관계/구현 가능성/미배정 영역 UI
- preview→명시 assign→plan 편집 작업대
- 검색 결과 version stale 표시와 재조회 동작

인계 identity는 `handoff:IMP-31`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: [IMP-30](../IMP-30/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
