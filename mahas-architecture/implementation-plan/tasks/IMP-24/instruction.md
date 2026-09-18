# IMP-24 — 파일 기반 하네스의 구성품 구현과 launch recipe 작성

**종류:** 구현 Task

**담당 역할:** 하네스 구성 구현자 · **구현 경계:** `realization`

## 1. 배정받는 순간의 지시

당신은 realization 경계에서 **파일 기반 하네스의 구성품 구현과 launch recipe 작성**를 책임진다. 아래 필요한 명세를 작업 시작 전에 읽고, 선행 인계물의 정확한 revision을 사용한다. 다른 Task 지시나 전체 문서 묶음을 모두 읽을 필요는 없다. 작업 방법의 세부 설계는 담당자의 전문성에 맡기되 외부 계약과 의미를 바꾸지 않는다.

## 2. 지금 읽을 문서

| 문서 | 필수 범위·시점 |
| --- | --- |
| [INSTRUCTIONS.md](../../../implementation-plan/INSTRUCTIONS.md) | 전체 — 구현 시작 전 |
| [requirements.md](../../../requirements.md) | REQ-05, REQ-07, REQ-08, REQ-09 — 구현 시작 전 |
| [injection.md](../../../spec/injection.md) | §1~5, §7~8 — 구현 시작 전 |
| [realization.md](../../../spec/contracts/realization.md) | harness profile lifecycle — 구현 시작 전 |
| [launch.md](../../../spec/contracts/launch.md) | initial attachment evidence — 구현 시작 전 |

## 3. 시작 조건과 선행 입력

| 선행 Task | 반드시 받을 입력 |
| --- | --- |
| [IMP-07](../IMP-07/instruction.md) | `handoff:IMP-07`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-09](../IMP-09/instruction.md) | `handoff:IMP-09`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-19](../IMP-19/instruction.md) | `handoff:IMP-19`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |
| [IMP-20](../IMP-20/instruction.md) | `handoff:IMP-20`: 고정 코드 revision, 공개 entrypoint/contract, 변경 경로, migration 및 미해결 제약 |

인계물의 코드/계약 revision이 없거나 서로 맞지 않으면 필요한 interface를 팀장/해당 제공자에게 요청한다. 임시 무권한 경로나 새 이름의 대체 계약을 임의로 만들지 않는다.

## 4. 구체적인 구현 지시

1. S-INJECTION §5의 explicit instruction file+initial prompt 경로를 direct argv로 구현한다. 역할 본문과 초기 업무 본문을 실제 loading point에 연결한다.

2. 구현이 쓰는 plugin manifest/skill/agent/tool 구성품만 생성하고 unsupported component는 명시 실패시킨다.

3. 필수 skill의 초기 full body 전달은 inline 또는 명시 preload로 고정한다. helper definition을 만들었다고 primary agent가 자동 해당 내용을 받는 것으로 보지 않는다.

4. 프로젝트/사용자/조직 자동 로딩 경로와 permission/tool 설정을 manifest에 기록하고 공용 파일을 덮어쓰지 않는다.

5. profile은 문서 기반 recipe 구현 상태로 등록한다. 실제 설치 버전의 verified activation은 VER-09의 SupportAttestation 후 operator가 수행하게 한다.

## 5. 수정 범위와 하지 않을 일

mahas-harness-config/claude

실제 모델 실행 시험·비용 발생 시험은 verification-plan에 별도

native App Server/SDK의 turn 제어를 도입하지 않는다.

명령 이름 비노출과 native OS 도구 권한을 혼동하지 않는다.

외부 계약 변경이 필요하면 변경 이유·소비자 영향을 해당 계약 소유자와 협의한다. 이 Task 밖의 경계 구현을 몰래 수정하여 문제를 우회하지 않는다.

## 6. 구현 결과와 인계물

- packages/mahas-harness-config/src/claude/{components,recipe,settings-policy}.ts
- instruction/skill/subagent/tool-config mapping의 공개 가능한 profile revision

인계 identity는 `handoff:IMP-24`다. [공통 인계 계약](../../INSTRUCTIONS.md)의 코드 revision·entrypoints·계약·migration·제약을 채워 제출한다. 산출물의 상태는 **implemented / not independently reviewed or accepted**다.

직접 소비하는 후속 구현 Task: [IMP-30](../IMP-30/instruction.md).

## 7. 완료 보고

무엇을 구현했는지, 어떤 계약과 revision을 만족하도록 작성했는지, 남은 제약/불확실성은 무엇인지 보고한다. 실제 수행하지 않은 하네스 실행·장애 복구·보안 검증 결과를 통과로 쓰지 않는다. 정식 review/verification 수행 지시는 이 Task의 범위가 아니다.
