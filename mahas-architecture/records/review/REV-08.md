# ReviewRecord — REV-08

- reviewTaskId: REV-08
- codeRevision: 8f6959457a8fc965c110dea79d533e53cf07326c
- specRevision: 99eb5f5
- scope: IMP-30 composition join과 REV-01..07 경계 결과의 결합. `packages/mahas-runtime/src/{composition,main}.ts`, `src/main/runtimeClient.ts`를 실제 조인으로 읽고, S-ARCH §7 흐름(책임 탐색 → 배정 → 역할 구현 → 실제 주입 → 협업 → 정산 → 정리)에서 누락·불일치 interface를 합성한다. 선행 59개 finding을 재나열하지 않는다. 실행 시험은 하지 않았다.
- disposition: changes-required

HANDOFF.md는 32 IMP가 구현되었다고 주장한다. 이 검토는 그 인계가 아니라 코드의 조인을 본다. 각 경계에 모듈과 `register*` 호출은 있으나, 화살표 계약이 한 시스템으로 닫히지 않는다.

## Revision alignment

선행 7건은 모두 같은 code/spec revision을 가리킨다. 구현 패키지(`packages/*`, `src/`)는 지정 revision과 현재 HEAD `92dcd77` 사이에 차이가 없다 — HEAD 추가는 `mahas-architecture/records/**`뿐이다. 재검토 범위(소스 drift)는 없다.

| Review | codeRevision | specRevision | disposition | findings |
| --- | --- | --- | --- | --- |
| REV-01 | `8f6959457a8fc965c110dea79d533e53cf07326c` | `99eb5f5` | changes-required | 11 |
| REV-02 | 동일 | 동일 | changes-required | 10 |
| REV-03 | 동일 | 동일 | changes-required | 7 |
| REV-04 | 동일 | 동일 | changes-required | 9 |
| REV-05 | 동일 | 동일 | changes-required | 9 |
| REV-06 | 동일 | 동일 | changes-required | 7 |
| REV-07 | 동일 | 동일 | changes-required | 5 |

## End-to-end flow

S-ARCH §7: 팀장 책임 탐색 → 구현 가능한 role 조회 → 명시 배정 → Task/META DAG 고정 → role+context 구성품 선택 → 권한 교집합과 입력 고정 → spawn recipe로 실제 첫 입력 전달 → agent join와 task accept → 공통 협업 API → 결과 정산 → 유지/인계/정리.

### 1. 책임 탐색

Interface는 있다. `registerDiscoveryOps`가 composition에 연결되고 (`composition.ts:325-330`) `responsibility.search`/`inspect`/`locate`/`collaborators`/`role.implementations`가 등록된다. 서버는 `items`와 `status: no-match|unassigned|ambiguous`를 돌려준다 (`discovery/search.ts:643-661`).

체인은 소비자에서 끊긴다. 작업대 `projectId`/`modelVersion`/`runId` 기본값은 `''`이고 `setContext` 호출처가 store 정의뿐이다 (`workbench/store.ts:27-32,61-69`). Search 버튼은 `!projectId`면 disabled (`ResponsibilityView.tsx:356`). 호출되어도 UI는 `candidates`를 읽고 서버 `items`를 버린다 (`workbench/contracts.ts:147-153`). inspect는 `coordinationView` 객체를 문자열 칸으로 두어 `[object Object]`가 된다 (서버 `inspect.ts:219-231` vs UI `contracts.ts:170-180`). 탐색 카드는 `status !== 'retired'`면 candidate 구현을 올린다 (`implementation-availability.ts:79-83`). selectionToken은 implementation digest를 묶지 않는다 (REV-01 F4, composition 어댑터 `composition.ts:344-356`).

### 2. 배정

Interface는 있다. `assignment.preview`/`team.assign`이 등록되고 (`coordination/index.ts:70-75`) 핸들러가 자체 `authorize(run)`를 호출한다 (`member.ts:477`). 검색 순위를 기본 확정으로 쓰지 않는 UI 제스처(preview 후 명시 클릭)는 맞다 (`TeamView.tsx:319-328`).

체인은 세 곳에서 끊긴다. (a) 작업대가 `expectedPlanRevision`을 payload에서 빼고 envelope `expectedRevisions.plan`만 보내며 (`ops.ts:110-117,133-138`), coordination 등록에 `resolveRevisions`가 없어 admission이 `STALE_REVISION`이다 (`admission.ts:343-364`, `coordination/index.ts:60-64`). 핸들러는 빠진 필드를 `?? 0`으로 읽어 이미 plan이 있는 Run을 거절한다 (`member.ts:480-488`, `plan.ts:533,566-573`). (b) `recheckImplementation`은 `candidate`를 통과시킨다 (`member.ts:275-282`). (c) `checkProvisioning`은 `ctx.grantRevisions` 키만 스캔하고 (`internal.ts:513-530`, `member.ts:513-525`), 기본 authenticator는 `grantRevisions: {}`이며 (`main.ts:361-366`) seed grant는 kind `'assignment'`이지 `'provisioning'`이 아니다 (`composition.ts:148-169`). operator-local도 배정 API에서 `SCOPE_DENIED`다.

Plan 게시 역시 UI `disposition`/`inputBindings`/`outputSlots` vs 서버 `action`/`inputs`/`outputs`로 어긋나 첫 DAG가 구조 오류이거나 빈 spec으로 간다 (`PlanView.tsx:60-91`, `plan.ts:76-82,176-221`).

### 3. 역할 구현

Interface는 있다. `registerRealizationOps`/`registerContextOps`/`registerMaterializeOps`가 연결된다 (`composition.ts:331-336`). 타입 분리(RoleInterface / RoleImplementation / ContextBundle / LaunchPlan)는 유지된다.

체인은 스키마 조인에서 끊긴다. `deriveInterface`는 `requiredMeaning:'required'`, `readerPerspective:'performer'`만 남겨 팀장 해상도 저작 경로가 없다 (REV-03 F1–F2). prepare는 `activation`을 JSON 객체로 저장하고 (`implementation-repository.ts:305-307`) compiler는 `'initial'|'conditional'` 문자열과 `binding.sections[]`만 받는다 (`compiler.ts:325-363`). compiler manifest는 `installPath`/`blobDigest`/`loadRoutes`이고 (`bundle-store.ts:133-144`) materializer는 `digest`/`path`를 필수한다 (`component-store.ts:146-171`). 공개된 구현 revision이 `context.build`에서 죽고, 살아도 materialize가 구성품을 설치하지 못한다.

### 4. 실제 주입

