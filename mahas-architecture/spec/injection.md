# S-INJECTION — 역할 구현 구성품을 실제 하네스 입력으로 만드는 명세

**읽는 시점:** IMP-07~IMP-09, IMP-19/20, IMP-24/25. 역할 구현 작성자는 §1~3, compiler는 §3~5, launcher와 하네스 설정 담당자는 §4~8을 읽는다. 이 파일을 모든 업무 agent에게 통째로 주입하지 않는다.

## 1. interface → implementation → materialization의 책임

RoleInterface가 요구하는 것은 '무엇을 판단해야 하고 어떤 의미를 알아야 하는가'다. 구현 작성자가 그 역할의 전문성과 해상도로 이를 instruction·skill·subagent·tool 구성품에 배치한다. 프로그램은 작성된 구현을 읽고 지원되는 하네스 파일/설정으로 낮춘다. 하네스별 파일을 만드는 formatter가 역할의 전문적 의미까지 설계한다고 설명하지 않는다.

구현의 `coverageBindings`는 각 필수 clause를 어느 component/section이 어떤 표현으로 성립시키는지 연결한다. `verbatim`은 원문이 그대로 필요할 때, `reexpressed`는 상위가 가치/긴장을 보고 하위가 구체 제약을 보는 것처럼 같은 내용을 다른 문법으로 구현할 때다. reexpressed component를 넣었으면 원본 장문을 다시 추가하지 않는다. 의미 검토는 REV-03, 실제 로딩은 VER-05/VER-09/VER-10이다.

## 2. 구성품의 닫힌 분류와 lowering

| component kind | 구현자가 정할 내용 | compiler가 생성할 것 | 필수 로딩 규칙 |
|---|---|---|---|
| instruction | role 책무·판단 기준의 역할별 표현·공통 협업 지침 | mandatory.md의 정확한 section | 첫 실행에 본문 전체 |
| skill | 전문 지침·선택 조건·보조 도구 | 해당 profile의 SKILL.md/metadata | optional은 catalog, 필수는 inline 또는 확정 preload |
| subagent | local helper의 전문성·수행 범위·도구 | native agent 정의 | 별도 mahas Member로 가장하지 않음; primary/helper 구별 |
| tool-config | mahas CLI와 필요 외부 tool 구성 | scoped CLI connection와 선택된 tool config | current action surface와 교집합; secret 별도 |
| launch-config | 시작 agent·profile 옵션·초기 입력 경로 | ProcessSpec+component load map | 승인된 recipe만, 임의 shell 문자열 실행 금지 |

profile이 component kind를 지원하지 않으면 publish/build가 unsupported를 반환한다. compiler가 subagent를 plain text로, 필수 skill을 optional catalog로 조용히 바꾸지 않는다. 다른 하네스용 RoleImplementation을 작성하는 것이 올바른 대안이다. 한 interface에 서로 다른 구성품 조합의 구현을 여러 개 공개할 수 있다.

## 3. 생성되는 산출물과 순서

```text
<execution-root>/
  role/mandatory.md       # 고정 역할/전문성/해상도/필수 협업 instruction 본문
  role/components/       # 이 구현이 실제 쓰는 skill/subagent/tool 설정만
  role/manifest.json     # component digest, clause coverage, load route
  task/initial.txt       # 이번 requirements 본문+입력 slot+협업 상대+결과 계약
  task/envelope.json     # 정확한 task/dispatch/input revision
  surface/commands.json  # current allowed command schema만
  surface/commands.md    # same surface로 생성한 설명
  connection/worker      # private credential/endpoint; 모델 입력에서 제외
  bin/mahas              # scoped CLI launcher
```

manifest는 구현 산출물이며 개발 문서의 별도 reference가 아니다. 원본은 SQLite 모델/구현 설정과 등록 context 파일이다. render 결과는 DB ContentBlob에도 digest로 보존하고 실행 디렉터리는 재생성 가능하다. 공용 repository의 AGENTS.md·CLAUDE.md·skill 파일을 여러 실행이 덮어쓰지 않는다. project 자동검색 경로에 skill을 설치해야 하면 실행이 독점하는 worktree를 사용한다. 기존 파일과 충돌하면 실패하고 덮어쓰지 않는다.

구성품 항목 JSON 정본은 `{id, kind, path, digest, loadPhase}`다. compiler가 내는 `installPath`/`blobDigest`/`loadRoutes`는 같은 필드의 별칭이며 materializer가 정본으로 번역한다. `maintenanceBasis`는 실행 루트 manifest에서 뺀다.

## 3.1 LaunchRecipe (prepare가 소비하는 정본)

