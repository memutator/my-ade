# fix-progress — WIP fix-session progress vs findings ledger

**Type:** orchestration evidence note — **not** a formal VER record. Statuses are
assessor judgements from code reading + targeted probes, not delivery sign-off.
`findings.md`/`STATUS.md` were deliberately left untouched.

**Assessed tree:** uncommitted WIP in the sibling worktree
`/home/pyosechang/projects/ade-wt-mahas-architecture` (read-only for this
assessment; nothing there was modified, staged or reverted).
WIP base `83a6d21`; repo HEAD `5e72a48` (5 records-only commits — all impl
changes are uncommitted WIP).

**Two observation points — the worktree is LIVE (the fix session kept editing
during the assessment):**

- **Snapshot** `/tmp/mahas-fixcheck/src` @ 2026-09-18 ~22:00 KST (local commit
  `5a68f90`, base/WIP diffs in `/tmp/mahas-fixcheck/diffs/`). All probe results
  below ran against this snapshot.
- **Live re-diff** @ 2026-09-19 ~05:50 KST — exactly 4 finding-implicated files
  changed post-snapshot (`gc.ts`, `restore.ts`, `reconcile.ts`,
  `lifecycle/operations.ts`), landing code fixes for F-003/F-004/F-016 and the
  F-005 direction change. Statuses below reflect the latest observed state;
  the evidence column says which observation it came from.

## Counts

| status | count | findings |
| --- | --- | --- |
| fixed | 10 | F-001, F-003, F-004, F-009, F-010, F-011, F-013, F-016, F-021, F-023 |
| addressing | 4 | F-005, F-014, F-017, F-022 |
| untouched | 10 | F-002, F-006, F-007, F-008, F-012, F-015, F-018, F-019, F-020, F-024 |
| n-a | 0 | — |

## Per-finding assessment

