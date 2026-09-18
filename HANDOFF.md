# HANDOFF — mahas architecture implementation (coordinator state)

**Worktree:** `/home/pyosechang/projects/ade-wt-mahas-architecture` (branch `mahas-architecture`, forked from `my-ade` main @ `a1c30db`).
**Spec package:** `mahas-architecture/` in this root — requirements.md, spec/, implementation-plan/tasks/IMP-01..32, review-plan, verification-plan.
**Node:** v24 (`node:sqlite` builtin). `node_modules` is a **symlink** → `../my-ade/node_modules`.

## Commits on this branch

| commit | content |
|---|---|
| `99eb5f5` | spec: mahas-architecture spec package |
| `f318e3e` | **IMP-01 done** — packages/ boundary + desktop runtime seam (verified: typecheck+lint+build green) |
| `78f3688` | records/: orchestration STATUS tracker (`update-status.py`, `watch-commits.sh`) + REV/VER ledger — agent-created |
| `725aa9a` | **IMP-03 done** — storage kernel: `storage/db.ts` (SHARED-APIS surface), spec-DDL verbatim migrations, blob/receipt/event-outbox, host `storage.ts`; smoke 47/47 |
| `5c12015` | **IMP-14 done** — coordination: task-spec revisions, input-resolver, work-envelope, dispatch-authority, dispatch-ops; smoke 38/38 |

## State of work — ~190 .ts files / ~64k LOC, MOSTLY UNCOMMITTED

All 30 remaining tasks were launched in parallel; **28 were killed by the model rate limiter mid-write**. Their partial files are intact in the worktree — most are substantial (many have smoke tests). Nothing was lost to deletion; progress resumes via `resume` on each agent id.

Done: IMP-01, IMP-03, IMP-14.
Everything else: partial work on disk, completion unknown — resume + verify each.

### File map (task → its directories/files)

- IMP-02 (contracts): `packages/mahas-contracts/src/{common,index}.ts` seeded by coordinator; needs `ids,rdd,role,access,work,execution,mail,resource,observation,ops` — **critical path, everything imports these names**
- IMP-04 (RDD aggregate): `runtime/src/model/{repository,publisher,change-set,structural-rules,ops}.ts`
- IMP-05 (index/territory/impact): `runtime/src/model/{indices,territory,impact-candidates}.ts` (+ discovery search backend?)
- IMP-06 (discovery API): `runtime/src/discovery/*` (12 files: search/inspect/locate/collaborators/visibility…)
- IMP-07 (role realization): `runtime/src/realization/*` (14 files: interfaces, implementation-repository, profile-registry, publisher, component-graph…)
- IMP-08 (context compiler): `runtime/src/realization/{compiler,bundle-store,source-snapshots,coverage,effective-context}.ts`
- IMP-09 (materializer): `runtime/src/realization/materializer.ts` (+ materialize ops?)
- IMP-10 (access core): `runtime/src/access/*` (9 files: authorize, grant, policy, principal, provisioning, revocation, actual-targets, operations)
- IMP-11 (registry/admission): `runtime/src/api/*` (registry, admission, surface, handler-ports, registry.smoke)
- IMP-12 (RPC+CLI): `runtime/src/rpc/*` (8 files) + `packages/mahas-cli/src/*` (4 files)
- IMP-13 (Run/assign/META DAG): `runtime/src/coordination/{run,plan,member,eligibility,internal}.ts` — `internal.ts` is the shared helper IMP-14 reused
- IMP-15 (mail/artifacts): `runtime/src/mail/*` (8) + `runtime/src/artifacts/*` (4)
- IMP-16 (workspace/claims): `runtime/src/resources/*` (6) + `execution-host/src/workspace*.ts`, `workspaces/`
- IMP-17 (host bootstrap/lease): `execution-host/src/{host,lease,effects,main}.ts` + `runtime/src/hostClient.ts`
- IMP-18 (process/PTY/terminal): `execution-host/src/{process-manager,pty-manager,process-identity,terminal-stream,stop-controller}.ts`
- IMP-19 (worker.start): `runtime/src/launch/*` (11 files: planner, start-coordinator, stage-receipts, store, initial-attachment/directives…)
- IMP-20 (join/accept): `runtime/src/launch/{join,acceptance,bootstrap-credential,worker-connection}.ts`
- IMP-21 (outcome/settle/wake): `runtime/src/coordination` or `outcome/` — check `git status` for new files
- IMP-22 (recovery): `runtime/src/recovery/*` (7: reconciler, reattach, resume, stop, orphan, identity-probe, ports)
- IMP-23 (lifecycle): `runtime/src/lifecycle/*` (8) + `runtime/src/main.ts` (mahasd entry)
- IMP-24/25 (harness): `packages/mahas-harness-config/src/{claude,codex,…}` + index.ts
- IMP-26 (observation): `runtime/src/observation/*` (5)
- IMP-27 (maintenance): `runtime/src/maintenance/*` (5)
- IMP-28 (client views): `runtime/src/client/*` (8) + `src/main/runtimeClient.ts` + `src/preload/index.ts` diffs
- IMP-29 (backup/ops): `runtime/src/operations/*` (5: backup, restore, migration, gc, support)
- IMP-31 (team-leader workbench): `src/renderer/src/workbench/*` (PlanView/ResponsibilityView/TeamView/bits, store, ops, client, contracts)
- IMP-32 (role-config workbench): `runtime/src/inspector/*` (3)

