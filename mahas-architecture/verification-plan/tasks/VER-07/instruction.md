# VER-07 — UI 분리·daemon 재부착·terminal I/O 검사

**종류:** 독립 실행 verification Task · **담당:** 실행 연속성 검증자

## 1. 시작 조건

구현 입력: [IMP-17](../../../implementation-plan/tasks/IMP-17/instruction.md), [IMP-18](../../../implementation-plan/tasks/IMP-18/instruction.md), [IMP-22](../../../implementation-plan/tasks/IMP-22/instruction.md), [IMP-23](../../../implementation-plan/tasks/IMP-23/instruction.md), [IMP-26](../../../implementation-plan/tasks/IMP-26/instruction.md), [IMP-28](../../../implementation-plan/tasks/IMP-28/instruction.md).

선행 검증: [VER-06](../VER-06/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-11, REQ-12, REQ-15, REQ-23, REQ-24에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [execution-host.md](../../../spec/contracts/execution-host.md)
- [client-terminal.md](../../../spec/contracts/client-terminal.md)
- [observation-client.md](../../../spec/contracts/observation-client.md)
- [execution-lifecycle.md](../../../spec/execution-lifecycle.md)

## 3. 준비 환경

동일 mahasd에 main/detached client를 연결하고 출력하는 PTY process와 입력 대기 process를 준비한다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. UI close/reopen과 detached 이동 동안 process incarnation이 유지되는지 확인한다.

2. mahasd crash/restart에서 execution-host가 유지한 process를 같은 identity로 reattach하는지 확인한다.

3. control unavailable 동안 worker CLI가 false success를 반환하지 않는지 확인한다.

4. output buffer overflow/reconnect cursor gap/backpressure, passive resize와 stale input lease를 검사한다.

5. hook turn-complete/silence/process 생존이 Task success를 생성하지 않는지 확인한다.

## 5. 기대 관측과 판정

UI와 process 수명이 분리되고 재부착은 새 spawn이 아니다. 모든 gap·unverifiable·권한 부족이 명시된다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

before/after process identity, terminal epoch/seq, client actions, receipts, Task state.

`evidence:VER-07`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
