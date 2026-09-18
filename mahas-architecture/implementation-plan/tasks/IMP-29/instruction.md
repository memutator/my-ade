# IMP-29 — 운영 migration·일관 backup·retention·복구 구현

**종류:** 구현 Task

**담당 역할:** 운영 저장 구현자 · **구현 경계:** `storage/resources`

## 1. 배정받는 순간의 지시

당신은 storage/resources 경계에서 **운영 migration·일관 backup·retention·복구 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-02, REQ-14, REQ-16, REQ-27 — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | §5~7 — 구현 시작 전 |
| [recovery-operations.md](../../../spec/contracts/recovery-operations.md) | backup.* — 구현 시작 전 |
| [resources-observation.md](../../../spec/domains/resources-observation.md) | MigrationReceipt/BackupSet/RetentionPin — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-03](../IMP-03/instruction.md) | `handoff:IMP-03`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-16](../IMP-16/instruction.md) | `handoff:IMP-16`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-22](../IMP-22/instruction.md) | `handoff:IMP-22`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-23](../IMP-23/instruction.md) | `handoff:IMP-23`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. 기존 프로젝트/관측 registry를 새 DB로 가져오는 explicit migration을 만들고 input fingerprint와 완료 stage를 남긴다.

2. model/role/interface current snapshot을 SQLite에 저장하며 records.json 변경을 두 번째 writer로 연결하지 않는다.

3. consistent SQLite snapshot과 필요한 blob/artifact/host receipt의 retention manifest를 묶어 backup을 만든다.

4. restore는 runtime offline과 manifest/schema/digest를 확인하고 복원된 모든 실행을 unconfirmed/reconciliation-needed로 시작한다.

5. published/active/unknown/미처리 Delivery/수락 output/backup pin을 GC에서 제외한다. partial cleanup은 residue를 기록하고 retry-safe한 effect로 관리한다.

## 5. 수정 범위와 하지 않을 일

runtime 운영 저장 모듈

release 검증·실제 장애 주입은 verification-plan

live WAL DB의 main 파일만 복사해 backup 성공을 선언하지 않는다.

downgrade가 새 schema에 조용히 write하지 못하게 한다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/operations/{migration,backup,restore,gc}.ts
- schema compatibility·content retention과 legacy import receipt

인계 identity는 `handoff:IMP-29`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `backup.create`, `backup.restore`.

직접 소비하는 후속 구현 Task: [IMP-30](../IMP-30/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
