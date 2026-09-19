# IMP-08 — 결정적 role component compiler와 ContextBundle 구현

**종류:** 구현 Task

**담당 역할:** 컨텍스트 compiler 구현자 · **구현 경계:** `realization`

## 1. 배정받는 순간의 지시

당신은 realization 경계에서 **결정적 role component compiler와 ContextBundle 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-05, REQ-06, REQ-07, REQ-09, REQ-22 — 구현 시작 전 |
| [realization.md](../../../spec/contracts/realization.md) | 빌드 함수, context.build — 구현 시작 전 |
| [injection.md](../../../spec/injection.md) | §2~4 — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | content_blobs/context_bundles/components/command_surfaces — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-05](../IMP-05/instruction.md) | `handoff:IMP-05`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-07](../IMP-07/instruction.md) | `handoff:IMP-07`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-11](../IMP-11/instruction.md) | `handoff:IMP-11`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. 고정된 interface/implementation/surface/source pins를 받아 component graph 순서로 내용을 해석한다. 입력 byte가 같은 경우 digest/본문 순서를 동일하게 만든다.

2. initial requirement를 충족하는 instruction 또는 confirmed preload path를 검사하고 missing/unsupported를 오류로 반환한다. optional skill 설명만으로 완료하지 않는다.

3. reexpressed binding의 구현 문구만 선택하고 원래 상위 장문을 추가하지 않는다. maintenanceBasis는 trace용으로만 기록한다.

4. mandatory role text와 permitted command guide를 만들고 source observation hash와 component manifest를 ContentBlob/ContextBundle에 저장한다.

5. Task/run/credential/timestamp를 재사용 text에서 제외한다. 필요한 action이 실제 surface에 없으면 REQUIRED_ACTION_DENIED로 돌려준다.

## 5. 수정 범위와 하지 않을 일

runtime/realization compiler

OS materialization·TaskEnvelope·native recipe 실행은 제외

경로만 전달하는 것을 필수 본문 전달로 기록하지 않는다.

길이가 길다고 자동 요약·절단하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/realization/{compiler,coverage,source-snapshots,bundle-store}.ts
- C-REALIZATION ContextBundle build 결과와 manifest

인계 identity는 `handoff:IMP-08`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `context.build`.

직접 소비하는 후속 구현 Task: [IMP-09](../IMP-09/instruction.md), [IMP-14](../IMP-14/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
