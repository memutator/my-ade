# IMP-11 — OperationRegistry·동일 admission·역할별 surface 구현

**종류:** 구현 Task

**담당 역할:** API 정책 경계 구현자 · **구현 경계:** `access/contracts`

## 1. 배정받는 순간의 지시

당신은 access/contracts 경계에서 **OperationRegistry·동일 admission·역할별 surface 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-09, REQ-10, REQ-14, REQ-25 — 구현 시작 전 |
| [access-cli.md](../../../spec/contracts/access-cli.md) | 전체 — 구현 시작 전 |
| [operations.md](../../../spec/operations.md) | 전체 — 구현 시작 전 |
| [common.md](../../../spec/common.md) | §2~4 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-02](../IMP-02/instruction.md) | `handoff:IMP-02`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-10](../IMP-10/instruction.md) | `handoff:IMP-10`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. 각 operation의 이름·input/output schema·target resolver·required permission·handler·event contract를 단일 registry에 연결한다.

2. CLI/UI/raw RPC의 요청이 같은 admission을 통과하게 하고 service-only C-HOST를 worker registry에서 제외한다.

3. role ceiling과 current grant의 교집합으로 command guide/help/schema/completion/MCP 목록을 만드는 함수를 제공한다.

4. operation 실행 전과 commit 직전의 revision/권한 검사, fingerprint conflict/replay 처리를 적용한다. replay 결과의 읽기 권한도 재검사한다.

5. 미구현 handler를 가진 action은 사용 가능 surface에 넣지 않는다. hidden command와 unknown command의 worker 오류를 통합하되 관리 trace는 분리한다.

## 5. 수정 범위와 하지 않을 일

runtime/operations

개별 business handler 구현은 각 domain 담당

if role==lead 분기를 client/server에 복제하지 않는다.

전체 관리자 schema를 scoped CLI에 내려주지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/operations/{registry,admission,surface,handler-ports}.ts
- filtered command schema/help/projection export

인계 identity는 `handoff:IMP-11`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `surface.describe`.

직접 소비하는 후속 구현 Task: [IMP-04](../IMP-04/instruction.md), [IMP-06](../IMP-06/instruction.md), [IMP-07](../IMP-07/instruction.md), [IMP-08](../IMP-08/instruction.md), [IMP-12](../IMP-12/instruction.md), [IMP-13](../IMP-13/instruction.md), [IMP-19](../IMP-19/instruction.md), [IMP-26](../IMP-26/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
