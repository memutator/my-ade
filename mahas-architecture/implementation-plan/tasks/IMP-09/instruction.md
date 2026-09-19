# IMP-09 — 구성품 materializer와 실효 컨텍스트 검사 조회 구현

**종류:** 구현 Task

**담당 역할:** 컨텍스트 설치 구현자 · **구현 경계:** `realization/launch`

## 1. 배정받는 순간의 지시

당신은 realization/launch 경계에서 **구성품 materializer와 실효 컨텍스트 검사 조회 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-05, REQ-07, REQ-16, REQ-22 — 구현 시작 전 |
| [injection.md](../../../spec/injection.md) | §3, §4 — 구현 시작 전 |
| [realization.md](../../../spec/contracts/realization.md) | context.inspect — 구현 시작 전 |
| [resources-observation.md](../../../spec/domains/resources-observation.md) | ContentBlob/RetentionPin — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-08](../IMP-08/instruction.md) | `handoff:IMP-08`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-16](../IMP-16/instruction.md) | `handoff:IMP-16`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. execution 전용 staging 디렉터리에 compiled components를 쓴 뒤 manifest/digest가 맞을 때만 atomic publish한다.

2. component output 경로를 canonicalize하고 escape/collision/symlink 덮어쓰기·공용 CLAUDE/AGENTS 수정 요구를 거부한다.

3. profile이 project-scoped skill을 요구하면 독점 worktree claim과 충돌 없는 경로를 사용한다. 같은 checkout 여러 role의 파일을 바꾸어 쓰지 않는다.

4. planned components와 actual attached/loading evidence를 구분한 context.inspect를 구현한다. inherited organization/user/project 지침은 known/unknown을 표시한다.

5. 원본·구현·bundle pin을 보존하고 materialize 실패의 staging/residual resource를 effect receipt로 내보낸다. agent credential은 text manifest에 포함하지 않는다.

## 5. 수정 범위와 하지 않을 일

realization materialization과 inspector query

native 설정 formatting은 profiles 담당; startup attachment는 IMP-19

generated 실행 파일은 SQLite 모델의 새 저작 정본이 아니다.

native 숨은 prompt를 볼 수 없으면 전체 context를 안다고 표시하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/realization/{materializer,component-store,effective-context}.ts
- 불변 실행 디렉터리 manifest와 계획/실제 로딩 조회

인계 identity는 `handoff:IMP-09`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `context.inspect`.

직접 소비하는 후속 구현 Task: [IMP-19](../IMP-19/instruction.md), [IMP-24](../IMP-24/instruction.md), [IMP-25](../IMP-25/instruction.md), [IMP-32](../IMP-32/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
