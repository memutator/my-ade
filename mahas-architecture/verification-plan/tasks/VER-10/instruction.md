# VER-10 — 설정 본문 기반 실제 CLI 하네스의 역할 구현 수락

**종류:** 독립 실행 verification Task · **담당:** 하네스 실행 검증자

## 1. 시작 조건

구현 입력: [IMP-25](../../../implementation-plan/tasks/IMP-25/instruction.md), [IMP-30](../../../implementation-plan/tasks/IMP-30/instruction.md).

선행 검증: [VER-03](../VER-03/instruction.md), [VER-05](../VER-05/instruction.md), [VER-06](../VER-06/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-05, REQ-07, REQ-08, REQ-09, REQ-28에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [injection.md](../../../spec/injection.md)
- [realization.md](../../../spec/contracts/realization.md)
- [launch.md](../../../spec/contracts/launch.md)

## 3. 준비 환경

사용자가 허용한 실제 Codex CLI 설치·계정·비용 범위와 격리 worktree를 사용한다. app-server는 기동하지 않는다. 설치 identity와 기존 설정 범위를 기록한다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

실제 profile이 아직 documented인 동안에는 operator가 purpose=verification인 격리 Run과 해당 profile revision에 한정한 provisioning grant를 발급한다. 업무용 launch의 verified-only 정책을 해제하지 않는다. 이 실행 결과는 SupportAttestation의 근거이며 admit은 별도 권한자 연산이다.

## 4. 수행 지시

1. developer instruction 실제 문자열과 초기 Task 본문을 direct argv/config로 전달하고 join/accept·협업 CLI를 실행한다.

2. 문자열 quoting/한글/개행과 물리 argv 한도, 필수 instruction 누락을 각각 확인한다.

3. optional skill discovery가 initial mandatory 의미를 대신하지 않는지 확인하고 generated skill이 다른 작업 checkout에 섞이지 않게 한다.

4. 하네스 shell에서 connection과 CLI가 접근 가능하되 operator secret/action은 제공되지 않는지 확인한다.

5. 지원되지 않은 native subagent/변경 role resume가 조용히 fallback하지 않는지 확인한다.

## 5. 기대 관측과 판정

같은 협업 API를 구조화 provider adapter 없이 사용한다. verified 범위는 실제 설치·recipe 기능에 한정된다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

redacted argv/config와 digest, actual mahas receipts, component manifest, 설치 identity.

`evidence:VER-10`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
