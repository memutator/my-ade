# Smoke baseline — independent re-verification of HANDOFF green claims

- Repo: `/home/pyosechang/projects/ade-wt-mahas-architecture`
- Branch: `mahas-architecture`, HEAD `83a6d21` (`docs: handoff — implementation complete…`)
- Verifier node: `v24.20.0` (runs `.ts` directly), npm `11.19.0`
- Constraints honored: no repo writes outside this file, no `npm install`/`dev`/`build`/`lint`, no `tools/e2e.mjs`, no git writes. Raw logs: `/tmp/mahas-ver-smoke/`.

## Results

| # | Check | Command | Claim (HANDOFF.md) | Observed | Verdict |
|---|-------|---------|--------------------|----------|---------|
| 1 | contracts tsconfig | `npx tsc -p packages/mahas-contracts/tsconfig.json` | noEmit-clean | exit 0, 0 lines output | pass |
| 2 | harness-config tsconfig | `npx tsc -p packages/mahas-harness-config/tsconfig.json` | noEmit-clean | exit 0, 0 lines output | pass |
| 3 | execution-host tsconfig | `npx tsc -p packages/mahas-execution-host/tsconfig.json` | noEmit-clean | exit 0, 0 lines output | pass |
| 4 | cli tsconfig | `npx tsc -p packages/mahas-cli/tsconfig.json` | noEmit-clean | exit 0, 0 lines output | pass |
| 5 | runtime tsconfig | `npx tsc -p packages/mahas-runtime/tsconfig.json` | noEmit-clean | exit 0, 0 lines output | pass |
| 6 | app typecheck | `npm run typecheck` (tsc -p tsconfig.node.json + tsconfig.web.json, --composite false) | green | exit 0, no diagnostics | pass |
| 7 | discovery smoke | `node packages/mahas-runtime/src/discovery/smoke.ts` | 51/51 | `51 passed, 0 failed`, exit 0 | pass |
| 8 | mail smoke | `node packages/mahas-runtime/src/mail/smoke.ts` | 48/48 | `48 passed, 0 failed`, exit 0 | pass |
| 9 | maintenance smoke | `node packages/mahas-runtime/src/maintenance/smoke.ts` | PASS (38 ok) | 38 `ok` checks, `SMOKE PASS`, exit 0 | pass |
| 10 | registry/api smoke | `node packages/mahas-runtime/src/api/registry.smoke.ts` | 40/40, 92 ops indexed | `40 passed, 0 failed` incl. `PASS 92 operations indexed`, exit 0 | pass |
| 11 | app lint | `npm run lint` | green | not-run — `eslint --cache` writes `.eslintcache` into the repo (forbidden) | not-run |
| 12 | app build | `npm run build` | green | not-run — writes `out/` (forbidden) | not-run |
| 13 | app e2e | `node tools/e2e.mjs` | 37/0 | not-run — needs `out/` build and spawns the app (forbidden) | not-run |

## Notes

- Smoke-file inventory is exhaustive: `find . -name "*smoke*" -not -path "./node_modules/*"` returns exactly the four harnesses above. `grep -rln smoke` also hits `packages/mahas-runtime/src/discovery/deps.ts:12` and `packages/mahas-runtime/src/main.ts:571` — comments only, not runnable harnesses.
- Output tails captured in `/tmp/mahas-ver-smoke/`: `tsc-<pkg>.log` (all empty), `app-typecheck.log`, `smoke-{discovery,mail,maintenance,registry}.log`.
- Registry smoke tail includes `PASS 92 operations indexed` — the "92 ops" sub-claim reproduces.
- The lint/build/e2e claims are unverified by this pass; typecheck is a component of `npm run build` and is independently green, but bundling (`electron-vite build`) and the 37-scenario e2e were out of scope for the no-write constraint.

## Overall verdict

All ten verifiable green claims reproduce exactly (5 package tsconfigs, app typecheck, 4 smokes: 51/51 · 48/48 · 38-ok PASS · 40/40 w/ 92 ops); lint, build, and e2e-37/0 remain unverified by design.
