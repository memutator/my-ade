# ReviewRecord — REV-02 (reviewer: grok)

> 본 기록은 grok 병렬 리뷰 산출이다. 검토 대상은 `mahas-architecture` 워킹트리(codeRevision `8f6959457a8fc965c110dea79d533e53cf07326c`, specRevision `99eb5f5`)의 packages 구현체다.

- reviewTaskId: REV-02
- codeRevision: 8f6959457a8fc965c110dea79d533e53cf07326c
- specRevision: 99eb5f5
- scope: IMP-10/11/12/13/19/20의 명령 비노출·권한·위임 경계. `packages/mahas-runtime/src/access/*`, `api/{admission,registry,surface,handler-ports}.ts`, `rpc/{local-server,operator-auth,worker-auth,operation-get,client,framing,endpoints}.ts`, `packages/mahas-cli/src/*`, `coordination/{index,member,run,internal}.ts`, `launch/{start-coordinator,join,acceptance,bootstrap-credential,worker-connection,planner,index,deps}.ts`, `composition.ts`, `main.ts` 기본 authenticator, `src/main/runtimeClient.ts` `exec:*` IPC, `packages/mahas-contracts/src/{access,ops,common}.ts`를 REQ-09/10/14/15 · D-ACCESS · C-ACCESS · C-DISCOVERY · C-LAUNCH와 대조. 실행 공격 시험은 하지 않았고 코드 경로만 추적했다.
- disposition: changes-required

## Verified aligned

- **Child grant 축소 (`grant.ts:327-375`)**: 자식은 parent actions 부분집합, expiry ≤ parent, provisioning은 provisioning 부모만, continuation은 provisioning 부모에서 파생 금지, `profileAdmission` 완화 금지. `requiredActions` 문자열은 grant 행을 만들지 않는다.
- **RDD contains 자동 승격 없음 (`actual-targets.ts:203-220`)**: boundary hop은 modelVersion뿐이고 부모 책임 경계로 올라가지 않는다. 요청의 `roleId`/`from`만으로 허용하지 않고, resolver가 붙은 경우에는 DB 행으로 확장한다.
- **Mail 자기 mailbox (`mail/inbox.ts:122-131`, `mail/shared.ts:152-176`)**: inbox는 payload member가 아니라 `ctx.memberId`의 현재 generation이다.
- **`execution.join` 대리 거부 (`launch/join.ts:138-157`)**: handler는 `ctx.executionId === payload.executionId`를 요구한다. 다만 아래 F1 때문에 기본 authenticator는 `executionId`를 비워 두어 이 검사는 현재 항상 실패하거나, operator impersonation 경로와 맞물린다.
- **CLI help/completion은 `surface.describe` (`mahas-cli/src/main.ts:322-395`, `dynamic-help.ts:1-7`)**: 정적 명령 사전을 복제하지 않는다. raw RPC는 같은 `OperationRegistry.dispatch`를 탄다 (`rpc/local-server.ts:276-279`).
- **`access.revoke` 자체는 in-flight를 미실행으로 고치지 않는다 (`revocation.ts:7-10,131-174`)**: `prepared|attempting|unknown` effect id만 보고한다. 거짓 미실행 확정은 revoke 모듈이 아니라 worker.start admission rollback(F4)에 있다.
- **D-ACCESS §4 문장**: native tool allowlist ≠ mahas API, shell OS 접근은 추가 sandbox 없이 완전 통제되지 않음을 spec은 명시한다. CLI/UI 카피는 그렇지 않다 (F2, F9).

## Findings

**1. [implementation] hello authenticator가 client `principalId`를 신뢰하고 worker secret을 검증하지 않으며, worker/operator 소켓이 하나다**