| id | WIP status | evidence (snapshot probe / live code read) | confidence |
| --- | --- | --- | --- |
| F-001 | **fixed** | probe-verified. `main.ts:330-440`: operator authenticator fixes `principalId:'operator-local'` server-side and derives `grantRevisions` from DB (`currentGrantRevisions`); worker authenticator requires `kind:'worker'` + `credentialId`/`secret`, resolved via `authenticateWorkerCredential` → `bindingToContextFields` (server-derived identity); worker socket bound at `mahasdWorkerEndpoint(configDir)` (`main.ts:429`), separate operator/worker `serveRpc` servers, both closed on shutdown/error. Custom `fx-transport.ts` 9/9: forged/absent creds rejected, claimed `principalId` ignored, worker socket is member-scoped (4 ops vs operator 76). Residual: bootstrap-mode op gating not enforced (see `launch/join.ts` note). | high |
| F-002 | **untouched** | `api/registry.ts` identical to base — list-vs-invoke oracle persists. Adjacent mitigation: `authorize.ts:429` now returns only `{operation, decisionId}` in denied-error details (drops `actualTargets`/`grantRevisions` leak) — reduces one info channel, not the oracle itself. | high |
| F-003 | **fixed** | code-verified (live tree, post-snapshot). `operations/restore.ts:411`: external blob dest now `${c.digest.slice(0,2)}/${c.digest}` — matches `putExternalContentBlob`'s shard rule/`external_ref`; comment cites F-003. Not re-probed (no restore drill re-run). | high |
| F-004 | **fixed** | code-verified (live tree, post-snapshot). `operations/gc.ts:392-460`: `planOrphanBlobFiles` uses new `listBlobFilesRecursive` — recursive shard-aware walk returning store-relative `<shard>/<digest>` paths; directories never become unlink candidates (kills EISDIR retryable residue); digest extracted for `known` set + dual pin check. Comment cites F-004. Not re-probed. | high |
| F-005 | **addressing** | live tree: `lifecycle/operations.ts:81` flipped `mutation:false→true` (correct direction — admission's tracked tx then absorbs reconcile's inner `withTx`). **But** the spec still lacks `resolveTargets` → the same admission gate (`admission.ts:380-386`) now rejects it with `MODEL_INVALID` instead of `ERR_SQLITE_ERROR`. Probe-verified broken on snapshot (`ERR_SQLITE_ERROR` via socket); code-verified still unreachable on live tree. | high |
| F-006 | **untouched** | `hostClient.ts` identical to base — `rl.on('error')` still absent at the dial path; stale-endpoint ECONNREFUSED crash path unchanged. | high |
| F-007 | **untouched** | `process-manager.ts` edited (spawn argv validation, stdin coercion, incarnation parsing) but `host_terminals` INSERT still precedes `persistProcess` (`process-manager.ts:368-395`) — FK ordering defect intact. | high |
| F-008 | **untouched** | `main.ts:211` still runs `checkCrashLoop` at boot admission before the lock; `service-bootstrap.ts` identical — refused boots still count toward the 5-in-120s throttle. | high |
| F-009 | **fixed** | probe-verified. `member.ts:402-435` `checkProvisioning` unwraps nested `scope.provisioning.*` (`const nested = raw.provisioning`) and enforces `allowedRoleIds`, `maxMembers` (member-count query), placement/profile/policy-revision. `fx-authz.ts`: role outside nested allowlist denied, inside accepted, maxMembers path active. | high |
| F-010 | **fixed** | probe-verified. `access/grant.ts:235-272` `scopeEntries` now emits `run/role/boundary/task` entries from flat scope keys (+ targets/placement/continuation scopes). Member grant scope now covers its own action set. | high |
| F-011 | **fixed** | code-verified. `discovery/locate.ts:25-137` rewired to canonical `resolveTerritory` + `loadContainsTree` + `projectRepositoryRoot`; ad-hoc `resolveDeepest` gone — non-ancestor overlap surfaces as ambiguous instead of silently resolving. Matches ledger's `fix-in-wip` note. | high |
| F-012 | **untouched** | `model/change-set.ts:1065-1077` `descendantsOf` BFS still has no visited set — cyclic reparent still escapes as `RangeError`. The 8KB file diff is input-alias normalization only. | high |
| F-013 | **fixed** | probe-verified. `assignmentShow` implemented (`member.ts:1311+`) and registered `memberOp('assignment.show', false, assignmentShow, 'run')` (`coordination/index.ts:155`). Direct socket call → `committed` with assignment projection. | high |
| F-014 | **addressing** | code+log-verified (snapshot). `lifecycle/reconcile.ts`: `UNAUTHENTICATED` hello now falls back to the authenticated/borrowed host session instead of dying; per-execution `host.process.probe` requires `spawnNonce`+`birthEvidence` match (PID-only insufficient); confirmed-exit vs unverifiable distinguished; unresolved state preserved (no blind respawn/adopt). `composition.ts` exposes recovery deps + owns the fenced host session; `reconcileExecutions` orphan sweep wired into `runtime.reconcile` (`operations.ts:97-149`). Daemon logs: `host-attached` + `reconcile.pass` + `ready` with honest `blockers` at epochs 1 and 2. Not `fixed`: full VER-06 kill-9 drill not re-run, and the socket-driven `runtime.reconcile` path is blocked by F-005's gate. | medium-high |
| F-015 | **untouched** | `main.ts:222` still `acquireServiceLock(paths.lock,…)` — lock is config-dir scoped; `service-bootstrap.ts` identical. Cross-config-dir same-DB split-brain unaddressed. | high |
| F-016 | **fixed** | code-verified (live tree, post-snapshot). `reconcile.ts:185-196` new `errMessage()` renders plain-object `{code,message}` errors as `` `${code} ${m}` ``; all four `String(err)` render sites switched (live :290/:318/:347/:353). Comment cites F-016. | high |
| F-017 | **addressing** | `execution-host/src/lease.ts` **byte-identical to base** — `epoch < stored.epoch → STALE_EXECUTION` still unconditional at :268-275, evaluated before the dead-evidence takeover path (:321-328, which requires `epoch > stored`). Fresh low-epoch controller still cannot reclaim; escape only via enough restarts to out-run the stored epoch. Improved half: `reconcile.ts` now captures `result.leaseError` and `main.ts` surfaces unresolved hosts as `ready`-time `blockers` (kills the "silent ready" half — log-verified). | medium |
| F-018 | **untouched** | probe-verified open. `authorize.ts` `decide()` (:225-277) still checks principal/execution/member/grant individually but never `memberId ↔ principalId` binding — `fx-authz.ts`: worker principal + foreign reviewer `memberId` still passes `decide()`. Mitigating side-effect only: socket ctx fields are now server-derived (F-001), so the wire can't mint a mismatched pair — residual vector is in-process ctx construction. | high |
| F-019 | **untouched** | `admission.ts:320-322` post-handler re-authorization unchanged (now also resolves `finalTargets` via `resolveTargets`); `access/operations.ts` identical — self-revoke still revokes the attested grant then fails the post-check → rollback. Note: `access.revoke` is currently `MODEL_INVALID`-blocked anyway (see migration blocker below), so the path can't even be reached via socket right now. | high |
| F-020 | **untouched** | `member.ts:150-196` `requiredActionsFor` base list still lacks `access.inspect`; `access/operations.ts` identical — member self-view still `UNAVAILABLE_OPERATION`. | high |
| F-021 | **fixed** | probe-verified. Same `scopeEntries` fix as F-010 (`grant.ts:235-272`): `fx-authz.ts` — own boundary covered by `scopeCoversTargets`, foreign boundary denied. Boundary targets now reachable through role/boundary scope entries. | high |
| F-022 | **addressing** | probe-verified partially open. `internal.ts:518-525` adds a principal-scoped fallback (empty `grantRevisions` → grants selected by `principal_id`), and `grantRevisions` is now server-derived at credential bind (`bootstrap-credential.ts:172-186`) so a socket caller can no longer inject foreign grant ids. **But** the id-only path persists: non-empty `grantRevisions` still looks up `WHERE id=?` without `principal_id=?` (:527-540), and `recheckCallerGrants` same — `fx-authz.ts`: foreign provisioning grant still returned for lead ctx, accepted by `recheckCallerGrants`, and enabled an r-doc assign commit in-process. | high |
| F-023 | **fixed** | probe-verified. Worker endpoint bound+authenticated (F-001 evidence); `fx-transport` check 9: revoked `execution_credentials` row → `UNAUTHENTICATED` on connect — `revoked_at` now consulted on the live auth path. Caveat: revoking mid-session does not fence an already-connected socket (documented limitation). | high |
| F-024 | **untouched** | probe-verified open. `decide()` (`authorize.ts:271-277`) still verifies existence+`revoked_at` only — no `grant.revision` vs `ctx.grantRevisions[id]` compare anywhere. `fx-authz.ts`: ctx attesting rev 1 while grant sits at rev 6 → admitted. Server-derived `grantRevisions` is groundwork, but no comparison logic exists. | high |

