# IMP-12 — 로컬 협업 RPC와 얇은 mahas CLI 구현

**종류:** 구현 Task

**담당 역할:** 협업 transport 구현자 · **구현 경계:** `transport/cli`

## 1. 배정받는 순간의 지시

당신은 transport/cli 경계에서 **로컬 협업 RPC와 얇은 mahas CLI 구현**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-08, REQ-09, REQ-14, REQ-18 — 구현 시작 전 |
| [access-cli.md](../../../spec/contracts/access-cli.md) | transport/CLI/results — 구현 시작 전 |
| [mail-artifacts.md](../../../spec/contracts/mail-artifacts.md) | operation.get — 구현 시작 전 |
| [common.md](../../../spec/common.md) | CommandRequest/Receipt/Error — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-11](../IMP-11/instruction.md) | `handoff:IMP-11`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-03](../IMP-03/instruction.md) | `handoff:IMP-03`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. socket/named pipe framing·protocol handshake·authenticated connection을 구현하고 worker/operator endpoint를 명시적으로 구별한다.

2. worker credential과 connection file을 읽어 scope-bound request를 만들되 raw secret을 argv·stdout·로그에 출력하지 않는다.

3. 허용 surface만으로 subcommand parser/help/completion을 생성하고 복합 input 파일·JSON stdout·stderr diagnostics·nonzero 실패를 구현한다.

4. 시간 초과와 연결 실패 때 operationId를 유지하고 operation.get으로 확인할 수 있게 한다. 클라이언트가 새 ID로 자동 mutation 재전송하지 않는다.

5. Control unavailable일 때 요청을 접수한 것으로 답하지 않는다. 읽기 실패를 empty inbox로 위장하지 않는다. IPC/UI도 동일 command handler에 연결할 포트를 내보낸다.

## 5. 수정 범위와 하지 않을 일

transport와 mahas-cli

business workflow·native prompt parsing은 제외

CLI 프로세스 수명을 Task/메시지 수명으로 사용하지 않는다.

하네스별 model/turn API를 CLI 내부에 넣지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-runtime/src/transport/{local-server,worker-auth,operator-auth}.ts
- packages/mahas-cli/src/{main,connection,dynamic-help,command-client}.ts

인계 identity는 `handoff:IMP-12`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

담당 operation: `operation.get`.

직접 소비하는 후속 구현 Task: [IMP-15](../IMP-15/instruction.md), [IMP-20](../IMP-20/instruction.md), [IMP-23](../IMP-23/instruction.md), [IMP-28](../IMP-28/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
