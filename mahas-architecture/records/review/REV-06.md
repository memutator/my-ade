# ReviewRecord — REV-06

- reviewTaskId: REV-06
- codeRevision: 8f6959457a8fc965c110dea79d533e53cf07326c
- specRevision: 99eb5f5
- scope: Independent protocol review of IMP-02/11/12/17/24/25/30 — public 77 + C-HOST 15 operation registry/handler/exposure (`packages/mahas-contracts/src/ops.ts`, `packages/mahas-runtime/src/api/{registry,admission,surface}.ts`, `composition.ts`), CLI/RPC/UI command surfaces (`packages/mahas-cli`, `packages/mahas-runtime/src/rpc/*`, `src/renderer/src/workbench/*`, `src/main/runtimeClient.ts`), execution-host C-HOST namespace (`packages/mahas-execution-host`), and harness-config vs launch/profile/materializer boundaries (`packages/mahas-harness-config`, `realization/profile-registry.ts`, `launch/{planner,initial-attachment,start-coordinator}.ts`) against REQ-08/09/14/25/28, S-COMMON, S-OPERATIONS, C-ACCESS, C-HOST, S-INJECTION.
- disposition: changes-required

Verified aligned (no findings): C-HOST 15개는 worker-facing `OperationRegistry`에 등록되지 않는다 — `HOST_OPERATION_NAMES`는 contracts에서 별도 namespace (`ops.ts:89-110`)이고 `composition.ts`는 host 클라이언트를 `host.hello`/`host.acquire`로만 붙인다. 실행면은 `execution-host`의 자체 테이블이 `host.hello`/`acquire`/`inventory`/`effect.get` (`host.ts:501-665`)과 `host.process.*`/`host.terminal.*` (`process-manager.ts:660-688`)과 `host.workspace.*` (`workspaces/mod.ts:21-28`)를 받는다. worker registry에서 빠진 공개 연산 `worker.release` (`recovery/index.ts:9-11`), `observation.ingest` (`observation/index.ts:8-11,73-86`), `task.report`/`outcome.decide`/`execution.wake`(등록부 없음)는 handler가 없으므로 `surface.ts:72`와 `admission.ts:180-184`가 사용 surface에서 빼고 `UNAVAILABLE_OPERATION`으로 통일한다 — IMP-11 §4.5와 맞다. CLI는 정적 업무 사전 없이 `surface.describe`로 verb를 만들고 (`main.ts:8-9,406-414`, `dynamic-help.ts:1-7`), worker 모드에서 operator 파일로 fallback하지 않는다 (`connection.ts:57-62`). 동일 `connectRpc`가 CLI와 desktop `exec:op`를 태운다 (`runtimeClient.ts:70,289`). mutation은 새 `operationId`를 자동 재전송하지 않는다 (`command-client.ts:5-13,83`; `rpc/client.ts:7-10`). 모델/access/mail/task 계층은 `mahas-harness-config`를 import하지 않으며 provider turn/App Server 타입도 없다. `harness.profile.register`는 항상 `draft` (`profile-registry.ts:252`)이고 `purpose=work`는 `state==='verified'`만 통과한다 (`planner.ts:390-396`). eslint `no-restricted-imports`는 packages/README 의존 방향을 막는다. host spawn은 `child_process.spawn`/`pty.spawn`에 argv 배열만 넘기고 `shell: true`가 없다 (`pty-manager.ts:111-118,143-151`).

공개 77 vs 등록 분류 (S-OPERATIONS 77 + C-HOST 15 = 92; `OPERATION_TABLE` 92행, contracts `OPERATION_NAMES`는 C-HOST 제외 77):

