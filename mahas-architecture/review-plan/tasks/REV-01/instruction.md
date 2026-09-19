# REV-01 — 전체 도메인·SQLite 정본·모델 변경 검토

**종류:** 독립 review Task · **담당:** 도메인/저장 검토자

## 1. 언제 시작하고 무엇을 받는가

구현 인계 [IMP-02](../../../implementation-plan/tasks/IMP-02/instruction.md), [IMP-03](../../../implementation-plan/tasks/IMP-03/instruction.md), [IMP-04](../../../implementation-plan/tasks/IMP-04/instruction.md), [IMP-05](../../../implementation-plan/tasks/IMP-05/instruction.md), [IMP-06](../../../implementation-plan/tasks/IMP-06/instruction.md), [IMP-07](../../../implementation-plan/tasks/IMP-07/instruction.md), [IMP-13](../../../implementation-plan/tasks/IMP-13/instruction.md), [IMP-14](../../../implementation-plan/tasks/IMP-14/instruction.md)의 동일 code/spec revision이 준비되면 시작한다. 다른 review와 병렬로 시작할 수 있다.

이 작업은 구현 담당자의 코드·계약을 독립적으로 검토한다. 직접 대규모 코드를 수정하거나 실제 모델 실행·crash injection을 수행하는 Task가 아니다. 결함은 원래 구현 owner에게 돌린다.

## 2. 시작 전에 읽을 것

[review 공통 지시](../../README.md), [요구사항](../../../requirements.md)의 REQ-02, REQ-03, REQ-04, REQ-05, REQ-17, REQ-22와 다음 명세를 읽는다.

- [rdd.md](../../../spec/domains/rdd.md)
- [role-realization.md](../../../spec/domains/role-realization.md)
- [work.md](../../../spec/domains/work.md)
- [storage.md](../../../spec/storage.md)
- [discovery-assignment.md](../../../spec/contracts/discovery-assignment.md)

## 3. 검토 지시

1. 도메인 객체가 Role/Task/Execution과 ModelVersion/ContextBundle을 합치지 않았는지 실제 타입과 repository를 대조한다.

2. RDD를 SQLite 정본으로 사용하고 파일 records/Git이 두 번째 writer가 되지 않는지 publication/import 경로를 확인한다.

3. composite identity·FK·JSON shape·tree/DAG·CAS 불변식의 집행 위치를 찾는다. SQL이 강제하지 않는 의미 조건이 서비스에도 없는 경우를 구분한다.

4. 팀장 책임 탐색의 no-match/ambiguous/stale/implementation availability가 API에 실제 드러나는지 확인한다.

5. 부모의 결합 책임·context path-only·role 책무와 이번 Task의 분리가 유지되는지 판단한다.

## 4. 결과 계약

스키마/도메인 누락과 책임 배정 API의 모순을 정확한 코드 위치·대상 IMP로 기록한다.

`review:REV-01`에 codeRevision/specRevision, 검토 범위, finding별 코드 위치·위반 계약·근거·실제 결과 위험·수정 담당 IMP, disposition, 미검토 범위를 기록한다. 의견과 실제 실행 증거를 구별한다. 명세가 부족하면 spec issue로, 구현이 다르면 implementation finding으로 분리한다.

## 5. 인계

REV-08 결합 검토와 관련 verification 담당자에게 전달한다. 변경된 revision에서 해결 여부를 확인하며 과거 review를 새 코드에 자동 승계하지 않는다.
