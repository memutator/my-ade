# IMP-23 — mahasd 서비스 수명·재시작 readiness·종료 정책 구현

**종류:** 구현 Task

**담당 역할:** 런타임 수명 구현자 · **구현 경계:** `platform/recovery`

## 1. 배정받는 순간의 지시

당신은 platform/recovery 경계에서 **mahasd 서비스 수명·재시작 readiness·종료 정책 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-12, REQ-14, REQ-15, REQ-23, REQ-27 — 구현 시작 전 |
| [architecture.md](../../../spec/architecture.md) | §1, §5 — 구현 시작 전 |
| [recovery-operations.md](../../../spec/contracts/recovery-operations.md) | runtime.status/reconcile/shutdown — 구현 시작 전 |
| [execution-lifecycle.md](../../../spec/execution-lifecycle.md) | §5~6 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-01](../IMP-01/instruction.md) | `handoff:IMP-01`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-12](../IMP-12/instruction.md) | `handoff:IMP-12`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-17](../IMP-17/instruction.md) | `handoff:IMP-17`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-22](../IMP-22/instruction.md) | `handoff:IMP-22`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. mahasd의 single writer service entrypoint, actual endpoint publication, process identity, stale lock 처리와 version mismatch 정책을 구현한다.

2. startup에서 schema 확인→새 controller epoch→host lease reconciliation→pending effect/claim 대조가 끝나기 전 writable readiness를 공개하지 않는다.

3. UI close는 detach로 처리하고 runtime shutdown은 leave-executions/drain-and-stop을 명시하도록 한다.

4. drain에서 신규 admission 중지·정지 intent·종료 증거·residual 기록·DB close 순서를 지킨다. timeout 자원을 미실행/해제로 지우지 않는다.

5. runtime.status/reconcile/shutdown receipt를 제공하고 control unavailable 동안 CLI가 접수를 거짓 성공 처리하지 않도록 connection readiness와 연결한다.

## 5. 수정 범위와 하지 않을 일

runtime daemon lifecycle와 desktop service connector

실제 UI views는 IMP-28/31/32

부모 IPC disconnect kill-all 동작을 managed service에 그대로 남기지 않는다.

독립 process라고 모든 OS/service-manager 종료를 견딘다고 주장하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/{main,service-bootstrap,readiness,lifecycle}.ts
- Desktop ensureRuntime client와 stop/leave 운영 명령 연결

인계 identity는 `handoff:IMP-23`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `runtime.status`, `runtime.reconcile`, `runtime.shutdown`.

직접 소비하는 후속 구현 Task: [IMP-28](../IMP-28/instruction.md), [IMP-29](../IMP-29/instruction.md), [IMP-30](../IMP-30/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