| class | count | 상태 |
| --- | --- | --- |
| public, handler 등록 | 71 | composition + `registerRuntimeOps` (`main.ts:339`) |
| public, stub handler (`assignment.show`) | 1 | surface에 올라감 — Finding 4 |
| public, 미등록 | 5 | `worker.release`, `observation.ingest`, `task.report`, `outcome.decide`, `execution.wake` — 비노출 정합 |
| C-HOST service-only | 15 | execution-host only, worker registry 제외 — 정합 |
| spec 밖 internal service ops | 16 | `DISPATCH_OPS` (`dispatch-ops.ts:67-84`) — worker registry에 `visibility:'service'`로 등록, operator seed grant에는 이름 없음 |

## Findings

**1. [implementation] mahasd는 worker/operator endpoint를 분리하지 않고, hello credential을 검증하지 않은 채 모든 연결을 `operator-local`로 만든다**

- Location: `packages/mahas-runtime/src/main.ts:353-378` (기본 `authenticate`가 `credential.principalId ?? 'operator-local'`; `serveRpc` 한 번, `mahasd.sock`만 bind); `rpc/endpoints.ts:14-24` (`mahasdWorkerEndpoint` → `mahasd-worker.sock` 정의만); `rpc/local-server.ts:310-314` (주석은 “두 소켓, fallback 없음”); `launch/bootstrap-credential.ts:57-58,160-187` (`authenticateWorkerCredential` / `isBootstrapOperationAllowed`는 RPC에서 호출되지 않음); `composition.ts:148-171` (operator grant `actions_json` = registry `OPERATION_NAMES` 92개, C-HOST 포함).
- Contract: C-ACCESS “worker와 operator의 endpoint/credential 경로를 분리하고 worker mode에 fallback-admin 경로를 두지 않는다”; S-ARCH §6; IMP-12 §4.1; REQ-09 (raw RPC도 현재 grant·실행·실제 대상으로 검사 — 전제는 서버가 credential에서 context를 구성, S-COMMON §2).
- Evidence: `mahasdWorkerEndpoint`를 bind하는 `serveRpc` 호출은 저장소에 없다. Worker hello `{kind:'worker', credentialId, secret}`에는 `principalId`가 없으므로 기본 authenticator가 항상 `operator-local`을 찍는다. `authenticateWorkerCredential`은 launch 모듈에만 있고 `main.ts`/`rpc/*`가 연결하지 않는다. 그 결과 bootstrap 제한(`BOOTSTRAP_OPERATIONS`, `authorize.ts:67-72,556-561`)은 `executionId`가 context에 없을 때 적용되지 않는다.
- Consequence: 같은 uid의 worker CLI·위조 credential·secret 없는 operator hello가 모두 로컬 operator grant(등록된 공개 연산 거의 전부, `access.grant` 포함)로 admission을 통과한다. REQ-09 비노출은 grant 교집합으로만 남고, 신원 자체가 허위이므로 CLI surface.describe / 도움말 / 완료도 operator 목록을 보여 준다. 발급된 bootstrap secret은 검사되지 않는다.
- Requested correction: operator 소켓과 worker 소켓을 각각 `serveRpc`하고, worker authenticator는 `authenticateWorkerCredential` + bootstrap 허용 연산만 통과시킨다. payload/`principalId` claim으로 context를 만들지 말 것. operator grant에서 C-HOST 이름을 빼 두라.
- Target: IMP-12 (transport/auth 배선), IMP-30 (daemon composition), IMP-20 (bootstrap credential이 실제로 hello에 쓰이게).

**2. [implementation] IMP-24/25 harness recipe는 runtime composition에 연결되지 않고, `harness.profile.register`가 저장하는 `recipe_json`은 `worker.prepare`가 요구하는 argv template이 아니다**

