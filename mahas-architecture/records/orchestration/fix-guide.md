# 결함 수정 가이드 — VER-01/02/03 + drill/infra 증거 기반

각 항목: **증상(재현 증거) → 근본 원인(코드 위치) → 수정 방향 → 재검증**.
revision `83a6d21` 기준. fix 세션의 WIP가 이미 일부를 건드리고 있으므로
`status` 칸은 `orchestration/findings.md` 대장을 따른다.

---

## A. 인가 코어 (IMP-10 / IMP-13) — 치명 우회 4종 + contract gap

### F-018 member↔principal 비바인딩 — 임의 memberId를 임의 권한에 결합

**증상.** `principalId=worker` + `memberId=reviewer`인 ctx가 reviewer의 delivery를
`delivery.ack`로 커밋 (`status='acknowledged'` 영구 반영).
증거: `/tmp/mahas-ver-03/out/s3-bypass.json` check "memberId-swap ctx".

**근본 원인.** `access/authorize.ts`의 `decide()`는 `ctx.principalId`로 grant를
조회하고 `ctx.memberId`는 member-스코프 op에서 그대로 신뢰한다. 두 필드의
소유관계(`members.id` ↔ `principals.id`, 또는 `member_principal_bindings`)를
검증하는 단계가 없다. 소켓 authenticator(`main.ts:353-367`)도 memberId를 스탬프하지
않아 wire에서든 in-process에서든 ctx 조립자가 임의 조합을 주입할 수 있다.

**수정 방향.** ctx 조립 경계(authenticator + dispatch 입구)에서
`memberId`가 있으면 그 member의 bound principal이 `ctx.principalId`와 일치하는지
반드시 확인 — 불일치 시 `UNAUTHENTICATED`. member 테이블에 principal 열이 없으면
`members.id = principals.id` 동일성(member is its own principal, member.ts:570-572
주석과 일치)을 검사한다. 같은 검사를 `requireCurrentMember` 진입부에도 두어
in-process 경로도 막는다.

**재검증.** `s3-bypass.ts` memberId-swap check → `UNAUTHENTICATED` 기대.

### F-022 외부 grant attestation — grant id만 알면 타인 권한 차용

**증상.** lead ctx의 `grantRevisions`에 operator-local 소유 `provAll`
(`grt_aaee2913`)을 넣으면 `team.assign r-doc`이 커밋 — 생성된 member grant의
`parentProvisioningGrant=provAll`로 기록 (`mem_9af55cf9`, `mem_c5c5da41`).
증거: `out/s6-cover.json` foreign-grant check + grants 테이블 row.

**근본 원인.** `coordination/internal.ts` `callerGrantsOfKind`(L513-530)와
`recheckCallerGrants`(L494-510)가 `ctx.grantRevisions`의 각 grant id를 그대로
`SELECT … WHERE id=?` 조회 — `principal_id`와 `ctx.principalId` 일치 여부를
어디에서도 비교하지 않는다. `decide()`의 grant 조회는 principal-scoped인데
이 두 헬퍼는 그렇지 않아 경로별로 인가 모델이 갈라진다.

**수정 방향.** 두 함수 모두 조회 시 `principal_id=?`를 조건에 추가하거나,
조회 후 `grant.principalId === ctx.principalId` 검사해서 불일치를 `GRANT_REVOKED`
대신 `UNAUTHENTICATED`(혹은 무시+missing)로 처리. 단, delegation 체인에서
parent grant를 읽는 정당한 경로가 있으면 'attestation으로 차용'과 'lineage 참조'를
구분할 것 — provisioning coverage 판단에는 본인 소유 grant만 인정하면 된다.

**재검증.** `s6-cover.ts` check (c) → denied + member row 미생성.

### F-009 provisioning 제약 전면 무력화 — flat vs nested scope 키

**증상.** `provMember`(`scope.provisioning.allowedRoleIds=[r-auth,r-web]`,
`maxMembers=2`) 하에 lead ctx가 `team.assign r-doc`을 두 번 커밋
(`mem_544acd84`, `mem_2b457b15`). VER-01이 논리로 발견, VER-03이 wire-level
내구 row로 확정. allowlist·maxMembers·placementScope·profileAdmission·
allowedPolicyRevision **전부** 미적용.

