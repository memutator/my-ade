# HANDOFF — mahas architecture implementation (coordinator state)

**Status: IMPLEMENTATION COMPLETE (2026-09-18).** All 32 IMP tasks are
implemented in this worktree; independent review (REV-01..08) and formal
verification (VER-01..12) have deliberately NOT been run — "implemented" is
not "accepted" (docs/implementation-plan/INSTRUCTIONS.md).

**Update 2026-09-19:** a findings-fix session (post-review defect
remediation, F-001..F-024 per `mahas-architecture/records/orchestration/fix-guide.md`)
is IN PROGRESS on this worktree — all state, landed fixes, and next steps are
preserved in "HANDOFF UPDATE — findings-fix session" at the bottom of this
file.

**Worktree:** `/home/pyosechang/projects/ade-wt-mahas-architecture` (branch `mahas-architecture`, forked from `my-ade` main @ `a1c30db`).
**Spec package:** `mahas-architecture/` — requirements.md, spec/, implementation-plan/tasks/IMP-01..32, review-plan, verification-plan.
**Node:** v24 (`node:sqlite` builtin, type stripping). `node_modules` is a **symlink** → `../my-ade/node_modules`.

## Commits on this branch

| commit | content |
|---|---|
| `99eb5f5` | spec: mahas-architecture spec package |
| `f318e3e` | IMP-01 — packages/ boundary + desktop runtime seam |
| `78f3688` | records/: orchestration STATUS tracker + REV/VER ledger |
| `725aa9a` | IMP-03 — storage kernel: `storage/db.ts`, spec-DDL migrations, blobs/receipts/outbox |
| `5c12015` | IMP-14 — task-spec revisions, input-resolver, work-envelope, dispatch authority |
| `4fbdfa2` | docs: coordinator handoff |
| `b443b68` | **IMP-02** — full domain contracts (work/execution/mail/resource/observation/ops + index) |
| `e98a354` | **integration** — finished all partial IMP-04..29 work: type/lint/build green, coordination/observation/launch/recovery registration seams, composition root, host-op registration, desktop exec seam, CLI fix, smoke fixes |
| `a0f6562` | **IMP-30/31** — desktop service bootstrap, workbench widgets, assignment.preview, operator/provisioning seed, NUL-check fixes, service scripts |

## Implementation ledger (all landed; evidence)

