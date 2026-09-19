# VER-02 — SQLite transaction·receipt·content snapshot 내구성 검사

**종류:** 독립 실행 verification Task · **담당:** 저장 검증자

## 1. 시작 조건

구현 입력: [IMP-03](../../../implementation-plan/tasks/IMP-03/instruction.md), [IMP-04](../../../implementation-plan/tasks/IMP-04/instruction.md), [IMP-15](../../../implementation-plan/tasks/IMP-15/instruction.md), [IMP-21](../../../implementation-plan/tasks/IMP-21/instruction.md), [IMP-29](../../../implementation-plan/tasks/IMP-29/instruction.md).

선행 검증은 없다. 지정된 구현 revision이 실행 가능해야 한다.

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-02, REQ-14, REQ-18, REQ-20, REQ-22, REQ-27에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [storage.md](../../../spec/storage.md)
- [common.md](../../../spec/common.md)
- [mail-artifacts.md](../../../spec/contracts/mail-artifacts.md)
- [recovery-operations.md](../../../spec/contracts/recovery-operations.md)

## 3. 준비 환경

격리 DB/content root와 write fault injection hook을 사용한다. 실제 생산 데이터나 사용자 worktree에 시험하지 않는다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. model publication, Message+Delivery, reply+ack, report+settlement의 각 DB write 경계에 실패를 주입한다.

2. 같은 operation ID 동일/다른 payload를 보내 receipt replay/conflict를 확인한다.

3. blob publish 중 파일 쓰기를 중단하고 manifest 없는 partial file이 accepted artifact로 조회되는지 검사한다.

4. pending/unknown 실행이 pin한 blob과 Delivery가 GC 대상에서 제외되는지 확인한다.

5. consistent backup을 복원하고 WAL/content manifest 누락 case를 거부하는지 확인한다.

## 5. 기대 관측과 판정

모든 원자 단위는 전부 반영되거나 전부 rollback된다. 중복 request가 추가 메시지/결과를 만들지 않고 불완전 content는 유효하지 않다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

fault point, transaction 전후 rows, receipt fingerprint, blob digest, backup/restore 기록.

`evidence:VER-02`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
