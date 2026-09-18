# VER-06 — 스폰·초기 입력의 cut-point와 중복 억제 검사

**종류:** 독립 실행 verification Task · **담당:** 실행 장애 검증자

## 1. 시작 조건

구현 입력: [IMP-16](../../../implementation-plan/tasks/IMP-16/instruction.md), [IMP-17](../../../implementation-plan/tasks/IMP-17/instruction.md), [IMP-18](../../../implementation-plan/tasks/IMP-18/instruction.md), [IMP-19](../../../implementation-plan/tasks/IMP-19/instruction.md), [IMP-20](../../../implementation-plan/tasks/IMP-20/instruction.md), [IMP-22](../../../implementation-plan/tasks/IMP-22/instruction.md).

선행 검증: [VER-02](../VER-02/instruction.md), [VER-03](../VER-03/instruction.md), [VER-05](../VER-05/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-11, REQ-13, REQ-14, REQ-15, REQ-16에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [execution-host.md](../../../spec/contracts/execution-host.md)
- [launch.md](../../../spec/contracts/launch.md)
- [execution-lifecycle.md](../../../spec/execution-lifecycle.md)

## 3. 준비 환경

격리한 execution-host/mahasd와 child process, 임시 worktree를 사용한다. 임의 사용자 프로세스에 signal하지 않는다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. S-LIFECYCLE §3의 모든 cut point에서 mahasd 연결/프로세스를 중단한다.

2. host effect key와 spawnNonce가 같은 재호출이 두 child를 만들지 않는지 확인한다.

3. process 생성 직후 receipt commit 전 gap과 initial input 후 응답 유실을 unknown으로 유지하는지 검사한다.

4. pid 재사용/다른 birth identity를 모사하고 잘못된 child를 입양하거나 stop하지 않는지 확인한다.

5. 권한 폐기·start_unknown 상태에서 같은 checkout에 두 번째 writer가 배정되는지 확인한다.

## 5. 기대 관측과 판정

명확한 증거 없이 신규 spawn/재주입이 없고 stage/residual이 보존된다. unknown은 success/never-started로 축약되지 않는다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

process inventory/identity, effect journal, cumulative receipts, resource claims.

`evidence:VER-06`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
