# 독립 review 의존 DAG

정본: [dag.json](dag.json). 아래 그림과 실행 가능 묶음은 그 그래프에서 생성한 projection이다. graph 자체가 자동 실행·재시도 정책을 결정하지 않는다.

```mermaid
flowchart TD
  REV_01["REV-01 전체 도메인·SQLite 정본·모델 변경 검토"]
  REV_02["REV-02 명령 비노출·권한·위임 경계 검토"]
  REV_03["REV-03 role + context 구현과 정보 해상도 검토"]
  REV_04["REV-04 협업·DAG·전달·정산 의미 검토"]
  REV_05["REV-05 실행 계층·소유권·재부착·복구 검토"]
  REV_06["REV-06 공통 API·CLI·하네스 의존 경계 검토"]
  REV_07["REV-07 작업대·운영·유지 흐름 검토"]
  REV_08["REV-08 경계 간 결합과 최종 아키텍처 검토"]
  REV_01 --> REV_08
  REV_02 --> REV_08
  REV_03 --> REV_08
  REV_04 --> REV_08
  REV_05 --> REV_08
  REV_06 --> REV_08
  REV_07 --> REV_08
```

## 선행 인계 기준의 실행 가능 묶음

| 묶음 | Task |
| --- | --- |
| 1 | [REV-01](tasks/REV-01/instruction.md), [REV-02](tasks/REV-02/instruction.md), [REV-03](tasks/REV-03/instruction.md), [REV-04](tasks/REV-04/instruction.md), [REV-05](tasks/REV-05/instruction.md), [REV-06](tasks/REV-06/instruction.md), [REV-07](tasks/REV-07/instruction.md) |
| 2 | [REV-08](tasks/REV-08/instruction.md) |

각 묶음은 가능한 병렬성을 보여줄 뿐 반드시 같은 시각에 시작해야 한다는 뜻은 아니다. 실제 배정과 자원은 팀장이 결정한다.
