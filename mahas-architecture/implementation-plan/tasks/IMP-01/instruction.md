# IMP-01 — 기존 앱 연결 지점과 서비스 package 경계 구현

**종류:** 구현 Task

**담당 역할:** 플랫폼 통합 구현자 · **구현 경계:** `workbench/platform`

## 1. 배정받는 순간의 지시

당신은 workbench/platform 경계에서 **기존 앱 연결 지점과 서비스 package 경계 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-11, REQ-12, REQ-23, REQ-27 — 구현 시작 전 |
| [architecture.md](../../../spec/architecture.md) | §1, §2, §5 — 구현 시작 전 |
| [execution.md](../../../spec/domains/execution.md) | §1 — 구현 시작 전 |
| [client-terminal.md](../../../spec/contracts/client-terminal.md) | client binding 계약 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

선행 구현 Task는 없다. 실제 저장소와 현재 도구 환경을 입력으로 받아 신규 연결 지점을 만든다. 이 문서의 제안 경로를 이미 존재하는 코드라고 가정하지 않는다.

## 4. 구체적인 구현 지시

1. 실제 저장소의 desktop bootstrap, PTY host 생성/종료, renderer persistence, detached relay의 호출 위치를 읽고 신규 서비스 포트를 삽입한다. 

2. packages/mahas-contracts/runtime/execution-host/cli/harness-config의 의존 방향을 package 경계로 만든다. renderer가 runtime repository를 import하지 못하도록 공용 계약 포트를 분리한다.

3. 기존 일반 터미널 경로는 유지하되 managed execution 생성·조회는 새 runtime client를 통해서만 호출하도록 feature boundary를 만든다.

4. 현재 pane/tab identity에서 Execution/Terminal identity를 별도 바인딩할 포트를 추가한다. 아직 Task 데이터가 없는 과거 세션을 managed Task로 변환하지 않는다.

5. service readiness/endpoint 연결 인터페이스와 종료 요청 전달 포트를 내보낸다. 실제 service lease와 수명 처리는 IMP-17/23이 주입하게 한다.

## 5. 수정 범위와 하지 않을 일

신규 package/desktop composition seam

DB 구현·provider adapter·기존 전체 파일 rename은 제외

아직 구현되지 않은 daemon의 영속 생존을 UI에 지원으로 표시하지 않는다.

기존 UI 설정 파일의 구조를 이 Task에서 전면 migration하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/bootstrap.ts와 desktop runtime-client 연결 포트
- packages/mahas-execution-host/src/main.ts entrypoint 껍질
- 기존 PTY/상태·resume 호출의 migration seam과 파일 위치 대응표

인계 identity는 `handoff:IMP-01`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: [IMP-02](../IMP-02/instruction.md), [IMP-17](../IMP-17/instruction.md), [IMP-23](../IMP-23/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