Interface는 있다. `worker.prepare`/`worker.start`/`execution.join`이 등록된다 (`launch/index.ts:23-48`, `composition.ts:371-418`).

체인은 다섯 겹으로 끊긴다.

1. `mahas-runtime`은 `mahas-harness-config`를 import하지 않는다 (composition 포함 0건). `buildClaudeLaunch`/`buildCodexLaunchSpec` 호출자가 runtime에 없다. `harness.profile.register`가 저장하는 `recipe_json`은 `{recipeVersion, injection, resume, wake, settingsPolicy}`이고 (`profile-registry.ts:236-253`) planner는 `process.executable` 절대경로 + `process.argv` slot template을 요구해 즉시 `INJECTION_UNSUPPORTED`다 (`planner.ts:547-568`). capabilities 필드도 `supportedComponents`(registry) vs `components`(planner `planner.ts:579-580`)로 갈라져 kind 검사가 꺼진다 (`initial-attachment.ts:137`).
2. planner가 `sourceSnapshotPins`로 `{assignmentId, assignmentRevision}` 객체를 넘기고 compiler는 path/digest 배열만 받는다 (`planner.ts:482-490`, `compiler.ts:207-214`).
3. composition materialize 어댑터는 `executionId`/`bundleDigest`/`workspaceId`만 넘기고 envelope·connection·wantBytes·checkoutPath를 버린다 (`composition.ts:374-394`). start는 `secretFiles`에 connection 바이트를 실어도 (`start-coordinator.ts:837-880`) 어댑터가 소비하지 않는다. materializer는 envelope가 없으면 `task/initial.txt`를 쓰지 않는다.
4. 쓰이는 connection 바이트는 `{credential: <raw token string>}`이고 (`initial-attachment.ts:387-401`) CLI는 `{kind:'worker', credentialId, secret}`를 요구한다 (`worker-auth.ts:61-92`). `writeWorkerConnection`/`issueBootstrapCredential`은 정의만 있고 start가 호출하지 않는다. `secret_hash`는 prefix 없는 digest (`start-coordinator.ts:896-899`)인데 `verifySecret`은 `sha256:`/`scrypt:`만 받는다 (`authorize.ts:95-116`). endpoint는 operator `mahasd.sock`이다 (`composition.ts:416`, `main.ts:378`).
5. 부팅 `startupReconcile`이 공유 HostSession을 `close()`하고 (`lifecycle/reconcile.ts:192-284`, `composition.ts:106-120,282-318`), probe/stop은 `expectedProcessIncarnation`을 보내 host는 `processIncarnation`/`spawnNonce`만 읽는다 (`identity-probe.ts:229-236`, `process-manager.ts:616-625`). spawn reject는 `{spawn:{state:'rejected'}}`인데 coordinator는 `out.state === 'rejected'`를 본다 (`start-coordinator.ts:1035-1058`). 부팅 직후 host 제어가 끊기고, 살아 있어도 프로세스를 이름으로 부르지 못한다.

추가로 `service:mahasd` principal에 grant가 없어 materializer의 `workspace.inspect` caller가 `UNAVAILABLE_OPERATION`이다 (`composition.ts:270-275,333-336`, `authorize.ts:552-555`). stdin 바이트는 `payload.initialStdin` 형제로 가고 host는 `spec.initialStdin`만 쓴다 (`start-coordinator.ts:1005-1014`).

### 5. 협업

Interface는 부분적으로 있다. `message.send`/`replyAndAck`/`inbox.check`/`inbox.wait`/`artifact.*`/`task.accept`가 등록된다. Run은 scheduler가 아니고 mailbox는 팀장 중계가 아니다 (REV-04 정합).

체인은 인수에서 끊긴다. 첫 Dispatch phase는 `'assigned'`인데 (`start-coordinator.ts:602-605`) 이는 D-WORK 어휘가 아니고 join UPDATE 집합에도 없다 (`join.ts:256-263`). join은 `dispatchesAdvanced=0`으로도 성공하고 `task.accept`는 `awaiting_accept`만 받는다. `assignment.show`는 stub으로 `UNAVAILABLE_OPERATION`이다 (`coordination/index.ts:76-84`). 설계된 worker 최소 surface(join / assignment.show / surface.describe / operation.get)는 F1 때문에 도달하지 않는다 — hello가 모든 연결을 operator-local로 만든다.

mail 자체 send/ack는 조인 가능하나, `inbox.wait`가 admission write/deferred tx 안에서 bounded poll한다 (`mail/wait.ts:40-94`, `admission.ts:246-258`) — 전달 원장과 직교하지 못하는 긴장이다. 정산 면이 없어서 후행 Dispatch의 `task-output`은 영원히 `INPUT_NOT_READY`다.

### 6. 정산

Interface가 없다. C-WORK `task.report`/`outcome.decide`, C-LAUNCH `execution.wake`는 `OPERATION_TABLE`에 IMP-21 소유로만 있고 (`registry.ts:126-127,144`) handler 파일이 트리에 없다 (`coordination/`에 outcome/settlement/handoff 없음, `mail/`에 wake-service 없음). `INSERT INTO outcomes`는 maintenance smoke fixture뿐이다. grant JSON과 `nextAllowedActions`는 이름을 남긴다 (`member.ts:173-184`). admission은 `UNAVAILABLE_OPERATION`이다 (`admission.ts:172-185`).

`settleDispatch` 내부 op와 `task.dispatch` 재사용 경로만 있다. 후자는 `createDispatch`/`pinInputs`/`reserveDispatch`를 우회한다 (`member.ts:791-1139`). owner-declaration과 designated-acceptance가 분리된 공개 경로가 없으므로 REQ-20/AC-01의 “팀장이 모든 결과를 재승인할 필요 없음”을 구현에서 확인할 수 없다.

### 7. 정리

Interface는 선언만 있다. `makeReleaseHandler`는 구현되어 있으나 `registerRecoveryOps`가 `worker.stop`/`worker.resume`만 등록하고 release는 “deliberately left unregistered”다 (`recovery/index.ts:8-38`, `reconciler.ts:970`). stop 영수증은 여전히 `worker.release`를 next action으로 가리킨다 (`stop.ts:403,445,462`).

`runtime.shutdown` drain은 `MahasdLifecycle.caller`가 compose 이전 `null`이라 `worker.stop`을 발행하지 않는다 (`main.ts:274-278,299-309`, `shutdown.ts:141-152`). 데스크톱 탭 close/restart는 `pty.kill`이며 `client.view.unbind`/`terminal.detach`를 호출하지 않는다 (`LeafPane.tsx:207,232-236`, `runtimeClient.ts:255-275`). UI close = detach (S-ARCH §5, `runtimeClient.ts:211-216`의 창 닫기)와 탭 단위 kill이 한 제품에 공존한다.

