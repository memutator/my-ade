# IMP-32 — 역할 구현 편집·context/권한/spawn Inspector 구현

**종류:** 구현 Task

**담당 역할:** 역할 구성 작업대 구현자 · **구현 경계:** `workbench`

## 1. 배정받는 순간의 지시

당신은 workbench 경계에서 **역할 구현 편집·context/권한/spawn Inspector 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-05, REQ-06, REQ-07, REQ-09, REQ-13, REQ-21, REQ-23 — 구현 시작 전 |
| [role-realization.md](../../../spec/domains/role-realization.md) | 전체 — 구현 시작 전 |
| [realization.md](../../../spec/contracts/realization.md) | implementation/context operations — 구현 시작 전 |
| [launch.md](../../../spec/contracts/launch.md) | worker.prepare/inspect — 구현 시작 전 |
| [injection.md](../../../spec/injection.md) | §3~4 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-07](../IMP-07/instruction.md) | `handoff:IMP-07`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-09](../IMP-09/instruction.md) | `handoff:IMP-09`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-19](../IMP-19/instruction.md) | `handoff:IMP-19`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-26](../IMP-26/instruction.md) | `handoff:IMP-26`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. interface clause와 그 의미를 구현하는 component/section을 연결하는 편집 화면을 만든다. raw context 선택과 역할별 재표현을 구별한다.

2. skill/subagent/tool/launch 구성품의 지원 여부와 초기 필수 로딩 coverage를 보여주고 conditional-only 누락을 감추지 않는다.

3. 허용 command 목록과 실제 current grant를 별도로 보여준다. role requiredActions 편집이 권한 부여처럼 보이지 않게 한다.

4. Context Inspector에서 planned/materialized/attached/worker_joined와 inherited unknown을 나란히 보여준다. manifest가 존재한다는 이유로 "주입 완료"를 단정하지 않는다.

5. worker.prepare의 exact pins와 blocked conditions, start receipt의 stage/residuals를 표시한다. 구현의 새 publication이 진행 execution을 자동 갱신하지 않게 한다.

## 5. 수정 범위와 하지 않을 일

desktop role/context/access/spawn inspector

meaning approval·권한 발급·execution confirmation은 서버 책임

모든 업무 agent에게 이 관리 화면과 관리자 schema를 노출하지 않는다.

same-content different-resolution을 단순 요약 길이 슬라이더로 구현하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- role interface→component coverage 편집 화면
- CommandSurface/ContextBundle/실제 InjectionReceipt Inspector
- spawn plan pins/blockers/stages/residuals 화면

인계 identity는 `handoff:IMP-32`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: [IMP-30](../IMP-30/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