- **IMP-01** package boundary + `src/main/runtimeClient.ts` seam — `packages/README.md`, eslint direction rules.
- **IMP-02** `packages/mahas-contracts/src/{common,ids,rdd,role,access,work,execution,mail,resource,observation,ops,index}.ts` — `npx tsc -p packages/mahas-contracts` green.
- **IMP-03** `runtime/src/storage/*` — migrations + receipt/blob/event stores.
- **IMP-04** `runtime/src/model/*` — model change sets, indices, impact candidates.
- **IMP-05/06** `runtime/src/discovery/*` — smoke 51/51 (`node packages/mahas-runtime/src/discovery/smoke.ts`).
- **IMP-07/08/09** `runtime/src/realization/*` — interfaces, profiles, compiler, bundle store, materializer, effective context.
- **IMP-10** `runtime/src/access/*` — authorize/decide/surface/grants/policy/provisioning/revocation.
- **IMP-11** `runtime/src/api/*` — registry/admission/surface; smoke 40/40, 92 operations indexed.
- **IMP-12** `runtime/src/rpc/*` + `packages/mahas-cli` — NDJSON RPC, operator/worker auth, `mahas` CLI.
- **IMP-13/14** `runtime/src/coordination/*` — run/plan/member/eligibility/task-spec/input-resolver/work-envelope/dispatch-authority/dispatch-ops; **`assignment.preview` + `team.assign` now share the same checks**.
- **IMP-15** `runtime/src/mail/*` + `runtime/src/artifacts/*` — smoke 48/48.
- **IMP-16** `runtime/src/resources/*` + `mahas-execution-host/src/workspaces/*`.
- **IMP-17/18** `mahas-execution-host/src/*` — host bootstrap/lease/effects, process/PTY/terminal/stop; process+workspace host ops registered at boot in `main.ts`.
- **IMP-19/20** `runtime/src/launch/*` — planner, start-coordinator, join/acceptance, bootstrap credentials; `registerLaunchOps`/`registerJoinOps`.
- **IMP-21** outcome/settle/wake — acceptance + dispatch settlement paths (`launch/acceptance.ts`, `coordination/dispatch-authority.ts`).
- **IMP-22** `runtime/src/recovery/*` — reconciler, reattach, resume, stop, orphan, identity probe; `worker.stop`/`worker.resume` registered.
- **IMP-23** `runtime/src/lifecycle/*` + `runtime/src/main.ts` — mahasd entrypoint; endpoint publication now happens **after** the RPC listener accepts.
- **IMP-24/25** `packages/mahas-harness-config/*` — claude/codex/… profiles.
- **IMP-26** `runtime/src/observation/*` — facts/interventions/projection/subscriptions; registration in `observation/index.ts`.
- **IMP-27** `runtime/src/maintenance/*` — impact service; smoke PASS (38 ok).
- **IMP-28** `runtime/src/client/*`, preload `exec:op/subscribe/onEvent`, workbench seam.
- **IMP-29** `runtime/src/operations/*` — backup/restore/migration/gc/support.
- **IMP-30** `runtime/src/composition.ts` — one registry with every implemented handler, kernel bindings, operator seed, lease-fenced host session, secrets; `startMahasd` composes by default; dev desktop spawns the two daemons under system node (`src/main/runtimeClient.ts`).
- **IMP-31** `src/renderer/src/workbench/*` (ResponsibilityView/TeamView/PlanView/bits/store/ops/client/contracts) mounted as widget blocks with `workbench.css` + i18n; search → queue → implementations → preview → explicit assign; plan prepare → commit.
- **IMP-32** `runtime/src/inspector/*` — role-config workbench views.

## Verification evidence run during integration

- `npx tsc -p packages/mahas-<pkg>/tsconfig.json` green for contracts, harness-config, execution-host, cli, runtime.
- `npm run typecheck`, `npm run lint`, `npm run build` green.
- Smokes: registry 40/40 · mail 48/48 · discovery 51/51 · maintenance PASS.
- App e2e: `node tools/e2e.mjs` → 37 passed, 0 failed.
- Control-plane e2e (tmp config dir): execution-host + mahasd boot, host attach +
  controller lease, `mahas status` ready, real RPC workflow
  `surface.describe → project.create → model.change.prepare → model.change.commit
  → run.create → responsibility.search` all committed. (ad-hoc script, not committed)

## Hardening fixes found during integration (beyond the task texts)

- `''`-instead-of-`'\0'` NUL checks in `discovery/model-read.ts`,
  `model/structural-rules.ts`, `launch/initial-attachment.ts` — every path was rejected.
- `publishEndpointFile` wrote the endpoint JSON **onto the socket path**
  (renaming over the listener inode); now takes the `*.endpoint.json` path.
- `serveRpc.ready` is awaited before publishing the endpoint file (was a race).
- `bindAccessDb` was never called by any composition — authorize answered
  CONTROL_UNAVAILABLE for every op.
- Execution-host parameter properties / TS-only syntax removed so the entrypoints
  actually run under Node type stripping.

## Still deliberately NOT done

- REV-01..08 independent reviews and VER-01..12 formal verification: not run
  (`mahas-architecture/records/orchestration/STATUS.md` keeps waiting lists).
  VER-09..11 (real harness acceptance) must not be claimed verified.
- Packaged-app daemon lifetime: desktop spawns mahasd/execution-host in dev
  only; a packaged build is an honest client until an operator runs the daemons
  (`mahasd` / `mahas-host` npm scripts).
- `observation.ingest` and `worker.release` remain unregistered (surface does
  not advertise them — honest UNAVAILABLE_OPERATION).
- `ModelChangeEdit` in mahas-contracts is less detailed than the live
  `runtime/src/model/change-set.ts` wire shape (no consumer imports the former).

## HANDOFF UPDATE — findings-fix session (in progress as of 2026-09-19)

