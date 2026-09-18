# S-ARCH — 실행 계층을 포함한 전체 아키텍처

**누가 언제 읽는가:** 팀장은 배정 전 전체를 읽는다. 실행·플랫폼·클라이언트 담당자는 자기 Task의 해당 절을 읽는다. 도메인별 세부 계약은 이 문서의 인터페이스 이름을 따라간다.

## 1. 배치와 정본

```text
Desktop / Detached UI / operator CLI
              │ local authenticated RPC / subscriptions
              ▼
mahasd (단일 control authority)
 ├─ DomainServices: RDD / Discovery / RoleImplementation / Access
 ├─ Coordination: Run / Plan / Member / Task / Dispatch / Mailbox / Outcome
 ├─ LaunchCoordinator / WorkspaceService / RecoveryCoordinator
 ├─ Observation / Intervention / Projection
 └─ mahas.sqlite — RDD 및 전체 제어 도메인의 단일 writer
              │ versioned ExecutionHost RPC
              ▼
execution-host (재부착 가능한 local daemon)
 ├─ PTY process manager / 일반 child process manager
 ├─ primitive effect receipt / process identity / terminal buffer
 └─ execution-host.sqlite — OS effect와 실행 자원 증거만
              │
       기존 하네스의 CLI agent
              │ shell tool → mahas CLI → mahasd 협업 API
```

`mahasd`는 특정 모델의 App Server가 아니라 우리 시스템의 제어면이다. 하네스는 app-server 없이 CLI로 실행된다. execution-host는 모델 공급자 adapter가 아니라 process/PTY의 소유자다. 두 daemon은 UI의 child-IPC disconnect 때문에 자동으로 죽지 않는 서비스 엔트리포인트로 실행한다. desktop은 service bootstrap 후 RPC client가 된다.

기존 입력 보고서의 실행은 앱 종료와 PTY 종료가 결합되어 있다(「ade 실행 아키텍처 분석」 §2.1). 이 설계는 그 부분을 새로 변경한다. Orca의 daemon identity·재부착, Task/Dispatch/Delivery와 잔여 자원 분리는 차용하는 근거지만 모든 provider 기능을 복제하지 않는다(「Orca와 Paseo의 실행 아키텍처 비교 분석」 §3.3, §5).

## 2. 코드 책임 경계와 서비스 계약

| 경계 | 성립시킬 단일 책임 | 외부 계약 | 명시적 비책임 |
|---|---|---|---|
| model | 책임 구조의 버전과 참조 일관성 | C-MODEL | 의미적으로 좋은 책임 분할을 자동 판정 |
| discovery | 배정에 필요한 책임 후보와 관계를 적정 해상도로 제공 | C-DISCOVERY | 검색 순위를 담당자 결정으로 승격 |
| realization | role+context를 수행 가능한 하네스 구성품으로 구현 | C-REALIZATION | 매 spawn마다 전체 원본을 LLM 요약 |
| access | 노출과 실제 호출이 현재 위임 범위를 넘지 않게 함 | C-ACCESS | shell/OS의 적대적 격리를 보증 |
| coordination | 합의된 작업·시도·전달·판정을 모순 없이 기록 | C-WORK, C-MAIL | 업무 계획·자동 재시도 선택 |
| launch | 고정된 역할·작업·권한을 실제 실행에 연결 | C-LAUNCH | generic PTY의 typed turn 추론 |
| execution | process/PTY의 수명·소유·effect를 증거와 함께 관리 | C-HOST | 업무 완료·메시지 처리 판단 |
| resources | 실제 checkout과 산출물의 소유·인계를 보존 | C-RESOURCE | 자동 merge·dirty 파일 강제 삭제 |
| recovery | 기록과 현재 증거를 대조하여 유효한 제어권을 복구 | C-RECOVERY | timeout을 사망으로 가정 |
| observation | 출처와 미확인을 유지한 상태/개입 projection | C-OBSERVATION | output silence를 완료로 판정 |
| workbench | 사용자가 역할·업무·실행을 구별해 조율하게 함 | C-CLIENT | renderer를 영속 제어 writer로 만듦 |