**근본 원인.** `access/grant.ts:291-292`의 `access.grant`는 provisioning 설정을
`scope.provisioning{...}` **중첩**으로 검증·저장하는데,
`coordination/member.ts:362-383` `checkProvisioning`은
`scope.allowedRoleIds` 등 **flat** 키를 읽는다. `ProvisioningScope` 인터페이스
(L331-338) 자체가 실제 저장 형태와 어긋남. `scope.provisioning` 하위를 한 번도
안 여는 구조라 모든 `continue` 조건이 `undefined`에 걸려 vacuous pass.

**수정 방향.** `checkProvisioning`이 `const prov = scope.provisioning ?? scope`로
실제 중첩을 읽도록 통일 (grant.ts의 write 스키마가 정본). `ProvisioningScope`를
`scope.provisioning` 형태로 재정의하거나, 읽기 쪽에서 래퍼를 벗기는 단일 헬퍼
(`provisioningSection(scope)`)를 만들어 allowedRoleIds/maxMembers/
placementScope/profileAdmission/allowedPolicyRevision 다섯 경로 전부에 적용.
VER-01 s4의 token-only 경로(`decodeAndCheckToken` 결과로 role을 정한 뒤
provisioning 미호출 여부)도 같이 점검 — allowlist는 token이 아니라 grant가
권한 원천이어야 함.

**재검증.** `s6-cover.ts` (a) r-doc → SCOPE_DENIED, (b) r-web → committed.

### F-010/F-021 member grant scope가 자기 op·boundary를 커버 불가

**증상.** member의 assignment grant actions에 있는 op인데도:
- coordinator `responsibility.search` → SCOPE_DENIED (VER-01)
- `responsibility.inspect(own boundaryId)` → SCOPE_DENIED (VER-03 s6)

**근본 원인.** `access/grant.ts:237-260` `scopeEntries()`는 scope의
`targets`/`runId`/`memberId`/provisioning·continuation 중첩만 읽는다.
`team.assign`이 기록하는 assignment scope는 flat
`{runId, roleId, boundaryId, taskIds, placement, parentProvisioningGrant}`
(`member.ts:574-581`) → 사실상 scope = `[{kind:'run'}]` 하나.
게다가 `actual-targets.ts`에서 boundary의 실제 조상은 `modelVersion→project`이고
`run`은 조상이 아니므로, boundary를 require하는 op(`responsibility.inspect`)는
run-scope로는 **구조적으로 영원히** 커버 불가. 좁힘(taskIds/boundaryId)은
기록만 되고 읽히지 않고, 읽혀도 run이 boundary의 조상이 아니라 역방향으로도
깨져 있다.

**수정 방향.** 두 층의 수정이 필요:
1. `scopeEntries()`가 assignment scope의 `boundaryId`/`taskIds`를
   `{kind:'boundary'}`/`{kind:'task'}` 엔트리로 매핑 — 단, 역할의 boundary는
   "cover"가 아니라 "접근 가능한 책임 범위"이므로 run-scope가 member의
   run 내부 boundary를 어떻게 cover하는지 도메인 정본 확인 (spec D-ACCESS).
   run이 boundary들을 transitive로 소유한다면 `expandOne`에
   `run → modelVersion → boundary` 경로를 추가하거나, coverage 판정을
   "target이 scope 엔트리의 descendant" 외에 "같은 run에 속한 boundary"로 확장.
2. `team.assign` 기록 형태를 `scopeEntries`가 읽는 정정 스키마로 맞춤
   (`scope.targets` 배열에 boundary/task 엔트리를 넣는 방식이 이미 지원됨).

**재검증.** s6 r1 (own boundary → committed), r2/r3 (foreign → SCOPE_DENIED),
VER-01 s4 coordinator search → committed.

### F-019 자기 grant 자진폐기가 항상 rollback

**증상.** subject가 attested grant를 `access.revoke`로 폐기하면 handler가
revoke까지 수행한 뒤 admission post-check이 같은 grant를 재검사 →
`GRANT_REVOKED` → txn 전체 rollback, `revoked_at` NULL 유지. spec은 자진폐기 허용.

