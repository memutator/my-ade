---
taskId: VER-01
codeRevision: 83a6d21
specRevision: 99eb5f5
verdict: failed
---

# VER-01 — 도메인 모델·책임 검색·배정의 실행 검사

VerificationRecord for REQ-02, REQ-03, REQ-04, REQ-17.
Five defects found on real execution — one **authorization bypass**
(provisioning `allowedRoleIds` is never enforced for canonically-issued
grants), one member-grant scope shape that makes the coordinator's own
discovery/ops unreachable, a locate ambiguity divergence, a crash on cyclic
reparent, and one op granted to every member but never implemented.
All other expected observations (durability, discovery, preview/assign
semantics, staleness, structural edits, negotiation assignment) reproduce on
real SQLite-backed API execution.

## environment

- repo `/home/pyosechang/projects/ade-wt-mahas-architecture`, branch
  `mahas-architecture`.
- **codeRevision `83a6d21`** — at verification time the main worktree was
  **dirty**: 67 uncommitted modifications vs HEAD `92dcd77` (a parallel
  session's WIP — incl. admission `resolveTargets` hardening that breaks
  `project.create`, and a `locate→resolveTerritory` rewiring). All results
  here were produced against a clean checkout:
  `git worktree add /tmp/mahas-ver-01/src-83a6d21 83a6d21`, imported by the
  harness via absolute `file://` URLs. (The dirty-tree diffs corroborate
  DEFECT-3/DEFECT-4-adjacent findings — the owner session is already fixing
  the same code.)
- **specRevision `99eb5f5`** — "spec: mahas responsibility/execution
  architecture package" (`99eb5f554709a287c7d9dab263aa223d3e4f246e`).
- Node `v24.20.0` (TypeScript via type-stripping; `node:sqlite`
  `DatabaseSync`), OS `Linux 7.0.0-31-generic x86_64`.
- Contracts read: `spec/domains/rdd.md`, `spec/domains/access.md`,
  `spec/domains/work.md`, `spec/contracts/model.md`,
  `spec/contracts/discovery-assignment.md`, `spec/contracts/work.md`.
- Everything under `/tmp/mahas-ver-01/` — real `composeRuntime` +
  `createOperationRegistry` + `registry.dispatch` against a real on-disk
  `mahas.sqlite` (WAL). No mocks, no implementation edits, no direct row
  seeding for behavior under test (raw SQL only for evidence reads).
- Secrets: `config/selection-token.key` intentionally **not** copied to
  evidence; sha256 `0b8f07f9…ae68b` recorded in `out/environment.json`.
- All spawned processes exited (`w.runtime.close()` + `db.close()` per
  script); `pgrep -f mahas-ver-01` clean at record time.

## results summary

| step | scope | checks | verdict |
|---|---|---|---|
| s1-publish | fixture publish v1 through real API (project, 6 boundaries, 6 roles, contract, contexts, non-goals, interfaces, 2 profiles, 5 impls, prov grants, run) | 42/42 | pass |
| s2-reopen | new process: SQLite durability + project.get/model.snapshot/projections | 30/30 | pass |
| s3-discovery | path/contract/horizontal/Korean/scope search, inspect, locate, collaborators, role.implementations, cursors, selection tokens, visibility | 52/52 | pass |
| s4-stale | preview/assign, least privilege, idempotency, stale/tampered tokens, revoked grant, retired impl, plan pin, side-effect absence | 41/43 | **fail** — DEFECT-1, DEFECT-2 |
| s5-structure | split, reparent, role.retire, boundary.retire, invalid candidates, touched scopes, commit guards, relationship consistency | 68/71 | **fail** — DEFECT-3 (×2), DEFECT-4 |
| s6-assign | coordination leader w/o Task, plan.prepare/commit negotiation tasks, two-sided task-pinned assign, task-pin negatives, member ctx surface | 45/46 | **fail** — DEFECT-5 |
| s7-member-delegate | member-held provisioning grant → member-ctx team.assign + search | 5/5 | pass (refines DEFECT-2) |