---

국소적으로 동작하는 조각(모델 publish 불변식, mail send/ack 원자성, host가 mahas.sqlite를 열지 않음, CLI가 정적 업무 사전을 복제하지 않음, packaged desktop이 daemon을 스폰하지 않음)은 위 화살표가 닫히면 의미가 있다. 지금은 탐색 UI가 비고, 배정이 거절되고, 구현이 빌드되지 않고, spawn recipe가 없고, host 세션이 부팅 reconcile에 닫히고, 정산 op가 없다.

## Cross-boundary tensions

1. **과도한 중앙 판단(권한).** 논리 API는 “runtime이 업무를 대신 결정하지 않는다”(REQ-01)고 말하지만, 기본 authenticator가 모든 hello를 `operator-local` wildcard grant(`OPERATION_NAMES` 전체, C-HOST 이름 포함, `composition.ts:168`)로 승격한다. 대부분의 op는 `resolveTargets`가 없어 빈 대상이 scope를 통과한다 (`admission.ts:368-376`, `grant.ts:237-242`). 결과: 한 로컬 principal이 대상 검사 없이 전 연산을 실행하거나, provisioning 쪽은 `grantRevisions:{}`로 전면 거절한다. 분산 판단이 아니라 슈퍼유저 아니면 정지다.

2. **과도한 context dump와 반대의 공백.** RoleInterface에 의미가 없고(`requiredMeaning:'required'`), compiler가 맞춰지면 maintenanceBasis와 coverage 밖 instruction이 실행 루트 `role/manifest.json`/`mandatory.md`로 떨어진다 (REV-03 F7). 동시에 작업대 inspect는 팀장 해상도를 보여 주지 못하고, 필수 본문은 argv/stdin에 실리지 않는다. 운영자/에이전트는 원문 파일 전부 또는 빈 화면 중 하나를 받는다 — REQ-06의 역할별 해상도가 아니다.

3. **하네스 의존이 협업 API보다 앞선다.** REQ-08은 인수/inbox/report를 공용 API로 두고 하네스 접점을 “승인 recipe”로 한정한다. 실제로는 harness-config가 composition에 없고, 협업 API(report/wake)도 없다. 에이전트는 기존 unmanaged PTY + hook 경로로만 살아 있다 (`runtimeClient.ts` `pty:*` vs `exec:*`). 제어면이 붙으면 그때 native recipe를 손 JSON으로 넣어야 하며, 그 순간 harness-config의 NUL/ARG_MAX/필수 skill 거부를 우회한다. 하네스 독립 협업이 아니라 하네스 우회 또는 레거시 셸이다.

4. **이중 실행 소유.** mahasd/execution-host가 process 소유자라고 하면서 데스크톱은 같은 앱에서 탭 레코드 lifetime으로 pty를 kill한다. `tab.binding`은 타입만 있고 한 번도 세팅되지 않는다. 관리 Execution과 비관리 셸이 한 탭 스트립에서 구분되지 않는다.

5. **이중 정본이 한 이름.** 연결 파일 writer 둘, bundle manifest 타입 둘, reconcilers 둘(`lifecycle/reconcile.ts`가 배선, `recovery/reconciler.ts`의 `reconcileExecutions`는 export만), Dispatch 생성기 셋(start `'assigned'`, `reserveDispatch` `'reserved'`, `task.dispatch` `'awaiting_accept'`), CommandSurface digest 셋(help/prepare/join). 각 경계에서는 합리적인 방언이고, 조인에서는 아무도 상대 계약을 읽지 않는다.

6. **unknown의 붕괴.** S-LIFECYCLE은 모호함을 unknown으로 보존하라고 한다. host 확정 receipt를 필드명 불일치로 unknown에 접고 (`stop.ts:323-341`), UI는 unknown을 실패 boolean으로 접는다 (`runtimeClient.ts:91-103`). 모호함 보존이 아니라 확정 증거의 소실이다.

## Combined findings

선행 국소 버그 중 조인을 막지 않는 것(예: REV-01 F1 런타임 `ModelEdit` 방언 — 작업대가 C-MODEL 타입을 쓰지 않음; REV-02 F7 AuthorizationDecision 누설; REV-02 F10 CLI 카피; REV-03 F7 maintenanceBasis 노출; REV-04 F2 inbox.wait tx; REV-06 F4 `assignment.show` stub 단독; REV-06 F6 host NUL 가드; REV-07 F2/F5 표시 미연결)은 여기에 재진술하지 않는다. 아래만 시스템이 한 흐름으로 성립하지 못하게 하는 결합 결함이다.

**1. [implementation] worker/operator 신원이 composition에서 조인되지 않는다 — 단일 소켓이 client `principalId`를 `operator-local`로 승격한다**

- Location: `packages/mahas-runtime/src/main.ts:353-378`; `packages/mahas-runtime/src/composition.ts:148-171,265-268`; `packages/mahas-runtime/src/rpc/local-server.ts:310-314,315-318`; `packages/mahas-runtime/src/rpc/endpoints.ts:14-24`; `packages/mahas-runtime/src/launch/bootstrap-credential.ts:160-187`; `src/main/runtimeClient.ts:64-72,281-293`; `packages/mahas-cli/src/connection.ts:50-55,105-110`
- Contract: C-ACCESS §1 endpoint/credential 분리, worker fallback-admin 금지; S-ARCH §6; REQ-09; IMP-12 §4.1; IMP-30 §4.2
- Evidence: `serveRpc`는 `mahasd.sock` 한 번만 bind한다. `mahasdWorkerEndpoint`를 bind하는 호출이 저장소에 없다. 기본 `authenticate`는 `credential.principalId ?? 'operator-local'`이고 `grantRevisions:{}`, `executionId`/`memberId` 없음. `authenticateWorkerCredential`/`isBootstrapOperationAllowed`는 RPC에 연결되지 않는다. seed는 그 principal에 `{kind:'*',id:'*'}`와 `OPERATION_NAMES` 전체 action을 넣는다. CLI는 `MAHAS_CONNECTION_FILE`이 없으면 operator로 추론하고, spawn env는 operator endpoint를 실을 수 있다. desktop `exec:op`도 `{kind:'operator'}`로 같은 소켓에 붙는다. local-server 주석(“두 소켓, fallback 없음”)과 main 조립이 모순이다.
- Consequence: 같은 uid의 worker CLI·위조 hello·secret 없는 operator credential이 모두 로컬 operator grant로 admission을 통과한다. 반대로 bootstrap 4개 op·`execution.join`의 `ctx.executionId` 검사는 context가 비어 성립하지 않는다. REQ-09 비노출과 REQ-10 최소 위임은 grant 교집합 이전에 신원이 허위라 무의미하다. 이후 finding 2·3·8의 worker 경로는 이 조인이 닫히기 전에는 검증 불가이다.
- Requested correction: operator 소켓과 worker 소켓을 각각 `serveRpc`한다. worker hello는 `authenticateWorkerCredential`만 통과시키고 client `principalId`를 context에 복사하지 않는다. `grantRevisions`·execution generation은 credential 행에서 채운다. worker로 스폰된 프로세스는 env 삭제/`--as operator`로 operator endpoint를 고르지 못하게 한다. operator seed에서 C-HOST 이름을 뺀다.
- Target: IMP-12 (transport/auth), IMP-30 (`main.ts` 기본 authenticator·seed), IMP-20 (bootstrap verify 연결)
- Consumers to re-review: REV-02, REV-06. grantRevisions가 채워지면 REV-02 F9 provisioning 문이 열리는지 REV-04 배정 경로도 재검토.

