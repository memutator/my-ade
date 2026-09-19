# VER-05 — 역할 구현의 실제 구성품·초기 입력 검사

**종류:** 독립 실행 verification Task · **담당:** 컨텍스트 검증자

## 1. 시작 조건

구현 입력: [IMP-07](../../../implementation-plan/tasks/IMP-07/instruction.md), [IMP-08](../../../implementation-plan/tasks/IMP-08/instruction.md), [IMP-09](../../../implementation-plan/tasks/IMP-09/instruction.md), [IMP-14](../../../implementation-plan/tasks/IMP-14/instruction.md), [IMP-19](../../../implementation-plan/tasks/IMP-19/instruction.md), [IMP-20](../../../implementation-plan/tasks/IMP-20/instruction.md).

선행 검증: [VER-01](../VER-01/instruction.md), [VER-03](../VER-03/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-05, REQ-06, REQ-07, REQ-08, REQ-22에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [injection.md](../../../spec/injection.md)
- [realization.md](../../../spec/contracts/realization.md)
- [launch.md](../../../spec/contracts/launch.md)

## 3. 준비 환경

argv/stdin/config file을 관측하는 cooperative test executable과 서로 다른 role implementation을 준비한다. 실제 model 이해 평가는 REV-03/VER-11과 구별한다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. 동일 원본이 팀장/조립/tool 역할에서 어떤 mandatory bytes로 재표현되는지 비교하고 부모 장문 자동 주입 여부를 본다.

2. 필수 skill을 conditional-only로 연결, component file 제거, stale interface, 권한 밖 action 요구를 각각 넣는다.

3. source snapshot→component manifest→actual argv/config/stdin→join digest의 연결을 수집한다.

4. 동일 cwd의 두 role 실행에서 공용 AGENTS/CLAUDE/skill 파일 덮어쓰기와 경로 충돌을 검사한다.

5. materialized만 된 상태, initial attached, joined, task accepted가 별도인지 확인한다.

## 5. 기대 관측과 판정

필수 내용과 이번 requirements 본문이 첫 입력 경로에 존재하며 optional 발견에 의존하지 않는다. 잘못된 coverage/누락은 launch 전 차단한다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

실제 input byte digests, manifest, receipt stages, inherited known/unknown 목록.

`evidence:VER-05`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
