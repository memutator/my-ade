# 도메인 모델 재정의 필요성

현재 usage 위젯의 도메인 모델은 `provider → fetcher → windows` 평면 구조다.
실제 LLM/agent 시장의 구조와 어긋나서, 표현하지 못하는 사실과 하드코딩으로 떠받치는
구현이 쌓이고 있다. UI를 더 고치기 전에 도메인 모델부터 다시 잡아야 한다.

## 현재 모델의 한계

### provider ↔ harness 구분 부재

지금 `provider`라는 단어가 세 가지를 가리킨다:

- manifest의 harness id (`codex`, `zcode`, `opencode`…)
- usage 소스의 상위 서비스 라벨 (`UsageSource.provider`)
- 우리 주석/변수명에서의 소비자 CLI

실제로는 **서비스를 제공하는 쪽**(OpenAI, z.ai, Anthropic…)과 **그것을 소비하는
쪽**(codex, zcode, cline…)이 다른 개념이고, 관계는 **N:M**이다.

### provider 내부의 상품 분화를 표현 못함

한 provider 안에 서로 다른 과금 상품이 공존한다:

- OpenAI: ChatGPT 구독 OAuth ↔ 플랫폼 API 키
- z.ai: 종량제 ↔ Coding Plan ↔ Start Plan ↔ Team Plan
- bigmodel.cn: 중국 realm (같은 회사지만 계정/빌링 분리)
- OpenCode: Go ↔ Zen

이들은 엔드포인트도, 인증 realm도, quota 스키마도 다르다. 지금 모델엔 이 단계가 없다.

### 교차 사용을 표현 못함

하네스가 "자기 공식" provider만 쓰는 게 아니다:

- opencode에 ChatGPT OAuth를 등록해 쓸 수 있음
- codex가 OpenCode Go를 쓸 수 있음
- zcode config 하나에 서로 다른 상품의 credential이 6개까지 바인딩됨

"하네스마다 credential 하나"라는 암묵 가정으로는 이 사실을 기록할 수 없다.

### 구현체를 우리가 소유

provider별 quota fetcher가 `src/main/usage.ts`에 하드코딩되어 있다.
세상의 모든 하네스/상품 조합을 우리가 알 수 없고, zcode의 entitlement처럼
특이한 계약을 일일이 코드로 고칠 수도 없다. 구현체는 밖에 있어야 한다.

### 사용자는 N개의 provider를 둘 수 있다

같은 상품의 계정 여러 개, 다른 상품의 계정 여러 개 — 카드 한 장당 하나의
"관측 가능한 자격증명"이 되어야 하는데 현재 소스 모델은 provider 단위다.

## 잡힌 방향

### 개념 세트

| 개념 | 의미 | 노출 |
|---|---|---|
| **Provider** | quota를 가진 쪽. 상품 변형까지 평탄하게 포함 | UI 노출 |
| **Harness** | 소비하는 쪽 (codex, zcode, cline, opencode…) | UI 노출 |
| **Credential** | 저장된 로그인 재료 (파일/키/토큰 세트) | 내부 |
| **Binding** | "이 harness가 이 credential을 참조한다"는 사실 | 내부 |
| **Probe** | credential을 읽어 관측치를 뱉는 외부 구현체 | 내부 |
| **Reading** | probe의 관측 사실 (meters, identity, plan…) | 내부 |

프론트에 노출되는 용어는 **Provider / Harness 두 개뿐** — 나머지는 기술적
용어를 자유롭게 쓴다.

### Provider id: `family/variant` 이중 세그먼트

```
openai/chatgpt        openai/api
anthropic/claude      anthropic/api
zai/payg              zai/coding-plan     zai/start-plan
bigmodel/coding-plan  (중국 realm — family도 분리)
github/copilot        google/gemini-oauth google/gemini-key
opencode/zen          opencode/go
```

- 첫 세그먼트 = 계정 realm 단위의 family (아이콘/그룹핑/dedup 파생)
- 두 번째 세그먼트 = **오퍼링 이름** — 하네스 이름이 아님
  (`openai/codex-oauth`가 아니라 `openai/chatgpt`: grant는 ChatGPT 구독의
  것이고 codex는 그걸 쓰는 first-party harness일 뿐)
- `provider/model` 레퍼런스, OpenRouter `author/slug`와 같은 문법
- 새 상품 추가 = manifest 행 + probe 파일. 코드 추가 없음이 목표

### N:M은 binding이 담당

provider/harness 어느 쪽에도 상대 목록을 심지 않는다. "harness H가
credential C를 참조한다"는 사실 레코드가 관계의 전부다. opencode가
`openai/chatgpt` credential을 바인딩하는 것도 행 하나로 표현된다.

### 구현체 외부화