- Location: `packages/mahas-runtime/src/composition.ts` ( `mahas-harness-config` import 없음); `realization/profile-registry.ts:236-256` (`ProfileRecipe = {recipeVersion, injection, resume, wake, settingsPolicy}`); `launch/planner.ts:547-583` (`LaunchRecipe.process.executable` 절대경로 + `process.argv: ArgvEntry[]`); `planner.ts:579-580` (`capabilities_json.components`를 읽음); register는 `supportedComponents`를 씀 (`profile-registry.ts:230-235`); `claude/profile.ts:110-114,159-175` (문서용 `argvOrder` 문자열, `state:'documented'`); `codex/recipe.ts:365-386` (`admissionState:'documented'`, `verifiedInstall:false`); `launch/initial-attachment.ts:349-365` (`buildSpawnSpec`가 `PlannedProcessSpec.executable`을 argv[0]에 붙이지 않음) vs `process-manager.ts:275-276` (`argv[0]` 절대경로 필수).
- Contract: S-INJECTION §4–6 (실제 argv 배열, NUL/한도, TOML escape, 미지원 component는 `INJECTION_UNSUPPORTED`); C-LAUNCH worker.prepare “exact processSpec”; C-REALIZATION `harness.profile.register`의 injectionRecipe가 launch가 소비할 recipe여야 함; IMP-30 §4.1 “materializer/profile registry를 composition root에 연결”, §4.3 missing/unsupported profile을 활성 surface에 넣지 말 것; REQ-08 하네스 접점은 “승인된 역할 구성품 설치와 시작/resume/wake recipe”.
- Evidence: `buildClaudeLaunch` / `buildCodexLaunchSpec` / `encodeDeveloperInstructionsOverride`를 호출하는 runtime 파일이 없다. register가 쓰는 injectionRecipe는 claude draft의 `kind:'file-based', argvOrder:[설명 문자열…]`이지 `{literal|slot}` template이 아니다. 이 상태로 prepare하면 `INJECTION_UNSUPPORTED: recipe lacks an absolute executable/argv template` (`planner.ts:564-568`). 설령 argv template을 맞춰도 spawn spec에서 executable이 빠진다. compiler는 `capabilities.supportedComponents`를 보고 (`compiler.ts:1094-1096`) planner는 빈 `components`라 kind 지원 검사를 건너뛴다 (`planRoutes`는 `supportedComponentKinds.length > 0`일 때만 거부, `initial-attachment.ts:137`).
- Consequence: 문서 기반 claude/codex recipe의 NUL·ARG_MAX·TOML 거부, 필수 skill preload, subagent 거부가 실제 launch 경로에 없다. operator가 프로필을 등록해도 work spawn이 되지 않거나, 손으로 `recipe_json`을 LaunchRecipe 모양으로 넣어야 한다 — 그때는 harness-config의 거부를 우회한다. REQ-08의 “공용 API/CLI + 승인 recipe”가 한 줄로 이어지지 않는다.
- Requested correction: composition이 문서 프로필 draft를 `harness.profile.register` 입력으로 넣되, 저장 recipe를 launch `LaunchRecipe`(절대 executable + slot argv + routes)로 정규화하거나, prepare가 harness-config recipe builder를 호출하게 한다. capabilities 필드명을 compiler/planner가 같게 읽고, `buildSpawnSpec`은 `executable`을 argv[0]으로 고정한다. 미지원 kind는 빈 배열일 때도 거부한다.
- Target: IMP-30 (배선), IMP-07 (recipe_json 정본 형태), IMP-19 (prepare/spawn spec), IMP-24/IMP-25 (draft가 그 정본을 내도록).

**3. [implementation] launch가 쓰는 `connection/worker` 바이트는 IMP-12 CLI가 읽는 WorkerConnectionFile이 아니며, endpoint도 operator 소켓이다**