**근본 원인.** `api/admission.ts:311-314`의 commit-직전 재인가가
`ctx.grantRevisions`의 모든 attested grant의 liveness를 다시 본다 —
handler가 이번 op에서 폐기한 grant를 exempt하지 않는다.

**수정 방향.** post-check이 "이번 operation이 의도적으로 폐기한 grant id"를
통과시키도록 — e.g. `revokeGrantTree`가 반환한 revoked id 집합을 txn context에
싣고 post-check이 그 id를 스킵하거나, op-level `skipAttestedRecheck` 표시.
단순히 revoked_at 검사를 빼면 안 됨 — handler가 자기 말고 다른 grant도
폐기했을 때의 의미를 유지해야 함.

**재검증.** `s4-revoke.ts` self-revocation check → committed + `revoked_at` 설정.

### F-020 `access.inspect` self-view 도달 불가

**증상.** contract은 subject의 자기 binding 조회용인데 member grant action set에
없어 `UNAVAILABLE_OPERATION` — handler의 self-inspection 분기까지 도달 못함.

**수정 방향.** member grant의 action set에 `access.inspect` 포함 (self-only
의미 — handler 내부에서 타인 binding 조회는 별도 인가). 또는 contract에서
self-inspection을 다른 op로 분리했다면 grant action set을 그쪽으로 갱신.

**재검증.** `s5-read.ts` 두 check → committed + 자기 grant 정보만 반환.

### F-024 admission이 grant revision 일치를 검사 안 함

**증상.** ctx가 attested grant의 구 revision을 주장해도 `decide()`는
존재+liveness만 봐서 admission 통과 — mutation 경계 `recheckCallerGrants`에서만
`revision !== rev → GRANT_REVOKED`로 fence. read op은 어디서도 fence 안 됨.

**수정 방향.** `decide()`의 attestation 검사에 revision 일치를 포함시켜
admission에서 즉시 거부 — 또는 명시적으로 "admission은 liveness만,
mutation 경계가 revision"이라는 이중 모델을 spec에 맞게 정리하고 read 경로에도
`recheckGrantSnapshot`을 적용. 현재는 두 검사가 다른 기준을 조용히 씀.

**재검증.** s3 old-revision attestation check → denied at admission.

---

## B. transport·worker credential (IMP-12/19/20/23)

### F-001 mahasd 인증 부재 — worker-auth 전체 dead code

**증상.** `mahasd.sock`에 bogus secret hello → populated operator surface;
존재하는 principalId claim → 그 principal의 surface + `access.grant` 커밋
(cli-surface `cac1bc64…` forged grant, s3 socket probes).
`main.ts:355-367` authenticator가 `credential.principalId`를 그대로 수용,
secret·credential kind 검증 없음. `mahasd-worker.sock`은 `main.ts`에서
한 번도 `serveRpc`되지 않음 (`mahasdWorkerEndpoint` 정의만 존재).

**수정 방향.** 세 층:
1. worker socket 실제 바인딩 — `serveRpc`를 `mahasdWorkerEndpoint(configDir)`에
   추가하고 그 전용 authenticator를 주입 (operator authenticator 재사용 금지).
2. operator authenticator에 credential 검증 — 최소한 `kind` dispatch:
   `worker` kind는 worker socket에서만 수용 + `execution_credentials`의
   `secret_hash`를 `verifySecret`로 비교 (`worker-auth.ts` 스키마대로
   credentialId+secret). operator credential은 로컬 trust 모델의 정본
   (unix peer credential / token file)을 spec C-ACCESS와 합의.
3. authenticator가 memberId/executionId/executionGeneration을 credential row에서
   **도출** — client claim 필드를 ctx로 복사하지 않음 (F-018과 결합).

**재검증.** s3 socket probes → UNAUTHENTICATED; worker socket에서 진짜
bootstrap credential round-trip (현재 blocked 항목 해제).

### F-023 `execution_credentials.revoked_at` 미참조