**Total: 283/289 checks. 6 failed checks → 5 defects.**

## step s1 — publish fixture through the real API (process A)

**Inputs:** `project.create` → `model.change.prepare`+`commit` (one change
unit: 3 horizontalRoles, 3 contexts, 6 boundaries incl. root, 1 contract,
6 roles, 2 non-goals) → `interface.get` ×6 → `harness.profile.register/admit`
×2 (`hp-main` verified, `hp-doc` documented) → `implementation.prepare/publish`
×5 (r-lib intentionally none) → `access.grant` provisioning ×2 → `run.create`.

**Expected:** RDD 정본 lands in SQLite (`rdd_*`, `boundary_*`,
`contract_consumers`, `role_search_rows`), `ModelPublished` event, receipts
persisted, FTS projection populated.

**Observed:** 6 boundaries / 6 roles / 1 contract / 3 contexts / 2 non-goals /
5 edges / 6 path claims / 6 search rows; `ModelPublished` ×1; 26 receipts.
Ambiguity fixture in place (`b-api` + `b-api-alt` both own `src/api`).

## step s2 — reopen from a new process (durability)

**Expected:** a fresh process over the same `mahas.sqlite` sees identical
model/relations via API + raw rows — RDD restored from SQLite 정본.

**Observed:** all `rdd_*`/edge/path/context/criteria counts identical to s1;
`project.get`/`model.snapshot` committed with `activeModelVersion=mv1`,
`rootBoundary=b-root`; coordination + role projections committed
(`ancestors=[b-root]`, contract `c-user-api` visible); search projection
carries Korean text; domain_events/receipts/grants durable (26/26/3);
zero role→boundary or edge orphans. Process A had exited cleanly.

## step s3 — discovery surface (REQ-03)

**Expected:** version-pinned search with matchReasons; ambiguity and
unassigned surfaced, not hidden; implementation availability; HMAC
selection tokens pinning model+role+interface.

**Observed:**
- Path search: `src/api/auth/login.ts` → ambiguity group b-api/b-api-alt +
  cards for tied boundaries; `docs/` → roleless boundary card; `vendor/` →
  unassigned diagnostic; `../nope` → invalid-path diagnostic alongside valid
  results; all-invalid → rejected `MODEL_INVALID`.
- Contract search `c-user-api` → provider (r-auth/r-users) + consumer
  (r-web) cards with `scopeCoverage.matchedContractIds`.
- `horizontalRoleNames=[backend|frontend|coordinator]` filters correctly;
  `scopeBoundaryId=b-web` prunes out-of-subtree cards.
- Korean substring/FTS (`인증`, `세션 관리`) matches; absent token → empty.
- Pagination: `limit=2` → disjoint pages, cursor pins `modelVersion` +
  visibility digest; bogus cursor → `MODEL_INVALID`.
- `responsibility.inspect b-api` → roles, outbound contract tension,
  `docs/security.md` context, `ng-api-1` non-goal.
- `responsibility.locate` — resolved/ambiguous/unassigned/invalid statuses
  per spec (see DEFECT-3 for the one divergence found later at s5).
- `responsibility.collaborators r-auth` → r-users (same-boundary), r-web
  (contract), r-lead (contains).
- `role.implementations` — r-auth `verified`; r-users `documented` with
  `profile-admission` blocker; r-lib `implementation-missing`;
  `componentNeeds=[skill]` excludes the instruction-only r-web impl.
- Selection tokens verify: claims pin `mv1 + roleId + roleDigest +
  interfaceDigest` (artifact `tokenClaims.r-auth`).
- Non-exposure: grant-less member ctx → `UNAVAILABLE_OPERATION`; draft-model
  pin → `MODEL_INVALID`.

## step s4 — preview/assign + staleness (REQ-04, REQ-17)

**Expected:** preview validates without side effects; assign is atomic
(Member+Assignment+derived Grant+run coordinator CAS+event); tokens are
evidence not authority — stale/tampered/revoked/retired all reject with no
writes.

