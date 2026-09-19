# 구현 의존 DAG

정본: [dag.json](dag.json). 아래 그림과 실행 가능 묶음은 그 그래프에서 생성한 projection이다. graph 자체가 자동 실행·재시도 정책을 결정하지 않는다.

```mermaid
flowchart TD
  IMP_01["IMP-01 기존 앱 연결 지점과 서비스 package 경계 구현"]
  IMP_02["IMP-02 전체 도메인 타입과 wire schema의 정본 구현"]
  IMP_03["IMP-03 두 SQLite 저장 경계와 transaction/content store 구현"]
  IMP_04["IMP-04 SQLite RDD aggregate와 원자적 모델 변경 구현"]
  IMP_05["IMP-05 책임 관계 인덱스·territory·변경 영향 계산 구현"]
  IMP_06["IMP-06 팀장의 책임 탐색·관계 조회 API 구현"]
  IMP_07["IMP-07 RoleInterface와 RoleImplementation 저작·공개 서비스 구현"]
  IMP_08["IMP-08 결정적 role component compiler와 ContextBundle 구현"]
  IMP_09["IMP-09 구성품 materializer와 실효 컨텍스트 검사 조회 구현"]
  IMP_10["IMP-10 주체·정책·grant·폐기 인가 코어 구현"]
  IMP_11["IMP-11 OperationRegistry·동일 admission·역할별 surface 구현"]
  IMP_12["IMP-12 로컬 협업 RPC와 얇은 mahas CLI 구현"]
  IMP_13["IMP-13 Run·팀장 배정·META DAG·Assignment 서비스 구현"]
  IMP_14["IMP-14 TaskSpec·Dispatch 권한·입력 pin과 WorkEnvelope 구현"]
  IMP_15["IMP-15 durable inbox·회신·artifact 저장 API 구현"]
  IMP_16["IMP-16 workspace·checkout·write claim과 물리 자원 primitive 구현"]
  IMP_17["IMP-17 재부착 가능한 execution-host bootstrap·lease·receipt 서비스 구현"]
  IMP_18["IMP-18 범용 PTY·pipes process와 terminal I/O 관리 구현"]
  IMP_19["IMP-19 고정 LaunchPlan과 단계별 worker.start coordinator 구현"]
  IMP_20["IMP-20 worker bootstrap·join·명시 Task 인수 연결 구현"]
  IMP_21["IMP-21 결과 선언·지정 수용·직접 인계와 안전 wake 연결 구현"]
  IMP_22["IMP-22 실행 정지·재부착·native resume·unknown reconciliation 구현"]
  IMP_23["IMP-23 mahasd 서비스 수명·재시작 readiness·종료 정책 구현"]
  IMP_24["IMP-24 파일 기반 하네스의 구성품 구현과 launch recipe 작성"]
  IMP_25["IMP-25 설정 본문 기반 하네스의 구성품 구현과 launch recipe 작성"]
  IMP_26["IMP-26 관측 출처·개입·snapshot/event projection 구현"]
  IMP_27["IMP-27 모델·context 변경 후보와 별도 유지 작업 흐름 구현"]
  IMP_28["IMP-28 Desktop·detached client·terminal view의 정본 분리 구현"]
  IMP_29["IMP-29 운영 migration·일관 backup·retention·복구 구현"]
  IMP_30["IMP-30 전체 runtime 배선·CLI 배포·service entrypoint 조립"]
  IMP_31["IMP-31 책임 탐색·배정·META DAG 작업대 구현"]
  IMP_32["IMP-32 역할 구현 편집·context/권한/spawn Inspector 구현"]
  IMP_01 --> IMP_02
  IMP_02 --> IMP_03
  IMP_03 --> IMP_04
  IMP_10 --> IMP_04
  IMP_11 --> IMP_04
  IMP_04 --> IMP_05
  IMP_05 --> IMP_06
  IMP_07 --> IMP_06
  IMP_10 --> IMP_06
  IMP_11 --> IMP_06
  IMP_04 --> IMP_07
  IMP_10 --> IMP_07
  IMP_11 --> IMP_07
  IMP_05 --> IMP_08
  IMP_07 --> IMP_08
  IMP_11 --> IMP_08
  IMP_08 --> IMP_09
  IMP_16 --> IMP_09
  IMP_03 --> IMP_10
  IMP_02 --> IMP_11
  IMP_10 --> IMP_11
  IMP_11 --> IMP_12
  IMP_03 --> IMP_12
  IMP_04 --> IMP_13
  IMP_06 --> IMP_13
  IMP_10 --> IMP_13
  IMP_11 --> IMP_13
  IMP_13 --> IMP_14
  IMP_08 --> IMP_14
  IMP_12 --> IMP_15
  IMP_14 --> IMP_15
  IMP_16 --> IMP_15
  IMP_03 --> IMP_16
  IMP_10 --> IMP_16
  IMP_17 --> IMP_16
  IMP_01 --> IMP_17
  IMP_02 --> IMP_17
  IMP_03 --> IMP_17
  IMP_17 --> IMP_18
  IMP_09 --> IMP_19
  IMP_14 --> IMP_19
  IMP_16 --> IMP_19
  IMP_18 --> IMP_19
  IMP_11 --> IMP_19
  IMP_12 --> IMP_20
  IMP_19 --> IMP_20
  IMP_15 --> IMP_21
  IMP_20 --> IMP_21
  IMP_16 --> IMP_22
  IMP_18 --> IMP_22
  IMP_19 --> IMP_22
  IMP_20 --> IMP_22
  IMP_21 --> IMP_22
  IMP_01 --> IMP_23
  IMP_12 --> IMP_23
  IMP_17 --> IMP_23
  IMP_22 --> IMP_23
  IMP_07 --> IMP_24
  IMP_09 --> IMP_24
  IMP_19 --> IMP_24
  IMP_20 --> IMP_24
  IMP_07 --> IMP_25
  IMP_09 --> IMP_25
  IMP_19 --> IMP_25
  IMP_20 --> IMP_25
  IMP_11 --> IMP_26
  IMP_13 --> IMP_26
  IMP_15 --> IMP_26
  IMP_18 --> IMP_26
  IMP_21 --> IMP_26
  IMP_05 --> IMP_27
  IMP_07 --> IMP_27
  IMP_13 --> IMP_27
  IMP_21 --> IMP_27
  IMP_12 --> IMP_28
  IMP_23 --> IMP_28
  IMP_26 --> IMP_28
  IMP_03 --> IMP_29
  IMP_16 --> IMP_29
  IMP_22 --> IMP_29
  IMP_23 --> IMP_29
  IMP_23 --> IMP_30
  IMP_24 --> IMP_30
  IMP_25 --> IMP_30
  IMP_27 --> IMP_30
  IMP_28 --> IMP_30
  IMP_29 --> IMP_30
  IMP_31 --> IMP_30
  IMP_32 --> IMP_30
  IMP_06 --> IMP_31
  IMP_13 --> IMP_31
  IMP_26 --> IMP_31
  IMP_07 --> IMP_32
  IMP_09 --> IMP_32
  IMP_19 --> IMP_32
  IMP_26 --> IMP_32
```

