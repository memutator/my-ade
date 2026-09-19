# REV-02 — 명령 비노출·권한·위임 경계 검토

**종류:** 독립 review Task · **담당:** 권한 검토자

## 1. 언제 시작하고 무엇을 받는가

구현 인계 [IMP-10](../../../implementation-plan/tasks/IMP-10/instruction.md), [IMP-11](../../../implementation-plan/tasks/IMP-11/instruction.md), [IMP-12](../../../implementation-plan/tasks/IMP-12/instruction.md), [IMP-13](../../../implementation-plan/tasks/IMP-13/instruction.md), [IMP-19](../../../implementation-plan/tasks/IMP-19/instruction.md), [IMP-20](../../../implementation-plan/tasks/IMP-20/instruction.md)의 동일 code/spec revision이 준비되면 시작한다. 다른 review와 병렬로 시작할 수 있다.

이 작업은 구현 담당자의 코드·계약을 독립적으로 검토한다. 직접 대규모 코드를 수정하거나 실제 모델 실행·crash injection을 수행하는 Task가 아니다. 결함은 원래 구현 owner에게 돌린다.

## 2. 시작 전에 읽을 것

[review 공통 지시](../../README.md), [요구사항](../../../requirements.md)의 REQ-09, REQ-10, REQ-14, REQ-15와 다음 명세를 읽는다.

- [access.md](../../../spec/domains/access.md)
- [access-cli.md](../../../spec/contracts/access-cli.md)
- [discovery-assignment.md](../../../spec/contracts/discovery-assignment.md)
- [launch.md](../../../spec/contracts/launch.md)

## 3. 검토 지시

1. root help/schema/completion/UI/MCP와 raw RPC가 같은 registry·current policy를 쓰는지 추적한다.

2. caller의 role/boundary 주장 대신 실제 Task/Delivery/ChangeSet 대상을 resolve하는지 확인한다.

3. 강한 role spawn, requiredActions 편집, parent boundary 이동, env 제거, receipt 재조회로 권한이 확대되는 경로를 찾는다.

4. revoke와 inFlight effect 사이의 경합에서 "실행되지 않음"을 거짓 확정하는지 검토한다.

5. same-user shell 위협과 논리 API 권한의 한계를 문서/UI가 정확히 표현하는지 확인한다.

## 4. 결과 계약

허용/거부 경로·노출 경로·secret 전달의 누락을 구체적 공격 입력과 코드 근거로 기록한다. 실행 공격 시험은 VER-03이다.

`review:REV-02`에 codeRevision/specRevision, 검토 범위, finding별 코드 위치·위반 계약·근거·실제 결과 위험·수정 담당 IMP, disposition, 미검토 범위를 기록한다. 의견과 실제 실행 증거를 구별한다. 명세가 부족하면 spec issue로, 구현이 다르면 implementation finding으로 분리한다.

## 5. 인계

REV-08 결합 검토와 관련 verification 담당자에게 전달한다. 변경된 revision에서 해결 여부를 확인하며 과거 review를 새 코드에 자동 승계하지 않는다.