`harness.profile.register`의 `injectionRecipe`는 ProfileRecipe다. `worker.prepare`는 LaunchRecipe를 요구한다.

```text
LaunchRecipe = {
  process: {
    executable: absolutePath,          // '/'로 시작, argv[0]과 같거나 argv 앞에 붙임
    argv: ArgvEntry[],                 // shell 문자열 아님
    stdio: 'pty' | 'pipes',
    terminalSize?: { cols, rows },
    env?: { [key]: string },           // secret 금지
    envAllowlist?: string[]
  },
  routes: InjectionRoute[]             // role/mandatory.md 와 task/initial.txt 는 required
}
ArgvEntry =
  | { literal: string }
  | { slot: 'file', source, flag? }
  | { slot: 'fileText', source }
  | { slot: 'configText', key, format?: 'toml-basic-string', source }
  | { slot: 'dir', source, flag? }
  | { slot: 'checkoutPath' }
  | { slot: 'executionRoot' }
InjectionRoute = { source, kind: argv-file|argv-text|argv-config-text|stdin|config-file|native-preload, target?, format?, required }
```

ProfileRecipe만 있고 `process.executable`이 없으면 서버는 등록된 `executableIdentity.locator.commands`와 해당 하네스 documented recipe(S-INJECTION §5–6)로 LaunchRecipe를 만든다. 절대 경로 실행 파일을 해석하지 못하면 `INJECTION_UNSUPPORTED`다. 두 스키마를 한 JSON에 섞어 정본이 두 개가 되게 하지 않는다.

mandatory.md의 순서는 자기 role과 판단 범위 → 책임에 맞게 구현된 필수 context → relevant contract 의미 → 허용 command 사용법 → bootstrap/협업 프로토콜이다. Task의 요구사항과 peers는 initial.txt에 둔다. credential·시간·run/task ID를 재사용 mandatory 본문에 섞지 않는다. 해상도는 구현 문구에서 정하고 compiler가 criterion·부모 문서를 전부 자동 append하지 않는다.

initial.txt에는 '(목표) (이번 요구사항 본문) (업무 범위·제약) (정확한 입력과 사용할 시점) (직접 협업 상대와 관계) (필요한 산출물·정산 주체) (join/accept의 정확한 요청)'을 넣는다. 큰 결과 파일은 ArtifactRef와 읽어야 할 이유/시점을 주되, 작업의 요구사항 자체를 '찾아서 읽어라'로 대체하지 않는다.

## 4. 전달 방식의 세 종류

1. **explicit instruction file route:** 하네스의 검증된 시작 flag/config가 mandatory.md의 전체 본문을 추가 지침으로 읽는다. 파일 path를 env에 등록하는 것만으로는 이 route가 아니다.
2. **explicit instruction text route:** compiler가 byte를 읽어 올바른 문자열 인코딩으로 설정/인자에 넣는다. initial.txt 역시 실제 문자열 또는 하네스가 읽는 stdin에 전달한다. `$(cat ...)` shell 보간은 사용하지 않는다.
3. **confirmed preload route:** 명시된 primary native agent의 시작 설정이 필수 skill의 전체 본문을 preload한다. 실제 지원·설치 파일 존재를 확인하며 discovery/description-only는 인정하지 않는다.

각 route는 `componentId → actualPath/argvIndex/configKey → byteDigest → loadingPhase`를 InjectionReceipt에 기록한다. 물리 한도 초과는 다른 검증 route를 명시 선택하거나 launch를 block한다. 자동 요약·절단 금지. native 숨은 prompt 전체를 읽을 수 없으면 '전체 최종 prompt 검증 완료'라고 표기하지 않는다.

## 5. 첫 실제 구현 경로 A — 파일 기반 instruction + native 구성품

Claude Code용 profile 구현은 공식 CLI의 `--append-system-prompt-file`과 초기 prompt 인자를 사용한다. compiler가 instruction 파일을 만들고 ProcessSpec을 다음과 같이 정한다.

```text
executable = resolved claude executable
argv = ["--append-system-prompt-file", mandatoryPath,
        ...(usesPlugin ? ["--plugin-dir", compiledPluginRoot] : []),
        ...(usesMcp ? ["--mcp-config", scopedMcpConfigPath] : []),
        initialText]
stdio = pty 또는 profile이 명시한 pipes 모드
cwd = allocated checkout
```