## 선행 인계 기준의 실행 가능 묶음

| 묶음 | Task |
| --- | --- |
| 1 | [IMP-01](tasks/IMP-01/instruction.md) |
| 2 | [IMP-02](tasks/IMP-02/instruction.md) |
| 3 | [IMP-03](tasks/IMP-03/instruction.md) |
| 4 | [IMP-10](tasks/IMP-10/instruction.md), [IMP-17](tasks/IMP-17/instruction.md) |
| 5 | [IMP-11](tasks/IMP-11/instruction.md), [IMP-16](tasks/IMP-16/instruction.md), [IMP-18](tasks/IMP-18/instruction.md) |
| 6 | [IMP-04](tasks/IMP-04/instruction.md), [IMP-12](tasks/IMP-12/instruction.md) |
| 7 | [IMP-05](tasks/IMP-05/instruction.md), [IMP-07](tasks/IMP-07/instruction.md) |
| 8 | [IMP-06](tasks/IMP-06/instruction.md), [IMP-08](tasks/IMP-08/instruction.md) |
| 9 | [IMP-09](tasks/IMP-09/instruction.md), [IMP-13](tasks/IMP-13/instruction.md) |
| 10 | [IMP-14](tasks/IMP-14/instruction.md) |
| 11 | [IMP-15](tasks/IMP-15/instruction.md), [IMP-19](tasks/IMP-19/instruction.md) |
| 12 | [IMP-20](tasks/IMP-20/instruction.md) |
| 13 | [IMP-21](tasks/IMP-21/instruction.md), [IMP-24](tasks/IMP-24/instruction.md), [IMP-25](tasks/IMP-25/instruction.md) |
| 14 | [IMP-22](tasks/IMP-22/instruction.md), [IMP-26](tasks/IMP-26/instruction.md), [IMP-27](tasks/IMP-27/instruction.md) |
| 15 | [IMP-23](tasks/IMP-23/instruction.md), [IMP-31](tasks/IMP-31/instruction.md), [IMP-32](tasks/IMP-32/instruction.md) |
| 16 | [IMP-28](tasks/IMP-28/instruction.md), [IMP-29](tasks/IMP-29/instruction.md) |
| 17 | [IMP-30](tasks/IMP-30/instruction.md) |

각 묶음은 가능한 병렬성을 보여줄 뿐 반드시 같은 시각에 시작해야 한다는 뜻은 아니다. 실제 배정과 자원은 팀장이 결정한다.
