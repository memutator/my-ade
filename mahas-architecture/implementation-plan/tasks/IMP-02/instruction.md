# IMP-02 — 전체 도메인 타입과 wire schema의 정본 구현

**종류:** 구현 Task

**담당 역할:** 도메인 계약 구현자 · **구현 경계:** `contracts`

## 1. 배정받는 순간의 지시

당신은 contracts 경계에서 **전체 도메인 타입과 wire schema의 정본 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-02, REQ-03, REQ-05, REQ-09, REQ-11, REQ-17, REQ-18, REQ-20 — 구현 시작 전 |
| [common.md](../../../spec/common.md) | 전체 — 구현 시작 전 |
| [rdd.md](../../../spec/domains/rdd.md) | 객체 표 — 구현 시작 전 |
| [role-realization.md](../../../spec/domains/role-realization.md) | §1, §2 — 구현 시작 전 |
| [work.md](../../../spec/domains/work.md) | §1 — 구현 시작 전 |
| [execution.md](../../../spec/domains/execution.md) | §1 — 구현 시작 전 |
| [messaging-outcomes.md](../../../spec/domains/messaging-outcomes.md) | §1 — 구현 시작 전 |
| [resources-observation.md](../../../spec/domains/resources-observation.md) | §1~3 — 구현 시작 전 |
| [operations.md](../../../spec/operations.md) | 전체 operation 이름 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-01](../IMP-01/instruction.md) | `handoff:IMP-01`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. modelVersion, implementationRevision, taskRevision, executionGeneration, controllerEpoch, hostIncarnation을 구별한 branded/opaque 타입을 정의한다.

2. domains 문서의 모든 aggregate와 nested value object를 wire-safe discriminated union으로 정의한다. Task, Dispatch, Execution의 상태를 하나의 enum으로 합치지 않는다.

3. CommandRequest, authenticated server context, Receipt, QueryResult, Error, ContentRef/ArtifactRef를 구현한다. raw payload가 인증된 principal을 덮어쓰는 필드를 허용하지 않는다.

4. C-HOST를 별도 service contract namespace로 내보내 worker operation schema와 분리한다. operation 이름은 spec/operations와 일치시킨다.

5. 공통 enum/필수 필드/unknown field 정책을 고정한다. 생성된 TypeScript 타입과 입력 schema를 각 핸들러가 복제하지 않도록 export 경로를 제공한다.

## 5. 수정 범위와 하지 않을 일

packages/mahas-contracts

DB migration·실제 핸들러·별도 참조 코드 생성은 제외

JSON schema 통과는 의미적 책임 충족이나 결과 품질의 증명이 아니다.

문서에 없는 provider turn 타입을 공통 필수 계약으로 추가하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-contracts/src/{ids,rdd,role,access,work,execution,mail,resource,observation}.ts
- 공용 runtime request/result schema와 C-* contract export

인계 identity는 `handoff:IMP-02`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: [IMP-03](../IMP-03/instruction.md), [IMP-11](../IMP-11/instruction.md), [IMP-17](../IMP-17/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