**2. [implementation] launch가 쓰는 `connection/worker` 바이트는 CLI가 읽는 WorkerConnectionFile이 아니며 endpoint도 operator 소켓이다**

- Location: `packages/mahas-runtime/src/launch/initial-attachment.ts:387-401`; `packages/mahas-runtime/src/launch/start-coordinator.ts:835-902`; `packages/mahas-runtime/src/launch/worker-connection.ts:60-84`; `packages/mahas-runtime/src/rpc/worker-auth.ts:25-31,61-92`; `packages/mahas-runtime/src/rpc/endpoints.ts:22-27`; `packages/mahas-runtime/src/access/authorize.ts:95-116`; `packages/mahas-runtime/src/composition.ts:416`
- Contract: C-ACCESS connection 파일 형태·path≠auth; S-INJECTION §3 `connection/worker`; IMP-12 §4.2; IMP-20 §4.1/§6
- Evidence: start는 `buildConnectionFile`로 `{protocolVersion, endpoint, executionId, generation, credential: token}`을 쓰고 `issueBootstrapCredential`/`writeWorkerConnection`을 호출하지 않는다. CLI `readWorkerConnectionFile`은 `credential.kind==='worker'` + `credentialId` + `secret`가 아니면 `UNAUTHENTICATED`다. hash는 prefix 없는 hex라 `verifySecret`이 실패한다. 파일명 정본도 `endpoints.ts`의 `worker-connection.json`과 layout의 `connection/worker`가 갈린다. Finding 1과 겹치면 파서가 느슨해져도 operator 소켓으로 승격된다.
- Consequence: 스코프 `bin/mahas`로 `execution.join`을 호출하는 설계된 worker 논리 인증이 파일 파싱에서 죽는다. 발급 secret은 쓰이지 않는다. Finding 1을 고쳐도 이 방언이 남으면 worker 협업 API에 도달하지 못한다.
- Requested correction: start/materialize는 `issueBootstrapCredential` + `writeWorkerConnection`(0600, worker endpoint, `{kind:'worker',credentialId,secret}`)만 사용한다. `secret_hash`는 `hashSecret`/`sha256:` 형식. `buildConnectionFile` 형태는 제거한다.
- Target: IMP-19 (파일을 쓰는 start/materialize), IMP-20 (credential 발급), IMP-12 (읽기 계약)
- Consumers to re-review: REV-02, REV-06, REV-03 (주입 레이아웃)

**3. [implementation] admission의 빈 대상 허용과 coordination/launch의 resolver 부재가 인가를 이름 allowlist로 접는다**

- Location: `packages/mahas-runtime/src/api/admission.ts:202-207,285-288,368-376`; `packages/mahas-runtime/src/access/grant.ts:237-242`; `packages/mahas-runtime/src/coordination/index.ts:60-86`; `packages/mahas-runtime/src/launch/index.ts:23-48`; `packages/mahas-runtime/src/mail/index.ts:26-47`; `packages/mahas-runtime/src/coordination/member.ts:140-186,564-590`; `packages/mahas-runtime/src/access/grant.ts:216-224`
- Contract: D-ACCESS §2 actualTargets는 DB에서; “request의 roleId/from은 인증 근거가 아니다”; REQ-09; IMP-11 §4.1/§4.4
- Evidence: `resolveTargets` 부재 시 `[]`. `scopeCoversTargets`는 `targets.length === 0`이면 `{covers:true}`. coordination/launch/mail/model 대부분이 resolver 없이 등록된다. `OperationSpec.visibility`는 admission이 읽지 않는다. AssignmentGrant의 `roleId`/`boundaryId`/`taskIds`는 `scopeEntries`가 무시해 Run ancestor로 열린다. Finding 1의 wildcard와 곱하면 전 연산이 대상 없이 통과하고, Finding 1을 고친 뒤에도 action 이름만 있는 member grant는 다른 run/task를 부른다.
- Consequence: 최소 위임이 경계 간에 운반되지 않는다. 핸들러 자체 `authorize`가 있는 op(team.assign, mail)는 한 겹 더 막히지만, 파이프라인의 독립 검증은 이 조인에서 비어 있다. 내부 `DISPATCH_OPS`도 worker registry에 `visibility:'service'`로 올라가 이름이 grant에 적히면 빈 대상으로 실행된다.
- Requested correction: 대상이 있는 모든 op에 DB 기준 `resolveTargets`를 단다. resolver 없는 mutation은 등록 거부 또는 빈 대상 deny. `visibility:'service'`는 worker registry에 올리지 않거나 admission이 집행한다. AssignmentGrant `targets`에 task/role/boundary를 정규화한다.
- Target: IMP-11 (기본 거부·visibility). 각 resolver는 IMP-10/13/15/19. scope 기록은 IMP-13
- Consumers to re-review: REV-02, REV-04 (coordination 대상), REV-06 (service ops 노출)

**4. [implementation] 탐색→배정 pin이 구현 축에서 비어 있고, 작업대 봉투와 provisioning attestation이 배정 호출을 닫는다**