- Location: `packages/mahas-runtime/src/main.ts:353-378`; `packages/mahas-runtime/src/composition.ts:148-171,265-268`; `packages/mahas-runtime/src/launch/bootstrap-credential.ts:160-187`; `packages/mahas-runtime/src/rpc/local-server.ts:310-314,315-318`; `src/main/runtimeClient.ts:64-72,281-293`
- Contract: C-ACCESS §1 worker/operator endpoint·credential 분리, fallback-admin 금지; D-ACCESS §3 bootstrap credential은 join/assignment.show/surface.describe/operation.get(자기 것)만, secret은 worker private 전달; REQ-09 raw RPC도 현재 grant·실행·실제 대상으로 검사; IMP-12 §4.1, IMP-20 §4.1/§4.3
- Evidence: 기본 `authenticate`는 `credential.principalId ?? 'operator-local'`만 찍고 `grantRevisions: {}`, `executionId`/`memberId` 없음. `verifySecret` / `authenticateWorkerCredential`은 호출되지 않는다. `serveRpc`는 `mahasd.sock` 한 개만 bind한다. `seedLocalOperator`는 그 principal에 `{kind:'*',id:'*'}`와 `OPERATION_NAMES` 전체 action을 넣는다. local-server 주석은 “두 소켓, fallback 없음”을 말하지만 main은 그렇게 조립하지 않는다. desktop `exec:op`도 `{kind:'operator'}`로 같은 소켓에 붙는다.
- Consequence: 공격 입력 (worker PTY, 동일 OS user): hello `{principalId:'operator-local'}` 또는 `{kind:'operator'}` 후 `access.grant` / `access.policy.publish` / `access.revoke` / `operation.get`. 서버는 operator-local의 wildcard grant로 인가한다. `{principalId:'<기존 member id>'}`면 그 멤버의 활성 grant 전부를 쓴다 (`authorize.ts:305-315`). `operation.get`은 `principalScope = ctx.principalId`이므로 operator 영수증 본문을 재조회한다. launcher 대리 `execution.join` 거부는 ctx.executionId가 없어서 의미 있는 bootstrap 경로가 열리지 않는다.
- Requested correction: worker 소켓과 operator 소켓을 분리하고, worker hello는 `authenticateWorkerCredential`만 통과시킨다. operator hello는 operator connection proof만 받는다. client가 고른 `principalId`/`memberId`/`executionId`를 context에 복사하지 않는다. `grantRevisions`·execution generation을 credential 행에서 채운다.
- Target: IMP-12 (transport 구분·auth 배선). IMP-20 verify 함수 연결, IMP-30 `main.ts` 기본 authenticator.

**2. [implementation] worker CLI는 env를 지우거나 `--as operator`로 operator 연결에 fallback한다**

- Location: `packages/mahas-cli/src/connection.ts:50-55,105-110`; `packages/mahas-cli/src/main.ts:108-112`; `packages/mahas-runtime/src/launch/start-coordinator.ts:983-988`; `packages/mahas-runtime/src/rpc/operator-auth.ts:83-88`
- Contract: D-ACCESS §3 “CLI env를 지웠다고 operator 연결로 fallback하지 않는다. operator socket/credential은 별도 명시 실행 경로다.”; C-ACCESS “worker mode에 fallback-admin 경로를 두지 않는다.”
- Evidence: `inferRole`은 `MAHAS_CONNECTION_FILE`이 없으면 operator다. `--as operator`는 명시 override. `resolveWorker`의 “no admin fallback” 오류는 role이 이미 worker일 때만 도달한다. spawn env는 `MAHAS_CONNECTION_FILE`과 함께 `MAHAS_ENDPOINT`에 **operator** `deps.endpoint`를 넣는다. operator 파일 부재 시 credential은 secret 없는 `{kind:'operator'}`이고, F1 authenticator가 이를 operator-local로 승격한다.
- Consequence: 공격 입력: worker 셸에서 `unset MAHAS_CONNECTION_FILE MAHAS_ROLE; mahas access grant --input ...` 또는 `mahas --as operator access grant ...`. 논리 API의 worker 최소 위임이 한 프로세스 안에서 operator grant로 바뀐다. `connection.ts:57-61` 주석과 동작이 모순된다.
- Requested correction: worker로 스폰된 프로세스(또는 한 번 worker connection을 본 프로세스)는 env 삭제·`--as operator`로 operator endpoint/credential을 고르지 못하게 한다. operator는 별도 명시 connection file + operator socket만 사용한다.
- Target: IMP-12.

**3. [implementation] 대부분의 operation이 `resolveTargets` 없이 등록되고, 빈 대상은 grant scope를 통과한다**