Post-review defect remediation against
`mahas-architecture/records/orchestration/fix-guide.md` (F-001..F-024).
Progress ledger: `mahas-architecture/records/orchestration/fix-progress.md`
(assessor note — reflects an EARLIER tree state; the statuses below supersede
it). All fixes are uncommitted WIP on this worktree (WIP base `83a6d21`,
repo HEAD `5e72a48`). `findings.md`/`STATUS.md` deliberately untouched.

### Landed — per finding

**Early fixes (assessor probe-verified; evidence in fix-progress.md):**
F-001, F-003, F-004, F-009, F-010, F-011, F-013, F-016, F-021, F-023.

**Second batch (prior session, all in `packages/mahas-runtime/src/`):**

- **F-005** (tx-depth + reconcile reachability) — `storage/transaction.ts`
  gained `markTransactionOpen`/`markTransactionClosed` (re-exported as
  `markTxOpen`/`markTxClose` from `storage/db.ts`); optional
  `markTxOpen?`/`markTxClose?` added to `StorageBoundary`
  (`api/handler-ports.ts`); `TxDepthHooks` wired through `runInTransaction` +
  admission dispatch so the pipeline's raw BEGIN registers depth and nested
  `withTx()` degrades to SAVEPOINT. Mid-migration regression also fixed:
  `resolveTargets` in `api/admission.ts` no longer throws MODEL_INVALID for
  mutations without `resolveTargets` — falls back to
  `defaultTargetsFromPayload` via the `PAYLOAD_TARGET_KINDS` map (fails closed
  to `{kind:'principal', id}`). `runtime.reconcile`
  (`lifecycle/operations.ts`) now carries a full spec — `mutation: true`,
  `longPoll: true`, inputSchema, `reconcileResolveTargets`
  (host/execution/runtimeInstance targets).
- **F-019** (self-revoke commit) — `TxnContext.exemptGrantRecheck?` +
  `TxnInternals.exemptedGrants` + `withGrantExemptions` in `api/admission.ts`;
  pre-commit re-check skips self-revoked grants; `access/operations.ts` revoke
  op registers `result.revokedGrantIds`; `AccessOperationContext` got the
  optional hook.
- **F-018** (member↔principal binding) —
  `memberPrincipalBound`/`requireMemberPrincipalBinding` in
  `access/authorize.ts`; enforced in decideOn step 1b, the snapshot-verify
  path, and `effectiveActionsFor`.
- **F-022/F-024** (grant ownership + revision) — decideOn attestation loop
  verifies grant ownership (principal or bound member) + attested revision;
  new `callerGrantRecords` helper (principal + bound-member active grants +
  owned attested ids); `grantSnapshot` uses it; `coordination/internal.ts`
  `recheckCallerGrants` + `callerGrantsOfKind` ownership-scoped.
- **F-002** (list-vs-invoke oracle) — `ALWAYS_SURFACE_OPERATIONS` allowed
  without grant (decideOn 3b); unjoined-path surface returns bootstrap +
  always-surface, sorted.
- **F-020** — `'access.inspect'` added to `requiredActionsFor`
  (`coordination/member.ts`).
- **F-006** (stale-endpoint crash) — `rl.on('error')` handler in
  `hostClient.ts` (reject before connect, `failAll` after) — stops the mahasd
  crash on a stale host endpoint file.

**Third batch (this session):**

- **F-007** — `packages/mahas-execution-host/src/process-manager.ts`:
  `persistProcess` now runs BEFORE the `host_terminals` INSERT
  (`host_terminals.spawn_nonce` FK → `host_processes(spawn_nonce)`); the
  already-spawned pty can no longer be orphaned by an FK failure.
