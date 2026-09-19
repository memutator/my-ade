# REV-08 — 경계 간 결합과 최종 아키텍처 검토

**종류:** 독립 review Task · **담당:** 전체 결합 책임자

## 1. 언제 시작하고 무엇을 받는가

구현 인계 [IMP-30](../../../implementation-plan/tasks/IMP-30/instruction.md)의 동일 code/spec revision이 준비되면 시작한다. 선행 review: [REV-01](../REV-01/instruction.md), [REV-02](../REV-02/instruction.md), [REV-03](../REV-03/instruction.md), [REV-04](../REV-04/instruction.md), [REV-05](../REV-05/instruction.md), [REV-06](../REV-06/instruction.md), [REV-07](../REV-07/instruction.md).

이 작업은 구현 담당자의 코드·계약을 독립적으로 검토한다. 직접 대규모 코드를 수정하거나 실제 모델 실행·crash injection을 수행하는 Task가 아니다. 결함은 원래 구현 owner에게 돌린다.

## 2. 시작 전에 읽을 것

[review 공통 지시](../../README.md), [요구사항](../../../requirements.md)의 REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-11, REQ-12, REQ-13, REQ-14, REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25, REQ-26, REQ-27, REQ-28와 다음 명세를 읽는다.

- [requirements.md](../../../requirements.md)
- [acceptance.md](../../../acceptance.md)
- [architecture.md](../../../spec/architecture.md)
- [README.md](../../../spec/contracts/README.md)

## 3. 검토 지시

1. 각 경계의 review 결과가 동일 code/spec revision을 가리키는지 확인하고 revision 차이는 다시 검토 범위로 지정한다.

2. 책임 탐색→배정→역할 구현→실제 주입→협업→정산→정리 흐름의 누락된 interface를 찾는다.

3. 국소적으로 적절해 보여도 전체에서 과도한 중앙 판단·context·하네스 의존을 만드는 긴장을 판단한다.

4. 미해결 blocker를 해당 IMP owner로 되돌리고 변경된 계약의 consumer 검토를 명시한다.

5. 독립 검증 결과와 review의 의미적 판단을 구분하여 결합 의견을 남긴다.

## 4. 결과 계약

전체 구조에 대한 review disposition과 잔여 쟁점을 낸다. 실행 시험 대신 통과를 선언하지 않는다.

`review:REV-08`에 codeRevision/specRevision, 검토 범위, finding별 코드 위치·위반 계약·근거·실제 결과 위험·수정 담당 IMP, disposition, 미검토 범위를 기록한다. 의견과 실제 실행 증거를 구별한다. 명세가 부족하면 spec issue로, 구현이 다르면 implementation finding으로 분리한다.

## 5. 인계

VER-12와 최종 사용자/제품 책임자에게 전달한다. 변경된 revision에서 해결 여부를 확인하며 과거 review를 새 코드에 자동 승계하지 않는다.