**Observed (passes):** preview → pending member, `grantCoverage` names the
broad prov grant, zero row deltas across
members/assignments/grants/deliveries/principals/dispatches/events/intents.
Coordination assign → member+assignment+grant derived under provisioning
grant, `runs.coordinator_member_id` set in the same tx, run `draft→active`,
31-action coordination vocabulary. Task assign → 14-action least-privilege
vocabulary (no `team.assign`). Documented-profile impl under `verified-only`
→ `SCOPE_DENIED`. Idempotent replay → same member, +0 rows; same opId +
different payload → `OPERATION_CONFLICT`. v2 publish → mv1 `superseded`,
mv2 `published`. Stale mv1 token → `STALE_REVISION` (preview **and** assign,
zero deltas). Tampered signature → rejected integrity. Revoked grant →
`GRANT_REVOKED`. Retired impl → `IMPLEMENTATION_MISSING`. Wrong
`expectedPlanRevision` → `STALE_REVISION`. `coordination`+`taskId` →
`MODEL_INVALID`. Second coordinator → `INVALID_TRANSITION`. Token-role ≠
impl-role → `INTERFACE_STALE`.

**Observed (failures → DEFECT-1, DEFECT-2 — see defects).**

## step s5 — structural edits (REQ-02/03/17)

**Expected:** split/reparent/role-retire/boundary-retire land as one change
unit with remaps; touched scopes = actual diff targets; malformed trees and
dangling FKs never publish; overlap stays a review diagnostic.

**Observed (passes):**
- `boundary.split b-api` → children `b-api-auth`/`b-api-users` under b-api;
  `roleRemap` (r-auth/r-users), `contractProviderRemap` (c-user-api),
  `nonGoalRemap` (ng-api-1), `contextRemap` (ctx-security) all applied in
  SQLite rows AND visible through inspect/search. `touchedTargets` covers
  split boundary + children + remapped role/contract/non-goal.
  `AMBIGUOUS_TERRITORY` correctly a **review** item, not a publish error.
  Prepare mutates nothing (mv2 rows identical, change row `prepared`,
  active version unmoved); mv2 relational rows immutable post-publish
  (status `superseded`); mv3 `parent_version=mv2`.
- `boundary.reparent b-lib→b-docs`: edge updated; `SUBTREE_MOVED` review;
  touched covers moved boundary + old/new parents; scope=`b-docs` now
  returns r-lib (subtree), scope=`b-web` excludes it; `src/lib` owner stays
  b-lib.
- `role.retire r-alt`: gone from mv5 roles; `role.implementations` →
  `NO_RESPONSIBLE_ROLE`; absent from inspect; boundary survives; stale
  token → `STALE_REVISION`.
- `boundary.retire b-api-auth` **without** remap → prepare reports
  `DANGLING_ROLE_BOUNDARY`+`DANGLING_CONTRACT_PROVIDER`+`DANGLING_NON_GOAL`;
  commit refused `MODEL_INVALID`; active stays mv5.
- `boundary.retire b-api-alt` clean → `src/api` ambiguity resolves to
  b-api; deeper `src/api/auth` → b-api-auth.
- Invalid candidates all refused at commit: `DANGLING_PARENT`,
  `MULTIPLE_ROOTS`, `MISSING_CRITERION`, `EDIT_TARGET_MISSING`,
  `CONTRACT_WITHOUT_CONSUMER`.
- Commit guards: wrong digest → `OPERATION_CONFLICT`; wrong
  `expectedActiveVersion` → `STALE_REVISION`; re-commit →
  `INVALID_TRANSITION`; unknown changeId → `MODEL_INVALID`.
- Lineage: single `published` tip; `ModelPublished` per commit.

**Observed (failures → DEFECT-3 ×2, DEFECT-4 — see defects).**

## step s6 — current-model assignment + initial negotiation (REQ-04)

**Expected:** coordination leader spawns without a Task; plan.commit writes
TaskSpecs/pins; task-pinned assign validates owner+revision+plan; the
negotiation "양측" both get members.