이는 문자열 shell command가 아니라 인자 배열이다. initialText는 initial.txt의 실제 본문이며 path 이름이 아니다. plugin을 쓰는 구현은 `.claude-plugin/plugin.json`, `skills/<component>/SKILL.md`, `agents/<component>.md` 등 profile이 지원하는 구성만 생성한다. native agent를 primary로 선택할 때는 해당 profile의 명시 agent 선택 설정을 기록한다. helper skill preload를 사용할 경우 full body preload가 가능한 설정을 coverage에 적고 누락 파일을 자체 preflight에서 거부한다. native 도구 자체가 누락 skill을 경고 후 생략할 수 있다는 이유로 필수 context 누락을 수용하지 않는다.

외부 도구 연결을 사용해도 mahas 협업의 기본 진입점은 같은 CLI/API다. profile이 MCP 표면을 제공하면 동일 filtered registry를 노출한다. native helper에게 새로운 role grant를 주지 않는다.

기능 근거: 공식 Claude Code CLI 문서의 append-system-prompt-file/plugin-dir/mcp-config, subagents 문서의 skills preload. 2026-09-18 조회. 이 명세는 공개 문서의 옵션을 사용하도록 정했을 뿐 설치된 버전의 실제 작동을 검증한 결과가 아니다.
https://code.claude.com/docs/en/cli-reference
https://code.claude.com/docs/en/sub-agents

## 6. 첫 실제 구현 경로 B — 설정 본문 + repository skill 구성

Codex CLI용 profile 구현은 `developer_instructions`의 추가 지침과 초기 prompt 인자를 사용한다. baseline implementation은 instruction+skill+CLI tool-config를 지원한다. native subagent component를 무조건 같은 형태로 변환하지 않으며 필요하면 별도 profile revision에서 구현한다.

```text
mandatoryText = UTF8(mandatory.md)  # 허용 command instructions는 이 파일에 이미 포함
configOverride = "developer_instructions=" + TOML_BASIC_STRING(mandatoryText)
argv = ["-c", configOverride, initialText]
cwd = allocated checkout
```

TOML 문자열 escape, argv byte 한도, NUL 거부를 구현한다. `model_instructions_file`의 기본 지침 대체와 혼동하지 않는다. optional skill은 해당 실행 전용 checkout의 `.agents/skills/<component>/SKILL.md`에 설치하고, 초기 필수 의미는 mandatoryText에 이미 들어간다. repo/user/admin의 기존 자동 로딩 경로도 EffectiveContextReceipt에 표시한다. 기존 조직 지침을 몰래 제거하지 않는다.

CLI wrapper와 connection path가 하네스의 shell 실행 환경에서도 접근되는지 profile admission으로 확인한다. CODEX_HOME을 임의로 새 빈 디렉터리로 바꿔 계정/설정이 유지된다고 가정하지 않는다. credential을 prompt/argv에 넣지 않는다. 길이 초과 시 지원되지 않는 파일 route를 지어내지 않고 INJECTION_UNSUPPORTED를 반환한다.

기능 근거: 공식 configuration reference의 developer_instructions, CLI config override, skills 로딩 위치. 2026-09-18 조회. 실제 설치 버전·권한 설정 시험은 VER-10의 책임이다.
https://developers.openai.com/codex/config-reference/
https://developers.openai.com/codex/cli/reference/
https://developers.openai.com/codex/skills/

## 7. bootstrap와 receipt

처음 실행된 agent가 received bundle/surface/envelope digest로 `mahas execution join`을 호출한다. runtime은 credential·ExecutionGeneration·current grant를 검증하고 정상 surface를 활성화한다. 이어 task assignment면 `mahas task accept`를 정확한 TaskRevision과 WorkEnvelopeDigest로 호출한다. coordination assignment는 Run mandate를 인수하고 discovery/plan 작업을 수행한다.

launcher가 대리 join하거나 manifest 존재만으로 task accept를 만들지 않는다. agent가 digest를 돌려줬다고 지침을 이해·준수했다고 보증하지 않는다. 지침의 역할 적합성은 별도 검토, 실제 입력 로딩은 실행 검증, 업무 결과의 품질은 담당자의 판단이다.

## 8. 추가 입력·resume·다른 역할

같은 execution에 다음 Task를 주는 것은 새 WorkEnvelope와 task accept를 요구한다. idle TUI를 자동 깨울 수 없으면 전달된 inbox와 수동 재개 요청을 남긴다. 이미 처리한 pointer를 새 operation ID로 다시 입력하지 않는다.

reattach는 기존 context를 바꾸지 않는다. native-resume은 같은 role/interface/bundle과 검증 route일 때만 허용한다. 역할이나 필수 지침 변경은 fresh conversation이 기본이다. 새 파일로 기존 대화 기억이 사라진다고 가정하지 않는다. static current instruction을 매 대화 transcript에 무제한 누적하지 않는다.
