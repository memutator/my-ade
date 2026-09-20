**mahas 소스 구조 평가 및 리팩터링 계획 — 2026-09-20**

기준 커밋: `73f338f16f20b680787be3dfbd54d06c280b7f9b`. 이 문서는 그 커밋의 정적 재검토이며, 테스트 전체 실행이나 Electron 동작 재현 결과와는 구분한다.

초안은 R01–R22 관찰과 W0–W8 이행안을 한 문서에 모았다. 이후 독립 검토 두 건을 취합해 **관찰은 유지하고 처방·순서를 좁혔다.** 번호 R01–R22는 같은 문제를 가리킨다. 이것을 확정 결함 22개로 세거나, 아래 선택 디렉터리 트리를 전면 재편의 증거로 읽지 않는다. R05는 여러 영역의 책임 집중을 묶어 보여주는 관찰이며 독립 결함으로 가산하지 않는다.

이 문서는 구조 감사의 출발점이다. 실제 계약 불일치, 검사 범위의 공백, 유지보수 위험, 선택적인 구조 개선안이 함께 들어 있다. 실행은 **확인된 계약 불일치 수정 → 동작 차이 검증 → 제한된 변경 API → (필요할 때만) 그 경계에 맞춘 파일 이동** 순서를 따른다. 옛 W0–W8 선행 그래프는 쓰지 않는다.

**사용자가 지적한 문제 바로 찾기**

