# VER-08 — 종료·자원 인계·업데이트·운영 복구 검사

**종류:** 독립 실행 verification Task · **담당:** 운영 장애 검증자

## 1. 시작 조건

구현 입력: [IMP-16](../../../implementation-plan/tasks/IMP-16/instruction.md), [IMP-22](../../../implementation-plan/tasks/IMP-22/instruction.md), [IMP-23](../../../implementation-plan/tasks/IMP-23/instruction.md), [IMP-28](../../../implementation-plan/tasks/IMP-28/instruction.md), [IMP-29](../../../implementation-plan/tasks/IMP-29/instruction.md).

선행 검증: [VER-02](../VER-02/instruction.md), [VER-06](../VER-06/instruction.md), [VER-07](../VER-07/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-12, REQ-14, REQ-15, REQ-16, REQ-27에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [resources.md](../../../spec/contracts/resources.md)
- [recovery-operations.md](../../../spec/contracts/recovery-operations.md)
- [execution-lifecycle.md](../../../spec/execution-lifecycle.md)
- [storage.md](../../../spec/storage.md)

## 3. 준비 환경

dirty worktree, retained artifact, unknown writer와 명확히 종료된 writer를 분리해서 준비한다. shutdown mode와 OS/service-manager 범위를 기록한다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. stop 응답 유실과 강제 escalation에서 old/new process identity가 섞이지 않는지 확인한다.

2. 같은 canonical checkout을 다른 workspace/symlink 이름으로 배정하고 exclusivity를 검사한다.

3. leave-executions와 drain-and-stop을 각각 수행하여 실제 process/DB/residual 결과를 확인한다.

4. protocol mismatch, stale endpoint, supervisor 재시작, schema downgrade 시 write 차단을 검사한다.

5. backup restore 후 과거 process가 unconfirmed로 복원되고 검증 없이 writer를 얻지 않는지 확인한다.

## 5. 기대 관측과 판정

unsafe cleanup/중복 writer가 없고 종료·복원 모드의 결과가 증거에 맞는다. process 생존 범위를 과장하지 않는다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

filesystem identity, claims/transfer receipts, shutdown/restart traces, backup manifests.

`evidence:VER-08`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