**Observed (passes):** fresh interfaces+implementations published on mv7
(digests re-derived per model version); run-3 created; tokens re-minted on
mv7. Coordination preview → committed, zero deltas. Coordination assign →
committed, `task_id=NULL`, coordinator CAS, run active, plan still empty.
`plan.prepare`/`commit` → plan revision 1 with `t-neg-auth` (owner r-auth)
+ `t-neg-web` (owner r-web) + edge. Task-pinned `team.assign` ×2 → both
sides assigned (`task_id`/`task_revision` pinned; task-scoped grants);
3 members on run-3. Plan revision 2 binds `assigned_member_id` on both
specs. Negatives: wrong owner role → `SCOPE_DENIED`; stale taskRevision →
`STALE_REVISION`; unknown task → `STALE_REVISION`; missing taskRevision →
rejected; stale expectedPlanRevision → `STALE_REVISION`; second coordinator
→ `INVALID_TRANSITION`. Member ctx: `surface.describe` committed; surface
lists task ops only; `run.get`/`responsibility.search` correctly hidden
(outside the task grant) — least privilege on the surface side verified.

**Observed (failure → DEFECT-5 — see defects).**

## step s7 — member-delegated coordination (probe)

**Expected:** a member with only its assignment grant cannot assign; a
member explicitly holding a provisioning grant can.

**Observed:** member ctx (assignment grant only) `team.assign` →
`SCOPE_DENIED provisioning coverage failed`. Operator then issued a
project-scoped provisioning grant **to the member principal**
(`parentGrantId`=broad grant): member-ctx `team.assign` → **committed**
(new member created), and member-ctx `responsibility.search` →
**committed** (the provisioning scope covers `{project}` targets). So the
DEFECT-2 wall is the *assignment-grant scope shape*, not member identity —
a second grant is the working path, but nothing in the assignment grant's
own action list warns that its listed ops are unreachable.

## supportedScope

Execution evidence (real `node:sqlite` DB, real composition root and
admission pipeline, no mocks) supports at `83a6d21`:

- REQ-02 durability: publish→process exit→reopen reproduces the full RDD
  model + relations + events + receipts + grants from SQLite alone;
  versioned snapshots are immutable (supersede, never rewrite); lineage is
  a single-tip chain.
- REQ-03 discovery: search/inspect/locate/collaborators/role.implementations
  are version-pinned; matchReasons, ambiguity groups, unassigned/invalid/
  roleless diagnostics all surfaced (with the DEFECT-3 exception);
  Korean text search works; cursors pin snapshot+visibility; member
  visibility filtering works (grant-less → hidden).
- REQ-04 assignment: preview = same validation, zero writes; assign is
  transactional (member+assignment+grant+coordinator CAS+event); least
  privilege per assignment kind; tokens are evidence (HMAC) not authority —
  every stale axis (model pin, plan pin, task pin, impl revision/status,
  grant revocation, tamper) rejects with no side effects; idempotency
  honored; single-coordinator enforced; coordination takes no Task;
  task-pinned assignment enforces owner-role + plan membership + revision;
  two-sided negotiation start reachable via plan tasks.
- REQ-17 model mutation: prepare returns full diagnostics without mutating;
  commit re-materializes + re-verifies digest + re-runs publish rules;
  touched scope = real diff (split/remap/reparent incl. moved subtrees);
  structural errors block, review diagnostics don't; relationship
  consistency holds in rows AND through the discovery surface.

## notExecuted / blocked