- Location: `launch/initial-attachment.ts:387-401` (`buildConnectionFile`: `{protocolVersion, endpoint?, executionId, generation, credential: token}`); `launch/start-coordinator.ts:835-845,892-902` (그 바이트를 `connection/worker`에 쓰고 `execution_credentials.secret_hash`에 prefix 없는 digest를 저장); `composition.ts:416` (`endpoint: opts.endpoint` = mahasd operator socket); `rpc/worker-auth.ts:61-92` (파일은 `credential.kind==='worker'` + `credentialId` + `secret`, POSIX 0600); `launch/worker-connection.ts:60-84` (올바른 `WorkerConnectionFile` writer가 있으나 start 경로가 호출하지 않음); `access/authorize.ts:95-116` (`verifySecret`은 `scrypt:` 또는 `sha256:`만).
- Contract: C-ACCESS “connection 파일은 실행 소유 디렉터리에서 읽는다. 파일 path 자체를 인증으로 쓰지 않고 credential proof를 별도로 검사한다”; S-INJECTION §3 `connection/worker`; IMP-12 §4.2.
- Evidence: CLI `readWorkerConnectionFile`은 `credential`이 문자열이면 즉시 `UNAUTHENTICATED`다. 설령 파서를 느슨하게 해도 hash가 `sha256:` prefix가 없어 `verifySecret`이 실패한다. `writeWorkerConnection`/`issueBootstrapCredential` (`bootstrap-credential.ts:61-63,100-111`)은 맞는 형태를 만들지만 spawn 경로가 다른 헬퍼를 쓴다. endpoint는 worker 소켓이 아니라 `mahasd.sock`이다 (Finding 1과 결합).
- Consequence: 스코프 CLI (`bin/mahas`가 `MAHAS_CONNECTION_FILE`을 export, `worker-connection.ts:104-109`)로 `mahas execution join`을 호출해도 파일 파싱에서 죽거나, Finding 1 때문에 operator로 승격된다. 발급된 bootstrap secret은 쓰이지 않는다.
- Requested correction: start 경로를 `issueBootstrapCredential` + `writeWorkerConnection`으로 통일하고 worker endpoint를 찍는다. secret_hash는 `hashWorkerSecret` 형식을 쓴다. 구 `buildConnectionFile` 형태는 제거한다.
- Target: IMP-19 (materialize/start가 파일을 씀), IMP-12 (읽기 계약), IMP-20 (credential 발급).

**4. [implementation] `assignment.show`는 항상 `UNAVAILABLE_OPERATION`인 stub인데 usable surface에 올라간다**

- Location: `packages/mahas-runtime/src/coordination/index.ts:76-84` (handler가 있어 등록됨); `api/surface.ts:70-73` (`if (!entry.handler) continue` — stub은 handler로 취급); `access/authorize.ts:67-72` (bootstrap 허용 목록에 `assignment.show` 포함).
- Contract: IMP-11 §4.5 “미구현 handler를 가진 action은 사용 가능 surface에 넣지 않는다”; C-ACCESS `surface.describe`는 허용 command summary만; C-WORK `assignment.show`는 bootstrap/자기 Member 조회.
- Evidence: 핸들러는 구현 없이 `mahasError('UNAVAILABLE_OPERATION', 'assignment.show is not implemented in this composition')`만 throw한다. CLI `mahas help` / completion / invoke와 bootstrap surface가 이 이름을 보여 주고, 호출하면 같은 코드로 거절한다. hidden/unknown과 구분되지 않는 worker 오류를 쓰면서도 목록에는 존재한다.
- Consequence: bootstrap 에이전트와 operator help가 없는 명령을 제시한다. join 직후 `assignment.show`로 mandate를 읽으라는 지침(S-INJECTION §7)이 공허하다.
- Requested correction: 실제 투영을 구현하거나 handler 없이 등록하지 않아 surface에서 빠지게 한다. bootstrap 허용 목록도 구현된 연산만 남긴다.
- Target: IMP-13 (또는 투영을 맡는 IMP-20), IMP-11 surface 규칙 준수.

**5. [implementation] 같은 operation의 결과·retry·목록 의미가 CLI · UI · RPC에서 갈라진다**