- Location: `packages/mahas-runtime/src/discovery/implementation-availability.ts:79-83`; `packages/mahas-runtime/src/discovery/selection-token.ts:66-96`; `packages/mahas-runtime/src/coordination/member.ts:239-282,347-358,480-525`; `packages/mahas-runtime/src/coordination/internal.ts:513-530`; `src/renderer/src/workbench/{ops.ts:110-138,store.ts:27-69,contracts.ts:147-180,PlanView.tsx:60-91}`; `packages/mahas-runtime/src/coordination/plan.ts:76-82,176-221,533,566-573`; `packages/mahas-runtime/src/api/admission.ts:343-364`
- Contract: C-DISCOVERY published 구현만, selectionToken이 implementation 후보 digest를 묶음; C-WORK `expectedPlanRevision` payload, PlanPatch `action`/`inputs`/`outputs`; REQ-04/05; D-ACCESS ProvisioningGrant
- Evidence: 가용성 필터는 `status !== 'retired'`. `recheckImplementation`은 candidate를 통과. 토큰 claims에 implementation digest가 없고 composition 어댑터도 옮기지 않는다 (`composition.ts:344-356`). 작업대는 project context를 바인딩하지 않아 search가 영구 disabled이거나 잘못된 필드를 읽는다. `expectedRevisions.plan`은 resolver가 없어 STALE. `checkProvisioning`은 빈 `grantRevisions`에서 covering grant가 없다. seed는 provisioning kind가 아니다.
- Consequence: 팀장 작업대에서 책임 탐색·META DAG 게시·명시 배정이 성공 경로가 없다. CLI raw로 우회해도 candidate 구현을 배정할 수 있고, operator-local도 provisioning에서 거절된다. AC-04의 search→preview→assign 사슬이 UI와 서버 양쪽에서 닫히지 않는다.
- Requested correction: 가용/배정은 `published`만. 토큰에 implementation 후보 digest를 넣고 assign이 재비교한다. 작업대는 workspace project/run을 `setContext`하고 서버 필드명(`items`, `expectedPlanRevision` payload, PlanPatch `action`/`inputs`/`outputs`)을 따른다. 로컬 operator에 명시 ProvisioningGrant를 seed하거나, `grantRevisions:{}`를 “현재 활성 행”으로 일관 정의한다. 봉투 CAS를 쓰려면 op spec에 `resolveRevisions`를 단다.
- Target: IMP-06 (token/availability), IMP-13 (assign/provisioning/resolver), IMP-31 (workbench), IMP-30 (operator provisioning seed)
- Consumers to re-review: REV-01, REV-02 F9, REV-04, REV-07

**5. [implementation] RoleInterface → compiler → materializer → harness recipe가 네 스키마로 갈라지고 harness-config가 composition에 없다**

- Location: `packages/mahas-runtime/src/realization/{interfaces.ts:29-49,194-223; implementation-repository.ts:305-307; compiler.ts:325-363,916-965; bundle-store.ts:133-144; component-store.ts:44-72,146-171; profile-registry.ts:230-256}`; `packages/mahas-runtime/src/launch/planner.ts:547-583`; `packages/mahas-runtime/src/composition.ts` (mahas-harness-config import 없음); `packages/mahas-harness-config/src/claude/profile.ts`; `packages/mahas-harness-config/src/codex/recipe.ts`
- Contract: REQ-05/07/08; D-ROLE; S-INJECTION §2–6; C-REALIZATION; C-LAUNCH worker.prepare; IMP-30 §4.1 materializer/profile registry를 composition에 연결
- Evidence: (a) interface는 clause-id flags. (b) prepare `activation` JSON vs compiler 문자열. (c) compiler `installPath`/`blobDigest` vs materializer `path`/`digest`. (d) registry `ProfileRecipe.injection` vs planner `LaunchRecipe.process`. (e) compiler `capabilities.supportedComponents` vs planner `capabilities.components`. (f) Claude/Codex native planner는 패키지 내부에서만 호출된다. documented draft로 prepare하면 `INJECTION_UNSUPPORTED`.
- Consequence: 역할 구현을 publish해도 하네스 native loading point(Claude `--append-system-prompt-file` + plugin skills, Codex `developer_instructions` + `.agents/skills`)에 본문이 붙지 않는다. 파일 생성만으로 delivered를 선언하는 상태를 launch가 거절하거나, 손-recipe로 우회하면 harness-config 가드가 없다. AC-05/AC-07/AC-08이 이 조인 없이는 성립하지 않는다.
- Requested correction: 저장 DTO와 compiler 입력, bundle manifest, LaunchRecipe를 한 스키마로 고정한다. composition이 harness-config recipe builder를 prepare에 연결하거나, register가 절대 executable+slot argv+routes를 저장하게 한다. 빈 supported-kind 배열일 때도 미지원 kind를 거부한다. 필수 skill은 inline/confirmed preload만 같은 어휘로 강제한다.
- Target: IMP-30 (배선), IMP-07 (recipe_json 정본), IMP-08 (compiler DTO), IMP-09 (manifest), IMP-19 (prepare/spawn), IMP-24/25 (draft가 그 정본을 내도록)
- Consumers to re-review: REV-03, REV-06. 스키마가 움직이면 C-REALIZATION/S-INJECTION 소비자 전부.

**6. [implementation] composition의 materialize/makeCaller 어댑터가 첫 입력과 내부 op를 버린다**

- Location: `packages/mahas-runtime/src/composition.ts:270-275,333-336,371-416`; `packages/mahas-runtime/src/launch/start-coordinator.ts:814-880,1005-1014`; `packages/mahas-runtime/src/launch/planner.ts:482-490`; `packages/mahas-runtime/src/realization/materializer.ts:93-99,238-277`; `packages/mahas-runtime/src/access/authorize.ts:552-555`; `packages/mahas-runtime/src/api/admission.ts:195-199`
- Contract: REQ-07; S-INJECTION §3–4 `task/initial.txt`와 `connection/worker`; C-RESOURCE `workspace.inspect`; IMP-30 §4.1; SHARED-APIS cross-domain은 registry 이름 호출
- Evidence: materialize 포트는 envelope/secretFiles/wantBytes/checkoutPath를 드롭한다. planner의 sourceSnapshotPins 객체는 compiler가 거절한다. `serviceCtx.principalId='service:mahasd'`에 principal/grant 행이 없어 `workspace.inspect`/`context.build` 내부 호출이 숨은 연산으로 거절된다. launch `deps.call`은 요청자 ctx를 쓰므로 operator 경로의 context.build는 우회할 여지가 있으나, checkout-scoped 구성품은 serviceCtx다. stdin은 host `ProcessSpec.initialStdin`에 실리지 않는다.
- Consequence: Finding 5를 고쳐도 이번 요구사항 본문과 bootstrap credential이 실행 루트/프로세스에 없다. join/accept 지시 생성기는 파일에 붙지 않는다. Codex checkout skill 등 scope='checkout' 설치가 조성 root에서 항상 거절된다.
- Requested correction: 어댑터가 MaterializeRequest 전체를 `materializeBundle`에 전달한다. prepare는 `{path,digest}[]` snapshot pin. 내부 makeCaller용 service principal+좁은 grant를 seed하거나, 인증된 controller service context에 `visibility:'service'`를 명시 허용한다. stdin 바이트는 spec 필드로 host가 읽게 한다.
- Target: IMP-30 (adapter/seed), IMP-19 (prepare/start payload), IMP-11 (service visibility)
- Consumers to re-review: REV-03 F6, REV-05 F7, REV-06 F7

