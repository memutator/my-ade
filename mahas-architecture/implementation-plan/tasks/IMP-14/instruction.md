# IMP-14 — TaskSpec·Dispatch 권한·입력 pin과 WorkEnvelope 구현

**종류:** 구현 Task

**담당 역할:** 작업 시도 구현자 · **구현 경계:** `coordination`

## 1. 배정받는 순간의 지시

당신은 coordination 경계에서 **TaskSpec·Dispatch 권한·입력 pin과 WorkEnvelope 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-07, REQ-11, REQ-17, REQ-20 — 구현 시작 전 |
| [work.md](../../../spec/domains/work.md) | 전체 — 구현 시작 전 |
| [role-realization.md](../../../spec/domains/role-realization.md) | WorkEnvelope — 구현 시작 전 |
| [launch.md](../../../spec/contracts/launch.md) | 스폰 stage와 정확한 입력 — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | task_specs/dispatches/work_envelopes — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-13](../IMP-13/instruction.md) | `handoff:IMP-13`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-08](../IMP-08/instruction.md) | `handoff:IMP-08`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. Task identity와 TaskSpec immutable revision을 분리하고 active authoritative Dispatch를 하나로 유지하는 repository를 만든다.

2. future task-output을 정확한 settled output의 ArtifactRef로 resolve한다. producer가 끝났다는 표시만으로 입력을 준비된 것으로 보지 않는다.

3. 이번 requirement 본문·업무 scope·artifact 사용 시점·peer 관계·output/report 조건을 WorkEnvelope 본문으로 작성하고 blob/digest를 고정한다.

4. coordination envelope는 Run mandate와 role context를 넣고 가짜 task/dispatch를 만들지 않는다.

5. task accept/report를 위한 current attempt/generation/revision 검사를 함수로 제공한다. Task 변경 시 기존 attempt 결과가 새 revision에 적용되지 않도록 pointer를 구별한다.

## 5. 수정 범위와 하지 않을 일

작업 시도/입력/초기 업무 envelope

accept API 연결은 IMP-20, 결과 정산은 IMP-21

소비자가 아직 실행되지 않은 producer의 live directory를 읽도록 바인딩하지 않는다.

현재 작업 요구사항을 Role.description이나 재사용 context에 추가하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/coordination/{task-spec,dispatch-authority,input-resolver,work-envelope}.ts
- reserveDispatch/acceptDispatch/fenceDispatch와 pinnedInput port

인계 identity는 `handoff:IMP-14`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: [IMP-15](../IMP-15/instruction.md), [IMP-19](../IMP-19/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