- Location: `packages/mahas-runtime/src/api/admission.ts:202-207,285-288,312-314,368-376`; `packages/mahas-runtime/src/access/grant.ts:237-244`; `packages/mahas-runtime/src/coordination/index.ts:60-86`; `packages/mahas-runtime/src/launch/index.ts:23-48`; `packages/mahas-runtime/src/access/operations.ts:70-75,491-495`; `packages/mahas-runtime/src/mail/index.ts:26-47`; `packages/mahas-runtime/src/model/ops.ts:646-665`; `packages/mahas-runtime/src/rpc/operation-get.ts:63-67,83-105`. resolver가 있는 쪽은 `launch/join.ts:490,512,533`과 resource/materialize 일부뿐이다.
- Contract: D-ACCESS §2 actualTargets는 DB의 Task→Role→Boundary, Delivery→recipient, Artifact→Dispatch, ChangeSet touched set에서 구한다. “request의 roleId/boundaryId/from은 요청 intent이지 인증 근거가 아니다.” IMP-11 §4.1/§4.4; REQ-09
- Evidence: `resolveTargets` 부재 시 admission은 `[]`를 인가한다. `scopeCoversTargets`는 `targets.length === 0`이면 `{covers:true}`다. 따라서 “이 action 이름을 가진 활성 grant가 하나라도 있으면” 대상 범위와 무관하게 pre-handler·in-tx·pre-commit authorize가 통과한다. 돌연변이 replay(admission.ts:228-242)도 같은 빈 대상으로 읽기 권한을 재검사했다고 친다. `OperationSpec.visibility` (`'service'|'operator'|…`)는 admission이 읽지 않는다. `taskSpec.create`/`dispatch.settle` 등 내부 op는 같은 worker-facing registry에 handler와 함께 올라 있다 (`dispatch-ops.ts:19-21,208-220`) — 기본 seed grant 어휘에는 없어 지금은 안 보이지만, 이름이 grant에 적히면 빈 대상으로 실행된다.
- Consequence: 공격 입력: member grant `actions`에 `team.assign`/`model.change.commit`/`artifact.read`가 있고 `scope.runId=run-A`일 때, payload `{runId:'run-B'}` / 다른 ChangeSet id. admission은 대상을 보지 않는다. handler가 자체 `authorize(ctx, op, [{kind:'run', id}])`를 호출하는 연산(team.assign, run.create, mail)은 한 겹 더 막히지만, 등록만 된 launch/model/access.inspect/operation.get/내부 dispatch op는 파이프라인 인가가 사실상 action-name allowlist다. F1과 겹치면 operator-local의 전 action이 대상 검사 없이 열린다.
- Requested correction: 대상이 있는 모든 op에 DB 기준 `resolveTargets`를 단다. resolver 없는 mutation은 등록을 거부하거나 빈 대상을 deny로 둔다 (`[]` 자명한 허용 삭제). replay도 저장된 실제 대상(또는 재resolve)으로 재인가한다. service-only 이름은 worker registry에 올리지 않는다.
- Target: IMP-11 (admission 기본 거부·visibility 집행). 각 op resolver는 IMP-10/13/19/해당 domain.

**4. [implementation] worker.start가 외부 spawn을 admission write tx 안에서 수행하고, pre-commit deny / `GRANT_REVOKED`를 미실행으로 확정할 수 있다**

