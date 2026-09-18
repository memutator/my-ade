# HANDOFF — mahas architecture implementation (coordinator state)

**Status: IMPLEMENTATION COMPLETE (2026-09-18).** All 32 IMP tasks are
implemented in this worktree; independent review (REV-01..08) and formal
verification (VER-01..12) have deliberately NOT been run — "implemented" is
not "accepted" (docs/implementation-plan/INSTRUCTIONS.md).

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
