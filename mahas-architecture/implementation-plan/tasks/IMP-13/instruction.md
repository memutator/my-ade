# IMP-13 — Run·팀장 배정·META DAG·Assignment 서비스 구현

**종류:** 구현 Task

**담당 역할:** 협업 도메인 구현자 · **구현 경계:** `coordination`

## 1. 배정받는 순간의 지시

당신은 coordination 경계에서 **Run·팀장 배정·META DAG·Assignment 서비스 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-01, REQ-04, REQ-10, REQ-17 — 구현 시작 전 |
| [work.md](../../../spec/domains/work.md) | §1~4 — 구현 시작 전 |
| [work.md](../../../spec/contracts/work.md) | run/plan/team/assignment operations — 구현 시작 전 |
| [discovery-assignment.md](../../../spec/contracts/discovery-assignment.md) | assignment.preview — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | runs/members/assignments/plans/plan_candidates/plan_tasks/task_edges — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-04](../IMP-04/instruction.md) | `handoff:IMP-04`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-06](../IMP-06/instruction.md) | `handoff:IMP-06`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-10](../IMP-10/instruction.md) | `handoff:IMP-10`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-11](../IMP-11/instruction.md) | `handoff:IMP-11`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. Run이 선택한 ModelVersion과 goal/coordination mandate를 저장한다. 팀장 Member는 coordination assignment로 Task 없이 시작 가능하게 한다.

2. assignment.preview에서 후보 token·구현 revision·provisioning grant·required action coverage·placement 조건을 보여주고 실제 Member나 권한을 만들지 않는다.

3. team.assign은 현재 token/모델/구현/권한을 재검사하여 Member, Assignment revision, grant binding을 원자 저장한다. 다른 역할 spawn으로 승격할 수 없게 한다.

4. Plan prepare/commit에 TaskSpec revision과 edges를 저장한다. cycle·다른 Run endpoint·active attempt의 disposition 누락을 거부한다.

5. 선행 required output과 settlementRequirement에서 eligible을 계산하되 자동 dispatch/retry하지 않는다. retire와 run.close는 잔여 실행/inbox/자원 처분을 명시하도록 한다.

## 5. 수정 범위와 하지 않을 일

runtime/coordination planning과 Member

실행 process 생성·결과 report는 제외

Task DAG를 대화 thread나 native subagent tree로 합치지 않는다.

팀장의 결과 결합 판단을 모든 child accepted의 자동 AND로 대체하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/coordination/{run,member,assignment,plan,eligibility}.ts
- 검색 selectionToken→preview→assign의 동일 version 처리

인계 identity는 `handoff:IMP-13`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `assignment.preview`, `run.create`, `run.get`, `run.close`, `plan.prepare`, `plan.commit`, `team.assign`, `team.retire`, `assignment.show`.

직접 소비하는 후속 구현 Task: [IMP-14](../IMP-14/instruction.md), [IMP-26](../IMP-26/instruction.md), [IMP-27](../IMP-27/instruction.md), [IMP-31](../IMP-31/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
