# VER-03 — 명령 비노출·raw RPC 인가·권한 폐기 검사

**종류:** 독립 실행 verification Task · **담당:** 권한 검증자

## 1. 시작 조건

구현 입력: [IMP-10](../../../implementation-plan/tasks/IMP-10/instruction.md), [IMP-11](../../../implementation-plan/tasks/IMP-11/instruction.md), [IMP-12](../../../implementation-plan/tasks/IMP-12/instruction.md), [IMP-13](../../../implementation-plan/tasks/IMP-13/instruction.md), [IMP-19](../../../implementation-plan/tasks/IMP-19/instruction.md), [IMP-20](../../../implementation-plan/tasks/IMP-20/instruction.md).

선행 검증: [VER-01](../VER-01/instruction.md), [VER-02](../VER-02/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-09, REQ-10, REQ-14, REQ-15에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [access-cli.md](../../../spec/contracts/access-cli.md)
- [access.md](../../../spec/domains/access.md)
- [launch.md](../../../spec/contracts/launch.md)

## 3. 준비 환경

operator/팀장/일반 담당자/검토자 credential을 각각 발급한다. 팀장 provisioning에는 허용 role와 범위를 명시한다. same-user OS sandbox 완전성은 이 검사의 보장 범위가 아니다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. 각 주체의 help/completion/schema/commands instruction/UI/MCP 목록을 캡처하고 숨겨진 action 이름 유출을 확인한다.

2. 일반 worker로 알려진 admin operation을 raw RPC에 직접 호출하고 타 Run/Task/Delivery/artifact를 지정한다.

3. env connection 제거, role/from spoof, requiredActions 확대, 강한 role spawn, 부모 이동을 통한 scope 우회를 시도한다.

4. spawn 직전/직후 grant revoke와 이전 generation의 ack/report/stop을 보낸다.

5. receipt 재조회와 검색 count/snippet에서도 현재 읽기 권한을 검사한다.

## 5. 기대 관측과 판정

비노출과 서버 거부가 모두 성립한다. 불법 호출은 side effect가 없고 legitimate inFlight는 unknown/실제 receipt로 남는다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

주체별 surface, raw requests/denials, grant revision, effect count, redacted auth trace.

`evidence:VER-03`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