**7. [implementation] 공유 HostSession을 reconcile이 닫고, C-HOST 요청/응답 모양이 mahasd가 읽는 모양이 아니다**

- Location: `packages/mahas-runtime/src/composition.ts:97-120,213-225,282-318`; `packages/mahas-runtime/src/main.ts:269-273,309,435`; `packages/mahas-runtime/src/lifecycle/reconcile.ts:192-284,325-384`; `packages/mahas-runtime/src/lifecycle/operations.ts:74-96`; `packages/mahas-runtime/src/recovery/{identity-probe.ts:229-264, stop.ts:308-341, reconciler.ts:269-275}`; `packages/mahas-execution-host/src/{host.ts:511-516, process-manager.ts:327-347,414-428,508-557,616-625}`
- Contract: C-HOST; S-LIFECYCLE §3/§5; REQ-12/14/15; C-RECOVERY restart algorithm
- Evidence: `hostClient`/`hostClientByEndpoint`는 맵의 기존 세션을 liveness 검사 없이 재사용하고, `fenced.close`는 소켓을 닫아도 맵 엔트리를 남긴다. startup/recovery probe·stop·inventory가 `finally { client.close() }`. reconcile의 두 번째 `host.hello`는 endpoint-file token 없이 이미 인증된 세션에 보내 host가 `UNAUTHENTICATED`로 거절한다. IMP-22 `reconcileExecutions`(probe + birth compare + orphan quarantine)는 배선되지 않고, 배선된 `judgeExecution`은 inventory `pid != null`을 live로 본다. host probe는 `payload.processIncarnation`/`spawnNonce`를 읽고 mahasd는 `expectedProcessIncarnation`만 보낸다 — `procs.get('')`. stop 응답은 `{stop:{outcome:'exited'}}`인데 mahasd는 `res.outcome`을 본다. spawn reject도 같은 래핑 불일치로 `START_UNKNOWN`.
- Consequence: compose attach 직후 첫 `runtime.reconcile`(부팅 포함)이 host 제어를 끊는다. 이후 managed spawn/stop/reattach는 `CONTROL_UNAVAILABLE`이거나 unverifiable이다. hello를 고쳐도 필드명·boot 알고리즘이 남으면 확정 OS 결과가 unknown으로 접히고, pid 존재를 live로 승격할 수 있다. REQ-12 재부착과 REQ-13 스폰 단계가 실행면에 닿지 않는다.
- Requested correction: composition-owned 세션을 recovery가 close하지 않는다(전용 dial 또는 close 없는 borrow). 닫힌 세션은 맵에서 제거. 이미 인증된 연결에 token 없는 hello를 보내지 않는다. `runtime.reconcile`이 `reconcileExecutions`를 탄다. host/mahasd 필드명(`processIncarnation`, nested `spawn`/`stop`/`effect.state`)을 한쪽으로 고정하고 OS reject는 `exited`+rejected다.
- Target: IMP-23 (session/boot), IMP-22 (probe/stop/reconciler), IMP-18 (host alias)
- Consumers to re-review: REV-05, REV-06 (C-HOST 와이어). 필드명이 계약으로 올라가면 C-HOST 문서도.

**8. [implementation] 정산·wake 공개 연산이 없고, 있는 dispatch 경로도 시도 생성 불변식을 우회한다**

- Location: `packages/mahas-runtime/src/coordination/index.ts:56-86`; `packages/mahas-runtime/src/api/registry.ts:126-127,144`; `packages/mahas-runtime/src/composition.ts:339-359`; `packages/mahas-runtime/src/coordination/member.ts:791-1139`; `packages/mahas-runtime/src/coordination/{dispatch-authority.ts:104-137,365-394; input-resolver.ts:141-163; eligibility.ts:64-72,210-234}`
- Contract: C-WORK `task.report`/`outcome.decide`; C-LAUNCH `execution.wake`; D-MAIL §4–5; REQ-17/20; IMP-21 instruction §4·§6
- Evidence: 지시된 `coordination/{outcome,settlement,handoff}.ts`, `mail/{wake-service,continuation}.ts`가 없다. outcomes 정본 writer가 smoke 외 없다. 미등록 이름은 `UNAVAILABLE_OPERATION`. HANDOFF의 “IMP-21 = acceptance + dispatch settlement”는 `task.accept`/`settleDispatch`이지 report/decide가 아니다. `task.dispatch`는 assignee pin·covering assignment·accepted settlement·`buildTaskEnvelope` reportContract를 건너뛴다. eligibility `latestOutcome`은 `task_id`만 보고 `task_revision`을 보지 않는다.
- Consequence: 담당자 report와 지정 수용이 호출 불능이다. 후행 Task는 `task-output`을 영원히 못 핀한다. 흐름의 “정산” 단계에 interface가 없다. Finding 8이 닫힌 뒤에도 F5 우회와 revision-less outcome 소비가 남으면 폐기된 요구사항의 결과가 새 spec의 성공이 된다.
- Requested correction: `(taskId, taskRevision, dispatchId)`에 checkAttemptAuthority로 Outcome을 기록하고, owner-declaration은 같은 tx Settlement, designated-acceptance는 해당 outcome revision에만 `outcome.decide`. accepted output은 ArtifactRef handoff만 후행 resolver가 쓴다. `execution.wake`는 ContinuationGrant·safe recipe·budget·같은 operation key. `task.dispatch`는 `createDispatch`/`pinInputs`/`reserveDispatch`를 탄다. 등록 전까지 grant 어휘와 nextAllowedActions에서 이름을 빼거나 미구현으로 명시한다.
- Target: IMP-21. dispatch 불변식 정렬은 IMP-14. eligibility revision 한정은 IMP-13
- Consumers to re-review: REV-04, REV-07 (report/accepted 표시), REV-06 (등록 분류)

**9. [implementation] 첫 Dispatch phase `'assigned'`는 join이 승격하지 못해 `task.accept`가 실패한다**