- Location: CLI `packages/mahas-cli/src/command-client.ts:96-140` (stdout = 전체 `CommandReceipt`, `pending`/`unknown` → exit 5, retry 필드 보존); UI `src/main/runtimeClient.ts:91-103` (`receiptToControl`: committed만 `ok`, 그 외는 실패로 접고 `retry`를 boolean `retryable`로 축소 — `replan`/`none` 소실, `pending`/`unknown`도 일반 오류); `src/renderer/src/workbench/ops.ts:38-51` (정적 `OP` 사전 11개, `surface.describe` 없음); `src/renderer/src/workbench/client.ts:122-132` (거절 receipt를 throw); CLI `main.ts:278-303` (`mahas status`는 hello 성공만으로 `readiness:'ready'`를 찍고 `runtime.status`를 부르지 않음).
- Contract: C-ACCESS “CLI/UI/MCP에 독립 명령 사전을 복제하지 않는다”, “JSON receipt를 stdout에, 오류는 nonzero”; S-COMMON §2 `CommandReceipt.status`와 `Error.retry: none|same-operation|reconcile|replan`; C-RECOVERY `runtime.status`가 제어면 건강의 정본; REQ-09; REQ-14 (ambiguous는 unknown이지 거절이 아님).
- Evidence: 서버 admission은 한 파이프라인이다 (`admission.ts:1-2,251`). 그러나 UI는 허용 연산을 surface 투영이 아니라 하드코드 이름으로 제안하고, receipt를 ControlResult로 접어 `unknown`을 실패한 것처럼 보여 준다. CLI built-in `status`는 소켓 hello를 서비스 ready로 번역한다 — mahasd가 아직 `writable`이 아니어도 (`readiness.ts:80-94,142-148`) `ready`다. `--json` 플래그는 파싱만 하고 출력 형식을 바꾸지 않는다 (`main.ts:104-106,269`).
- Consequence: 같은 `plan.commit` 거절이 CLI에서는 `STALE_REVISION` + `retry:'same-operation'` receipt이고 UI에서는 throw + retryable boolean이다. unknown spawn 결과를 UI가 재시도 가능한 실패로 오인할 수 있다. 운영자 `mahas status`는 재시작 중 CONTROL_UNAVAILABLE 게이트를 숨긴다.
- Requested correction: UI 명령 목록을 `surface.describe`에서 만들고, `exec:op`는 receipt status를 접지 말고 전달한다 (`unknown`/`pending` 구분). `mahas status`는 `runtime.status` 결과이거나 최소한 readiness snapshot이어야 하며 hello만으로 `ready`를 쓰지 않는다.
- Target: IMP-31 (workbench 표면), IMP-12 (CLI status vs runtime.status), IMP-30 (desktop `receiptToControl`).

**6. [implementation] C-HOST `host.process.spawn`은 NUL·인자 크기·개수 한도를 거부하지 않는다**

- Location: `packages/mahas-execution-host/src/process-manager.ts:265-277` (비어 있지 않은 argv, `argv[0]` 절대경로만); `pty-manager.ts:111-132` (검사 없이 spawn, `PATH`/`HOME`를 host 프로세스 env에서 채움); 대조 `mahas-harness-config/src/claude/recipe.ts:127-137,185-192`, `codex/recipe.ts:142-171,242-273` (NUL / MAX_ARG_STRLEN / ARG_MAX — 그러나 Finding 2로 spawn 경로에 없음).
- Contract: C-HOST “NUL/크기/인자 수는 실제 OS 한계에 맞게 검사한다. shell interpolation/eval 없음”; S-INJECTION §4 “물리 한도 초과는 … launch를 block한다. 자동 요약·절단 금지”.
- Evidence: host 핸들러에 `\0` 스캔, 단일 인자 128KiB, 전체 ARG_MAX 가드가 없다. Node spawn은 shell을 쓰지 않으므로 interpolation은 없다. 한도 초과/NUL은 OS errno로만 보이며 `INJECTION_UNSUPPORTED`가 아니다. `env.PATH ??= process.env.PATH`는 allowlisted map만 쓰라는 C-HOST와 어긋나는 암묵 상속이다.
- Consequence: recipe 가드가 빠지거나 우회되면 NUL/과대 argv가 host에서 명시 거절되지 않고 unknown spawn이 된다. host env 상속은 계정 secret이 자식에게 새는 경로가 된다.
- Requested correction: spawn 전에 NUL·MAX_ARG_STRLEN·ARG_MAX를 검사해 `INJECTION_UNSUPPORTED`/`INVALID_ARGUMENT`로 거절한다. env는 spec allowlist만, host `PATH`/`HOME` 기본값은 명시 capability로만.
- Target: IMP-18 (process spawn), IMP-17 (HostEnvelope/ProcessSpec 검증 seam).

