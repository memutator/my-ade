# VER-01 — 도메인 모델·책임 검색·배정의 실행 검사

**종류:** 독립 실행 verification Task · **담당:** 도메인 검증자

## 1. 시작 조건

구현 입력: [IMP-04](../../../implementation-plan/tasks/IMP-04/instruction.md), [IMP-05](../../../implementation-plan/tasks/IMP-05/instruction.md), [IMP-06](../../../implementation-plan/tasks/IMP-06/instruction.md), [IMP-07](../../../implementation-plan/tasks/IMP-07/instruction.md), [IMP-13](../../../implementation-plan/tasks/IMP-13/instruction.md).

선행 검증은 없다. 지정된 구현 revision이 실행 가능해야 한다.

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-02, REQ-03, REQ-04, REQ-17에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [rdd.md](../../../spec/domains/rdd.md)
- [model.md](../../../spec/contracts/model.md)
- [discovery-assignment.md](../../../spec/contracts/discovery-assignment.md)
- [work.md](../../../spec/contracts/work.md)

## 3. 준비 환경

격리된 mahas.sqlite에 root harness, prompt assemble, tools 경계와 각 역할을 API로 등록한다. 같은 이름의 다른 scope 역할, 미배정 경로, 비조상 중첩도 별도 case로 준비한다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. 모델 publish 후 프로세스를 재시작하고 SQLite만으로 동일 모델·관계를 조회한다. records 파일은 제공하지 않는다.

2. 경로·계약·전문성·한국어 query 검색에서 matchReasons/미배정/ambiguous/구현 가능성을 수집한다.

3. 검색 후 모델/권한을 바꾸어 오래된 token으로 preview/assign을 호출한다.

4. split/reparent/role retire에서 관계 일관성과 old/new touched scope를 확인한다.

5. Task 없는 coordination 팀장 배정과 initial negotiation 양측 배정을 실행한다.

## 5. 기대 관측과 판정

검색은 version에 고정되고 stale assignment는 거부된다. 잘못된 tree/FK는 publish되지 않고 ambiguous/unassigned는 숨겨지지 않는다. RDD가 SQLite 정본으로 복원된다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

API request/receipt, DB snapshot/version, 검색 카드, 배정 결과.

`evidence:VER-01`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