**증상.** credential row를 revoke해도 member grant로 ordinary op이 계속 커밋 —
테이블은 쓰이기만 하고 op 경로에서 읽는 곳이 없음 (worker-auth 미바인딩과 같은
근본 원인). credential-level revoke가 아무 효과도 없음.

**수정 방향.** F-001의 worker authenticator 도입 시 `revoked_at IS NULL`을
credential 검증 조건에 포함. member ctx가 credential을 통해 도출됐다면
credential revoke = 그 ctx의 전면 거부 (grant revoke와는 별도 축).

**재검증.** credential revoke 후 동일 ctx의 op → UNAUTHENTICATED.

### F-002 list-vs-invoke 2-name oracle (minor)

`surface.describe`/`operation.get`이 모든 surface에 리스트되지만 member가
호출하면 `SCOPE_DENIED` (비노출이면 `UNAVAILABLE_OPERATION`이어야 일관).
surface projection과 invoke admission의 surface 판정을 한 소스로 통일.

### F-008 crash-loop 카운트에 거부된 boot 포함 (minor)

인증/lock 실패로 못 뜬 boot도 5-in-120s 카운트 — 검증 재시도 시 인위 차단.
의도된 throttle이면 crash가 아닌 startup-failure 카운터로 분리.

---

## C. lifecycle·host·daemon (IMP-17/18/22/23)

### F-014 실행 재부착 경로 전체 dead code

**증상.** kill -9 후 재부팅해도 process는 live인데 전 execution이
`left-unknown` — reconcile이 `host.hello`를 credential 없이 보내
`UNAUTHENTICATED`(host.ts:511), 그 에러가 `reconcile.ts:276`에서 삼켜지고
probe.error 분기가 없어 inventory를 못 얻음. orphan sweep
(`recovery/reconciler.ts`)도 미배선.

**수정 방향.** 세 고리 모두 필요:
1. host.hello에 controller credential 제시 — host가 기대하는 auth 형태
   (host.ts:511 주변의 credential 검사)에 맞는 토큰을 reconcile이 전달.
2. `probe.error` 분기에서 inventory 실패를 명시 상태로 기록 — silent
   `left-unknown` 대신 `reattach-failed` 등 관측 가능한 결과.
3. `recovery/reconciler.ts` orphan sweep을 compose 루프에 실제 연결 —
   지금은 정의만 있고 호출자가 없음.

**재검증.** drill D-01 재실행 — kill-9 후 재부팅 시 execution이 live로 재발견.

### F-015 same-DB split-brain

두 config dir이 같은 `mahas.sqlite`를 열면 `mahasd.lock`(config-dir 스코프)이
서로를 못 봄 → 둘 다 serve. lock을 DB 파일 inode 기준(또는 DB 내부 lease row)으로
옮겨 단일 writer 불변식 회복. host lease의 epoch takeover는 이미 올바르게
거부함 — 같은 패턴을 control plane에도 적용.

### F-017 fresh DB의 host lease reclaim 불가

epoch < stored lease epoch이면 `STALE_EXECUTION` 영구 — DB 재생성/복구 시나리오
차단. dead-evidence 기반 takeover(lease.ts:306-327)는 이미 있으니, stale-epoch
경로에서 "상대 controller의 생존 증거"를 확인하고 죽었으면 reclaim 허용.

### F-005 `runtime.reconcile` RPC 항상 ERR_SQLITE_ERROR

op spec이 `mutation:false` → admission이 `BEGIN DEFERRED`로 감싸는데
reconcile 내부 `withTx`→`BEGIN IMMEDIATE`가 같은 connection에서 중첩
(txDepth가 admission의 raw BEGIN을 못 봄). op 등록을 mutation:true로 바꾸거나,
reconcile이 이미 tx 안이면 withTx를 중첩 호출하지 않도록 txDepth 공유.

### F-006 stale host endpoint 파일로 mahasd 크래시

`hostClient.ts:146` dial ECONNREFUSED가 readline `error` 이벤트로 escape —
`rl.on('error')` 없음 → 프로세스 사망. endpoint 파일 존재 ≠ host 생존으로
간주하고, dial 실패를 `host-attach-failed` degraded start로 정상 처리.

