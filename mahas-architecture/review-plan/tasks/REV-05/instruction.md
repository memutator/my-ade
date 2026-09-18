# REV-05 — 실행 계층·소유권·재부착·복구 검토

**종류:** 독립 review Task · **담당:** 실행 아키텍처 검토자

## 1. 언제 시작하고 무엇을 받는가

구현 인계 [IMP-16](../../../implementation-plan/tasks/IMP-16/instruction.md), [IMP-17](../../../implementation-plan/tasks/IMP-17/instruction.md), [IMP-18](../../../implementation-plan/tasks/IMP-18/instruction.md), [IMP-19](../../../implementation-plan/tasks/IMP-19/instruction.md), [IMP-20](../../../implementation-plan/tasks/IMP-20/instruction.md), [IMP-22](../../../implementation-plan/tasks/IMP-22/instruction.md), [IMP-23](../../../implementation-plan/tasks/IMP-23/instruction.md), [IMP-29](../../../implementation-plan/tasks/IMP-29/instruction.md)의 동일 code/spec revision이 준비되면 시작한다. 다른 review와 병렬로 시작할 수 있다.

이 작업은 구현 담당자의 코드·계약을 독립적으로 검토한다. 직접 대규모 코드를 수정하거나 실제 모델 실행·crash injection을 수행하는 Task가 아니다. 결함은 원래 구현 owner에게 돌린다.

## 2. 시작 전에 읽을 것

[review 공통 지시](../../README.md), [요구사항](../../../requirements.md)의 REQ-11, REQ-12, REQ-13, REQ-14, REQ-15, REQ-16, REQ-27와 다음 명세를 읽는다.

- [execution.md](../../../spec/domains/execution.md)
- [execution-host.md](../../../spec/contracts/execution-host.md)
- [launch.md](../../../spec/contracts/launch.md)
- [recovery-operations.md](../../../spec/contracts/recovery-operations.md)
- [execution-lifecycle.md](../../../spec/execution-lifecycle.md)

## 3. 검토 지시

1. mahasd와 execution-host의 책임/DB writer/실제 OS process 소유권이 명세와 일치하는지 추적한다.

2. spawn nonce, pid birth, boot/endpoint incarnation, controller lease, generation이 replay·takeover에서 사용되는지 확인한다.

3. process/initial-input/stop의 ambiguous 경계를 성공 또는 미실행으로 축약하는 코드가 있는지 조사한다.

4. reattach/native-resume/task retry/fresh role가 별도 경로인지, TTL만으로 old writer를 대체하지 않는지 확인한다.

5. terminal backpressure, input lease, graceful/escalated stop, dirty/unknown resource 인계와 cleanup을 검토한다.

## 4. 결과 계약

각 cut point의 정산 근거와 잔여 자원 처리가 코드에서 닫히는지 기록한다. 실제 kill/crash 주입은 VER-06~08이다.

`review:REV-05`에 codeRevision/specRevision, 검토 범위, finding별 코드 위치·위반 계약·근거·실제 결과 위험·수정 담당 IMP, disposition, 미검토 범위를 기록한다. 의견과 실제 실행 증거를 구별한다. 명세가 부족하면 spec issue로, 구현이 다르면 implementation finding으로 분리한다.

## 5. 인계

REV-08 결합 검토와 관련 verification 담당자에게 전달한다. 변경된 revision에서 해결 여부를 확인하며 과거 review를 새 코드에 자동 승계하지 않는다.