## Mid-migration blocker (not a ledger finding — flags WIP completeness)

`admission.ts:380-386` now rejects **every** mutation op that lacks
`resolveTargets` (`MODEL_INVALID`), and `:392-397` rejects mutations that
resolve zero actual targets (`SCOPE_DENIED`). Migrated (work via socket):
coordination (`run.*`, `plan.*`, `team.*`, `assignment.*`, `task.dispatch` —
`memberOp`/`operatorOp` inject `payloadTargets` + `resolveWorkRevisions`),
settlement-ops (new), resources, launch (`worker.*`, `execution.join`),
realization `context.build`.

Still unmigrated → **currently rejected**: `project.create` + all `model.*`
mutations, `access.policy.publish/grant/revoke`, `inbox.check`, `delivery.ack`,
`message.send`, dispatch-ops internals, `runtime.shutdown`, `runtime.reconcile`
(post-flip), recovery/backup/maintenance/client mutations. Consequences:

- the VER-03 fixture suite (`s0-fixture` → `s6-cover`) **cannot run unchanged** —
  it dies at `project.create` before reaching its checks. All probe results
  above came from custom targeted probes (`fx-transport.ts`, `fx-authz.ts`,
  direct socket calls) plus daemon logs.
- an operator cannot bootstrap a project or grant through the socket in this
  WIP state; member `inbox.check`/`delivery.ack`/`message.send` are also dead.
- F-019's self-revoke path is unreachable via socket until `access.*` migrates.

## Spec diffs — semantic summary (`spec/contracts/*`, `spec/domains/*`, `spec/*`)

16 spec files changed; snapshot spec == live spec. Theme: **canonical-schema
formalization**, not semantic renegotiation — for every cross-boundary JSON
shape the spec now writes down the canonical field set once plus an explicit
alias table, and states that unlisted keys are `MODEL_INVALID` and stored JSON
is post-translation canonical. This matches what the new code does (alias
translation at the boundary via `optStr`/`strMap`-style helpers). **No
security-relevant contract was weakened**: D-ACCESS/access contracts are not in
the diff set — the impl fixes move *toward* the contract, not the reverse.

Per file:

- `common.md` — alias rule (canonical name written once per schema; server
  translates listed aliases only; unlisted keys → `MODEL_INVALID`); plan CAS
  canonical = payload `expectedPlanRevision` (envelope `expectedRevisions.plan`
  is a server-translated alias); `expectedRevisions` ids are what the op's
  `resolveRevisions` knows.
- `contracts/README.md` — new index table mapping each cross-boundary wire
  shape (TypedModelEdit, PlanPatch/InputBinding, Settlement.decision,
  LaunchRecipe, HostEnvelope payload, …) to its canonical spec location.
- `contracts/work.md` — PlanPatch/TaskSpecPatch/EdgePatch/AttemptDisposition/
  InputBinding/OutputSlot/SettlementPolicy schemas written out; alias table
  (`disposition→action` w/ `stop→revoke`, `inputBindings→inputs`,
  `outputSlots→outputs`, `OutputSlot.name→slot`, `InputBinding.identity.*→`
  top-level, `fromTaskId/output→taskId/outputSlot`,
  `SettlementPolicy.kind/acceptor→mode/acceptorMemberId`).
