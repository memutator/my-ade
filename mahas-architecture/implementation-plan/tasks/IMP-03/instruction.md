# IMP-03 — 두 SQLite 저장 경계와 transaction/content store 구현

**종류:** 구현 Task

**담당 역할:** 저장소 구현자 · **구현 경계:** `storage`

## 1. 배정받는 순간의 지시

당신은 storage 경계에서 **두 SQLite 저장 경계와 transaction/content store 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-02, REQ-14, REQ-22, REQ-27 — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | §1~7; control/host DDL — 구현 시작 전 |
| [common.md](../../../spec/common.md) | §3~6 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-02](../IMP-02/instruction.md) | `handoff:IMP-02`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. spec/storage의 control DDL과 host DDL을 실제 migration으로 작성하고 schema version/write compatibility를 강제한다. 두 daemon이 같은 DB를 write하지 않게 한다.

2. WAL/FULL/foreign_keys/busy timeout을 connection 초기화에 적용하고 단일 writer lock과 migration receipt를 구현한다. 현재 프로젝트의 실제 SQLite binding에 맞춰 연결 코드를 둔다.

3. transaction helper에 domain mutation+receipt+event+effect intent를 묶는 인터페이스를 만든다. filesystem/process 호출을 callback transaction 안에 숨기지 않는다.

4. 작은 instruction/config snapshot은 ContentBlob body, 큰 artifact는 content-addressed 외부 store와 manifest를 사용한다. atomic publish marker와 digest 확인을 구현한다.

5. operationId/fingerprint 조회·conflict와 effect outbox의 prepared/attempting/confirmed/rejected/unknown repository를 제공한다. 원장 caps로 미처리 상태를 잘라내지 않는다.

## 5. 수정 범위와 하지 않을 일

runtime/storage 및 공유 SQLite port

backup orchestration은 IMP-29; 비즈니스 repository는 각 담당자

RDD를 records.json에서 읽고 SQLite를 cache로 쓰는 dual authority 금지.

빈 FK 검사 성공을 aggregate 의미 검사로 대체하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/storage/{database,migrations,transaction,blob-store,receipt-store,event-outbox}.ts
- 공유 low-level SQLite port; execution-host용 별도 DB open 함수
- schema v1 migrations와 typed repository transaction context

인계 identity는 `handoff:IMP-03`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: [IMP-04](../IMP-04/instruction.md), [IMP-10](../IMP-10/instruction.md), [IMP-12](../IMP-12/instruction.md), [IMP-16](../IMP-16/instruction.md), [IMP-17](../IMP-17/instruction.md), [IMP-29](../IMP-29/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
