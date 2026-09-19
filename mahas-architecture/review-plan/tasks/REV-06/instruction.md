# REV-06 — 공통 API·CLI·하네스 의존 경계 검토

**종류:** 독립 review Task · **담당:** 프로토콜 검토자

## 1. 언제 시작하고 무엇을 받는가

구현 인계 [IMP-02](../../../implementation-plan/tasks/IMP-02/instruction.md), [IMP-11](../../../implementation-plan/tasks/IMP-11/instruction.md), [IMP-12](../../../implementation-plan/tasks/IMP-12/instruction.md), [IMP-17](../../../implementation-plan/tasks/IMP-17/instruction.md), [IMP-24](../../../implementation-plan/tasks/IMP-24/instruction.md), [IMP-25](../../../implementation-plan/tasks/IMP-25/instruction.md), [IMP-30](../../../implementation-plan/tasks/IMP-30/instruction.md)의 동일 code/spec revision이 준비되면 시작한다. 다른 review와 병렬로 시작할 수 있다.

이 작업은 구현 담당자의 코드·계약을 독립적으로 검토한다. 직접 대규모 코드를 수정하거나 실제 모델 실행·crash injection을 수행하는 Task가 아니다. 결함은 원래 구현 owner에게 돌린다.

## 2. 시작 전에 읽을 것

[review 공통 지시](../../README.md), [요구사항](../../../requirements.md)의 REQ-08, REQ-09, REQ-14, REQ-25, REQ-28와 다음 명세를 읽는다.

- [common.md](../../../spec/common.md)
- [operations.md](../../../spec/operations.md)
- [access-cli.md](../../../spec/contracts/access-cli.md)
- [execution-host.md](../../../spec/contracts/execution-host.md)
- [injection.md](../../../spec/injection.md)

## 3. 검토 지시

1. 공개 77개 연산과 서비스 전용 15개 연산의 registry/handler/노출 분류를 대조한다.

2. input/output/error/retry 의미가 CLI·UI·RPC에서 달라지지 않는지 확인한다.

3. 하네스별 이름/turn API가 model/access/mail/task 계층에 침투하지 않는지 code dependency를 추적한다.

4. actual argv/config/paths escaping과 missing capability의 명시 거부를 확인한다.

5. installed profile가 문서 확인만으로 verified가 되거나 무조건 provider session fallback을 쓰는지 확인한다.

## 4. 결과 계약

동일 operation의 계약 불일치와 하네스 종속성 확대를 계약 ID/코드 위치로 기록한다.

`review:REV-06`에 codeRevision/specRevision, 검토 범위, finding별 코드 위치·위반 계약·근거·실제 결과 위험·수정 담당 IMP, disposition, 미검토 범위를 기록한다. 의견과 실제 실행 증거를 구별한다. 명세가 부족하면 spec issue로, 구현이 다르면 implementation finding으로 분리한다.

## 5. 인계

REV-08 결합 검토와 관련 verification 담당자에게 전달한다. 변경된 revision에서 해결 여부를 확인하며 과거 review를 새 코드에 자동 승계하지 않는다.
