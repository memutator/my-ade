# mahas — 책임 기반 협업과 실행 아키텍처

**상태:** 구현 전 규범 명세와 Task 배정 패키지. **제품명:** mahas. **대체 범위:** 이전 mahas 개정안의 문서 구성, RDD 파일 정본, 축약된 실행 계층, 단일 구현 계획을 대체한다.

## 무엇부터 읽는가

| 독자·상황 | 지금 읽을 문서 | 얻어야 하는 판단 |
|---|---|---|
| 사용자·팀장이 구현 범위를 확정 | [requirements](requirements.md) → [architecture](spec/architecture.md) → [acceptance](acceptance.md) | 무엇을 만들고 무엇으로 수락하는가 |
| 팀장이 실제 일을 배정 | [구현 계획](implementation-plan/README.md) → [DAG](implementation-plan/DAG.md) → 선택 Task의 instruction | 누가 어떤 입력으로 무엇을 구현하는가 |
| 구현 담당자가 Task를 받음 | 해당 Task instruction의 requiredReads만 | 구현할 계약·수정 범위·인계물 |
| 의미와 코드 경계를 검토 | [review-plan](review-plan/README.md)의 지정 Task | 독립 검토 결과와 수정 책임자 |
| 실제 동작·실패·하네스를 시험 | [verification-plan](verification-plan/README.md)의 지정 Task | 실행 evidence와 지원 범위 |
| 최종 결과를 결합 | [delivery](delivery.md) → [acceptance](acceptance.md) | 같은 revision의 구현·검토·검증이 수락 조건을 충족하는가 |

**모든 문서를 모든 agent에게 읽히지 않는다.** 각 Task instruction은 필요한 문서·절·읽을 시점·선행 인계물을 명시한다. 팀장은 instruction 본문을 첫 입력으로 전달한다. mahas가 구현되기 전에는 현재 하네스로 같은 계획을 수행하며, 구현 대상 CLI가 먼저 존재해야 하는 순환 의존이 없다.

## 문서 구조

```text
requirements.md                 제품 요구사항의 정본
acceptance.md                   관측 가능한 수락 기준의 정본
delivery.md / delivery-dag.json 세 계획 사이의 인계
spec/
  architecture.md               제어면·실행면·코드 책임 경계
  common.md                     identity·revision·receipt·error
  storage.md                    RDD 포함 SQLite DDL·transaction
  injection.md                  role+context의 구현·실제 주입
  execution-lifecycle.md        소유권·수명·장애 전이
  domains/                      전체 도메인 모델
  contracts/                    경계별 operation 계약
  operations.md                 operation별 구현 소유자
implementation-plan/
  INSTRUCTIONS.md / dag.json / DAG.md
  tasks/IMP-01…IMP-32/instruction.md
review-plan/
  dag.json / DAG.md / tasks/REV-01…REV-08/instruction.md
verification-plan/
  dag.json / DAG.md / tasks/VER-01…VER-12/instruction.md
```

별도 source/reference/examples 폴더나 사용 시점을 알 수 없는 참조 구현을 제공하지 않는다. DDL·필드·API·하네스 시작 설정은 해당 spec 안의 구현 계약으로 정의한다. task별 구현 산출물은 실제 코드 revision으로 인계하고, 별도 설명 문서를 계속 복제하지 않는다.

## 주요 설계 결정

RDD와 역할 구현·권한·작업·실행 원장은 **mahas.sqlite**가 정본이다. 코드·타입·테스트·재사용 전문 지침은 원래 파일을 정본으로 두고 RDD Context는 anchor만 저장한다. 실행 때 만든 snapshot/bundle은 불변 재현 산출물이며 두 번째 저작 정본이 아니다.

**RoleInterface(role+context) → RoleImplementation(하네스 구성품 세트) → ContextBundle → LaunchPlan → actual input → join/accept**를 분리한다. 같은 원본도 책임별 해상도로 구현하며 즉석 요약이나 무조건 모든 원문 주입으로 대체하지 않는다.

팀장은 responsibility.search/inspect/locate/collaborators와 role.implementations를 이용하여 책임자를 찾고, assignment.preview/team.assign으로 배정한다. Task가 없는 coordination 역할의 시작과 같은 실행에 다음 Task를 주는 task.dispatch도 명시했다.

실행은 **mahasd + 재부착 가능한 execution-host**다. PTY와 일반 process를 기본으로 하고 provider App Server를 요구하지 않는다. endpoint/process identity, controller lease/fence, stage receipt, unknown, terminal I/O, native resume, resource handoff와 cleanup까지 구현 범위다. 이것은 입력 보고서의 현재 앱에 이미 존재한다는 주장이 아니라 신규 목표 구조다.

## 제출 상태와 근거 수준

이 패키지는 사용자의 RDD 합의와 첨부된 두 정적 실행 분석 보고서를 기반으로 한 신규 설계다. 보고서의 scope는 고정 스냅샷이며 현재 mahas 저장소의 코드 실행 결과로 확대하지 않는다. 외부 문서는 S-INJECTION의 실제 CLI 시작 옵션과 S-STORAGE의 SQLite 동작을 확인하는 데만 사용했고 해당 절에 확인 범위를 표시했다.

원 저장소 수정, 프로그램 빌드, 실제 하네스 실행, 보안·장애 시험은 이 제출에서 수행하지 않았다. [문서 제출 확인](verification-plan/submission-status.md)은 링크·DAG·연산 소유자·DDL 형식 등 **문서 정합성**만 다룬다. VER Task의 제품 실행 결과는 아직 not-run이다.
