# REV-03 — role + context 구현과 정보 해상도 검토

**종류:** 독립 review Task · **담당:** 역할 구성 검토자

## 1. 언제 시작하고 무엇을 받는가

구현 인계 [IMP-07](../../../implementation-plan/tasks/IMP-07/instruction.md), [IMP-08](../../../implementation-plan/tasks/IMP-08/instruction.md), [IMP-09](../../../implementation-plan/tasks/IMP-09/instruction.md), [IMP-14](../../../implementation-plan/tasks/IMP-14/instruction.md), [IMP-19](../../../implementation-plan/tasks/IMP-19/instruction.md), [IMP-20](../../../implementation-plan/tasks/IMP-20/instruction.md), [IMP-24](../../../implementation-plan/tasks/IMP-24/instruction.md), [IMP-25](../../../implementation-plan/tasks/IMP-25/instruction.md), [IMP-32](../../../implementation-plan/tasks/IMP-32/instruction.md)의 동일 code/spec revision이 준비되면 시작한다. 다른 review와 병렬로 시작할 수 있다.

이 작업은 구현 담당자의 코드·계약을 독립적으로 검토한다. 직접 대규모 코드를 수정하거나 실제 모델 실행·crash injection을 수행하는 Task가 아니다. 결함은 원래 구현 owner에게 돌린다.

## 2. 시작 전에 읽을 것

[review 공통 지시](../../README.md), [요구사항](../../../requirements.md)의 REQ-05, REQ-06, REQ-07, REQ-08, REQ-21, REQ-22와 다음 명세를 읽는다.

- [role-realization.md](../../../spec/domains/role-realization.md)
- [injection.md](../../../spec/injection.md)
- [realization.md](../../../spec/contracts/realization.md)
- [launch.md](../../../spec/contracts/launch.md)

## 3. 검토 지시

1. RoleInterface를 문구 복사로, RoleImplementation을 flags 목록으로 축소하지 않았는지 component와 coverage를 읽는다.

2. 동일 관심사가 팀장에게는 가치·긴장, 담당자에게는 자기 문법의 구체 제약으로 구현되는지 실제 작성된 지침을 판단한다.

3. 필수 의미가 optional skill catalog에만 들어가는 경로, parent maintenance basis가 자식 context로 유입되는 경로를 찾는다.

4. instruction/skill/subagent/tool 구성품이 하네스별 구현에서 의도한 실제 loading point에 연결되는지 code path와 manifest를 대조한다.

5. 지침의 source snapshot과 현재 저작 정본·이번 WorkEnvelope를 섞거나 기존 대화에 role 변경을 덮어쓰는지 확인한다.

## 4. 결과 계약

필수 누락·잘못된 추상화·과도한 원문 주입·native helper 책임 혼동을 clause/component 단위로 지적한다.

`review:REV-03`에 codeRevision/specRevision, 검토 범위, finding별 코드 위치·위반 계약·근거·실제 결과 위험·수정 담당 IMP, disposition, 미검토 범위를 기록한다. 의견과 실제 실행 증거를 구별한다. 명세가 부족하면 spec issue로, 구현이 다르면 implementation finding으로 분리한다.

## 5. 인계

REV-08 결합 검토와 관련 verification 담당자에게 전달한다. 변경된 revision에서 해결 여부를 확인하며 과거 review를 새 코드에 자동 승계하지 않는다.
