# mahas 명세 인덱스

**팀장:** 처음 배정할 때 architecture, requirements, 각 계획 README를 읽고 필요한 Task를 선택한다. **구현 담당자:** 자기 Task instruction에 지정된 spec만 읽는다. **리뷰·검증 담당자:** 해당 별도 Task가 고정한 코드 revision과 계약을 읽는다. 이 폴더 전체를 모든 agent에게 자동 주입하지 않는다.

## 구조와 공통 계약

| 문서 | 읽어야 하는 시점 |
|---|---|
| [architecture](architecture.md) | 책임 경계·프로세스 배치·정본을 결정할 때 |
| [common](common.md) | identity·revision·에러·receipt를 구현할 때 |
| [storage](storage.md) | SQLite migration/repository를 만들 때; 담당 테이블만 발췌 |
| [operations](operations.md) | operation registry를 배선하고 빠진 handler를 확인할 때 |
| [injection](injection.md) | role+context를 구성품으로 구현하고 실제 첫 입력에 넣을 때 |
| [execution-lifecycle](execution-lifecycle.md) | 스폰·정지·재부착·복구 전이를 구현할 때 |

## 전체 도메인

| 문서 | 범위 |
|---|---|
| [RDD](domains/rdd.md) | SQLite 책임 모델·변경 |
| [역할 구현](domains/role-realization.md) | interface·implementation·components·bundle·WorkEnvelope |
| [권한](domains/access.md) | principal·policy·grant·surface |
| [작업](domains/work.md) | Run·Member·Assignment·Task·Plan·Dispatch |
| [실행](domains/execution.md) | host·lease·process·terminal·spawn·input·wake |
| [협업과 결과](domains/messaging-outcomes.md) | Message·Delivery·Artifact·Outcome·Settlement |
| [자원·관측·유지](domains/resources-observation.md) | workspace·claim·intervention·projection·impact·backup |

## 경계 간 입출력

[contracts/README.md](contracts/README.md)에 C-MODEL부터 C-CLIENT까지의 계약이 있다. 각 연산은 입력, 호출 주체, 권한·전제조건, 반환, 저장·외부 effect, 실패를 정의한다. 필드의 구조는 위 도메인 명세로 연결되며 사업적 판단은 서버가 대신하지 않는다.
