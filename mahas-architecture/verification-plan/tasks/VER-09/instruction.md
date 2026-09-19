# VER-09 — 파일 기반 실제 CLI 하네스의 역할 구현 수락

**종류:** 독립 실행 verification Task · **담당:** 하네스 실행 검증자

## 1. 시작 조건

구현 입력: [IMP-24](../../../implementation-plan/tasks/IMP-24/instruction.md), [IMP-30](../../../implementation-plan/tasks/IMP-30/instruction.md).

선행 검증: [VER-03](../VER-03/instruction.md), [VER-05](../VER-05/instruction.md), [VER-06](../VER-06/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-05, REQ-07, REQ-08, REQ-09, REQ-28에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [injection.md](../../../spec/injection.md)
- [realization.md](../../../spec/contracts/realization.md)
- [launch.md](../../../spec/contracts/launch.md)

## 3. 준비 환경

사용자가 허용한 실제 Claude Code 설치·계정·비용 범위와 격리 worktree를 사용한다. 설치 버전/OS/executable hash를 기록한다. 권한 우회 flag를 임의 사용하지 않는다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

실제 profile이 아직 documented인 동안에는 operator가 purpose=verification인 격리 Run과 해당 profile revision에 한정한 provisioning grant를 발급한다. 업무용 launch의 verified-only 정책을 해제하지 않는다. 이 실행 결과는 SupportAttestation의 근거이며 admit은 별도 권한자 연산이다.

## 4. 수행 지시

1. instruction file+초기 prompt route로 실제 시작하고 required instructions/Task 본문을 가진 역할이 join/accept를 호출하는지 확인한다.

2. skill/subagent/tool 구성품을 사용하는 구현에서는 실제 로딩과 helper의 Member/권한 경계를 확인한다.

3. mahas CLI가 하네스 shell 권한 안에서 실행 가능하고 타 역할 command가 숨겨지고 거부되는지 확인한다.

4. 지원하는 resume/wake만 별도로 수행하고 unknown/unsupported는 그대로 남긴다.

5. 필수 source 누락/크기 한도/조직 설정 충돌에서 profile을 verified로 잘못 표기하지 않는지 확인한다.

## 5. 기대 관측과 판정

특정 설치 조건에서만 SupportAttestation을 발급한다. 문서상 옵션 존재나 agent의 말만으로 전체 loading 성공을 단정하지 않는다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

redacted process config, input/loader 근거, actual CLI receipts, component usage, 설치 정보.

`evidence:VER-09`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