## Conventions (enforced — read first)

- `packages/README.md` — package boundaries + import rules (relative `.ts` extensions, `import type`, eslint no-restricted-imports directions).
- `packages/SHARED-APIS.md` — coordinator-fixed kernel APIs + **canonical domain type names**. Cross-domain calls go through `makeCaller(registry, ctx)` op-name dispatch — never sibling service imports. Storage via `openControlDb/withTx/appendDomainEvent/insertReceipt` (`runtime/src/storage/db.ts`). Authz via `access/authorize.ts`. Host calls via `hostClient.call('host.*', …)`. Host ops register via IMP-17's op-registration seam.
- Contract types import from `packages/mahas-contracts/src/index.ts` by canonical names — IMP-02 owns them; consumers may reference names not yet exported (settles when IMP-02 lands).
- Each domain exports `register<Domain>Ops(registry, deps)` — IMP-30 wires.
- No git commits by task agents — coordinator commits per task after verifying.

## Resume plan

Rate limit: parallel bursts >~8 got killed. Resume in waves ≤6 concurrent, ~2-3 min between launches; if killed again, `resume` preserves progress — just re-resume.

Wave order (critical path first):
1. **IMP-02** (`a1925246`) — everything types from this
2. IMP-10 (`80e38127`), IMP-11 (`0be32588`), IMP-17 (`54c685d8`), IMP-18 (`933ecf89`), IMP-16 (`e166f1f5`)
3. IMP-04 (`06d13c6a`), IMP-12 (`b06d2d4f`), IMP-05 (`258bcfbb`), IMP-07 (`377e16ec`)
4. IMP-06 (`03e7f7eb`), IMP-08 (`8340637f`), IMP-13 (`d34c85fa`), IMP-09 (`05b92ded`)
5. IMP-15 (`493f9095`), IMP-19 (`32194728`), IMP-20 (`cfb537a1`), IMP-21 (`1e6b87d5`)
6. IMP-22 (`388214c8`), IMP-23 (`f5361d7c`), IMP-24 (`e70f425d`), IMP-25 (`77ffdc5f`)
7. IMP-26 (`53fcf339`), IMP-27 (`aeb899cd`), IMP-29 (`1f2e679f`), IMP-28 (`f35147d0`)
8. IMP-31 (`3b6f610c`), IMP-32 (`028f0ac1`)
9. **IMP-30** (fresh launch — integration/wiring, needs all landed)

Resume prompt template: "You were rate-limited mid-task. Continue IMP-XX exactly as your instruction file says — your partial files are in the worktree (check `git status` in /home/pyosechang/projects/ade-wt-mahas-architecture). Read packages/SHARED-APIS.md + your instruction's requiredReads. Finish, verify (npx tsc -p packages/<pkg>/tsconfig.json + your smoke), report ImplementationHandoff. Don't commit."

## Per-task completion → commit flow

For each finished agent: verify its files typecheck (`npx tsc -p packages/mahas-*/tsconfig.json`), `git add` its changedPaths only, commit `IMP-XX: <title>`. Keep `npm run typecheck` (app) green — src/* edits (IMP-28's seam, IMP-31 workbench) need care.

After all 31 land: launch IMP-30 (runtime wiring + CLI deploy + service entrypoints), then fix integration fallout until `npm run typecheck`, `npm run lint`, `npx electron-vite build`, and all package tsconfigs are green.

Then review-plan (REV-01..08) + verification-plan (VER-01..12) per `mahas-architecture/delivery.md` + `acceptance.md`. `mahas-architecture/records/` tracks unblocked REV/VER — run `python3 mahas-architecture/records/orchestration/update-status.py` after each IMP commit.

## Known unresolved decisions (from completed handoffs)

- IMP-03: `CommandReceipt` lacks `operation` field — insertReceipt reads it structurally; IMP-02 may add it (works unchanged either way).
- IMP-03: host↔runtime share no low-level sqlite port (eslint blocks host→runtime); `withTx`/`sha256Hex` deliberately mirrored in host `storage.ts`.
- IMP-14: `ACCEPTING_DECISIONS=['accepted']` literal adopted — IMP-21's outcome.decide must match (const exported).
- IMP-14: task_specs write path — IMP-13 plan.commit should go through taskSpec invariants (its internal.ts helpers).
- IMP-02 should export every canonical name in SHARED-APIS.md; `ExecutionRecord` (not `Execution` — `Execution` already exists in identity.ts for the seam type; IMP-02 resolves the collision).
