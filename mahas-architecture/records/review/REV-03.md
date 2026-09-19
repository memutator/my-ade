# ReviewRecord — REV-03

- reviewTaskId: REV-03
- codeRevision: 8f6959457a8fc965c110dea79d533e53cf07326c
- specRevision: 99eb5f5
- scope: RoleInterface/RoleImplementation 저작·coverage (IMP-07), ContextBundle compiler (IMP-08), materialize/inspect (IMP-09), WorkEnvelope (IMP-14), LaunchPlan/start attachment (IMP-19), join/initial text (IMP-20), Claude/Codex native lowering (IMP-24/25), inspector projections (IMP-32). 대조 계약: REQ-05/06/07/08/21/22, D-ROLE, S-INJECTION, C-REALIZATION, C-LAUNCH. `packages/mahas-runtime/src/realization/*`, `coordination/{work-envelope,task-spec}.ts`, `launch/{planner,start-coordinator,initial-directives,initial-attachment,join}.ts`, `packages/mahas-harness-config/src/**`, `inspector/{ops,views,protocol}.ts`, `packages/mahas-contracts/src/role.ts`.
- disposition: changes-required

Verified aligned (optional).

- 네 객체 분리: `RoleInterface` / `RoleImplementation` / `ContextBundle` / `LaunchPlan` 타입이 합쳐지지 않는다 (`role.ts:3-7`, `work.ts:15-16`).
- `evaluateCoverage`는 IMP-07 어휘(`requiredLoadPhase: initial`)에서 conditional-only 필수 clause를 `uncoveredClauses`로 올려 publish가 `MANDATORY_COMPONENT_MISSING`으로 거절한다 (`component-graph.ts:351-372`, `publisher.ts:348-356`).
- reexpressed clause가 원본 context path를 다시 주입하면 compiler `validateCoverage`가 거절한다 (`coverage.ts:212-234`). `maintenanceBasis`는 mandatory.md 본문에 붙지 않는다 (`compiler.ts:876-908`).
- WorkEnvelope는 bundle과 별도 blob/digest로 고정되고, `buildInitialText`는 요구사항 본문을 경로 지시가 아니라 본문으로 넣는다 (`work-envelope.ts:17-20,214-237`, `initial-directives.ts:171-204`).
- `execution.join`은 bootstrap credential·digest pin만 검사하고 이해 증명으로 부르지 않는다 (`join.ts:7-19,85-104,141-146`).
- native-resume은 같은 implementation/interface/bundle pin을 요구하고, 역할 변경은 `fresh`만 허용하며 `nativeHandle`을 거절한다 (`recovery/resume.ts:271-317,466-516`).
- profile `verified`는 documentation-only evidence로 승격되지 않는다 (`profile-registry.ts:10-12,513-523`). helper subagent는 `permissionRequirements`를 선언하지 못한다 (`component-graph.ts:116-125`).
- `context.inspect`는 planned ≠ attached, provider hidden prompt는 항상 unknown이다 (`effective-context.ts:8-12,237-242`). Claude/Codex recipe 모듈 자체는 argv 배열, NUL/한도 거절, Codex required-skill catalog 거절, `--append-system-prompt-file` / `developer_instructions` 경로를 문서와 맞춰 구현한다 — 다만 runtime이 이 모듈을 호출하지 않는다 (Finding 5).

## Findings

**1. [implementation] RoleInterface가 의미 계약이 아니라 clause-id flags 목록이다**

- Location: `packages/mahas-runtime/src/realization/interfaces.ts:29-49,150-155,194-223,249-267`
- Contract: REQ-05/06; D-ROLE §1–2 (`RoleInterface` = role + 필요한 context의 의미 계약; `ContextRequirement.requiredMeaning` / `readerPerspective`); C-REALIZATION `interface.get` (context requirements, digest). IMP-07 §4.1.
- Evidence: `deriveInterface`는 `rdd_criteria.criterion`/`description`과 bound context 본문을 읽은 뒤 clauseId만 남기고 `requiredMeaning`을 리터럴 `'required'`, `readerPerspective`를 `'performer'`, `deliveryClass`를 전부 `'initial'`로 고정한다. criterion 문구는 `maintenanceRefs`의 id로만 남고 `toRoleInterface`의 `scopeOfJudgment`는 `role.description` 한 줄이다. 구현 작성자가 coverage로 재표현해야 할 의미가 인터페이스에 없다.
- Consequence: RoleImplementation은 무엇을 성립시켜야 하는지 모른 채 component/flag만 채우게 된다. 링크 존재(coverageBinding)가 의미 충족을 대체하는 구조가 된다. 팀장·담당자 해상도(Finding 2)의 입력이 비어 있다.
- Requested correction: RDD criterion 문구·책임 진술·bound context의 required meaning을 `requiredMeaning`에 역할 문법으로 담고, `readerPerspective`/`deliveryClass`를 역할별로 구분할 수 있게 두라. 리터럴 `'required'`는 의미 계약이 아니다.
- Target: IMP-07

