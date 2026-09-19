# VER-11 — 서로 다른 하네스의 역할·해상도·협업 종단 수락

**종류:** 독립 실행 verification Task · **담당:** 프로젝트 책임 기반 검증자

## 1. 시작 조건

구현 입력: [IMP-06](../../../implementation-plan/tasks/IMP-06/instruction.md), [IMP-13](../../../implementation-plan/tasks/IMP-13/instruction.md), [IMP-21](../../../implementation-plan/tasks/IMP-21/instruction.md), [IMP-24](../../../implementation-plan/tasks/IMP-24/instruction.md), [IMP-25](../../../implementation-plan/tasks/IMP-25/instruction.md), [IMP-30](../../../implementation-plan/tasks/IMP-30/instruction.md), [IMP-31](../../../implementation-plan/tasks/IMP-31/instruction.md), [IMP-32](../../../implementation-plan/tasks/IMP-32/instruction.md).

선행 검증: [VER-04](../VER-04/instruction.md), [VER-07](../VER-07/instruction.md), [VER-09](../VER-09/instruction.md), [VER-10](../VER-10/instruction.md).

[공통 지시](../../README.md)와 [수락 기준](../../../acceptance.md)을 읽고 요구사항 REQ-01, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21에 연결된 결과를 생성한다.

## 2. 필요한 계약

- [requirements.md](../../../requirements.md)
- [acceptance.md](../../../acceptance.md)
- [discovery-assignment.md](../../../spec/contracts/discovery-assignment.md)
- [injection.md](../../../spec/injection.md)
- [work.md](../../../spec/contracts/work.md)

## 3. 준비 환경

팀장 역할과 tool/prompt assemble 담당을 서로 다른 검증된 하네스에 배정한다. 사용자·팀장이 실제 작업 요구사항과 계약 합의→병렬 구현→통합 검토 Plan을 정한다.

실제 서비스·하네스·OS·DB binding 버전과 code/spec revision을 기록한다. 아직 없는 환경은 blocked로 남기고 mock 결과를 실제 실행 결과로 바꾸지 않는다.

## 4. 수행 지시

1. 팀장이 책임 검색/구현 가능성/preview를 거쳐 담당자를 배정하고 역할 구현을 선택한다.

2. 팀장은 비용·설명 충분성·안정성의 긴장을, 담당자는 자기 문법의 구체 지침을 받고 일하는지 입력과 판단 근거를 함께 관찰한다.

3. 담당자들이 CLI inbox/send/replyAndAck로 직접 협의하고 exact artifact를 인계한다. 팀장을 중계자로 사용하지 않는다.

4. 안전 wake 미지원 경우 수동 재개 필요가 표시되고 메시지가 유지되는지 확인한다.

5. 계약 또는 부모 책임을 바꾸어 stale 후보와 별도 유지 Task가 생기는 경로를 실행한다.

## 5. 기대 관측과 판정

해상도 차이가 실제 판단 단위의 차이로 작동하고 작업·협업·결합 책임이 분산된다. 전체 자동 무인 수행을 미지원 하네스에 주장하지 않는다.

기대 관측과 다른 결과는 실패로, 실행할 수 없던 항목은 blocked/not-run으로 구분한다. 자연어 답변만 믿지 않고 API receipt·process/DB evidence 등 해당 계약의 정본으로 확인한다.

## 6. 제출할 증거

역할별 input, 팀장 판단 근거, peer messages, artifact revisions, outcomes, impact records.

`evidence:VER-11`에 환경, exact revisions, 수행 절차/입력, 기대/실제 관측, 로그/receipt/artifact digest, verdict, 지원 범위, 미실행 항목을 기록한다. secret은 삭제하고 원본 증거의 보존 위치를 권한 있게 연결한다.

## 7. 결함 처리와 인계

해당 계약을 소유한 IMP Task에 재현 조건과 증거를 전달한다. 검증 담당자가 테스트를 통과시키기 위해 구현을 몰래 변경하지 않는다. 수정 revision을 받은 뒤 영향받은 절차를 반복한다. 후속 verification과 VER-12에 evidence를 전달한다.
