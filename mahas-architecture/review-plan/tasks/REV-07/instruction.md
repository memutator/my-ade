# REV-07 — 작업대·운영·유지 흐름 검토

**종류:** 독립 review Task · **담당:** 운영/UX 검토자

## 1. 언제 시작하고 무엇을 받는가

구현 인계 [IMP-26](../../../implementation-plan/tasks/IMP-26/instruction.md), [IMP-27](../../../implementation-plan/tasks/IMP-27/instruction.md), [IMP-28](../../../implementation-plan/tasks/IMP-28/instruction.md), [IMP-29](../../../implementation-plan/tasks/IMP-29/instruction.md), [IMP-31](../../../implementation-plan/tasks/IMP-31/instruction.md), [IMP-32](../../../implementation-plan/tasks/IMP-32/instruction.md)의 동일 code/spec revision이 준비되면 시작한다. 다른 review와 병렬로 시작할 수 있다.

이 작업은 구현 담당자의 코드·계약을 독립적으로 검토한다. 직접 대규모 코드를 수정하거나 실제 모델 실행·crash injection을 수행하는 Task가 아니다. 결함은 원래 구현 owner에게 돌린다.

## 2. 시작 전에 읽을 것

[review 공통 지시](../../README.md), [요구사항](../../../requirements.md)의 REQ-04, REQ-06, REQ-21, REQ-23, REQ-24, REQ-27와 다음 명세를 읽는다.

- [client-terminal.md](../../../spec/contracts/client-terminal.md)
- [observation-client.md](../../../spec/contracts/observation-client.md)
- [resources-observation.md](../../../spec/domains/resources-observation.md)
- [recovery-operations.md](../../../spec/contracts/recovery-operations.md)

## 3. 검토 지시

1. 같은 view 변경이 worker authority나 process kill로 이어지지 않는지 UI action 경로를 읽는다.

2. 책임 검색과 배정 preview, interface 구현/실제 주입 inspector가 다른 책임의 적절한 표현을 제공하는지 판단한다.

3. live/unknown/needs-input/report/accepted/released가 서로 다른 증거와 상태로 보이는지 확인한다.

4. 기존 session/resume 이관, stale 후보 분류, backup/restore/GC의 정본·증거 표시를 대조한다.

5. 정보를 찾게 하는 숨은 문서 의존이나 무조건 전체 context 펼치기가 있는지 확인한다.

## 4. 결과 계약

작업자가 잘못 판단하도록 만드는 상태/권한/해상도 표시를 화면 경로와 API 계약에 연결해 기록한다.

`review:REV-07`에 codeRevision/specRevision, 검토 범위, finding별 코드 위치·위반 계약·근거·실제 결과 위험·수정 담당 IMP, disposition, 미검토 범위를 기록한다. 의견과 실제 실행 증거를 구별한다. 명세가 부족하면 spec issue로, 구현이 다르면 implementation finding으로 분리한다.

## 5. 인계

REV-08 결합 검토와 관련 verification 담당자에게 전달한다. 변경된 revision에서 해결 여부를 확인하며 과거 review를 새 코드에 자동 승계하지 않는다.