**2. [implementation] 같은 관심사의 팀장 해상도(가치·긴장)를 공식 경로로 저작·조회할 수 없다**

- Location: `packages/mahas-runtime/src/realization/interfaces.ts:34-38,202,214`; `packages/mahas-runtime/src/discovery/inspect.ts:7-13,40-41,113-148`; `packages/mahas-runtime/src/discovery/smoke.ts:192-210`; `packages/mahas-runtime/src/inspector/views.ts:153-209`
- Contract: REQ-06; D-ROLE §3 (상위에는 가치·긴장, 하위에는 구체 제약; 컴파일러가 원문을 필터/요약하지 않음; 역할 구현 작성자가 재표현); `responsibility.inspect` coordination view는 authored `readerPerspective`만 읽고 즉석 요약하지 않음.
- Evidence: discovery는 `readerPerspective ∈ {coordination, coordinator, parent, 팀장}`인 clause만 팀장 뷰로 채택하고, 없으면 `status: 'missing'`을 정직히 반환한다. 그러나 `interface.get` → `deriveInterface`는 그 값을 절대 쓰지 않는다. coordination clause를 추가하는 API도 없다. smoke는 `interface.get`을 우회해 `requirements_json`에 팀장/owner 문구를 직접 INSERT한다. inspector `coverageRows`는 `requiredMeaning`을 그대로 보여 주므로 실데이터에서는 `'required'`만 보인다. 저장소에 공식 경로로 저작된 역할 구현 본문은 없다.
- Consequence: 팀장은 하위 구현 원문 없이 가치·긴장을 조율할 표현을 받지 못하고, 담당자 구현 작성자는 자기 문법의 제약으로 재표현할 원 의미를 인터페이스에서 읽지 못한다. REQ-06의 “선택만이 아니라 의미를 재표현”이 성립하지 않는다.
- Requested correction: 하위 역할 interface에 팀장용 `readerPerspective` clause(가치·긴장·제약)를 도출하거나, 구현 작성자가 그 해상도를 인터페이스에 남기는 명시 연산을 제공하라. discovery smoke의 손 INSERT를 정규 경로로 대체하라.
- Target: IMP-07

**3. [implementation] IMP-07이 저장하는 component/coverage 형태를 IMP-08 compiler가 읽지 못한다**

- Location: `packages/mahas-runtime/src/realization/component-graph.ts:48,54-60,143-161,175-182,434-442`; `implementation-repository.ts:305-311`; `compiler.ts:325-363,336-337`; `coverage.ts:37,127-136`
- Contract: C-REALIZATION 빌드 함수 (`build(interfaceDigest, implementationRevision, …)`는 저장된 구현 revision을 읽는다); `packages/mahas-contracts/src/role.ts:165-175` (`ImplementationComponent.activation: string`, `binding: ComponentBinding`); S-INJECTION §2 (compiler는 작성된 구현을 하네스 파일로 낮춘다).
- Evidence: prepare는 `activation`을 `{phase, route}` JSON으로 저장하고 (`JSON.stringify(c.activation)`), coverage `requiredLoadPhase`를 `'initial'|'conditional'`로 제한하며, 본문은 `contentBinding`/`config`에 둔다. compiler `componentNode`는 `activation`이 정확히 `'initial'|'conditional'` 문자열이어야 하고, `binding.sections[]`의 `text`/`source`만 본문으로 인정하며, `requiredLoadPhase`는 `'inline'|'preload'|'catalog'`만 허용한다. 계약 타입의 `activation: string`과도 prepare 쪽이 어긋난다.
- Consequence: `implementation.publish`가 통과한 revision이 `context.build`에서 `MODEL_INVALID`(unknown activation / missing sections / unknown requiredLoadPhase)로 죽는다. 저작된 instruction 본문은 `contentBinding`에 남아 mandatory.md로 내려가지 않는다. 필수 의미 전달(REQ-07)과 재표현 주입(REQ-06)이 빌드에서 끊긴다.
- Requested correction: 저장 DTO와 compiler 입력 DTO를 하나로 고정하라. activation·load-phase 어휘(initial 전달 = inline|preload, conditional = catalog)와 본문 위치(`contentBinding` vs `sections`)를 한쪽으로 정규화하고 양쪽에서 거절하라.
- Target: IMP-08

