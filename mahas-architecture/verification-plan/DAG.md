# 독립 verification 의존 DAG

정본: [dag.json](dag.json). 아래 그림과 실행 가능 묶음은 그 그래프에서 생성한 projection이다. graph 자체가 자동 실행·재시도 정책을 결정하지 않는다.

```mermaid
flowchart TD
  VER_01["VER-01 도메인 모델·책임 검색·배정의 실행 검사"]
  VER_02["VER-02 SQLite transaction·receipt·content snapshot 내구성 검사"]
  VER_03["VER-03 명령 비노출·raw RPC 인가·권한 폐기 검사"]
  VER_04["VER-04 META DAG·직접 통신·결과 revision 검사"]
  VER_05["VER-05 역할 구현의 실제 구성품·초기 입력 검사"]
  VER_06["VER-06 스폰·초기 입력의 cut-point와 중복 억제 검사"]
  VER_07["VER-07 UI 분리·daemon 재부착·terminal I/O 검사"]
  VER_08["VER-08 종료·자원 인계·업데이트·운영 복구 검사"]
  VER_09["VER-09 파일 기반 실제 CLI 하네스의 역할 구현 수락"]
  VER_10["VER-10 설정 본문 기반 실제 CLI 하네스의 역할 구현 수락"]
  VER_11["VER-11 서로 다른 하네스의 역할·해상도·협업 종단 수락"]
  VER_12["VER-12 최종 요구사항 추적·출시 상태 정산"]
  VER_01 --> VER_03
  VER_02 --> VER_03
  VER_02 --> VER_04
  VER_03 --> VER_04
  VER_01 --> VER_05
  VER_03 --> VER_05
  VER_02 --> VER_06
  VER_03 --> VER_06
  VER_05 --> VER_06
  VER_06 --> VER_07
  VER_02 --> VER_08
  VER_06 --> VER_08
  VER_07 --> VER_08
  VER_03 --> VER_09
  VER_05 --> VER_09
  VER_06 --> VER_09
  VER_03 --> VER_10
  VER_05 --> VER_10
  VER_06 --> VER_10
  VER_04 --> VER_11
  VER_07 --> VER_11
  VER_09 --> VER_11
  VER_10 --> VER_11
  VER_08 --> VER_12
  VER_11 --> VER_12
```

## 선행 인계 기준의 실행 가능 묶음

| 묶음 | Task |
| --- | --- |
| 1 | [VER-01](tasks/VER-01/instruction.md), [VER-02](tasks/VER-02/instruction.md) |
| 2 | [VER-03](tasks/VER-03/instruction.md) |
| 3 | [VER-04](tasks/VER-04/instruction.md), [VER-05](tasks/VER-05/instruction.md) |
| 4 | [VER-06](tasks/VER-06/instruction.md) |
| 5 | [VER-07](tasks/VER-07/instruction.md), [VER-09](tasks/VER-09/instruction.md), [VER-10](tasks/VER-10/instruction.md) |
| 6 | [VER-08](tasks/VER-08/instruction.md), [VER-11](tasks/VER-11/instruction.md) |
| 7 | [VER-12](tasks/VER-12/instruction.md) |

각 묶음은 가능한 병렬성을 보여줄 뿐 반드시 같은 시각에 시작해야 한다는 뜻은 아니다. 실제 배정과 자원은 팀장이 결정한다.