- **F-008** (refused boots don't count) — `lifecycle/service-bootstrap.ts`:
  new `'refused'` journal entry type, settled like ready/stopped in
  `checkCrashLoop`; `main.ts` writes `'refused'` on lock-acquisition failure
  and on every `fail()` after the boot marker — only real pre-ready deaths
  feed the 5-in-120s throttle.
- **F-012** (cyclic reparent) — `model/change-set.ts` `descendantsOf` BFS has
  a visited set (cycle members skipped; `validateCandidate` reports
  CONTAINS_CYCLE separately via `model/structural-rules.ts`); audited the
  other parent-chain walks (ops.ts role ancestors, structural-rules
  `ancestorsOf`, territory `ancestorChain`, revocation `collectSubtree`) —
  all cycle-guarded.
- **F-015 part 1** (lock keyed to the DB file) —
  `lifecycle/service-bootstrap.ts`: new `singleWriterLockPath(dbPath)`
  (`<dbPath>.lock`); `main.ts` takes the single-writer lock from the control
  DB path instead of the config dir, so two config dirs aiming at one DB
  exclude each other. **Part 2 (in-DB fence) still pending — see Remaining.**

### Design decisions to preserve

- Binding rule: a member is its own principal (`members.id = principals.id`)
  or the launch's worker principal `principal-<executionId>`; anything else is
  UNAUTHENTICATED.
- Grant ownership: attested grant ids count only when owned by the principal
  or its bound member; attested ids never widen the candidate set.
- A `declare module` augmentation for the `runtimeInstance` kind was added
  then REVERTED — relies on the kernel resolving unknown kinds to self-only
  ancestry.
- F-005 is depth-driven, not query-count-driven: `markTxOpen`/`markTxClose`
  are OPTIONAL on `StorageBoundary` — if the production wiring doesn't supply
  them, the old nested-tx behavior recurs at runtime.

### Remaining (next steps)

1. **F-015 part 2** — in-DB liveness fence: after the DB is opened and BEFORE
   `lifecycle.acquireControllerEpoch` in `main.ts`, refuse
   (ALREADY_RUNNING / LOCK_UNVERIFIABLE via `verdictForProcess`) when any
   `runtime_instances` row in state 'starting'/'ready' has a live or
   unverifiable process identity (belt & braces for different path spellings
   of the same DB file, e.g. symlink).
2. **F-017** — fresh-DB host lease reclaim: `epoch < stored lease epoch` is a
   permanent `STALE_EXECUTION` today, blocking DB regeneration/recovery.
   Dead-evidence takeover already exists (`lease.ts:306-327`) — apply the same
   pattern on the stale-epoch path: verify the OTHER controller's survival
   evidence and allow reclaim when it is dead (fix-guide.md §C).
3. **F-014 residual** — full VER-06 kill-9 drill not re-run (reconcile code
   landed earlier; socket-driven `runtime.reconcile` was blocked by F-005 and
   should now be reachable — re-probe it).
4. Verify the production `StorageBoundary` implementation/wiring actually
   supplies `markTxOpen`/`markTxClose` (see F-005 note above).
5. `npx tsc -p packages/mahas-runtime/tsconfig.json --noEmit` — the previous
   run captured no output; rerun and confirm clean (check
   `txn.ctx.controllerEpoch` and `TargetRef` typing in the reconcile
   resolver). Then run tests/smokes; stricter authorize may break existing
   flows (member grants via bound member, always-surface without grant).
6. Update `records/orchestration/fix-progress.md` statuses, then commit all
   fix batches (repo HEAD is still the 5 records-only commits; everything
   above is uncommitted).

### Verification state

Typecheck/tests have NOT yet been run for the fix batches (subagent runs
failed on timeout + 429 rate limit; all edits were applied directly). The
green tsc/lint/build/smoke/e2e evidence in the sections above predates these
fixes.

### Files touched by the fix session

- `packages/mahas-runtime/src/`: `access/authorize.ts`,
  `access/operations.ts`, `api/admission.ts`, `api/handler-ports.ts`,
  `coordination/internal.ts`, `coordination/member.ts`, `hostClient.ts`,
  `lifecycle/operations.ts`, `lifecycle/service-bootstrap.ts`, `main.ts`,
  `storage/db.ts`, `storage/transaction.ts`; `model/change-set.ts` (F-012
  visited set — landed in the WIP, verified present in the live tree).
- `packages/mahas-execution-host/src/`: `process-manager.ts`.
- Out of scope: F-025–F-028 (client-probe findings added to the ledger after
  this session's baseline — not assessed/started).