- `assignment.show` — registered (vocabulary) but deliberately stubbed at
  `coordination/index.ts:76-84` ("the concrete projection lives with the
  launch boundary (IMP-20). Until wired, refuse honestly.") → blocked at
  this revision; DEFECT-5 records that members are nonetheless granted it.
- Worker/execution/dispatch lifecycle (`worker.prepare/start`,
  `task.dispatch`, `task.accept`, `execution.*`) — outside this task's
  steps (assignment boundary only).
- `model.impact.*` classification, `run.close`, `team.retire` — reachable
  but not in the listed steps.
- Multi-member negotiation beyond plan-bound two-sided assignment
  (message-mediated negotiation) — not reachable without the mail/worker
  boundaries.

## defects — routed to IMP owners

### DEFECT-1 (critical) — provisioning `allowedRoleIds` (and maxMembers/placement/admission) never enforced — authorization bypass

- **Owner:** IMP-13 (`checkProvisioning`, coordination/member.ts), shape
  contract jointly with IMP-10 (access/grant.ts, access/provisioning.ts).
- **Where:** `coordination/member.ts:331-437` — `ProvisioningScope` + the
  whole `checkProvisioning` read **flat** fields:
  `scope.allowedRoleIds` (:364), `scope.maxMembers` (:366),
  `scope.placementScope` (:374), `scope.profileAdmission` (:395),
  `scope.allowedPolicyRevision` (:407). But `access.grant` **requires** the
  nested canonical shape — `scope.provisioning.allowedRoleIds`
  (access/grant.ts:291-292, shape :36-40, parent-child checks :357-371,
  `scopeEntries` maps `s.provisioning?.placementScope` :221) and
  `access/provisioning.ts:48-55` reads the same nested shape. Under any
  canonically-issued grant every check field is `undefined` → allowlist
  skipped (`Array.isArray(allowed)` false), maxMembers skipped, placement
  skipped, admission falls back to `'verified-only'` default.
- **Observed:** provisioning grant issued with
  `scope.provisioning.allowedRoleIds:['r-lead']` (accepted by
  `access.grant`), then `team.assign` for **r-auth** under it →
  **committed** — an r-auth Member+Assignment+Grant was created by a grant
  that explicitly allows only r-lead. (s4 check
  `provisioning allowlist enforced: r-auth refused under r-lead-only grant`
  — obs `committed`; artifacts `restrictedAssign.outcome`,
  `restrictedAssign.memberRow`.)
- **Contract:** `spec/domains/access.md` ProvisioningGrant
  "강한 role을 임의 spawn하여 권한 우회하지 못하게 함" — the allowlist is the
  stated anti-escalation mechanism; it is currently dead code for
  canonically-issued grants.
- **Repro:** `node /tmp/mahas-ver-01/s4-stale.ts` (after s1-s3) → the FAIL
  check; member row + committed receipt in
  `evidence/VER-01/out/s4-stale.json` artifacts.
- **Direction:** align on one canonical shape — read
  `scope.provisioning.*` in `checkProvisioning` (matching IMP-10's
  issuance/validation), or flatten at issue time and read flat everywhere.
  Same mismatch also silently disables `maxMembers` and `placementScope`.

### DEFECT-2 — member assignment-grant scope can't cover the ops it grants (coordinator can't search)

- **Owner:** IMP-13 (grant scope construction) with IMP-10 (`scopeEntries`
  mapping).
- **Where:** `coordination/member.ts:574-581` — the member grant stores
  `scope = {runId, roleId, boundaryId, taskIds, placement,
  parentProvisioningGrant}`; `access/grant.ts:215-224` `scopeEntries`
  translates only `targets / runId / memberId /
  provisioning.placementScope / continuation.taskScope` — so the grant's
  coverage is `{run}` alone. Every discovery op authorizes
  `{project}/{modelVersion}/{boundary}/{role}` targets
  (discovery/visibility.ts:82-88) → `SCOPE_DENIED` at the in-handler
  authorize, even though `responsibility.search` is literally in the
  coordination grant's 31-action list (member.ts:140+ `requiredActionsFor`).
- **Observed:** run-1 coordinator member ctx `responsibility.search` →
  rejected `SCOPE_DENIED "no active grant covers this operation on the
  actual targets"`; same ctx `run.get` → committed (run-scoped target IS
  covered); `access.grant` → `UNAVAILABLE_OPERATION` (correct). s4 checks
  + artifact `memberSearchRejection`. s7 proves the workaround: a separate
  project-scoped provisioning grant to the member principal makes both
  `team.assign` and `responsibility.search` commit — so the capability is
  reachable only by granting the member a second grant the assignment flow
  never creates.
- **Contract:** `spec/domains/work.md` — the coordination leader's job is
  "책임 검색·팀 배정" via the C-DISCOVERY results its grant lists; and
  `access.md` — a surface listing ops the grant's own scope can never
  authorize is inconsistent either way.
- **Repro:** `node /tmp/mahas-ver-01/s4-stale.ts` → FAIL check
  `DEFECT: coordinator member can search (grant lists the op)`;
  `node /tmp/mahas-ver-01/s7-member-delegate.ts` for the contrast.
- **Direction:** either map `roleId`/`boundaryId`/`taskIds` (and the
  run's project/modelVersion) into covering targets in `scopeEntries`, or
  issue the member grant with explicit `targets` for the run's
  project/model scope; alternatively document that coordination duties
  require a separately-issued provisioning grant and stop listing
  unreachable ops in `requiredActionsFor('coordination')`.

### DEFECT-3 — `responsibility.locate` silently resolves deeper non-ancestor overlap instead of reporting ambiguity

- **Owner:** IMP-06 (discovery/locate.ts).
- **Where:** `discovery/locate.ts:63-92` `resolveDeepest` — deepest claim
  wins; ambiguity only for same-depth non-ancestor ties — used at :131.
  The codebase's own canonical resolver `model/territory.ts:220-267`
  `resolveTerritory` puts non-ancestor-pair detection **before**
  deepest-wins (rule 2 → `ambiguous` at any depth), matching
  `spec/domains/rdd.md`: "비조상 경계의 같은 파일 소유는 모호성으로 반환…
  임의 한 경계를 우선 선택하지 않는다". (The uncommitted tree already
  re-wires locate to `resolveTerritory` — the owner session agrees.)
- **Observed:** on mv3 (b-api split → `b-api-auth` claims `src/api/auth`
  while non-ancestor `b-api-alt` still claims `src/api`),
  `locate('src/api/auth/login.ts')` → `resolved winner=b-api-auth` with
  `claimants=[b-api-auth,b-api,b-api-alt,b-root]` — a non-ancestor
  overlapping claim silently out-prefixed. Same for `src/api/users/*`.
  (s5 checks `DEFECT: locate src/api/{auth,users}/* → ambiguous`,
  artifact `locate.mv3.divergence`.)
- **Repro:** `node /tmp/mahas-ver-01/s5-structure.ts` → the two FAIL
  checks; contrast with `src/api` + `src/api/readme` (same-depth pair →
  correctly `ambiguous`).
- **Direction:** use `resolveTerritory` (or equivalent rule order) in
  locate — which the WIP tree already does.

### DEFECT-4 — cyclic `boundary.reparent` crashes `model.change.prepare` with `RangeError` (no clean rejection)

- **Owner:** IMP-04 (model/change-set.ts; dispatch boundary IMP-11 for the
  uncaught escape).
- **Where:** `model/change-set.ts:1037-1044` — `descendantsOf` BFS inside
  `diffSnapshots` has **no visited set**; a candidate whose parent map
  contains a cycle loops forever pushing ids → `RangeError: Invalid array
  length`. It is invoked from `model/ops.ts:429` during prepare — *before*
  the `CONTAINS_CYCLE` diagnostic already produced by `validateCandidate`
  (:428) can be returned — and escapes `registry.dispatch` as an **uncaught
  exception** (no rejected receipt at all; the caller's await throws).
- **Observed:** `model.change.prepare` with
  `{boundary.reparent b-root → newParentId b-web}` → dispatch threw
  `RangeError: Invalid array length` (s5 artifact `cycleReparent.outcome`
  records `threw:true` + stack). Runtime+DB survive — transaction rolled
  back, active version unchanged (verified by the following check).
- **Contract:** malformed trees are hard structural **errors** — they must
  surface as diagnostics + refused commits, not crash the operation
  boundary.
- **Repro:** `node /tmp/mahas-ver-01/s5-structure.ts` → FAIL check
  `DEFECT: cyclic reparent → clean CONTAINS_CYCLE refusal`.
- **Direction:** add a `seen` set in `descendantsOf` and/or skip the diff's
  subtree walk when `validateCandidate` already reports errors; admission
  should also frame non-MahasError handler throws as a rejected receipt.

### DEFECT-5 — `assignment.show` is granted to every member but not implemented

- **Owner:** IMP-13 (grant vocabulary) / IMP-20 (owns the projection per
  code comment).
- **Where:** `coordination/member.ts:144` — `assignment.show` is inside
  `requiredActionsFor` for **both** assignment kinds, so every member grant
  lists it; `coordination/index.ts:76-84` — the registered handler is an
  intentional stub that always throws `UNAVAILABLE_OPERATION
  "assignment.show is not implemented in this composition"`;
  `api/registry.ts:124` declares it in the vocabulary.
- **Observed:** `assignment.show` → rejected `UNAVAILABLE_OPERATION` for
  operator ctx and member ctx alike (s6 FAIL check + artifact
  `assignmentShow.sideA`).
- **Impact:** every member carries a dead action; member-facing
  introspection of one's own assignment is blocked at this revision.
- **Repro:** `node /tmp/mahas-ver-01/s6-assign.ts`.
- **Direction:** wire the IMP-20 projection, or drop the action from
  `requiredActionsFor` until it exists.

## observations (recorded, not defects)

- `assignment.preview` for a task-kind member lists `requiredActions`
  correctly and `grantCoverage` resolves the covering grant — preview is a
  faithful dry-run of assign.
- Member ctx on a **task** member correctly hides `run.get` and
  `responsibility.search` (not in its grant) — `UNAVAILABLE_OPERATION` at
  the surface stage, before authorize. Least privilege works on the
  surface side; DEFECT-2 is about grant-scope coverage, not surface.
- `checkProvisioning`'s default `profileAdmission='verified-only'` meant
  the documented-profile rejection still fired correctly even though the
  grant's nested admission field was unread (DEFECT-1) — the right outcome
  for the wrong reason.
- The `role.retire`-of-missing-role case surfaces as `EDIT_TARGET_MISSING`
  (edit-apply diagnostic) rather than a named structural code — still an
  error that correctly blocks commit.
- The uncommitted WIP tree contains fixes-in-progress consistent with
  DEFECT-3 (locate→`resolveTerritory`) and new admission hardening
  (`resolveTargets` mandatory for mutations — which in WIP state breaks
  `project.create` since it declares none). Not scored here; noted for the
  owners.

## evidenceRefs

- `evidence/VER-01/harness/` — all harness sources: `common.ts`
  (runtime wiring, ctx builders, SQL helpers, Recorder),
  `s1-publish.ts`, `s2-reopen.ts`, `s3-discovery.ts`, `s4-stale.ts`,
  `s5-structure.ts`, `s6-assign.ts`, `s7-member-delegate.ts`.
- `evidence/VER-01/out/` — per-check JSON: `s1-publish.json`,
  `s2-reopen.json`, `s3-discovery.json`, `s4-stale.json`,
  `s5-structure.json`, `s6-assign.json`, `s7-member-delegate.json`, plus
  raw row/artifact dumps `s1/s2/s4/s5/s6/s7-evidence.json` and
  `environment.json` (node/os/revisions/key-sha256/worktree note).
- `evidence/VER-01/db/mahas.sqlite` — the control DB 정본 after the full
  run (all model versions mv0→mv7, 3 runs, members/assignments/grants,
  plans/tasks, receipts, domain events).
- `evidence/VER-01/state.json` — harness state (ids, tokens-by-role are in
  it; the token **key** is not — see secrets note).
- Live originals remain at `/tmp/mahas-ver-01/` (harness, out/, db/,
  config/, repo/ fixture tree, `src-83a6d21/` git worktree of the pinned
  revision) for re-inspection; rerun via
  `cd /tmp/mahas-ver-01 && node sN-*.ts` (s1 first, sequential).
- Code locations cited are pinned-revision paths
  (`/tmp/mahas-ver-01/src-83a6d21/...` == `packages/...@83a6d21`).