- **probe** — provider별로 credential을 읽어 정규화된 Reading을 반환.
  단순 JSON API는 선언형(엔드포인트+헤더+추출 경로), OAuth refresh나
  entitlement 해석처럼 로직이 필요하면 스크립트. 우리가 모르는 provider는
  사용자가 probe를 추가할 수 있어야 함
- **credential detector** — harness별로 config에서 binding을 읽어내는 것도
  외부화 대상 (codex auth.json, zcode provider entries, opencode auth.json을
  파싱하는 규칙)

앱 자체는 정규화된 사실만 소비해서 UI를 그린다.

### domain = 사실, projection = 정책

도메인은 존재와 관계의 기록일 뿐이다. "두 credential이 같은 계정인가",
"머신이 다른데 합칠까" 같은 판단은 전부 projection의 표시 정책이다.
나중에 machine이 들어와도 credential/binding의 소속 속성일 뿐 모델은 안 흔들림.

- usage projection이 묻는 질문은 하나: **얼마나 썼고 얼마나 쓸 수 있나**
- quota는 credential(provider) 측 사실, 토큰 소모는 harness/session 측 사실 —
  다른 축이며 섞이지 않음

## 같은 문제, 하네스 쪽

provider의 quota만의 이야기가 아니다. **하네스 통합 자체가 같은 질환**을
가지고 있다 — cline 추가 작업에서 드러난 것처럼, agent는 OAuth만 등록하고
세션 알림/ledger/resume을 빠뜨렸다. "뭘 추가해야 하는지"가 어디에도
선언되어 있지 않기 때문이다. 세션 알림 버그가 잦은 것도 같은 뿌리다.

### 하네스 하나 추가에 실제로 흩어지는 것 (실측)

| 관심사 | 위치 |
|---|---|
| 감지/정체성/resume | `resources/agents/manifest.json` |
| 훅 설치 mechanism | `src/main/hookInstallers.ts` `PROVIDERS[]` |
| payload→이벤트 정규화 | `resources/mahas-hook.cjs` `buildEvent` — 하네스별 특수 케이스가 산재 |
| 세션/토큰 저장소 스캔 | `src/main/ledger.ts` `SCANNERS[]` |
| quota fetcher | `src/main/usage.ts` `FETCHERS[]` |
| OAuth/키 등록 플로우 | `src/main/usageAuth.ts` provider switch |
| 하네스 고유 quirk | `src/main/devinLocks.ts` 같은 전용 서브시스템 |
| renderer 목록 | `WidgetView.tsx` `USAGE_PROVIDERS`/`OAUTH_PROVIDERS`/`KEY_PROVIDERS` |
| 문서 | `AGENTS.md`, `docs/agents.md`, `docs/notifications.md` |

선언되지 않은 암묵 계약도 있다: 어떤 이벤트를 쏘는가(needs-input 존재
여부도 하네스마다 다름), sessionId가 resume에 어떤 의미인가, subagent
이벤트를 어떻게 강등하는가, 에러 배너를 pty 출력에서 재분류해야 하는가.

### 방향 — harness pack

하네스 통합을 **하네스당 하나의 단위**로 묶는다. pack이 선언하는
capability 목록:

- **identify** — 바이너리/프로세스 match, label, 아이콘 domain, color
- **resume** — 명령 템플릿 + sessionId 필드 의미
- **notify** — 훅 설치 mechanism + payload→canonical 이벤트 매핑
  (subagent 강등, 에러 배너, codex recap 같은 예외도 pack 소유)
- **ledger** — 세션/토큰 저장소 위치 + 파싱 규칙
- **credentials** — cred 파일 위치와 형태 → provider로의 binding 규칙
- **quirks** — 탈출구 (devin lock sweep 같은 전용 로직)

어떤 capability를 지원하는지가 pack의 선언이므로, "cline은 needs-input이
없다" 같은 것도 누락이 아니라 명시된 사실이 된다. provider probe와 같은
원리 — **우리 소스는 프레임워크와 정규화 계약만 소유하고, 구현체는 밖에
있다**. 우리가 모르는 하네스는 pack을 추가하면 되고, 이벤트 의미론의
특수성은 pack 경계 안에 갇힌다.

## 미해결 / 다음에 잡을 것

- Reading의 정규화 스키마 (meter/entitlement를 포괄하는 사실 형태)
- binding detector의 책임 범위 (자동 감지 vs 명시 등록)
- session/agent를 domain에 올릴지 (token ledger의 session→credential 귀속)
- probe 신뢰 경계 (외부 스크립트에 credential material을 넘기는 규약)
- harness pack의 물리적 형태 (단일 manifest 파일? 디렉토리? 스크립트 포함?)
- canonical 이벤트 분류법의 확정 (pack이 매핑하는 대상 스키마)
- pack의 capability 선언 형식 (지원 안 함을 명시하는 법)
