# 독립 review 계획

**소비자:** 팀장과 review 역할. 구현 Task와 별도의 배정이다. 해당 구현 인계의 정확한 revision과 spec을 받고 시작한다. 실제 실행·장애 시험은 [verification-plan](../verification-plan/README.md)에 있다.

[DAG](DAG.md) · [기계 판독 DAG](dag.json)

## 검토 지시

계약의 의미, 책임 구분, 코드의 제어 흐름, 저장/권한/수명 경계를 독립적으로 읽는다. 검사기나 컴파일러의 성공만으로 의미 적합성을 승인하지 않는다. 반대로 실제 실행하지 않은 실패를 관측한 사실처럼 쓰지 않는다. finding에는 위치·관련 계약·추론 근거·결과 위험·수정할 IMP owner를 포함한다. 수정 구현은 별도 Task revision으로 배정한다.

## 출력 계약

`ReviewRecord={reviewTaskId,codeRevision,specRevision,scope,findings[{location,contract,evidence,consequence,requestedCorrection,targetImplementationTask}],disposition,limitations}`. disposition은 accepted/changes-required/blocked이며 점수나 막연한 품질 감상으로 대체하지 않는다.

## Task 목록

| Task | 검토 책임 | 구현 입력 | 선행 review |
| --- | --- | --- | --- |
| [REV-01](tasks/REV-01/instruction.md) | 전체 도메인·SQLite 정본·모델 변경 검토 | IMP-02, IMP-03, IMP-04, IMP-05, IMP-06, IMP-07, IMP-13, IMP-14 | 없음 |
| [REV-02](tasks/REV-02/instruction.md) | 명령 비노출·권한·위임 경계 검토 | IMP-10, IMP-11, IMP-12, IMP-13, IMP-19, IMP-20 | 없음 |
| [REV-03](tasks/REV-03/instruction.md) | role + context 구현과 정보 해상도 검토 | IMP-07, IMP-08, IMP-09, IMP-14, IMP-19, IMP-20, IMP-24, IMP-25, IMP-32 | 없음 |
| [REV-04](tasks/REV-04/instruction.md) | 협업·DAG·전달·정산 의미 검토 | IMP-13, IMP-14, IMP-15, IMP-20, IMP-21, IMP-31 | 없음 |
| [REV-05](tasks/REV-05/instruction.md) | 실행 계층·소유권·재부착·복구 검토 | IMP-16, IMP-17, IMP-18, IMP-19, IMP-20, IMP-22, IMP-23, IMP-29 | 없음 |
| [REV-06](tasks/REV-06/instruction.md) | 공통 API·CLI·하네스 의존 경계 검토 | IMP-02, IMP-11, IMP-12, IMP-17, IMP-24, IMP-25, IMP-30 | 없음 |
| [REV-07](tasks/REV-07/instruction.md) | 작업대·운영·유지 흐름 검토 | IMP-26, IMP-27, IMP-28, IMP-29, IMP-31, IMP-32 | 없음 |
| [REV-08](tasks/REV-08/instruction.md) | 경계 간 결합과 최종 아키텍처 검토 | IMP-30 | REV-01, REV-02, REV-03, REV-04, REV-05, REV-06, REV-07 |

## 코드 변경 후

같은 code/spec revision에서만 review 결과를 적용한다. 변경된 contract의 consumer와 권한/수명 경로를 중심으로 재검토 범위를 팀장이 정한다. review 자체가 Task execution 성공이나 실제 하네스 호환성을 증명하지 않는다.
