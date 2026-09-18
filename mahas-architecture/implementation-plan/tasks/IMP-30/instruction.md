# IMP-30 — 전체 runtime 배선·CLI 배포·service entrypoint 조립

**종류:** 구현 Task

**담당 역할:** 아키텍처 통합 구현자 · **구현 경계:** `platform`

## 1. 배정받는 순간의 지시

당신은 platform 경계에서 **전체 runtime 배선·CLI 배포·service entrypoint 조립**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-01, REQ-08, REQ-12, REQ-25, REQ-28 — 구현 시작 전 |
| [architecture.md](../../../spec/architecture.md) | 전체 — 구현 시작 전 |
| [operations.md](../../../spec/operations.md) | 모든 operation과 service-only 구분 — 구현 시작 전 |
| [README.md](../../../spec/contracts/README.md) | 계약 registry — 구현 시작 전 |
| [DAG.md](../../../implementation-plan/DAG.md) | 최종 합류 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-23](../IMP-23/instruction.md) | `handoff:IMP-23`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-24](../IMP-24/instruction.md) | `handoff:IMP-24`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-25](../IMP-25/instruction.md) | `handoff:IMP-25`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-27](../IMP-27/instruction.md) | `handoff:IMP-27`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-28](../IMP-28/instruction.md) | `handoff:IMP-28`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-29](../IMP-29/instruction.md) | `handoff:IMP-29`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-31](../IMP-31/instruction.md) | `handoff:IMP-31`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-32](../IMP-32/instruction.md) | `handoff:IMP-32`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. domain repositories, actual target resolvers, registry handlers, event outbox, host client, materializer/profile registry를 composition root에 연결한다.

2. worker CLI에는 filtered schema만 노출하고 operator/host-only 경로를 분리한 배포 구성을 만든다.

3. missing handler·unsupported profile·미확인 실행 기능을 활성 surface에 넣지 않도록 runtime startup admission을 완성한다.

4. desktop service bootstrap/endpoint ownership, mahasd standalone entrypoint, execution-host readiness를 배포 파일에 포함한다.

5. 구현 handoff에 정확한 code revision, migrations, executable entrypoints, operation ownership, documented profile 상태와 known limitations를 기록한다. 독립 review/verification 결과를 스스로 승인하지 않는다.

## 5. 수정 범위와 하지 않을 일

runtime composition/packaging

review 승인·제품 수락 보고서는 별도 폴더 책임

원본 저장소에 없는 구현을 이미 존재하는 것으로 보고하지 않는다.

두 실제 하네스 수락은 VER-09~11 전까지 verified로 표시하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- mahasd composition root, execution-host service bundle, scoped mahas CLI 배포
- Desktop service bootstrap과 feature activation 설정
- 모든 C-* handler/ports가 연결된 구현 revision

인계 identity는 `handoff:IMP-30`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: 최종 결합 및 별도 review/verification 담당자.

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
