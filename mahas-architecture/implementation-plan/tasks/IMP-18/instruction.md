# IMP-18 — 범용 PTY·pipes process와 terminal I/O 관리 구현

**종류:** 구현 Task

**담당 역할:** 프로세스 실행 구현자 · **구현 경계:** `execution`

## 1. 배정받는 순간의 지시

당신은 execution 경계에서 **범용 PTY·pipes process와 terminal I/O 관리 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-08, REQ-11, REQ-13, REQ-14, REQ-15, REQ-24 — 구현 시작 전 |
| [execution-host.md](../../../spec/contracts/execution-host.md) | ProcessSpec와 process/terminal operations — 구현 시작 전 |
| [execution-lifecycle.md](../../../spec/execution-lifecycle.md) | §1~4 — 구현 시작 전 |
| [execution.md](../../../spec/domains/execution.md) | §3~5 — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-17](../IMP-17/instruction.md) | `handoff:IMP-17`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. executable/argv/cwd/env를 인자 배열로 받아 PTY 또는 pipes process를 직접 생성한다. 현재 TUI에 shell 명령을 타이핑하는 경로를 사용하지 않는다.

2. effect intent를 OS spawn보다 먼저 저장하고 stable effect key·spawnNonce·ProcessIncarnation을 연결한다. crash gap은 unknown으로 보존한다.

3. stop은 exact process identity와 group ownership을 확인하고 graceful/escalate 단계를 기록한다. pid 재사용이나 미확인 group에 신호를 보내지 않는다.

4. terminal 출력 epoch/sequence/bounded buffer/snapshot과 gap 처리를 구현한다. control receipt가 출력 폭주에 종속되어 무한 대기하지 않도록 큐를 구별한다.

5. attach/detach는 view subscription만 바꾸고 input/resize는 유효 lease proxy로 제한한다. bytes admitted를 agent task accept로 보고하지 않는다.

## 5. 수정 범위와 하지 않을 일

execution-host process/terminal modules

업무 스케줄링·permission 자동 승인·역할 context 저작은 제외

provider App Server adapter나 typed turn parser를 요구하지 않는다.

process exit/idle/silence를 Task completion으로 만들지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-execution-host/src/{process-manager,process-identity,pty-manager,terminal-stream,stop-controller}.ts
- process spawn/probe/stop 및 terminal RPC 핸들러

인계 identity는 `handoff:IMP-18`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `host.process.spawn`, `host.process.probe`, `host.process.stop`, `host.terminal.attach`, `host.terminal.input`, `host.terminal.resize`, `host.terminal.snapshot`, `host.terminal.detach`.

직접 소비하는 후속 구현 Task: [IMP-19](../IMP-19/instruction.md), [IMP-22](../IMP-22/instruction.md), [IMP-26](../IMP-26/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