- Location: `packages/mahas-runtime/src/api/admission.ts:246-258,309-315`; `packages/mahas-runtime/src/launch/index.ts:32-39` (`mutation: true`); `packages/mahas-runtime/src/launch/deps.ts:200-210`; `packages/mahas-runtime/src/launch/start-coordinator.ts:102-108,333-382,447-455,692-697,1020-1088`
- Contract: D-ACCESS §4 “외부 spawn 직전에 plan에 대한 current permission을 확인하고 effect key를 기록한다. 그 직후 revoke가 발생하면 이미 시작했을 수 있는 process를 미실행으로 돌리지 않는다.”; C-ACCESS `access.revoke` “inFlight 존재시 gone/never-started로 표시 금지”; REQ-14 timeout/ambiguous를 미실행으로 판정하지 않음; C-LAUNCH worker.start 전제
- Evidence: admission은 handler 전체를 `BEGIN IMMEDIATE`에 넣고, handler return 뒤 다시 `authorize`한 다음 COMMIT한다. deny면 ROLLBACK. `tx()`는 이미 열린 트랜잭션이면 inline이다. `stageProcessAttempting`은 그 안에서 effect를 `attempting`으로 기록한 뒤 `host.process.spawn`을 await한다. spawn **직전** grant 재읽기는 없다 (마지막 확인은 `inputs_pinned`, 그 사이 resource/materialize). spawn 이후 pre-commit authorize가 실패하면 SQLite는 `effect_intents`/`executions` insert를 되돌리지만 호스트 프로세스는 남는다. `SPAWN_NEVER_ADMITTED`에 `GRANT_REVOKED`가 들어 있어, attempting 기록 이후 그 코드를 받으면 effect를 `rejected`로 두고 `liveness:'exited'`로 분류한다. 같은 시각 `access.revoke`의 in-flight 조회는 롤백된 행을 보지 못한다.
- Consequence: 공격/경합 입력: `worker.start`가 host.spawn을 보낸 직후 같은 grant를 `access.revoke`. 호출자는 `rejected`/`GRANT_REVOKED` 영수증(미실행처럼 보임)을 받고, revoke 결과는 `inFlightEffects: []`인데 프로세스는 살아 있다. 이후 새 worker API는 (F1이 고쳐진 뒤) 거부되어야 하지만, 원장은 “시작하지 않음”이다.
- Requested correction: effect key commit을 외부 호출 **앞**의 닫힌 트랜잭션으로 분리한다. spawn 직전 `recheckGrantSnapshot`/`pins.grant`를 다시 읽는다. 이미 `attempting`인 spawn의 `GRANT_REVOKED`는 unknown/in-flight이지 never-started가 아니다. pre-commit deny로 외부 effect를 무효화하지 않는다.
- Target: IMP-19 (핸들러 경계). admission이 긴 외부 effect를 한 write tx에 가두는 점은 IMP-11.

**5. [implementation] bootstrap credential 발급·파일·검증 경로가 서로 다른 계약이라 worker 논리 인증이 연결되지 않는다**

- Location: `packages/mahas-runtime/src/launch/start-coordinator.ts:835-900,983-988`; `packages/mahas-runtime/src/launch/initial-attachment.ts:387-401`; `packages/mahas-runtime/src/launch/worker-connection.ts:60-85`; `packages/mahas-runtime/src/launch/bootstrap-credential.ts:49-54,61-63,85-119,160-187`; `packages/mahas-runtime/src/rpc/worker-auth.ts:25-31,61-92`; `packages/mahas-runtime/src/rpc/endpoints.ts:22-24`; `packages/mahas-runtime/src/launch/join.ts:467-469`; `packages/mahas-runtime/src/access/authorize.ts:67-72,279-288`; `packages/mahas-runtime/src/composition.ts:371-416`
- Contract: D-ACCESS §3 bootstrap surface; C-ACCESS connection 파일 형태·path≠auth; IMP-20 §4.1 “raw secret 대신 connection handle”, §6 `bootstrap-credential`/`worker-connection`; C-LAUNCH execution.join은 bootstrap credential·exact pins
- Evidence: `issueBootstrapCredential` / `writeWorkerConnection` / `mahasdWorkerEndpoint`는 정의만 있고 start 경로에서 호출되지 않는다. 실제 파일은 `buildConnectionFile`이 `{protocolVersion, endpoint, executionId, generation, credential: <raw token string>}`를 쓴다. CLI `readWorkerConnectionFile`은 `{kind:'worker', credentialId, secret}`를 요구하므로 파싱 거부. `endpoint`는 operator `opts.endpoint`(mahasd.sock)이다. `execution_credentials.secret_hash`는 prefix 없는 hex (`deps.digest`)인데 `verifySecret`은 `sha256:<hex>` 또는 scrypt만 받는다. join 주석은 bootstrap 제한이 worker-auth의 `isBootstrapOperationAllowed`에 있다고 하나 그 함수는 transport에 연결되지 않았다. kernel bootstrap 분기는 `ctx.executionId`가 있을 때만 켜지며 F1은 그 필드를 안 넣는다.
- Consequence: 설계된 worker 최소 surface는 런타임에 도달하지 않는다. 에이전트가 스코프 CLI를 써도 연결 파일이 거절되고, env를 지우면 F2로 operator가 된다. secret hash 형식이 달라 나중에 authenticator를 연결해도 기존 행은 검증 실패한다.
- Requested correction: start는 `issueBootstrapCredential` + `writeWorkerConnection`(0600, worker endpoint, `{kind:'worker',credentialId,secret}`)만 사용한다. hash는 `verifySecret`이 아는 형식. worker-auth가 바인딩을 AuthenticatedContext로 옮기고 bootstrap 4개 op만 허용한 뒤 join에서 full surface로 승격한다. operator 소켓/파일을 worker env에 넣지 않는다.
- Target: IMP-20 (발급·join 연결). 파일/endpoint는 IMP-19, 소켓 bind는 IMP-12.