**7. [implementation] `service:mahasd` makeCaller는 활성 principal/grant가 없어 내부 op가 `UNAVAILABLE_OPERATION`이다**

- Location: `composition.ts:270-275` (`serviceCtx.principalId = 'service:mahasd'`), `148-171` (seed는 `operator-local`만); `333-336`, `374-380` (materialize `caller`가 `serviceCtx`로 `makeCaller`); `access/authorize.ts:552-555` (없는 principal → `actions: []`, ALWAYS_SURFACE 추가 전에 return); `admission.ts:195-199` (비어 있는 surface → hidden → `UNAVAILABLE_OPERATION`); `realization/effective-context.ts:497-501`, `materializer.ts:238-294` (`workspace.inspect`).
- Contract: IMP-11 단일 admission; SHARED-APIS “cross-domain work is invoked by operation name through the OperationRegistry”; C-RESOURCE `workspace.inspect`는 launch/materialize가 실제 checkout을 확인할 때 필요.
- Evidence: `visibility:'service'`는 등록 메타데이터일 뿐 (`handler-ports.ts:47-49`) admission이 보지 않는다. 가시성은 grant 이름 집합이다. `service:mahasd` row가 없으므로 `workspace.inspect`/`context.build`를 serviceCtx로 부르면 step 3에서 거절된다. launch의 `deps.call`은 요청자 ctx를 쓰므로 operator 경로의 `context.build`는 우회할 수 있으나, composition이 materializer에 주입한 caller는 serviceCtx다.
- Consequence: checkout-scoped 구성품 materialize(`.agents/skills` 등)와 service-visibility 내부 op가 조성 root에서 항상 거절된다. Finding 2와 겹치면 documented 프로필 launch가 이중으로 막힌다.
- Requested correction: 내부 makeCaller용 service principal+좁은 grant를 seed하거나, admission이 인증된 controller service context에 `visibility:'service'` 연산을 허용하는 명시 경로를 둔다. 빈 principal을 silent allow 하지 말 것.
- Target: IMP-30 (composition seed), IMP-11 (service visibility vs grant).

## Limitations

- 정적 코드 대조만 수행했다. 실제 mahasd/CLI/하네스 실행, crash injection, 설치 버전 수락은 하지 않았다. Finding 1·3·7의 “항상 operator-local / 파일 파싱 실패 / serviceCtx 거절”은 호출 그래프와 분기에서 추론한 것이며 런타임 로그로 관측한 실패가 아니다.
- IMP-21 미등록 연산(`task.report`/`outcome.decide`/`execution.wake`)은 REV-04 Finding 1과 같은 공백이다. 이 기록은 노출 분류(surface에 안 올라감)만 확인하고 업무 의미는 재심사하지 않았다.
- workbench `plan.commit`/`team.assign` 필드 드리프트는 REV-04 Finding 3–4의 범위라 여기서 재기술하지 않았다. Finding 5는 명령 사전·receipt/retry 접기·status 의미만 다룬다.
- `packages/README.md`의 “모든 op가 CONTROL_UNAVAILABLE” 서술은 코드와 다르나 계약 문서가 아니므로 finding으로 쓰지 않았다.
- 16개 `DISPATCH_OPS`는 operator seed grant에 이름이 없어 현재 `surface.describe`에 안 나온다. Finding 1이 남는 한 별도 노출 구멍으로 단정하지 않았다.
