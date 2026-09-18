# REV-04 — 협업·DAG·전달·정산 의미 검토

**종류:** 독립 review Task · **담당:** 협업 계약 검토자

## 1. 언제 시작하고 무엇을 받는가

구현 인계 [IMP-13](../../../implementation-plan/tasks/IMP-13/instruction.md), [IMP-14](../../../implementation-plan/tasks/IMP-14/instruction.md), [IMP-15](../../../implementation-plan/tasks/IMP-15/instruction.md), [IMP-20](../../../implementation-plan/tasks/IMP-20/instruction.md), [IMP-21](../../../implementation-plan/tasks/IMP-21/instruction.md), [IMP-31](../../../implementation-plan/tasks/IMP-31/instruction.md)의 동일 code/spec revision이 준비되면 시작한다. 다른 review와 병렬로 시작할 수 있다.

이 작업은 구현 담당자의 코드·계약을 독립적으로 검토한다. 직접 대규모 코드를 수정하거나 실제 모델 실행·crash injection을 수행하는 Task가 아니다. 결함은 원래 구현 owner에게 돌린다.

## 2. 시작 전에 읽을 것

[review 공통 지시](../../README.md), [요구사항](../../../requirements.md)의 REQ-01, REQ-17, REQ-18, REQ-19, REQ-20와 다음 명세를 읽는다.

- [work.md](../../../spec/domains/work.md)
- [messaging-outcomes.md](../../../spec/domains/messaging-outcomes.md)
- [work.md](../../../spec/contracts/work.md)
- [mail-artifacts.md](../../../spec/contracts/mail-artifacts.md)

## 3. 검토 지시

1. Run을 자동 scheduler로 사용하거나 팀장을 모든 메시지 중계자/결과 수용자로 만드는 경로를 확인한다.

2. TaskSpec revision, input artifact pin, active Dispatch, Member mailbox의 독립 수명을 추적한다.

3. replyAndAck/owner settlement/outbox 원자성과 stale consumer generation 처리를 대조한다.

4. 초기 계약 협의 양쪽 worker가 후행 input을 기다리다 시작 못 하는 순환 대기가 없는지 Plan 사용 흐름을 읽는다.

5. accepted outcome이 자원 cleanup/turn-complete와 섞이지 않고 특정 revision에 연결되는지 확인한다.

## 4. 결과 계약

정상 흐름과 실패 흐름에서 당사자의 책임 판단이 유지되는지, transaction 경계의 결함을 기록한다.

`review:REV-04`에 codeRevision/specRevision, 검토 범위, finding별 코드 위치·위반 계약·근거·실제 결과 위험·수정 담당 IMP, disposition, 미검토 범위를 기록한다. 의견과 실제 실행 증거를 구별한다. 명세가 부족하면 spec issue로, 구현이 다르면 implementation finding으로 분리한다.

## 5. 인계

REV-08 결합 검토와 관련 verification 담당자에게 전달한다. 변경된 revision에서 해결 여부를 확인하며 과거 review를 새 코드에 자동 승계하지 않는다.