**6. [implementation] AssignmentGrant의 task/role/boundary 필드가 coverage에 쓰이지 않아 위임이 Run 전체로 열린다**

- Location: `packages/mahas-runtime/src/coordination/member.ts:140-186,564-590`; `packages/mahas-runtime/src/access/grant.ts:216-224,237-260`
- Contract: REQ-10 최소 위임; D-ACCESS AssignmentGrant는 boundary/task/contract 대상; “새 경계가 생겨도 묵시 확대 안 함”; C-ACCESS access.grant 상위보다 넓은 대상 금지
- Evidence: `team.assign`은 `scope: {runId, roleId, boundaryId, taskIds, placement, parentProvisioningGrant}`를 저장한다. `scopeEntries`는 `runId`/`memberId`/`targets`/`provisioning.placementScope`/`continuation.taskScope`만 TargetRef로 본다. `roleId`/`boundaryId`/`taskIds`는 무시된다. 따라서 task 멤버 grant는 해당 Task가 아니라 Run ancestor로 모든 같은 Run 대상을 덮는다. `requiredActionsFor('task')`는 그 Run에서 `artifact.read`/`message.send` 등을 준다.
- Consequence: 공격 입력: Run에 task 멤버 M1(T1), M2(T2). M1 credential이 실제 member로 붙는다고 가정하면 (F1/F5 수정 후) `artifact.read`/`message.send`의 대상이 T2/M2여도 grant scope 매칭은 `run:` 키로 성공한다. 핸들러가 member 자기 mailbox만 보는 inbox는 안전하지만, 대상 resolver가 빈 연산(F3)과 겹치면 Run 안 타 멤버 아티팩트/메시지를 논리 API로 읽는다.
- Requested correction: `GrantScope.targets`에 `{kind:'task',id}`, `{kind:'role',id}`, `{kind:'boundary',id}`를 정규화해 넣고 `scopeEntries`가 그것만 보게 한다. task assignment는 run-wildcard를 기본 주지 않는다.
- Target: IMP-13 (scope 기록). coverage 해석은 IMP-10.

**7. [implementation] 인가 거절 영수증이 AuthorizationDecision 전체(실제 대상·grant revision)를 worker에게 돌려준다**

- Location: `packages/mahas-runtime/src/access/authorize.ts:217-224,349-409,423-430`; `packages/mahas-runtime/src/api/admission.ts:156-169,205-212`
- Contract: D-ACCESS §1 AuthorizationDecision은 “서버 내부 진단. 타 대상 정보는 worker에게 누설하지 않음”; REQ-09 비노출
- Evidence: deny 시 `AccessError.details = {operation, targets, decisionId: outcome.decision}`이고 `decision`은 `actualTargets`/`grantRevisions`/`policyRevisions`/`reason`을 가진 객체다. admission `reject()`가 그 Error를 `CommandReceipt.error`에 넣는다. 필드 이름이 `decisionId`이나 값은 id가 아니다.
- Consequence: 공격 입력: 다른 run/task id로 거절되는 호출을 반복. 응답 details에서 실제 ancestor 대상과 다른 grant id를 수집한다. 숨겨진 대상의 존재·관계가 논리 API로 샌다.
- Requested correction: worker-facing error는 `code`+불투명 message(+자기 decision id 문자열)만. actualTargets/relations/다른 grant는 `authorization_decisions` 행에만 남긴다.
- Target: IMP-10.

