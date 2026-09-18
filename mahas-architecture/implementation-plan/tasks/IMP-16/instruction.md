# IMP-16 — workspace·checkout·write claim과 물리 자원 primitive 구현

**종류:** 구현 Task

**담당 역할:** 작업 공간 구현자 · **구현 경계:** `resources`

## 1. 배정받는 순간의 지시

당신은 resources 경계에서 **workspace·checkout·write claim과 물리 자원 primitive 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-13, REQ-16, REQ-20, REQ-27 — 구현 시작 전 |
| [resources-observation.md](../../../spec/domains/resources-observation.md) | §1, §4 — 구현 시작 전 |
| [resources.md](../../../spec/contracts/resources.md) | 전체 — 구현 시작 전 |
| [execution-host.md](../../../spec/contracts/execution-host.md) | host.workspace.* — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | resources/checkouts/workspaces/resource_claims/resource_transfers/retention_pins — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-03](../IMP-03/instruction.md) | `handoff:IMP-03`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-10](../IMP-10/instruction.md) | `handoff:IMP-10`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-17](../IMP-17/instruction.md) | `handoff:IMP-17`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. logical Workspace와 canonical Checkout identity를 분리하고 symlink/실제 worktree 경로를 확인한다.

2. 같은 실제 자원의 held/transferring/unknown write claim을 배타적으로 관리한다. Workspace ID만 달라서 두 writer가 통과하지 않게 한다.

3. approved placement intent를 host workspace primitive로 전달하고 worktree 생성·probe·삭제 receipt와 잔여 자원을 저장한다.

4. claim handoff에서 old writer quiescence와 current claim revision을 확인한 후 명시 owner 교체를 수행한다. TTL이나 heartbeat 누락만으로 인계하지 않는다.

5. release는 live/unknown execution, dirty 상태, artifact/bundle retention을 검사한다. 실패/unknown cleanup이 있으면 실제 잔여 경로를 보존한다.

## 5. 수정 범위와 하지 않을 일

runtime/resources 및 execution-host/workspaces

PTY/process host 구현과 Task 정산은 제외

boundary.paths는 write sandbox가 아니다.

다른 작업의 파일을 강제 삭제하거나 자동 merge하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/resources/{workspace,checkout,claims,transfer,release}.ts
- packages/mahas-execution-host/src/workspaces/{prepare,probe,release}.ts

인계 identity는 `handoff:IMP-16`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `workspace.prepare`, `workspace.inspect`, `claim.handoff`, `claim.release`, `host.workspace.prepare`, `host.workspace.probe`, `host.workspace.release`.

직접 소비하는 후속 구현 Task: [IMP-09](../IMP-09/instruction.md), [IMP-15](../IMP-15/instruction.md), [IMP-19](../IMP-19/instruction.md), [IMP-22](../IMP-22/instruction.md), [IMP-29](../IMP-29/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