v1 신규 코드는 `packages/mahas-contracts`, `packages/mahas-runtime`, `packages/mahas-execution-host`, `packages/mahas-cli`, `packages/mahas-harness-config`로 나눈다. 기존 desktop 경로의 실제 대응은 IMP-01에서 고정한다. 이 package 경로는 신규 구현 지시이며 현재 저장소에 이미 있다는 주장이 아니다.

## 3. 네 종류의 그래프

RDD contains tree는 책임 분할, contract graph는 입출력 의존, Run Plan DAG는 이번 작업의 선후행, RoleImplementation의 구성 그래프는 지침/skill/tool 설치 관계다. 이 그래프들을 한 종류의 parent_id로 합치지 않는다. 메시지는 왕복할 수 있고 Task DAG에 cycle을 만들 필요가 없다. native subagent의 호출 tree는 mahas의 Member/Task graph가 아니다.

## 4. 저장과 effect 경계

mahas.sqlite는 모델·권한·실행 계획·상태 정산의 정본이다. execution-host.sqlite는 process 생성·정지·workspace primitive의 결과 증거다. execution-host는 Task를 accepted로 만들거나 grant를 해석하지 않는다. 제어면은 execution-host의 receipt를 읽어 자기 effect/outbox를 정산한다. 두 DB를 한 transaction처럼 설명하지 않는다.

도메인 DB transaction 안에는 파일 쓰기, process spawn, 네트워크 전송을 넣지 않는다. 의도/outbox를 먼저 commit하고 외부 effect에 안정적인 key를 전달한다. 실행면 receipt를 얻지 못하면 unknown을 유지한다. 조회 projection은 원본 모델/원장으로 재생성할 수 있다.

## 5. 수명 정책

UI close = detach. operator의 runtime.shutdown은 `drain-and-stop` 또는 `leave-executions`를 명시한다. 기본 UI 종료는 daemon을 유지한다. mahasd crash 중에는 execution-host의 기존 process가 생존할 수 있지만 새 권한 있는 협업 요청은 unavailable이다. 메시지가 접수됐다고 거짓 응답하지 않는다. mahasd 재시작은 DB를 열고 host/process identity를 reconciliation한 뒤 새 mutation을 허용한다.

OS 재부팅·서비스 매니저의 전체 process group 종료까지 process 생존을 보장하지 않는다. liveness와 제어 연결 상태를 따로 표시한다. 재부착은 spawn과 다르고, native conversation resume도 재부착과 다르다.

## 6. 운영 신뢰 경계

operator는 별도 control socket/credential로 관리한다. worker의 CLI는 scope-bound credential과 endpoint만 가진다. worker에게 mahas.sqlite 경로를 API로 열지 않으며 정상 호출은 모두 서버 admission을 통과한다. 같은 OS 사용자에게 임의 shell 접근을 준 경우 파일·환경·다른 프로세스 credential 공격까지 이 논리 권한으로 막았다고 주장하지 않는다. 강한 격리는 추가 OS identity/container 과제이며 v1 비목표다.

## 7. 설계의 중심 흐름

팀장 책임 탐색 → 구현 가능한 role 조회 → 명시 배정 → Task/META DAG 고정 → role+context 인터페이스를 구현한 구성품 선택 → 권한 교집합과 입력 고정 → spawn recipe로 실제 첫 입력 전달 → agent join와 task accept → 공통 협업 API → 결과 정산 → 유지/인계/정리.

이 흐름의 각 화살표에는 contracts 폴더의 입력·출력·실패 계약이 있다. 다수 터미널을 열거나 문서 파일만 생성하는 것은 위 흐름의 완료가 아니다.