- Location: `packages/mahas-runtime/src/launch/start-coordinator.ts:602-605`; `packages/mahas-runtime/src/launch/join.ts:256-263`; `packages/mahas-runtime/src/launch/acceptance.ts:159-243`
- Contract: D-WORK §2 phase 어휘 `reserved/starting/awaiting_join/awaiting_accept/...`; C-WORK `task.accept` 전제(join 완료, active Dispatch); C-LAUNCH
- Evidence: `'assigned'`는 어휘와 join UPDATE 집합에 없다. join 성공이 dispatch를 움직이지 않아도 된다. accept는 `awaiting_accept`만. 재사용 `task.dispatch`는 처음부터 `'awaiting_accept'`를 넣어, 이미 조인된 실행에서만 accept가 가능하다. 생성기가 세 개다.
- Consequence: Finding 1–7을 고쳐 프로세스가 떠도 최초 스폰된 task worker는 초기 지시의 `task.accept`를 완료하지 못한다. 인수·assignment Delivery ack 원자성(IMP-20)은 재사용 경로에서만 의미가 있다. 협업 단계의 입구가 start 경로에서 닫힌다.
- Requested correction: `admitDispatch`가 D-WORK phase(`reserved` 또는 `awaiting_join`)를 쓰거나, join 필터가 start가 기록한 phase를 승격한다. 가능하면 첫 시도도 `reserveDispatch`를 탄다.
- Target: IMP-19 (phase 기록), IMP-20 (join/accept 소비자)
- Consumers to re-review: REV-04 F7, REV-05 (start receipts)

**10. [implementation] 정리 면이 선언만 있고 배선되지 않는다 — release 미등록, shutdown이 stop을 안 보내고, UI 탭 close가 process kill이다**

- Location: `packages/mahas-runtime/src/recovery/index.ts:8-38`; `packages/mahas-runtime/src/recovery/reconciler.ts:903-1118`; `packages/mahas-runtime/src/main.ts:274-278`; `packages/mahas-runtime/src/lifecycle/shutdown.ts:141-152`; `src/renderer/src/components/LeafPane.tsx:207,232-236`; `src/main/runtimeClient.ts:211-216,255-275`; `src/renderer/src/types.ts:49-54`
- Contract: C-LAUNCH `worker.release`; C-RECOVERY `runtime.shutdown` drain-and-stop; C-CLIENT `terminal.detach`/`client.view.unbind`; S-ARCH §5 UI close = detach; REQ-12/16
- Evidence: `makeReleaseHandler`는 있으나 register되지 않는다. lifecycle는 compose 전에 `caller: null`로 생성되고 이후 대입되지 않는다. `ComposedRuntime`은 caller를 export하지 않는다. 창 닫기는 daemon을 유지하지만 탭 X/Restart는 `pty.kill`이며 renderer는 `exec:bindView`를 한 번도 호출하지 않는다.
- Consequence: 확인된 stop 뒤 leftover claim을 공개 op로 놓을 수 없다. operator drain은 프로세스를 신호하지 않은 채 stage를 완료로 기록할 수 있다. 운영자는 탭 닫기를 관측 해제와 실행 종료로 동시에 읽는다. 관리 Execution이 붙어도 같은 버튼이 worker를 죽인다.
- Requested correction: `makeReleaseHandler`를 recovery registry에 등록한다. compose 후 `makeCaller`를 `MahasdLifecycle`에 주입하고 drain이 generation/incarnation을 담아 `worker.stop`을 보낸다. managed 탭 close는 unbind/detach, stop은 별도 명령. Restart는 관리 Execution에 대해 자동 새 spawn이 아니다.
- Target: IMP-22 (release), IMP-23/IMP-30 (shutdown caller), IMP-28 (desktop close/bind)
- Consumers to re-review: REV-05, REV-07

**11. [spec] 교차 경계 와이어가 한 스키마로 고정되지 않아 각 IMP가 방언을 정본처럼 구현한다**

- Location: `mahas-architecture/spec/domains/rdd.md:32-36`; `mahas-architecture/spec/contracts/model.md:6-7,53-57`; `mahas-architecture/spec/contracts/work.md:7,73,87`; `mahas-architecture/spec/domains/work.md:13`; `mahas-architecture/spec/domains/messaging-outcomes.md:14,31`; `packages/mahas-contracts/src/{rdd.ts:190-280, work.ts:167-205, role.ts:55-73,165-175}`
- Contract: C-MODEL “typed edit의 완전한 종류와 필수 payload는 D-RDD §3”; C-WORK PlanPatch; C-REALIZATION injectionRecipe; S-STORAGE payload JSON은 domains/C-*를 따른다
- Evidence: TypedModelEdit 필드 스키마가 D-RDD §3에 없고 IMP-02 평탄 유니온과 IMP-04 중첩 `ModelEdit`가 공존한다. PlanPatch task 항목·InputBinding 위치(`taskId` vs `identity.taskId`)·disposition 키(`action` vs `disposition`)·settlement 문자열(`accepted` vs `accept`)이 문서·계약·eligibility·resolver·작업대에서 각각 다르다. RoleInterface `requirements_json`은 계약 `{responsibilityRefs, contextRequirements}`가 아니라 `DerivedRequirement[]`다. ProfileRecipe vs LaunchRecipe는 C-REALIZATION이 “launch가 소비할 recipe”라고만 하고 필드 집합을 고정하지 않는다. C-HOST nested `spawn`/`stop` vs 평탄 `state`도 같다.
- Consequence: 구현자가 각자 합리적인 별칭을 고르면 조인 실패가 spec 위반으로 판정되지 않는다. Finding 4–7의 상당은 이 공백에서 자란다. 계약 변경 없이 한쪽만 고치면 다른 소비자가 다시 깨진다.
- Requested correction: D-RDD/C-MODEL에 TypedModelEdit 필드 스키마를, C-WORK/C-MAIL에 PlanPatch·InputBinding·Settlement.decision을, C-REALIZATION/S-INJECTION에 LaunchRecipe·bundle manifest 필드명을, C-HOST에 probe/stop/spawn/effect 래핑을 한 세트로 적는다. 별칭을 허용하려면 서버가 명시 번역하고 미지 필드는 거절한다.
- Target: 명세 소유 (해당 C-*/D-*). 소비자 IMP-02/04, IMP-07/08/09/19/24/25, IMP-13/14/21/31, IMP-18/22
- Consumers to re-review: 계약이 움직인 모든 REV. 팀장이 재검토 범위를 정한다 — 과거 review를 새 코드에 자동 승계하지 않는다.

## Residual blockers by IMP owner

조인을 막는 잔여만. 괄호는 원 관측. 국소-only는 표 밖에 적는다.