**4. [implementation] compiler ContextBundle manifest와 materializer parser의 필드가 서로 다른 계약이다**

- Location: `packages/mahas-runtime/src/realization/bundle-store.ts:133-167`; `compiler.ts:916-965`; `component-store.ts:44-72,146-215`; `materializer.ts:200-201,267-277`
- Contract: S-INJECTION §3 (manifest = component digest, clause coverage, load route; `role/mandatory.md` + `role/components/`); IMP-09 §4.1 (compiled components를 digest 검증 후 publish).
- Evidence: compiler가 쓰는 `ComponentManifestEntry`는 `installPath`, `blobDigest`, `loadRoutes`, `covers`이다. materializer `parseBundleManifest`는 각 component에 `digest`와 `path`를 필수이고 `loadPhase`/`route`/`scope`를 읽는다. `requiredText` 쪽은 digest만 맞아 기본 경로 `role/mandatory.md`로 갈 수 있으나, 구성품 배열은 첫 component에서 `missing digest`/`missing path`로 거절된다.
- Consequence: `context.build`가 성공해도 `materializeBundle`이 구성품을 설치하지 못한다. skill/subagent/tool 파일이 실행 루트에 없고, InjectionReceipt의 actualPath를 만들 수 없다.
- Requested correction: bundle manifest 스키마를 한 곳으로 두고 compiler 출력 = materializer 입력으로 고정하라 (`path`/`digest` 또는 `installPath`/`blobDigest` 중 하나, load route 필드명 통일).
- Target: IMP-09

**5. [implementation] instruction/skill/subagent/tool이 하네스 native loading point에 연결되지 않는다**

- Location: `packages/mahas-harness-config/src/claude/{components,recipe,profile}.ts`; `packages/mahas-harness-config/src/codex/{components,recipe}.ts`; `packages/mahas-runtime/src/launch/planner.ts:547-586,691-703`; `packages/mahas-runtime/src/launch/initial-attachment.ts:145-154`; `packages/mahas-runtime/src/realization/profile-registry.ts:58-64,236-242`; `packages/mahas-runtime/src/realization/compiler.ts:476-488,827-853`; `packages/mahas-runtime/src/composition.ts` (mahas-harness-config import 없음)
- Contract: REQ-07/08; S-INJECTION §4–6 (Claude `--append-system-prompt-file` + plugin skill/agent; Codex `developer_instructions` + checkout `.agents/skills`; compiler가 필수 skill을 optional catalog로 조용히 바꾸지 않음); C-LAUNCH worker.prepare (`INJECTION_UNSUPPORTED`).
- Evidence: (a) `mahas-runtime`은 `mahas-harness-config`를 import하지 않는다. `planComponents` / `buildClaudeLaunch` / `planCodexComponents` / `buildCodexLaunchSpec`의 호출자는 패키지 내부뿐이다. (b) `harness.profile.register`가 저장하는 `recipe_json`은 `{recipeVersion, injection, resume, wake, settingsPolicy}`이다. planner는 `recipe.process.executable`(절대 경로)와 `recipe.process.argv`(slot template)를 요구해, 등록된 Claude/Codex draft로는 즉시 `INJECTION_UNSUPPORTED`다. (c) planner는 `capabilities.components`를 읽지만 registry는 `supportedComponents`를 쓴다 — 빈 목록이 되어 kind 검사가 꺼진다 (`supportedComponentKinds.length > 0` 가드). (d) compiler 기본 설치 경로는 `role/components/skills/<id>/SKILL.md`, `role/components/agents/<id>.md`이고 checkout `scope`가 없다. Claude는 `role/components/claude-plugin/{skills,agents}` + `plugin.json`, Codex는 checkout `.agents/skills/<name>/SKILL.md`를 읽는다. (e) Claude/Codex planner와 launch `planRoutes`는 `activation === 'required'|'mandatory'`만 필수 skill로 본다. IMP-07이 저장하는 값은 `{phase:'initial'|'conditional'}`이므로 필수 skill catalog 거절이 실행 경로에서 동작하지 않는다. Codex 모듈의 required-skill 거절은 호출되지 않으면 효과가 없다.
- Consequence: 구성품이 파일로만 생기고, 첫 모델 입력의 검증된 flag/config/preload에 붙지 않는다. 필수 skill이 optional catalog로 침묵 강등되거나(검사 우회), 아예 launch가 recipe 스키마 불일치로 막힌다. native helper 정의 파일이 생겨도 primary preload 확인이 runtime에 없다. REQ-07의 “경로 등록만으로 전달 완료 선언 금지”를 launch가 지키려면 이 연결이 필요하다.
- Requested correction: 승인된 profile recipe를 `process.argv` slot + `routes[]`(source=`role/mandatory.md`/`task/initial.txt`)로 저장하고, launch가 harness-config planner/recipe를 호출하게 하라. 필수 skill은 inline 또는 confirmed preload만 coverage·recipe가 같은 어휘로 강제하라. Claude plugin layout / Codex checkout skill 경로는 compiler/materializer `scope`와 일치시켜라.
- Target: IMP-19

