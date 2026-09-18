# 계획 사이의 인계와 최종 결합

**소비 시점:** 팀장은 배정/통합 시, review·verification 책임자는 입력 준비를 확인할 때 읽는다. [delivery-dag.json](delivery-dag.json)은 세 계획 사이의 인계를 합친 기계 판독 그래프다. 구현 DAG 자체에는 review/verification Task를 섞지 않는다.

```text
implementation-plan의 32개 Task → exact implementation handoff
                 ├─ review-plan의 7개 전문 검토 → REV-08 결합
                 └─ verification-plan의 실행/장애/실제 하네스 검사 → VER-12
                                                    │
IMP-30 구현 합류 + REV-08 + VER-12 ──────────────────┴→ acceptance.md
```

review는 실제 실행을 대체하지 않고 verification은 역할/책임의 의미 검토를 대체하지 않는다. 독립 review는 필요한 코드가 나오면 먼저 시작할 수 있으며 모든 검토를 구현 종료까지 직렬로 미루지 않는다. 검증도 해당 implementation input이 준비된 범위에서 진행한다. release는 동일 revision의 결과만 결합한다.

결함은 원래 IMP owner에게 수정 작업으로 돌아간다. 이 반복은 오류를 해결하는 새 작업 배정이며 정적 task dependency DAG에 순환 edge를 추가하지 않는다. 변화한 code/contract revision의 downstream 범위를 팀장이 판단한다.

문서의 정본은 requirements(무엇), spec(모델·계약·구현 의미), acceptance(관측해야 할 결과)다. Task instruction은 이번 구현에서 어느 부분을 어떤 순서로 만들지 지정한다. 서로 충돌하면 담당자가 임의 해석으로 숨기지 않고 해당 계약 소유자/팀장에게 명시하여 spec revision을 고정한다.