| 지적·질문 | 직접 대응하는 검토 항목 | 연관된 구체 원인 |
| --- | --- | --- |
| 하네스 관련 타입이 분산되어 있다 | [R12 하네스 개념·타입 소유권](#r12) | [R06 전달 계약](#r06), [R16 정의·catalog의 권위](#r16) |
| 정규화한 DB를 알림·훅에서도 사용하는가 | [R13 hook·알림의 canonical identity 연결](#r13) | [R16 catalog 갱신](#r16) |
| src/renderer가 너무 무겁다 | [R07 renderer 책임·기능 배치](#r07) | [R17 Project 연결](#r17), [R18 저장 스키마](#r18), [R22 조회 갱신](#r22) |
| integration·E2E 테스트를 찾기 어렵다 | [R14 테스트 분류·검사 범위·E2E 계약](#r14) | [R15 테스트와 Pack identity의 결합](#r15) |
| integrations는 무엇을 하는 영역인가 | [R11 외부 adapter·Pack 경계](#r11) | 제품 코드 영역이며 통합 테스트 전용 폴더가 아님; [R15](#r15)·[R16](#r16)에서 배포·정의 문제 추적 |

**종합 판단**

프로세스 수준의 경계(desktop / mahasd / execution-host, unmanaged PTY / managed execution)와 도메인 어휘는 상당히 명확하다. DDD가 전혀 없다는 평가는 부정확하다. 내부 소스는 도메인별로 독립적으로 이해하고 변경하기는 아직 어렵다.

필요한 작업은 폴더 종교가 아니라 **같은 상황에서 같은 정책이 적용되게 하는 것**이다. 현재 프로세스 구성을 유지하는 모듈형 모놀리스가 출발점이다. 이미 있는 분리(collection의 도메인 저장 함수, quota의 material/probe 포트, `shell/hydration.ts`, daemon cursor 구독)를 대체하지 말고 잇는다.

| 평가 축 | 현재 판단 | 핵심 근거 |
| --- | --- | --- |
| 프로세스·수명 경계 | 비교적 명확 | desktop / mahasd / execution-host, unmanaged PTY / managed execution 분리 |
| 기능 탐색성 | 큰 영역은 찾기 쉽지만 수정 지점 예측은 어려움 | 도메인·행동 단계·기술 계층이 혼합된 폴더 분류, 여러 의미의 index/client/types |
| 변경 응집도 | 핵심 실행·협업 흐름에서 부족 | 같은 실행 및 멤버 상태를 여러 모듈이 해석하고 직접 변경. 특히 dispatch 철회 내용이 경로마다 다름 |
| DDD | 도메인 모델링은 존재, 경계의 캡슐화는 부분적 | 풍부한 개념·명시적 불변식과 별개로 aggregate 변경 권한이 분산 |
| 계층 구조 | 포트는 있으나 적용이 불균일 | domain policy, SQL, operation handler, 외부 효과가 같은 모듈에 공존하는 파일이 있음. 작은 CRUD까지 폴더 수를 강제할 근거는 없음 |
| 복잡성 관리 | 일부 순수 로직 분리는 좋으나 조정 코드에 집중 | compiler, launch coordinator, member, basis observer, domain IPC, renderer store |

**항목 분류**

| 종류 | 항목 | 지금 할 일 |
| --- | --- | --- |
| 기능 연결 결함 | [R17](#r17) | workbench에 shell `uid()`를 domain `projectId`로 넣지 않는다. 미연결 → 선택/생성 → 탭에 연결 저장 |
| 계약 불일치 | [R12](#r12) · [R06](#r06) inspect/descriptor | 실제 반환값과 공유 DTO를 같게 두고, 중복 `HarnessResumeRecipe`를 한 정의로 모은다. 이름 정리와 분리해서 기록한다 |
| 경로 정확성 | [R19](#r19) | `MAHAS_CONFIG_DIR` → `XDG_CONFIG_HOME/mahas` → `~/.config/mahas`를 desktop·CLI·daemon 기본값이 같이 쓴다. Node 탐색은 한 구현, 최소 버전은 인자 |
| 제품 identity | [R15](#r15) · [R16](#r16) | digest에서 비실행 테스트·개발 문서를 빼고 제품 변경은 새 revision. `IMMUTABLE_REVISION`을 부팅이 삼키면 옛 snapshot이 남는다. projection `--check`를 build에 단다. 사용자 catalog 행은 upsert로 덮지 않는다 |
| 검사 공백 | [R14](#r14) | `integrations/**/*.ts`를 typecheck에 넣는다. 세 IMP `smoke.ts`는 수동 집합으로 기록만 한다. `tests/` 폴더 이동은 하지 않는다 |
| 의미 차이 (테스트 먼저) | [R03](#r03) · [R02](#r02) · [R07](#r07) 탭 닫기 | `revoke-dispatch`와 `fenceDispatch`의 갱신 내용 비교, 두 reconcile에 같은 host 증거, 일반 탭 vs 최소화된 탭의 detach. 폴더 이동으로 완료하지 않는다 |
| 조립/테스트 격리 | [R20](#r20) | 있는 `makeAccessKernel`을 instance로 주입한다. 운영 다중 runtime 장애를 재현한 것은 아니다 |
| 제목·범위 조정 | [R08](#r08) · [R09](#r09) · [R10](#r10) · [R18](#r18) · [R21](#r21) · [R22](#r22) | 기존 포트·hydration·cursor·boot-test를 활용한다. 전면 재작성 대상이 아니다 |
| 선택적 구조 | [R01](#r01) · [R04](#r04) · [R05](#r05) · [R11](#r11) · 폴더 트리 | 해당 코드를 제품 이유로 건드릴 때만 제자리 추출. 기본 잔여 과제가 아니다 |

<a id="work-plan"></a>

**실행 순서 (S0–S5)**

옛 W0–W8은 선행이 너무 넓었다. R17을 Pack·전체 operation 정리 뒤에 두지 않는다. 각 단계는 **공개 계약 추가 → 기존 구현 위임 → 소비자 전환 → 구 경로 제거**를 따르고, 광범위한 rename과 정책 변경을 한 PR에 섞지 않는다. 공개 API·변경 소유권 메모는 단계마다 같이 갱신한다 (전부 S5로 미루지 않는다).

| 단계 | 작업 | 대상 | 이 순서인 이유 |
| --- | --- | --- | --- |
| [S0](#s0) | 테스트 목록·검사 범위 확인, 기존 실패 기록 | [R14](#r14) | 회귀 판단 기준. 폴더 이동·공식 runner 편입은 하지 않는다 |
| [S1](#s1) | 확인된 계약·경로 불일치를 각각 작은 수정으로 | [R17](#r17) [R12](#r12) [R06](#r06) inspect/descriptor [R19](#r19) [R14](#r14) typecheck [R20](#r20) [R07](#r07) dock unbind | 구조 재편 없이 실제 불일치를 줄인다. 서로 선행이 아니다 |
| [S2](#s2) | Pack 배포 입력 분리와 projection drift 검사 | [R15](#r15) [R16](#r16) | 이후 정리로 제품 identity가 바뀌지 않게 한다. 사용자 catalog는 덮지 않는다 |
| [S3](#s3) | dispatch·reconcile 의미 비교 테스트 후 제한된 변경 API | [R02](#r02) [R03](#r03) | runtime을 옮기기 전에 소유권 원칙이 동작하는지 검증한다 |
| [S4](#s4) | persist 필드 목록, shell command, 좁은 E2E adapter | [R18](#r18) [R07](#r07) [R14](#r14) E2E | 파일 재배치 전에 저장 형식과 탭 수명 계약을 고정한다 |
| [S5](#s5) | (선택) 검증된 경계를 따른 이동, compatibility·문서 | 해당 영역을 건드릴 때 | 기본 잔여 과제가 아니다. 새 폴더 트리는 정답이 아니라 이 과정을 거친 뒤 고를 수 있는 배치안이다 |

S1 항목은 병렬로 작은 PR이 될 수 있다. 같은 store·registry·composition 파일을 여러 작업이 동시에 재편하도록 나누지 않는다.

<a id="s0"></a>

**S0. 검증 기준만 고정**

작업: runner 집합(기본 unit+pipeline, `--include-runtime` 중복 제거 목록, packs, renderer, 두 Electron 드라이버, 수동 IMP smoke 3개)을 문서화한다. `integrations/**/*.ts`가 typecheck 밖인 사실을 기록한다. 기존 실패는 별도 기록하고 삭제로 통과시키지 않는다.

하지 않는 것: `tests/integration`·`tests/e2e` 트리 이동, 세 IMP smoke를 공식 runner에 넣기, 새 테스트 프레임워크.

<a id="s1"></a>

**S1. 확인된 계약·경로 불일치**

서로 독립인 작은 수정이다.

1. **R17** — workbench context를 shell folder id로 시드하지 않는다. 미연결(`''`)을 허용하고 ContextBar로 domain Project id를 넣는다. 넣은 id는 widget 탭에 저장한다. renderer `string` 별칭만으로 IPC 혼용을 막았다고 보지 않는다.
2. **R12 / R06 inspect** — `harness.profile.inspect`의 공유 DTO를 runtime 실제 반환(평평한 요약)과 같게 둔다. `HarnessResumeRecipe`는 `resume-recipe.ts` 한곳. descriptor는 Pack projection 타입을 main/preload/renderer가 공유한다. 명명 정리(`AgentProviderInfo`, legacy `HarnessProfile`)는 계약 연결과 분리한다.
3. **R19** — config dir 해석 함수 하나. authClient·CLI·`startMahasd` 기본값이 XDG를 건너뛰지 않게 한다. Node 후보 목록은 한 구현, 최소 major는 인자(`>=24` vs 제한 없음).
4. **R14 typecheck** — `integrations/**/*.ts`를 정식 typecheck에 포함한다.
5. **R20** — `makeAccessKernel` instance를 composition이 주입한다. artifact 명세와 묶지 않는다.
6. **R07 dock** — 최소화된 탭을 dock에서 닫을 때도 LeafPane과 같이 exec unbind/detach를 수행한다. 일반 vs 최소화 닫기 비교는 S3/S4 테스트로 고정한다.

<a id="s2"></a>

**S2. Pack identity와 projection**

배포·등록 콘텐츠에서 conformance·개발 문서를 제외한다. 이미 등록된 revision은 덮지 않고 affected Pack은 새 revision으로 이행한다. 부팅이 `IMMUTABLE_REVISION`을 삼키고 옛 snapshot을 유지하는 경로를 명시적으로 다룬다. immutable 검사 자체는 유지한다.

`project.mjs --check`를 `npm run build`에 연결한다. catalog seed는 insert-only를 유지하고, 두 roster ID 집합의 대조는 검사로 둔다. Pack JSON을 seed가 읽게 만드는 일과 provenance/FK 정책은 사용자 정의 행이 필요할 때 한다.

<a id="s3"></a>

**S3. 의미 비교 테스트와 제한된 변경 API**

먼저 테스트:

- 동일한 host 증거를 lifecycle reconcile과 recovery reconcile에 넣었을 때 판정이 같은지, 다른 어휘로만 매핑되는지
- `teamRetire()`의 `revoke-dispatch`(authority만 `revoked`)와 `fenceDispatch()`(phase `revoked` + `current_dispatch_id` 해제)가 같은 의미인지 다른 의미인지
- 일반 탭 닫기와 최소화된 탭 닫기의 detach/unbind

그 다음에야 공개 변경 연산을 제한한다. 서비스 readiness와 실행 복구를 하나의 coordinator로 합치지 않는다. `modules/execution/{domain,application,adapters}`로 옮기지 않는다.

<a id="s4"></a>

**S4. desktop 저장·shell command·E2E**

persist 필드 목록을 `shell/hydration.ts` 쪽으로 모은다. 새 snapshot codec 계층을 만들지 않는다. pane/tab 전이는 store/shell command 하나. E2E는 private store 필드 대신 좁은 test adapter. `window.__mahas = useStore`를 거대한 공개 API로 키우지 않는다.

<a id="s5"></a>

**S5. 선택적 이동**

S1–S4에서 검증된 경계가 있는 영역을 제품 이유로 건드릴 때만 파일을 옮긴다. host 내부 분리, artifact 명세 모듈, 공유 read-model adapter, runtime 내부 public path 강제, renderer `features/` 일괄 이동은 기본 잔여 과제가 아니다.

한 일: 검증된 소유권을 [code-map](../development/code-map.md)·[domains](domains/README.md)·[contracts](contracts/README.md)에 적었고, `mahas-harness-config`에 `./runtime-pack`·`./session-locks` 공개 subpath를 선언했다. `modules/*/domain|application|adapters` 트리와 renderer `features/` 일괄 이동은 하지 않았다.

---

<a id="r01"></a>

**R01. 내부 모듈과 패키지 공개 경계를 검사가 충분히 표현하지 못한다**

실행: 선택 (S5). 공개 subpath 선언이 필요해진 패키지(현재 `mahas-harness-config`가 `runtime-pack.ts`를 직접 import)는 그 패키지를 만질 때 고친다.

[경계 정책](../../tools/boundary-policy.mjs)은 같은 패키지 내부 import를 전부 허용하고, 대상의 공개 subpath인지는 강제하지 않는다. 패키지 검사가 통과해도 도메인 내부 참조는 검출되지 않는다. 파일 단위 순환 import는 초안에서 없다고 했으나 이번 취합에서 SCC를 독립 재계산하지는 않았다.

주의: `inventory ↔ metering ↔ observation ↔ sessions`가 맞닿는 이유는 [R08](#r08) collection이 한 트랜잭션으로 커밋하기 때문이다. runtime 내부 DAG를 강제하면 그 원자성과 충돌한다. 순환 import 문제가 아니라는 초안의 한정은 유지한다.

<a id="r02"></a>

**R02. 실행이라는 도메인이 행동 단계별로 분산되어 있다**

실행: [S3](#s3).

생성·전이·복구·정지가 `launch`, `recovery`, `lifecycle`에 나뉜다. `ExecutionRow`는 [launch/rows.ts](../../packages/mahas-runtime/src/launch/rows.ts)(SQL, session 컬럼 없음), [lifecycle/types.ts](../../packages/mahas-runtime/src/lifecycle/types.ts)(SQL, session 컬럼 있음), [recovery/ports.ts](../../packages/mahas-runtime/src/recovery/ports.ts)(camelCase 도메인)로 모양이 다르다. 서로 다른 projection은 필요할 수 있다. 문제는 같은 상태를 **변경**하는 경로가 분산된 것이다.

[runtime.reconcile](../../packages/mahas-runtime/src/lifecycle/operations.ts)은 두 패스를 실행하고 리포트 어휘를 다시 매핑한다. 서비스 readiness와 실행 복구가 둘 다 필요한 것은 맞다. 하나의 거대한 coordinator로 합치지 않는다. 공통 전이·판정 API를 제자리에서 추출할지는 S3 비교 테스트 뒤에 정한다.

<a id="r03"></a>

**R03. aggregate의 변경 권한이 약하다**

실행: [S3](#s3). 강하게 타당. 추상적인 DDD 개선이 아니라 실제 갱신 내용의 차이다.

주요 함수는 `DatabaseSync` / `TxnContext`로 스키마 전체에 접근한다. 공유 SQLite와 한 트랜잭션으로 여러 변경을 묶는 것 자체는 문제가 아니다. “다른 모듈의 SQL을 모두 금지한다”가 목표가 아니다.

확인한 dispatch 경로:

| 경로 | dispatch에 대한 주요 변경 |
| --- | --- |
| [`teamRetire()`](../../packages/mahas-runtime/src/coordination/member.ts)의 `revoke-dispatch` | `authority_state='revoked'`, revision 증가, 이벤트 `dispatch.revoked`(revision `0`) |
| [`fenceDispatch()`](../../packages/mahas-runtime/src/coordination/dispatch-authority.ts) | 위 변경에 더해 `phase='revoked'`, `tasks.current_dispatch_id` 해제, 이벤트 `dispatch.fenced` |

두 동작이 반드시 같아야 한다거나 현재 버그라고 단정하지 않는다. 권한만 철회하는 것과 시도를 fencing하는 것은 의도적으로 다를 수 있다. 그 차이를 모델과 테스트로 고정한 뒤에 공개 변경 연산을 맞춘다.

Message INSERT가 member dispatch와 mail writer에 나뉜 것, ImpactCandidate의 초기 상태 `'open'` vs `'candidate'`도 같은 종류의 질문이다.

<a id="r04"></a>

**R04. 정책·유스케이스·입출력의 분리가 파일 내부에 머무른다**

실행: 해당 파일을 건드릴 때. `compileContextBundle` 같은 순수 함수가 이미 있으므로 추출하면 된다. 모든 모듈에 `domain/application/adapters` 폴더 수를 강제하지 않는다.

<a id="r05"></a>

**R05. 큰 파일의 문제는 길이가 아니라 서로 다른 변경 이유다**

종합 관찰이다. 독립 결함 수에 넣지 않는다. 줄 수 감소는 완료 기준이 아니다. 분리된 파일이 거대한 DB/context를 그대로 공유하면 개선이 아니다.

<a id="r06"></a>

**R06. 조립·IPC·operation의 공개 계약과 구현이 충분히 연결되지 않는다**

실행: inspect/descriptor는 [S1](#s1). 전체 typed operation registry와 desktop IPC map은 그 계약을 만질 때.

composition callback 안에 설치 revision 판정·진단 중복·SQL이 있는 것은 맞다. `OperationHandler`가 `unknown → unknown`인 것도 맞다. 우선순위는 타입 이름을 바꾸는 것이 아니라 **이미 깨진 wire를 생산자·소비자에 묶는 것**이다. 그 근거는 [R12](#r12) inspect 결과다. R06 전체를 S1의 선행으로 두지 않는다.

<a id="r07"></a>

**R07. 렌더러는 기능 중심과 기술 중심 분류가 혼합되어 있다**

실행: dock unbind는 [S1](#s1). shell command 중앙화는 [S4](#s4). `features/` 일괄 이동은 [S5](#s5) 선택.

usage/sessions는 `features/`에 있고 terminal/files view는 `components/`, 상태는 루트 `store.ts`다. [LeafPane.closeTab](../../src/renderer/src/components/LeafPane.tsx)은 exec unbind/detach 후 탭 배열을 줄인다. [PaneDock.closeTab](../../src/renderer/src/components/PaneDock.tsx)은 배열만 줄인다. 최소화된 managed execution 탭을 dock에서 닫으면 unbind가 빠질 수 있다. 중요한 것은 파일 위치가 아니라 **같은 shell 전이를 쓰는 것**이다.

91파일 / 21,785줄, `styles.css` 4,022줄은 규모 설명이다. 성능 진단이 아니다. 모든 비동기 흐름을 daemon으로 옮기지 않는다. 여러 Zustand store로 나누지 않는다.

<a id="r08"></a>

**R08. 관측 수집의 조정 책임이 observation 하위에 있다**

실행: collection을 만질 때. “분리가 전혀 없다”가 아니다. 이미 session·usage·quota 저장 함수를 호출한다. 조정자 소유권과 역참조를 정리하고, 원자적 커밋을 이벤트로 해체하지 않는다.

<a id="r09"></a>

**R09. auth 조립부와 credential adapter·quota application의 소유권을 정리해야 한다**

(이전 제목 “inventory/auth는 별도 애플리케이션에 가깝다”는 과장이다.)

실행: quota/auth를 만질 때. [domain.ts](../../packages/mahas-runtime/src/inventory/auth/domain.ts)는 의도적인 factory다. quota에는 이미 `CredentialMaterialSource`와 `QuotaProbePort`가 있다. 새 포트를 발명하지 말고 resolver 구현의 위치·의존을 정리한다.

<a id="r10"></a>

**R10. mahas-client로의 소비자 전환과 compatibility 정리가 미완료다**

(이전 제목 “정식 진입점이 불명확하다”는 과장이다.)

실행: CLI 연결을 만질 때. desktop `runtimeClient.ts`는 이미 `mahas-client`를 쓴다. CLI는 runtime RPC facade를 직접 import한다. bootstrap은 호환 재수출임을 이미 명시한다.

<a id="r11"></a>

**R11. execution-host와 Pack은 경계를 보존하고 내부 역할은 후순위로 명료화한다**

실행: 선택 (S5). host를 runtime execution에 흡수하지 않는다. lease·effect journal·birth identity를 보존하는 것이 폴더 분리보다 앞선다.

<a id="r12"></a>

**R12. 하네스 타입은 개념·소유자·표현 계층의 구분이 흐려져 있다**

실행: [S1](#s1). 강하게 타당. **명명 개선**과 **실제 계약 오류**를 분리한다.

| 구분 | 소스 근거 | 종류 |
| --- | --- | --- |
| 같은 이름, 다른 개념 | [harness-config의 HarnessProfile](../../packages/mahas-harness-config/src/index.ts)은 label/match/resume descriptor, [contracts의 HarnessProfile](../../packages/mahas-contracts/src/role.ts)은 실행 프로파일 | 명명. 개념은 유지하고 legacy 이름을 바꾸거나 격리 |
| 같은 의미, 중복 선언 | `HarnessResumeRecipe`가 [runtime-pack.ts](../../packages/mahas-harness-config/src/runtime-pack.ts)와 [resume-recipe.ts](../../packages/mahas-harness-config/src/resume-recipe.ts)에 각각 있음 | 계약. 한 정의로 모은다 |
| 같은 전달 데이터, 공유 계약 단절 | Pack `HarnessManifestEntry` → main 인라인 타입 → preload `{label,match}` → renderer `AgentDescriptor` | 계약. 같은 descriptor 타입을 공유 |
| 같은 operation 결과명, 다른 형상 | contracts `HarnessProfileInspectResult`는 `{ profile: HarnessProfile, ... }`, runtime은 `profileId/revision/recipeSummary/...` 평평한 요약. 등록부는 변환 없이 반환 | **실제 wire 오류.** 공유 DTO를 구현에 맞춘다 |
| 어휘 혼용 | UI `AgentProviderInfo` vs catalog `Provider` | 명명 |

catalog `Harness`, inventory `HarnessInstallation`, realization 실행 profile은 다른 개념이다. 한 타입으로 합치지 않는다. 완료 기준은 “한 파일에 모였다”가 아니다. 어느 화면이 지금 깨지는지는 inspect 호출 경로를 테스트로 고정해야 한다. workbench InspectorView는 현재 `harness.profile.inspect`를 호출하지 않는다.

<a id="r13"></a>

**R13. DB의 정규화된 식별이 실시간 hook 전달 계약까지 연결되지는 않는다**

실행: hook 전달을 만질 때. 장애와 구분한다.

ingest는 canonical session을 저장하지만 반환은 `{committed, recordKeys}`다. main은 저장 확인 후 원래 hook 이벤트를 투영한다. 정규화 DB를 안 쓰는 것이 아니라 **전달 계약이 확정 identity를 안 실어 준다.** 저장 후 전달 보장은 이미 있다. 알림 배치는 `MAHAS_TAB` 스탬프와 탭 기록으로 동작한다.

가장 작은 개선: ingest 결과에 원본 record와 canonical session/handle/attachment 대응을 추가하고 desktop이 이를 쓴다. 알림마다 DB를 다시 읽거나 pane/focus를 daemon으로 옮기지 않는다.

<a id="r14"></a>

**R14. 테스트의 발견·검사 범위와 E2E 계약의 소유권이 불명확하다**

실행: typecheck는 [S1](#s1), 목록은 [S0](#s0), E2E adapter는 [S4](#s4).

루트 `test/`·`tests/`·`e2e/`는 없다. `*.smoke.ts` 43개, basename `smoke.ts` 3개, 소스 `*.test.mjs` 3개, `*.manual.ts` 1개, 드라이버는 `tools/`다. `integrations/`는 제품 Pack이다. 통합·E2E가 없다는 판단은 부정확하다. `smoke`가 순수 로직부터 host 통합까지 덮어 파일명으로 범위를 예측하기 어렵다.

기본 `test:domain`은 unit+pipeline이다. `test:domain:full`은 중복 제거 목록이며 두 Electron 드라이버는 빠진다. `npm test`라는 이름이 없는 것 자체는 결함이 아니다.

[discovery/mail/maintenance/smoke.ts](../../packages/mahas-runtime/src/discovery/smoke.ts) 세 파일은 IMP 시대 수동 하네스(손 DDL)다. 공식 runner에 넣지 않는다. 상태를 기록만 한다.

`integrations/**/*.ts` 10개는 root typecheck·boundary 수집 밖이다. 여기에는 fixture-support와 Pack conformance가 들어 있다. “typecheck가 통과했다”에 이 트리를 포함시키지 못한다.

E2E는 `window.__mahas = useStore`를 직접 쓴다. 실제 Electron·PTY 자산은 있다. private store가 드라이버 API가 된 것이 문제다.

<a id="r15"></a>

**R15. 테스트를 고치면 제품 Pack의 identity까지 바뀐다**

실행: [S2](#s2). 강하게 타당.

[PackRegistry.sourceFiles](../../packages/mahas-runtime/src/integration/registry.ts)는 일반 파일을 재귀 수집하고 digest에 경로·내용 해시를 넣는다. 테스트·README 제외 규칙이 없다. 같은 revision에 다른 digest면 `IMMUTABLE_REVISION`. [electron-builder](../../electron-builder.yml)는 `integrations/packs` 전체를 복사한다.

잘못된 것은 immutable 검사가 아니다. 배포·등록 콘텐츠 집합이다. 기존 snapshot을 보존하고 새 revision으로 이행한다.

추가로: [composition-domains.ts](../../packages/mahas-runtime/src/composition-domains.ts)는 `registerDirectory` 실패를 로그하고 계속 가서 옛 snapshot을 유지한다. 테스트 주석만이 아니라 **같은 revision의 제품 파일 수정도 설치본에 안 반영될 수 있다.** 실제 daemon 수집 중단 여부를 이 코드만으로 단정하지 않는다. 초안의 `/tmp` digest 실험은 재실행하지 않았다.

<a id="r16"></a>

**R16. 하네스·provider 정의의 원본과 DB 갱신 경로가 분리되어 있다**

실행: `--check`와 roster 대조는 [S2](#s2). Pack→catalog 자동 동기화는 그 다음.

두 경로: Pack `harnesses.json` → `project.mjs` → `resources/agents/manifest.json`, 그리고 `BUILTIN_HARNESSES` → `seedBuiltinCatalog` (`ON CONFLICT DO NOTHING`). `catalog.harness.put`의 desktop/CLI 호출자는 없다. 확인한 시점에 두 roster ID는 같다. 현재 drift 사고라기보다 유지비다. 사용자 수정 행을 무조건 upsert하지 않는다. build는 projection `--check`를 호출하지 않는다.

<a id="r17"></a>

**R17. shell의 Project ID가 도메인 Project ID처럼 사용된다**

실행: [S1](#s1). 강하게 타당. 폴더 정리보다 먼저 다룰 기능 연결 문제다.

[addProject](../../src/renderer/src/store.ts)는 로컬 `uid()`로 Project를 만든다. [WidgetView](../../src/renderer/src/components/WidgetView.tsx)는 workspace `projectId`를 workbench에 그대로 넘긴다. [WorkbenchScopeProvider](../../src/renderer/src/workbench/scope.tsx) 주석도 입력을 “desktop project id”라고 하고 변환하지 않는다. [ResponsibilityView](../../src/renderer/src/workbench/ResponsibilityView.tsx)는 같은 값을 검색 `projectId`에 넣는다. daemon [resolveModelVersion](../../packages/mahas-runtime/src/discovery/model-read.ts)은 `projects` 테이블을 조회하고 없으면 `SCOPE_DENIED`다. 검색 버튼은 `!projectId`이면 비활성화되어 있으므로, 시드를 끊으면 미연결 상태가 이미 UI에 있다.

첫 수정에 desktop application 계층을 만들지 않는다. 흐름은 **미연결 → ContextBar에 domain Project id → widget 탭에 저장**이다. 경로 자동 연결·branded `string` 별칭은 이 버그의 전제가 아니다. IPC를 지나면 브랜드는 사라진다.

<a id="r18"></a>

**R18. desktop 저장·복원·종료 처리의 스키마 계약이 분산돼 있다**

(이전 제목 “소유자가 없다”는 과장이다.)

실행: [S4](#s4). [shell/hydration.ts](../../src/renderer/src/shell/hydration.ts)가 이미 버전 decode·legacy pane 정규화·resume 가지치기를 소유한다. 남은 분산은 [App.snapshot](../../src/renderer/src/App.tsx) 필드 목록, `store.hydrate` 기본값, [withShutdownEvidence](../../src/main/state/persistence.ts)의 `resumeSessions` 해석이다. 새 codec 계층을 만들지 않는다. main-window 단일 writer와 `saveSync` fence는 보존한다.

<a id="r19"></a>

**R19. 환경·연결 정책의 분산은 실제 경로 불일치다**

실행: [S1](#s1). 강하게 타당. DRY가 아니라 profile 선택 정확성이다.

[eventsFile](../../src/main/eventsFile.ts)·[runtimeClient](../../src/main/runtimeClient.ts)는 `MAHAS_CONFIG_DIR` → `XDG_CONFIG_HOME/mahas` → `~/.config/mahas`. [authClient](../../src/main/runtime/authClient.ts)·[CLI defaultConfigDir](../../packages/mahas-cli/src/connection.ts)·[startMahasd](../../packages/mahas-runtime/src/main.ts) 기본값은 XDG를 건너뛴다. desktop spawn은 `MAHAS_CONFIG_DIR`를 넘기므로 일상 경로는 버티지만, XDG만 지정한 환경과 `npm run mahasd`/CLI 기본값은 다른 profile을 가리킬 수 있다.

[PTY Node 탐색](../../src/main/pty.ts)과 [serviceBootstrap](../../src/main/runtime/serviceBootstrap.ts)(Node ≥24)의 후보 목록도 다르다. 한 구현에 모으고 최소 버전은 인자로 둔다. platform 패키지를 만들지 않는다.

<a id="r20"></a>

**R20. runtime context 뒤에 전역 인증 DB가 있다**

실행: [S1](#s1). `makeAccessKernel`은 이미 instance API다. `bindAccessDb`가 process-wide `boundKernel`을 덮어쓰고 composition이 호출한다. `startMahasd`는 같은 DB의 두 번째 writer를 거절하므로 운영 다중 runtime 사고는 재현하지 않았다. 주입과 artifact 명세를 묶지 않는다.

<a id="r21"></a>

**R21. 빌드·실행·패키징 경로의 대조를 강화한다**

실행: 패키징/서비스 경로를 만질 때. Vite build가 이미 `build-services`를 호출하고 boot-test가 있다. “빌드 기반이 없다”가 아니다. 공유 artifact 명세 모듈은 기본 잔여 과제가 아니다.

<a id="r22"></a>

**R22. client가 daemon cursor 계약을 아직 잇지 않았다**

실행: 화면 갱신을 만질 때. daemon `SubscribeResult`는 cursor/events를 주고 desktop은 push를 정직하게 거절한다. 데이터가 유실됐다는 뜻이 아니다. 기존 계약을 잇는 polling adapter면 되고 서버 구독 체계를 재작성하지 않는다.

**탐색 지도**

[코드 지도](../development/code-map.md)와 [도메인 목록](domains/README.md)에 변경 소유자를 단계마다 보강한다. 적용된 migration 식별자는 정리 목적으로 바꾸지 않는다.

**선택 배치안 (S5 이후, 정답이 아님)**

```text
packages/mahas-runtime/src/
  boot/
  modules/execution/{public.ts, domain, application, adapters}
  ...
src/renderer/src/
  app/ shell/ features/ shared/ui/ platform/
```

실제 이름과 디렉터리는 소유권을 검증한 뒤에만 옮긴다. 모든 폴더를 npm 패키지나 bounded context로 승격하지 않는다. DB는 하나로 유지해도 된다.

**이행 과정에서 보존할 불변식**

- desktop·mahasd·execution-host의 수명과 권위. unmanaged shell은 `pty:*`, managed execution은 `exec:*`. UI close는 detach.
- pane은 kind-tagged block의 stack. 프로그램적 open은 stack, `soleLeafSplit` 예외. 마지막 tab 닫기는 leaf를 닫는다.
- 안정적인 pane mount/portal, 숨긴·최소화한 tab의 mount, preview/dirty 파일 탭. PTY 수명은 정확한 session을 소유한 tab record.
- desktop 저장은 main window 단일 writer, 직렬·원자적 I/O, `saveSync` stale-write fence.
- hook은 durable ingest 확인 후 renderer에 전달. source record·cursor·batch 원자성과 중복 제거.
- unknown은 null/unknown, coverage를 전달. SQLite 단일 writer와 필요한 cross-module transaction.
- Pack immutable revision·snapshot, host effect journal·lease·birth identity. 적용된 DB migration을 정리 목적으로 수정하지 않는다.

**조사 한계**

소스 대조로 Project 전달, inspect 생산자·계약, dispatch 변경 내용, config 경로, Pack 해시·패키징, 테스트 runner, 경계 수집, collection/auth 포트, renderer 저장·탭 처리, 구독 거절을 확인했다.

초안의 파일·줄 수, `.prepare()` 파일 수, import SCC, TypeScript program 8개의 포함 여부는 취합 검토에서 전부 재실행하지 않았다. 검사 도구가 무엇을 열거하는지는 확인했다. `typecheck`·domain full·미등록 smoke 3개·Electron E2E·패키징·digest 실험을 이번 취합에서 실행하지는 않았다. 지적한 위험이 운영 장애로 재현됐다는 결론이 아니다.
