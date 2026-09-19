# VER-12 — 최종 요구사항 추적·출시 상태 정산

**종류:** 독립 실행 verification Task · **담당:** 제품 수락 검증자

## 1. 시작 조건

구현 입력: [IMP-30](../../../implementation-plan/tasks/IMP-30/instruction.md).

선행 검증: [VER-08](../VER-08/instruction.md), [VER-11](../VER-11/instruction.md).

최종 결합 검토 [REV-08](../../../review-plan/tasks/REV-08/instruction.md)의 같은 code/spec revision 결과도 입력으로 받는다.

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-11, REQ-12, REQ-13, REQ-14, REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25, REQ-26, REQ-27, REQ-28에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [requirements.md](../../../requirements.md)
- [acceptance.md](../../../acceptance.md)
- [README.md](../../../verification-plan/README.md)
- [README.md](../../../review-plan/README.md)

## 3. 준비 환경

같은 code revision에 대해 완료된 검증 evidence와 REV-08 disposition을 모은다. 미실행/환경 미지원 항목은 빈 pass로 간주하지 않는다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. AC-01~28의 primary verification evidence와 필요 review 결과를 연결한다.

2. 수정된 code/spec revision 이후 영향받는 검증이 재실행됐는지 확인한다.

3. 두 실제 하네스의 지원 범위/OS/설정/남은 wake 제약을 support matrix로 정리한다.

4. 미해결 unknown/residual, 권한 defect, 필수 injection 누락을 release blocker로 구별한다.

5. 사용자/최종 책임자에게 accepted/changes-required/blocked를 근거와 함께 제출한다.

## 5. 기대 관측과 판정

실제 수행한 범위만 제품 수락으로 기록한다. 문서 정합성 검사·DDL 파싱·가짜 하네스 성공을 실제 하네스/보안 검증으로 바꾸지 않는다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

acceptance trace matrix, exact revision, review dispositions, verification records, support attestations.

`evidence:VER-12`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 최종 사용자/제품 책임자에게 수락 매트릭스를 전달한다.
