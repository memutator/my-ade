# IMP-17 — 재부착 가능한 execution-host bootstrap·lease·receipt 서비스 구현

**종류:** 구현 Task

**담당 역할:** 실행 호스트 구현자 · **구현 경계:** `execution`

## 1. 배정받는 순간의 지시

당신은 execution 경계에서 **재부착 가능한 execution-host bootstrap·lease·receipt 서비스 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-11, REQ-12, REQ-14, REQ-15 — 구현 시작 전 |
| [architecture.md](../../../spec/architecture.md) | §1, §4~6 — 구현 시작 전 |
| [execution-host.md](../../../spec/contracts/execution-host.md) | transport 및 host.hello/acquire/inventory/effect.get — 구현 시작 전 |
| [execution-lifecycle.md](../../../spec/execution-lifecycle.md) | §5 — 구현 시작 전 |
| [storage.md](../../../spec/storage.md) | host DB DDL — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-01](../IMP-01/instruction.md) | `handoff:IMP-01`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-02](../IMP-02/instruction.md) | `handoff:IMP-02`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-03](../IMP-03/instruction.md) | `handoff:IMP-03`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. UI/부모 IPC disconnect와 독립된 execution-host entrypoint와 authenticated local endpoint를 만든다.

2. PID+birth/boot evidence+launchNonce+endpointIncarnation을 기록하고 exclusive claim/atomic publication/identity-matched cleanup을 구현한다.

3. protocol version handshake와 current host incarnation을 확인한다. 오래된 endpoint 파일만 보고 새 host를 병렬로 띄우거나 old PID를 kill하지 않는다.

4. controller lease는 긍정적 dead/handoff 증거가 있을 때만 takeover한다. mutation에서 epoch와 lease proof를 검사한다.

5. host effect receipt와 process/workspace inventory 저장 포트를 구현한다. 실제 OS effect 실행자는 IMP-18/16이 등록한다. host reference는 재연결 시 최신 인스턴스를 조회하도록 지연 바인딩한다.

## 5. 수정 범위와 하지 않을 일

execution-host service/identity/lease/storage

process/PTY body는 IMP-18

host DB에서 Task/Grant/RDD를 직접 변경하지 않는다.

lease TTL만으로 실행 writer를 승계하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-execution-host/src/{main,service-bootstrap,endpoint,lease,host-store,rpc-server}.ts
- mahasd용 current-host getter와 service inventory 포트

인계 identity는 `handoff:IMP-17`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `host.hello`, `host.acquire`, `host.inventory`, `host.effect.get`.

직접 소비하는 후속 구현 Task: [IMP-16](../IMP-16/instruction.md), [IMP-18](../IMP-18/instruction.md), [IMP-23](../IMP-23/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