**6. [implementation] 이번 WorkEnvelope·source snapshot pin이 context.build/materialize에 전달되지 않아 첫 실행 본문이 빠진다**

- Location: `packages/mahas-runtime/src/launch/planner.ts:482-490`; `packages/mahas-runtime/src/realization/compiler.ts:207-214`; `packages/mahas-runtime/src/launch/deps.ts:54-63`; `packages/mahas-runtime/src/launch/start-coordinator.ts:814-880`; `packages/mahas-runtime/src/composition.ts:374-394`; `packages/mahas-runtime/src/realization/materializer.ts:93-99,263-277`
- Contract: REQ-07; S-INJECTION §3–4 (`task/initial.txt` = 이번 요구사항 본문; materialized ≠ path-only); C-LAUNCH worker.prepare/start; C-REALIZATION `context.build` `sourceSnapshotPins`.
- Evidence: planner는 `sourceSnapshotPins`로 `{assignmentId, assignmentRevision}` 객체를 넘긴다. compiler는 path/digest 배열만 받아 비배열이면 `MODEL_INVALID`다. Finding 3과 겹치면 `context.build`는 prepare에서 성공하지 못한다. 설령 bundle이 있어도 start의 `MaterializeRequest`에는 envelope/initialText가 없고, composition adapter는 `executionId`/`bundleDigest`/`workspaceId`만 `materializeBundle`에 넘기며 `envelope`, `connection`/`secretFiles`, `wantBytes`, `checkoutPath`를 버린다. materializer는 envelope가 없으면 `task/initial.txt`를 쓰지 않는다.
- Consequence: 역할 본문과 이번 요구사항이 첫 argv/stdin에 실리지 않는다. join/accept 지시(`initial-directives.ts`)는 생성기만 있고 실행 파일에 안 붙는다. source snapshot과 현재 저작 정본을 섞는 대신, snapshot pin 자체가 잘못된 객체라 관측이 거부된다.
- Requested correction: prepare는 구현이 참조하는 파일의 `{path, digest}[]`를 pin하라. start/composition은 `buildInitialText` 결과와 envelope digest를 materializer `envelope`로 넘기고, connection 파일과 text-route bytes(`wantBytes`)를 유지하라.
- Target: IMP-19

**7. [implementation] 실행 디렉터리 manifest에 maintenanceBasis가 실려 부모 유지 근거가 자식 context로 노출된다**