- `domains/rdd.md` — TypedModelEdit flat discriminated union (canonical) +
  input-only alias table (`boundary{…}`→flat fields, `parentId`/
  `newParentId`→`*BoundaryId`, `set.paths`/`addPaths`-style deltas→snapshot-
  then-full-replace, split `*Remap` aliases) — mirrors the new `change-set.ts`
  normalization. `paths`/`consumerBoundaryIds` documented as full replacement.
- `domains/work.md` — TaskSpec canonical `inputs`/`outputs` (stored
  `inputs_json`/`outputs_json`); InputBinding identity fields flattened to
  top-level.
- `domains/messaging-outcomes.md` — Settlement.decision canonical enum
  `accepted|rejected|revision-requested`; sole alias `accept→accepted`.
- `contracts/execution-host.md` — payload = flat fields canonical; per-op
  alias table for spawn/probe/stop/effect.get (`payload.spec`, `initialStdin`
  string|`{bytesB64}`|ContentRef, `processIdentity≡processIncarnation`,
  `expectedProcessIncarnation`, `spawn.state`, `probe.state`, `stop.outcome`,
  `receipt.outcome`, `effect.state`) — matches `process-manager.ts` parsing.
- `contracts/launch.md` — Dispatch phase canonical enum
  (`reserved/starting/awaiting_join/awaiting_accept/running/reported/settled/
  revoked`; `assigned` explicitly absent — first recorded phase is
  `awaiting_join`); `worker.start` gains `generation?` for same-plan
  native-resume/fresh new-generation starts.
- `contracts/discovery-assignment.md` — `implementationAvailability` restricted
  to `status==='published'` revisions; `selectionToken` now pins
  `roleDigest`/`interfaceDigest` plus impl id/revision/digest (or candidate-set
  digest); response envelopes canonicalized (`items`/`coordinationView`/
  `implementations`).
- `contracts/realization.md`, `domains/role-realization.md`, `injection.md` —
  `RoleInterface.requirements` object (`{responsibilityRefs,
  contextRequirements}`; `requiredMeaning` is a sentence, not a flag); two-layer
  recipe formalized — `ProfileRecipe` (registered via `harness.profile.register`)
  vs `LaunchRecipe` (consumed by `worker.prepare`, schema in S-INJECTION §3.1 —
  new `launch/recipe-adapter.ts` does the translation); bundle manifest item
  canonical `{id,kind,path,digest,loadPhase}` (aliases `installPath`,
  `blobDigest`, `loadRoutes[0]`); `maintenanceBasis` excluded from exec manifest.
- `storage.md` — payload JSON = canonical fields only; aliases are input-time
  translations.
- `contracts/model.md` — `edits` canonical = D-RDD §3; prepare translates
  aliases before storing.
- `contracts/client-terminal.md` — managed-execution tab close =
  `terminal.detach`/`client.view.unbind`; process stop = `worker.stop`;
  restart ≠ auto-respawn; only unmanaged PTYs die with the tab.

## Still-open findings (what the fix session has NOT landed)

- **Critical/high residual:** F-018 (member↔principal binding absent in
  `decide()` — in-process exploit verified), F-024 (grant-revision compare
  absent — stale-revision attestation admitted), F-022 residual (id-only grant
  lookup accepts foreign grants in-process), F-005 (`runtime.reconcile` still
  unreachable — now `MODEL_INVALID`), F-015 (same-DB split-brain), F-017
  (epoch<stored lease still unrecoverable), F-006 (stale-endpoint crash),
  F-007 (PTY FK ordering), F-012 (cyclic-reparent crash).
- **Minor:** F-002 (list/invoke oracle), F-008 (crash-loop counting), F-019
  (self-revoke rollback — currently masked by the MODEL_INVALID gate), F-020
  (`access.inspect` unreachable).
- **Out of scope of this note:** the live ledger added F-025–F-028
  (client-probe findings) after the snapshot; they are not assessed here.

## Method / artifacts

- WIP copy: `rsync -a --exclude .git` → `/tmp/mahas-fixcheck/src`, local commit
  `5a68f90`; base/WIP unified diffs in `/tmp/mahas-fixcheck/diffs/` (base blobs
  via `git show 83a6d21:<path>`); post-snapshot drift detected via
  `diff -rq` against the live tree (only the 4 files listed above).
- Probes (snapshot daemon, isolated `/tmp/mahas-fixcheck/config`): custom
  `fx-transport.ts` (9/9 transport-auth checks), `fx-authz.ts` (provisioning
  allowlist, scope coverage, F-018/F-022/F-024 exploit checks), direct socket
  calls (`assignment.show`, `runtime.reconcile`), daemon logs across restart
  (epoch 1→2). Legacy `s0-fixture`/`s3-bypass`/`s6-cover` could not run —
  unmigrated ops die at the `resolveTargets` gate (see blocker section).
- Spec diff: `git show 83a6d21:<spec>` vs WIP for all 16 changed spec files.