**8. [implementation] CommandSurface digest가 help / prepare / join 세 갈래라 같은 policy projection이 아니다**

- Location: `packages/mahas-runtime/src/access/authorize.ts:547-618` (`surfaceForOn`: `{actions, schemas:{}, pins}`); `packages/mahas-runtime/src/api/surface.ts:60-99` (`projectCommandSurface`: `{actionsAndSchemas:{effectiveActions,schemas}, policyPins}`); `packages/mahas-runtime/src/launch/planner.ts:441-468` (`{actionsAndSchemas:{allowed}, policyPins:{grantId,…}}`); `packages/mahas-runtime/src/launch/join.ts:196-207,303-309`; `packages/mahas-cli/src/main.ts:333-341`; `src/main/runtimeClient.ts:277-293`
- Contract: D-ACCESS §3 / C-ACCESS “CLI/UI/MCP에 독립 명령 사전을 복제하지 않는다”; CommandSurface digest는 LaunchPlan/WorkerJoin pin; REQ-09 help/schema/completion/UI/MCP가 같은 projection
- Evidence: CLI help는 `surface.describe` → `projectCommandSurface`. admission 가시성은 IMP-10 `surfaceFor`(스키마 빈 digest). `worker.prepare`는 grant∩ceiling 배열만 해시하고 registry schema와 교차하지 않는다. join은 payload digest를 **plan 행**과 비교한 뒤 응답 `effectiveSurface`는 다시 `surfaceFor()`다. desktop `exec:op`는 surface 목록을 조회하지 않고 operator raw dispatch다. mahas 연산을 registry에서 뽑는 MCP adapter는 없고, 하네스 `mcp.json`은 role component 병합이다 (`mahas-harness-config/.../components.ts` — native MCP는 D-ACCESS §4가 별 정책으로 인정).
- Consequence: 에이전트 지침에 핀된 surfaceDigest와 이후 `surface.describe` digest가 구조적으로 불일치한다. 가시성 집합도 prepare의 `allowed` vs registry 교차 vs grant 원본이 갈린다. UI는 operator 전 명령 파이프라 역할별 비노출 목록을 보여 주지 않는다.
- Requested correction: 유일한 projection 함수(registry `describe` = grant∩ceiling∩registered+implemented+canonical schema)만 digest하고, prepare/join/CLI/UI가 그 digest를 핀·표시한다. UI 명령 팔레트도 그 목록에서만 생성한다. native MCP는 mahas surface가 아님을 UI에 적는다.
- Target: IMP-11 (정본 projection). prepare pin은 IMP-19, UI는 IMP-28/32.

**9. [implementation] ProvisioningGrant 한도가 team.assign 인가 경로에 없고, placement JSON 모양이 두 개다 — 강한 role spawn 검사가 공전한다**

- Location: `packages/mahas-runtime/src/coordination/internal.ts:513-530`; `packages/mahas-runtime/src/coordination/member.ts:329-384,511-525`; `packages/mahas-runtime/src/access/grant.ts:34-41,216-222`; `packages/mahas-runtime/src/access/provisioning.ts:39-64`; `packages/mahas-runtime/src/main.ts:361-366`
- Contract: REQ-10 ProvisioningGrant 없이 강한 역할 스폰 금지; D-ACCESS ProvisioningGrant `allowedRoleIds`/`placementScope`; C-DISCOVERY assignment.preview/team.assign은 provisioning allowlist를 재검사; C-LAUNCH verification grant는 경로·profile revision 제한
- Evidence: `checkProvisioning`은 `ctx.grantRevisions` 키만 스캔한다. 기본 authenticator는 `grantRevisions: {}`이므로 covering grant가 항상 없다 → 현재는 **fail-closed**(팀 배정 자체 불가). 동시에 kernel `provisioningAdmission`은 그 op의 인가 grant가 kind=provisioning일 때만 돌고, F3의 빈 대상이면 role/placement 한도를 보지 않는다. `access.grant`의 `placementScope`는 `TargetRef[]`인데 `checkProvisioning`은 `{hostIds, checkoutIds}`를 읽고, 배열에 `hostIds`가 없으면 placement 검사를 skip한다. `allowedRoleIds` 누락 시 `!Array.isArray(allowed)`라서 역할 필터도 skip한다 (issueGrant는 provisioning kind에 allowedRoleIds를 요구하지만 직접 SQL seed/변형은 우회 가능).
- Consequence: 지금 배정 API는 막혀 있다. F1/F5를 고쳐 grantRevisions만 채우면, placement TargetRef가 무시되어 허용 호스트 밖 spawn/assign이 통과할 수 있다. kernel 경로(빈 대상 + provisioning grant가 `team.assign` action을 포함)는 allowlist 없이 action 이름만으로 통과한다. 강한 role spawn의 실제 문은 연결되어 있지 않다.
- Requested correction: 배정 인가는 현재 활성 ProvisioningGrant 행(principal+kind)을 읽고, `allowedRoleIds`와 TargetRef placement를 kernel `provisioningAdmission`과 같은 함수로 적용한다. payload role 이름이 아니라 선택 토큰이 가리키는 실제 role 행을 대상으로 삼는다. `grantRevisions: {}`를 “grant 없음”이 아니라 “attestation 없음 → DB 현재 행”으로 일관되게 정의한다.
- Target: IMP-13 (`checkProvisioning`). 스코프 스키마 단일화는 IMP-10.