- Location: `packages/mahas-runtime/src/realization/compiler.ts:961-963,933-965`; `packages/mahas-runtime/src/realization/component-store.ts:393-394`; `packages/mahas-runtime/src/realization/compiler.ts:889-896`
- Contract: REQ-21/22; D-ROLE §5 (“maintenanceBasis를 주입 목록으로 사용하지 않는다”); `role.ts:177-180` (maintenance lookup ≠ 자식 runtime 주입); IMP-08 §4.3 (trace only).
- Evidence: compiler는 `maintenanceBasis`를 bundle `manifest`에 넣고, materializer는 `manifestRaw`를 `role/manifest.json`으로 실행 루트에 쓴다. worker가 읽을 수 있는 파일이다. `context.inspect`는 `detail==='maintenance'`일 때만 source observations를 주지만, 실행 파일 쪽 제한은 없다. 추가로 compiler는 coverage에 묶이지 않은 initial instruction section 전체를 mandatory.md에 넣는다 — 스키마가 맞춰진 뒤 부모 원문을 instruction component에 넣으면 재표현 여부와 무관하게 주입된다.
- Consequence: 자식 실행이 부모 유지 근거(basisRef)를 재사용 context처럼 읽고, 역할 해상도와 무관한 상위 장문이 필수 본문에 붙을 수 있다.
- Requested correction: `maintenanceBasis`는 inspector/maintenance 조회에만 두고 실행 `role/manifest.json`에서 빼라. mandatory 본문은 coverage가 `inline`으로 묶은 section만 넣고, 나머지 initial instruction dump를 제거하라.
- Target: IMP-08

**8. [implementation] IMP-32 inspector는 재표현 편집 화면이 없고, coverage 표시가 첫 binding·IMP-07 load-phase만 본다**

- Location: `packages/mahas-runtime/src/inspector/{ops,protocol,views}.ts`; `views.ts:159-163,185-192`; desktop/workbench inspector UI 부재 (coverageRows 소비처 없음)
- Contract: REQ-05/06/07/13; IMP-32 §4.1–4.4 (clause↔component/section 편집, raw vs 재표현 구별, conditional-only 누락을 감추지 않음, planned/materialized/attached/worker_joined를 나란히, 요약 슬라이더 금지).
- Evidence: 산출물은 op allowlist·envelope 타입·순수 projection뿐이다. `coverageRows`는 clause당 첫 binding만 취하고, `requiredLoadPhase !== 'initial'`이면 conditional-only로 표시한다. compiler 어휘(`inline`/`preload`)가 오면 초기 전달도 conditional-only로 오인된다. `realization` 필드는 보여 주지만 편집·저장 경로가 없고, Finding 1 때문에 화면에 나올 의미 문구가 `'required'`다.
- Consequence: 역할 구성 담당자가 raw context 선택과 재표현을 구별해 고칠 수 없다. inspector가 “주입 완료”를 단정하지 않는 정직함(views.ts:13, 333-336)은 유지되지만, REQ-06의 해상도 작업을 수행할 도구가 없다.
- Requested correction: clause 의미 문구와 component section을 연결하는 편집 화면을 두고, 모든 binding·load route(inline/preload/catalog)와 planned vs receipt를 보여 주라. 기계 coverage를 의미 승인으로 표시하지 말라.
- Target: IMP-32

## Limitations

- 정적 코드 대조만 수행했다. 빌드·테스트·실제 하네스 실행은 하지 않았으므로 Finding 3–6의 실패 모드는 코드 경로 추론이며 관측된 crash가 아니다.
- 공식 `interface.get`/`implementation.prepare` 경로로 저작된 역할 구현 본문이 저장소에 없어, 팀장 vs 담당자 지침의 문장 품질(가치·긴장 vs 구체 제약)은 판단하지 못했다. Finding 1–2는 그 저작이 입력 의미 없이 진행되도록 닫힌 경로라는 점에 한정한다.
- IMP-24/25 recipe 모듈의 Claude/Codex CLI 플래그 적합성은 공개 문서 대조이며, 설치 버전 검증(VER-09/10)이 아니다.
- `worker.resume`의 역할 변경 거절은 recovery 코드에서 확인했다. start-coordinator가 native `--resume` argv를 쓰는지(대화에 새 mandatory를 덮어쓰는지)는 recipe가 launch에 연결되지 않아 실행 경로로 확인하지 못했다.
- desktop UI·권한 부여 화면·RDD 모델 편집기는 REV-03 범위에서 깊게 보지 않았다. IMP-32는 runtime inspector 모듈까지만 읽었다.