| IMP | join blocker |
| --- | --- |
| IMP-06 | published만 가용; selectionToken에 impl digest; locate를 `resolveTerritory`와 동일하게 (REV-01 F3–F5) |
| IMP-07 | RoleInterface 의미 문장; `requirements_json` 계약 객체; `recipe_json`=LaunchRecipe; admit attestation revision (REV-01 F9–F10, REV-03 F1–F2, REV-06 F2) |
| IMP-08 | compiler 입력을 IMP-07 저장 DTO와 하나로 (REV-03 F3) |
| IMP-09 | materializer parser = compiler manifest (REV-03 F4) |
| IMP-10 | 빈 대상 deny; AssignmentGrant에 task/role/boundary targets; `grantRevisions`를 credential에서 (REV-02 F3/F6) |
| IMP-11 | `resolveTargets` 없는 mutation 거부; `visibility` 집행; service principal 경로 (REV-02 F3, REV-06 F7) |
| IMP-12 | 두 소켓 bind; worker hello verify; CLI operator fallback 제거 (REV-02 F1–F2, REV-06 F1) |
| IMP-13 | candidate 거부; provisioning을 활성 행으로; `resolveRevisions`/`resolveTargets`; coordinatorRole 고정 (REV-01 F6/F8, REV-02 F9, REV-04 F3) |
| IMP-14 | InputBinding 코덱 단일화; outcome을 `task_revision`으로 pin (REV-01 F11, REV-04 F6) — IMP-21 writer보다 먼저 |
| IMP-16 | workspace `assertLease`가 TTL을 사망으로 쓰지 말 것 (REV-05 F8) — Finding 7 수정 후 노출 |
| IMP-17 | 인증된 세션에 token 없는 hello 금지; lease TTL vs epoch fence 일치 (REV-05 F1/F8) |
| IMP-18 | `expectedProcessIncarnation` alias; spawn/stop/effect 래핑; stdin ContentRef (REV-05 F2/F7) |
| IMP-19 | `writeWorkerConnection`; phase 어휘; spawn을 닫힌 tx 밖으로; executable을 argv[0]; stdin on spec (REV-02 F5, REV-04 F7, REV-05 F4 of launch) |
| IMP-20 | `authenticateWorkerCredential`을 serveRpc에; join이 start phase를 승격; `assignment.show` 구현 또는 미등록 (REV-02 F1, REV-04 F7, REV-06 F4) |
| IMP-21 | `task.report`/`outcome.decide`/`execution.wake` 구현·등록; `task.dispatch`가 `createDispatch`를 타게 (REV-04 F1/F5) |
| IMP-22 | `worker.release` 등록; `reconcileExecutions`를 boot에; native-resume/fresh가 새 generation start를 만들게 (REV-05 F3/F4/F6) |
| IMP-23 | 공유 session close 금지; shutdown에 caller 주입; inventory pid≠live (REV-05 F1/F3/F5) |
| IMP-24/25 | documented draft가 LaunchRecipe+native routes를 내게 (REV-03 F5, REV-06 F2) |
| IMP-28 | managed close=detach; Restart≠자동 새 spawn; `runtime.snapshot`을 화면에 (REV-07 F1–F2) |
| IMP-29 | restore 시 credential revoke + join 거부 국면 (REV-05 F9) — Finding 7 수정 후 |
| IMP-30 | authenticator/seed/service grant/harness-config import/materialize adapter/lifecycle caller — 이 기록의 조성 결함 |
| IMP-31 | 작업대 context 바인딩과 C-DISCOVERY/C-WORK 필드명 (REV-04 F3–F4, REV-07 F3) |
| IMP-32 | inspector 화면 마운트; view model을 `context.inspect` attached[]에 (REV-07 F4) |

국소이며 이 조인을 단독으로 막지 않음: IMP-02/04 TypedModelEdit 방언(내부 model.change는 런타임 방언으로 동작; 계약 클라이언트가 생기면 Finding 11), IMP-03 저장 경계(REV-01 정합), IMP-15 `inbox.wait` tx(mail send/ack는 존재), IMP-26 `observation.ingest` 의도적 미등록(정직), IMP-27 분류 UI 부재(연산은 있음).

## Independent verification vs this review

REV-08이 수행하지 않은 것 — 실행 성공/실패를 관측 사실로 쓰지 않는다.

- mahasd / execution-host 기동, `startupReconcile`의 실제 hello 실패, host socket close 후 `CONTROL_UNAVAILABLE` 재현
- CLI `readWorkerConnectionFile` 파싱 거절, `--as operator` fallback의 런타임 권한 확대
- `worker.prepare`에 documented Claude/Codex profile을 넣었을 때의 `INJECTION_UNSUPPORTED`
- `task.report` 호출의 `UNAVAILABLE_OPERATION` (코드상 미등록으로 추론)
- workbench 클릭, Electron `exec:op`, tab close → `pty.kill`
- crash injection, lease TTL 120s 만료, backup restore 후 join
- typecheck/lint/build, HANDOFF가 인용한 smoke/e2e (37 passed 등) — 컴파일 성공은 조인 수락이 아니다
- VER-01..12, 실제 하네스 수락(VER-09..11)

이 기록의 판단은 호출 그래프·등록부·필드명·기본값의 정적 대조다. “부팅 직후 host 세션이 닫힌다”는 `close()`가 공유 세션에 연결되었다는 코드 경로 추론이며, 로그로 관측한 실패가 아니다.

## Limitations

- REV-01..07을 파일 단위로 재수행하지 않았다. 교차 테마로 지정된 인용 줄은 이 revision에서 재확인했다. 인용 밖 국소 수정이 있었다면(없음 — 소스 diff 0) 놓쳤을 수 있다.
- HANDOFF의 통합 e2e 스크립트는 커밋되어 있지 않아 `surface.describe → project.create → … → responsibility.search` committed 주장을 재실행하지 않았다. 그 경로가 일부 열려 있어도 이 기록의 이후 단계(배정 CAS, prepare recipe, host reconcile, report) 공백을 메우지 않는다.
- packaged desktop이 daemon을 스폰하지 않는 것은 정직한 client이며 결함으로 재분류하지 않았다. dev `ensureControlPlane`이 두 daemon을 띄우는 것은 확인했으나, 그 부팅이 Finding 7의 reconcile close와 맞물리는지는 실행하지 않았다.
- same-uid 소켓/파일 접근은 spec이 비목표로 둔다. Finding 1은 논리 API가 credential을 검증하지 않는다는 점이며, OS 격리를 요구하지 않는다.
- 명세 Finding 11이 해결되기 전에 구현만 맞추면 다른 소비자가 깨질 수 있다. 계약 변경의 재검토 범위는 팀장이 정한다.
- 코드를 수정하지 않았다.
