# WIP build + e2e — app suite re-run against the fix session's dirty worktree

Orchestration evidence, not a VER record. Same method as `app-e2e.md` (which
reproduced 37/0 on a clean `83a6d21` copy), this time against the live
mid-refactor WIP.

## Snapshot

- Source: `/home/pyosechang/projects/ade-wt-mahas-architecture` (branch `mahas-architecture`)
- Snapshot moment: `2026-09-18T22:27:26Z` — HEAD `ce6f3903cef4a98746d477cb67ce2f26cba6bb49`, `git status --short | wc -l` = **120** (98 M + 22 ??).
- Method: `rsync -a` (no excludes — `.git` included so the copy preserves the exact WIP diff) → `/tmp/mahas-wip-e2e/src`. `node_modules` is a symlink → `/home/pyosechang/projects/my-ade/node_modules`, preserved as-is by `-a` (same resolution as the baseline run). Copy verified: HEAD `ce6f390`, 120 dirty.
- Dirty-set shape: `packages/` 72 (57 M + 6 ?? mahas-runtime, 4 exec-host, 3 contracts, 2 cli), `src/` 13 (11 renderer workbench + `src/main/runtimeClient.ts` + new `workbench/InspectorView.tsx`), `mahas-architecture/spec` 17 M, records 15 ?? + 2 M, `HANDOFF.md` 1 M. Zero dirty under `tools/` — the e2e driver is untouched.
- Delta vs baseline `83a6d21`: the 47 files committed between `83a6d21..ce6f390` are **all under `mahas-architecture/records/`** — no product code changed by commit. The entire code delta under test = the 120 uncommitted files.
- Isolation (replicated from `app-e2e.md`): `HOME=/tmp/mahas-wip-e2e/home`, `XDG_CONFIG_HOME=/tmp/mahas-wip-e2e/xdg`, `XDG_DATA_HOME=/tmp/mahas-wip-e2e/data` exported for every command; `tools/e2e.mjs` additionally mkdtemp-overrides `XDG_CONFIG_HOME` per boot and runs each app instance with `MAHAS_TEST=1` + `ELECTRON_DISABLE_SANDBOX=1` + `MAHAS_HOOK_DEBUG=1`. Ran on the real desktop (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`).
- Main worktree untouched: `out/main/index.js` still 86 648 B dated Sep 18 22:24 after the run; HEAD + dirty count unchanged.

## Results

| # | Check | Command | Observed | Verdict |
|---|-------|---------|----------|---------|
| 1 | typecheck | `npm run typecheck` (tsc node + web) | exit 0, clean | pass |
| 2 | lint | `npm run lint` (eslint --cache .) | exit 1 — **966 problems (29 errors, 937 warnings)** | fail (see below) |
| 3 | app build | `npm run build` (typecheck + electron-vite) | exit 0; `out/{main,preload,renderer}` produced; `out/main/index.js` 86 823 B (baseline 86 648 B); `✓ built in 4.16s` | pass |
| 4 | app e2e | `node tools/e2e.mjs` (all 8 scenarios) | **`37 passed, 0 failed`**, exit 0 | **reproduced — matches 37/0 baseline** |

### Scenario breakdown (37/37, identical to baseline)

| Scenario | Checks | Result |
|----------|--------|--------|
| orphans — app quit kills agent processes | 2 | 2/2 |
| resume — two sessions restore to their own tabs | 5 | 5/5 |
| attention — attended/ambient/away + read-on-view | 7 | 7/7 |
| status — working pulse / input amber / error red dots | 5 | 5/5 |
| adopt — previous-run orphan events re-register | 2 | 2/2 |
| projectrm — removing a project drops workspaces + cleans state | 8 | 8/8 |
| browserfile — html opens as file:// tab in browser pane | 3 | 3/3 |
| tabdnd — hold-drag reorder/split/stack/cross-workspace | 5 | 5/5 |

## Lint failure analysis (not part of build; baseline never ran lint)

All **29 errors** are in `mahas-architecture/records/verification/evidence/VER-01|VER-02/harness/*.ts` — verification-harness scripts committed at HEAD (`ce6f390`), not in the dirty set and not product code: `no-unused-vars` (dead bindings like `q1`/`qa`/`rProf2`/`provAll`/`rSend`/`threw`), `explicit-function-return-type`, a few `no-explicit-any`. `eslint.config.mjs` ignores `node_modules`/`dist`/`out`/`resources`/`tools` but not `records/`, so evidence TS gets linted.

The 937 warnings are overwhelmingly `prettier/prettier` formatting drift across `packages/mahas-runtime/**` (the WIP refactor's unformatted files) plus a handful in `src/renderer/src/workbench/*` — `0 errors and 937 warnings potentially fixable with --fix`. Consistent with mid-flight code not yet prettier-clean.

## Test-visible WIP changes (diff grep)

- `tools/` — zero dirty files; e2e driver and `mahas-fake.mjs` byte-identical to baseline.
- `src/main/runtimeClient.ts` (+9/−4): `receiptToControl` now maps `pending`/`unknown` receipts to `"<status>: outcome not yet known"` with `retryable: true` — error-shaping only, not on any e2e path.
- `src/renderer/src/**` dirty files are all workbench-surface (`PlanView`, `ResponsibilityView`, `TeamView`, `bits`, `contracts`, `ops`, new `InspectorView`, `WidgetView`, `LeafPane` workbench lane, `i18n`, `types`, `utils`) — none touch the pty/tab/workspace/notify/drag pipeline the suite exercises.
- `packages/mahas-runtime/src/api/admission.ts`: mutations now gate on `resolveTargets` — ops without a declared resolver fall back to `defaultTargetsFromPayload`, and a mutation resolving **zero** actual targets throws `SCOPE_DENIED` (admission.ts:500-518). The known-dead socket ops live behind this gate; `tools/e2e.mjs` drives the Electron UI, not the runtime socket API, so the mid-migration op deaths do not surface here. (Tx-depth hooks + `inbox.wait` long-poll autocommit also landed in the same file.)

## New failures vs baseline

**None.** Every check that passed on clean `83a6d21` passes on the WIP tree; nothing that was failing is newly fixed or newly broken in this suite's scope.

## Verdict

**App-surface green; WIP still mid-flight.** The desktop app under test builds clean and reproduces **37 passed / 0 failed** on the dirty tree — the 120-file refactor does not regress any e2e-covered behavior, and typecheck is clean. But the tree is not releasable as-is: `npm run lint` fails (29 errors in committed VER harness files + 937 warnings in unformatted `packages/` WIP), and the runtime socket layer is mid-migration (mutation ops gated on `resolveTargets`, several dead by design per the fix session's own notes) — outside this suite's coverage.

## Raw evidence

- `/tmp/mahas-wip-e2e/out/typecheck.log` — exit 0 (md5 `fc322db2…`)
- `/tmp/mahas-wip-e2e/out/lint.log` — exit 1, 966 problems verbatim (md5 `ee4f4988…`)
- `/tmp/mahas-wip-e2e/out/build.log` — exit 0, `✓ built in 4.16s` (md5 `d15d6fec…`)
- `/tmp/mahas-wip-e2e/out/e2e.log` — `37 passed, 0 failed`, `E2E_EXIT=0` (md5 `fe6fe7c8…`)
- `/tmp/mahas-wip-e2e/src/` — the snapshot copy (incl. `.git`; rebuilt `out/` present)
- `/tmp/mahas-wip-e2e/{home,xdg,data}` — fake HOME/XDG; captured Electron caches (`.pki`, `.cache/{nvidia,fontconfig,radv_builtin_shaders}`) confirm the app ran under the fake HOME, not the real one.
