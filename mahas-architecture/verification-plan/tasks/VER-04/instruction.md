# VER-04 — META DAG·직접 통신·결과 revision 검사

**종류:** 독립 실행 verification Task · **담당:** 협업 검증자

## 1. 시작 조건

구현 입력: [IMP-13](../../../implementation-plan/tasks/IMP-13/instruction.md), [IMP-14](../../../implementation-plan/tasks/IMP-14/instruction.md), [IMP-15](../../../implementation-plan/tasks/IMP-15/instruction.md), [IMP-20](../../../implementation-plan/tasks/IMP-20/instruction.md), [IMP-21](../../../implementation-plan/tasks/IMP-21/instruction.md).

선행 검증: [VER-02](../VER-02/instruction.md), [VER-03](../VER-03/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-01, REQ-17, REQ-18, REQ-19, REQ-20에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [work.md](../../../spec/contracts/work.md)
- [mail-artifacts.md](../../../spec/contracts/mail-artifacts.md)
- [messaging-outcomes.md](../../../spec/domains/messaging-outcomes.md)

## 3. 준비 환경

실제 모델을 호출하지 않는 cooperative test process로 제공자/소비자/검토 Member와 합의→병렬→결합 Plan을 만든다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. 두 초기 협의 task를 실행한 후 exact catalog output을 각각의 구현 task input으로 resolve한다.

2. replyAndAck 전후 connection을 끊고 같은 operation을 재조회한다.

3. 읽기만 한 Delivery가 여전히 outstanding인지, 이전 consumer generation ack가 거부되는지 확인한다.

4. old outcome revision을 승인한 뒤 새 outcome이 자동 accepted 되지 않는지 확인한다.

5. owner-declaration Task와 지정 수용 Task, Task 종료 뒤 Member 회신을 각각 수행한다.

## 5. 기대 관측과 판정

팀장이 메시지를 재전송하지 않아도 당사자 협업이 성립한다. DAG는 계획이며 자동 새 업무를 만들지 않는다. 입력·결과는 exact revision이다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

Plan revisions, Delivery/ack rows, outcomes/settlements, input ArtifactRefs.

`evidence:VER-04`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
