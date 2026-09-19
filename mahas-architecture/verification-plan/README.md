# 독립 검증 계획

**소비자:** 팀장과 검증 역할. 구현/리뷰와 별도의 Task다. 테스트 코드 작성·실행 harness·장애 주입·실제 하네스 실행·수락 evidence는 이 폴더의 책임이다. 구현 계획은 해당 관측/주입 hook과 계약을 제공하지만 정식 검증을 대신 수행하지 않는다.

[DAG](DAG.md) · [기계 판독 DAG](dag.json) · [수락 기준](../acceptance.md)

## 수행 지시

각 Task의 준비 환경과 exact code/spec revision을 고정한다. test process와 실제 CLI 하네스를 구별한다. 실제 하네스 실행은 사용자가 승인한 설치·계정·비용·격리 경로에서만 한다. fault injection은 테스트 소유 process/DB/worktree에서만 수행한다. 운영 데이터나 다른 사용자의 PID에 destructive 시험을 하지 않는다.

검증 결과는 passed/failed/blocked/not-run으로 기록한다. docs-only, DDL parsing, fake process, 실제 하네스, 실제 OS 복구의 근거 수준을 구별한다. 미검증을 passed로 채우지 않는다. 기본적으로 제품 수락은 [acceptance.md](../acceptance.md)의 필수 조건을 모두 관측해야 한다.

## 출력 계약

`VerificationRecord={taskId,codeRevision,specRevision,environment,steps,expected,observed,evidenceRefs,verdict,supportedScope,notExecuted}`. SupportAttestation은 이 evidence를 근거로 별도 권한자가 publish한다. 검증 기록 작성만으로 profile을 자동 활성화하지 않는다.

## Task 목록

| Task | 검증 책임 | 구현 입력 | 선행 검증 |
| --- | --- | --- | --- |
| [VER-01](tasks/VER-01/instruction.md) | 도메인 모델·책임 검색·배정의 실행 검사 | IMP-04, IMP-05, IMP-06, IMP-07, IMP-13 | 없음 |
| [VER-02](tasks/VER-02/instruction.md) | SQLite transaction·receipt·content snapshot 내구성 검사 | IMP-03, IMP-04, IMP-15, IMP-21, IMP-29 | 없음 |
| [VER-03](tasks/VER-03/instruction.md) | 명령 비노출·raw RPC 인가·권한 폐기 검사 | IMP-10, IMP-11, IMP-12, IMP-13, IMP-19, IMP-20 | VER-01, VER-02 |
| [VER-04](tasks/VER-04/instruction.md) | META DAG·직접 통신·결과 revision 검사 | IMP-13, IMP-14, IMP-15, IMP-20, IMP-21 | VER-02, VER-03 |
| [VER-05](tasks/VER-05/instruction.md) | 역할 구현의 실제 구성품·초기 입력 검사 | IMP-07, IMP-08, IMP-09, IMP-14, IMP-19, IMP-20 | VER-01, VER-03 |
| [VER-06](tasks/VER-06/instruction.md) | 스폰·초기 입력의 cut-point와 중복 억제 검사 | IMP-16, IMP-17, IMP-18, IMP-19, IMP-20, IMP-22 | VER-02, VER-03, VER-05 |
| [VER-07](tasks/VER-07/instruction.md) | UI 분리·daemon 재부착·terminal I/O 검사 | IMP-17, IMP-18, IMP-22, IMP-23, IMP-26, IMP-28 | VER-06 |
| [VER-08](tasks/VER-08/instruction.md) | 종료·자원 인계·업데이트·운영 복구 검사 | IMP-16, IMP-22, IMP-23, IMP-28, IMP-29 | VER-02, VER-06, VER-07 |
| [VER-09](tasks/VER-09/instruction.md) | 파일 기반 실제 CLI 하네스의 역할 구현 수락 | IMP-24, IMP-30 | VER-03, VER-05, VER-06 |
| [VER-10](tasks/VER-10/instruction.md) | 설정 본문 기반 실제 CLI 하네스의 역할 구현 수락 | IMP-25, IMP-30 | VER-03, VER-05, VER-06 |
| [VER-11](tasks/VER-11/instruction.md) | 서로 다른 하네스의 역할·해상도·협업 종단 수락 | IMP-06, IMP-13, IMP-21, IMP-24, IMP-25, IMP-30, IMP-31, IMP-32 | VER-04, VER-07, VER-09, VER-10 |
| [VER-12](tasks/VER-12/instruction.md) | 최종 요구사항 추적·출시 상태 정산 | IMP-30 | VER-08, VER-11 |

## release와 반복

검증 실패는 원래 IMP owner의 수정 revision으로 되돌린다. 코드/계약이 바뀌면 영향을 받은 검증 evidence를 새 revision에서 다시 만든다. REV-08의 의미적 결합 검토와 VER-12의 실행 근거를 제품 책임자가 함께 사용한다.