### F-007 `spec.pty` spawn FK 순서

`host_terminals` INSERT(FK→`host_processes`)가 `persistProcess`보다 먼저 실행
→ `FOREIGN KEY constraint failed` → receipt `unknown`, terminal row 없음
(pty 자체는 spawn됨 — 실제는 성공인데 정본이 실패로 기록).
process row persist 후 terminal row INSERT 순서로 교체.

---

## D. 저장 계층 (IMP-29)

### F-003 restore external blob 경로 오류

`restoreContent`가 external blob을 `<root>/<digest>` flat으로 쓰는데
`external_ref`는 sharded `<digest[0:2]>/<digest>`를 기대 → restore 성공 보고해도
`getContentBlob` ENOENT. restore 경로를 writer와 같은 shard 규칙으로 통일.

### F-004 GC orphan 수집이 shard 구조를 못 읽음

`planOrphanBlobFiles`의 비재귀 `readdirSync`가 shard *디렉토리*를 후보로 열거
→ EISDIR unlink 실패 → 영구 retryable residue + `effect_intents` churn.
진짜 orphan(`<shard>/<digest>`)은 영원히 미수집. 재귀 walk 또는 shard-depth
인식 열거로 교체하고, 실패한 unlink를 영구 후보에서 제외하지 말 것.

---

## E. model·discovery (IMP-04/06)

### F-012 cyclic reparent 크래시

`descendantsOf` BFS에 visited set 없음 → 사이클 입력 시
`RangeError: Invalid array length`가 dispatch를 빠져나감 — rejected receipt도
`CONTAINS_CYCLE` 보고도 없음. BFS에 visited set 추가 + 사이클 감지 시
명시 `CONTAINS_CYCLE` 거부 (spec의 cycle-guard semantics).

### F-011 `locate` 비조상 중첩 조용히 resolve

ad-hoc `resolveDeepest`가 canonical `resolveTerritory`(`model/territory.ts`)를
안 써서 `src/api/auth/*`가 비조상 `b-api-alt` 중첩에도 `b-api-auth`로 resolve —
ambiguous 은폐. `resolveTerritory`로 리와이어 (fix WIP에서 진행 중).

### F-013 `assignment.show` stub

등록만 되고 handler 없음 → 모든 caller에 `UNAVAILABLE_OPERATION`.
grant action set에 있는데 도달 불가 — handler 구현 또는 action set에서 제거.

---

## F. mail·durability minor

### F-016 `String(err)` → `[object Object]`

`lifecycle/reconcile.ts`의 error 렌더링이 plain-object MahasError를 못 읽음 —
`err.code`/`err.message` 추출 헬퍼로 교체 (운영 로그 가독성).

---

## 수정 우선순위 제안

1. **F-001+F-018+F-022+F-023** — 인증/바인딩 묶음: transport authenticator에서
   credential 검증 + principal·member·grant 소유관계를 ctx 조립 시점에 고정.
   이 넷이 한 근본 원인(identity claim이 검증 없이 ctx로 흘러듦)의 서로 다른
   표현이라 같이 고치는 게 검증 비용이 적다.
2. **F-009+F-010/F-021** — scope 스키마 정본 통일: write(`access.grant`)와
   read(`checkProvisioning`, `scopeEntries`)가 같은 중첩 구조를 보도록.
3. **F-014+F-005+F-006+F-015+F-017** — 재부착/복구 경로: VER-06/07/08의
   헤드라인이 될 항목, 지금 고쳐두면 lifecycle VER이 의미를 가짐.
4. **F-003/F-004** — restore/GC: VER-02 재검증 대상, 독립적이라 병렬 수정 가능.
5. **F-019/F-020/F-024** — admission 규칙 정리: 비교적 작은 패치, 인가 묶음 다음.
6. 나머지 minor(F-002/007/008/011/012/013/016)는 각 owner의 후속 sweep.

각 수정이 커밋되면 findings.md의 `status`를 `fixed-in-<sha>`로 갱신하고
해당 probe(s3~s6, VER-01/02 절차)만 재실행하면 된다.
