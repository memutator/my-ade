# IMP-22 — 실행 정지·재부착·native resume·unknown reconciliation 구현

**종류:** 구현 Task

**담당 역할:** 실행 복구 구현자 · **구현 경계:** `recovery`

## 1. 배정받는 순간의 지시

당신은 recovery 경계에서 **실행 정지·재부착·native resume·unknown reconciliation 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-11, REQ-14, REQ-15, REQ-16, REQ-20, REQ-27 — 구현 시작 전 |
| [recovery-operations.md](../../../spec/contracts/recovery-operations.md) | 동작 구분/재시작 알고리즘 — 구현 시작 전 |
| [launch.md](../../../spec/contracts/launch.md) | worker.stop/resume/release — 구현 시작 전 |
| [execution-lifecycle.md](../../../spec/execution-lifecycle.md) | 전체 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-16](../IMP-16/instruction.md) | `handoff:IMP-16`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-18](../IMP-18/instruction.md) | `handoff:IMP-18`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-19](../IMP-19/instruction.md) | `handoff:IMP-19`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-20](../IMP-20/instruction.md) | `handoff:IMP-20`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-21](../IMP-21/instruction.md) | `handoff:IMP-21`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. DB active/unknown effect와 host receipt/inventory를 stable key·spawnNonce·birth identity로 대조한다. unmatched orphan은 quarantine/unknown으로 남긴다.

2. same process reattach와 native conversation resume와 Task retry를 별도 함수를 통해 수행한다. retry 선택을 복구 loop에 숨기지 않는다.

3. 정지 요청은 exact incarnation과 과거 operation receipt를 보존하고 unresolved stop에서는 resource claim을 유지한다.

4. native-resume은 old process dead/quiescent와 같은 role/interface/bundle의 검증 recipe를 요구한다. 새 process generation/credential과 inbox fencing을 수행한다.

5. worker.release를 retain/transfer/release 정책으로 resources에 연결한다. Task settlement가 process 종료나 cleanup 성공을 의미하지 않게 한다.

## 5. 수정 범위와 하지 않을 일

runtime/recovery와 worker lifecycle handlers

OS daemon bootstrap 자체와 새 업무 결정은 제외

타임아웃·lease 만료·화면 부재만으로 사망 확정 금지.

changed role을 과거 대화에 파일만 갈아 끼워 재사용하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/recovery/{reconciler,identity-probe,reattach,resume,stop,orphan}.ts
- stale generation fencing과 residual resource resolution 포트

인계 identity는 `handoff:IMP-22`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `worker.stop`, `worker.resume`, `worker.release`.

직접 소비하는 후속 구현 Task: [IMP-23](../IMP-23/instruction.md), [IMP-29](../IMP-29/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