**10. [implementation] 제품 CLI/help는 worker 논리 권한 경계를 주장하지만, same-user shell 한계와 fallback을 표시하지 않는다**

- Location: `packages/mahas-cli/src/main.ts:244-273`; `packages/mahas-cli/src/connection.ts:57-61`; `packages/mahas-runtime/src/inspector/views.ts:11-14,401-432`; `packages/mahas-runtime/src/rpc/local-server.ts:338-341`; `mahas-architecture/spec/domains/access.md:34`; `src/main/runtimeClient.ts:70-71,218-293`
- Contract: REV-02 지시 5; D-ACCESS §4 (한계를 수락 시험 위협 모델에 **그대로** 기록); REQ-09 “비노출을 인증 또는 OS sandbox로 부르지 않는다”
- Evidence: spec 문장은 정직하다. CLI static help는 “every other verb is generated from YOUR surface”만 말하고, worker 프로세스가 같은 uid로 `~/.config/mahas/operator-connection.json`(0600)과 `mahasd.sock`(chmod 600, 같은 user 읽기 가능)을 열 수 있다는 사실을 쓰지 않는다. inspector는 allowed commands vs grants 섹션만 두고 OS 공유를 말하지 않는다. socket mode 600은 path≠auth이면서 same-user에게는 열린 파일이다. desktop은 렌더러가 `exec:op`로 임의 operation을 operator 세션에 넣는다.
- Consequence: 운영자/에이전트는 “connection file + surface = 권한”으로 읽게 되고, F1/F2가 그 믿음을 깨도 UI가 한계를 정정하지 않는다. native harness permission과 mahas API를 같은 샌드박스로 오해할 수 있다.
- Requested correction: CLI/inspector/작업대에 한 줄로 적는다 — mahas API grant는 same-user OS 접근(소켓 파일, config, checkout)을 막지 않으며, worker 셸에서 operator socket/file을 쓰는 것은 지원 경로가 아니다. 비노출/grant를 sandbox라고 부르지 않는다.
- Target: IMP-12 (CLI 카피). 작업대 표기는 IMP-32.

## Limitations

- 실행 공격·crash injection은 하지 않았다. 위 경합(F4)과 hello impersonation(F1)은 코드 제어 흐름에 따른 추론이며 VER-03 실행 증거가 아니다.
- typecheck/lint 성공을 수락으로 쓰지 않았다.
- mahas 연산을 MCP tool list로 투영하는 서버는 트리에 없다. 하네스 `mcp.json`은 별 정책(D-ACCESS §4)으로 보고, 두 번째 mahas 명령 사전으로 보지 않았다.
- C-HOST `host.*`는 mahasd worker registry에 등록되지 않아 raw 호출은 `UNAVAILABLE_OPERATION`이다. 그 점은 C-ACCESS와 맞다.
- `callerGrantsOfKind`가 비어 team.assign이 현재 fail-closed인 것은 권한 확대가 아니라 기능 정지이다. F9는 그 문이 잘못된 모양으로 열려 있다는 점만 적는다.
- 발견을 코드로 고치지 않았다.
