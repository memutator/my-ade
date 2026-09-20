# Verification

What can be checked in this repository, how to run it, and what the checks do not
prove. Results below were observed in this worktree on 2026-09-20, using system
Node 24.20.0 and isolated synthetic fixtures. Successful commands exited 0.
The earlier shell E2E snapshot is distinguished from the final domain/UI checks.
These passes are not a whole-milestone completion verdict; the separate
[source audit](milestone-audit.md) records implementation gaps and unverified criteria.

## Commands

| command | what it covers | typical runtime |
| --- | --- | --- |
| `npm run check:boundaries` | every import in `packages/*/src`, `src/main`, `src/preload`, `src/renderer`: resolved package direction, type-only UI imports, the narrow runtime↔host and runtime↔client exceptions | ~0.5 s |
| `npm run test:boundaries` | the boundary policy itself against a temporary fixture tree | ~0.3 s |
| `npm run check:docs` | every repo-relative Markdown link in the root docs, `docs/**`, `packages/**`, `integrations/**`, and `.codex/**` resolves | ~0.2 s |
| `npm run typecheck:node` | main + preload (`tsconfig.node.json`) | ~5 s |
| `npm run typecheck:web` | renderer (`tsconfig.web.json`) | ~15 s |
| `npm run typecheck:packages` | each package entrypoint **and every file under `packages/*/src`** participates in that package tsconfig program, then each program typechecks | ~10 s |
| `npm run typecheck:integrations` | Pack and fixture TypeScript under `integrations/**/*.ts` | ~5 s |
| `npm run typecheck` | node + web + packages + `tsconfig.integrations.json` (`integrations/**/*.ts`) | ~30 s |
| `node tools/check-catalog-roster.mjs` | Pack `harnesses.json` / `providers.json` ids match `BUILTIN_HARNESSES` / `BUILTIN_PROVIDERS` | ~0.1 s |
| `npm run lint` | ESLint (with cache), including the `mahas-boundaries/resolved-package-imports` rule | ~10 s |
| `npm run build:services` | bundles `mahasd`, `execution-host`, and the `mahas` CLI into `out/services/*.mjs`, parses each artifact with `node --check`, then boots each one in a throwaway config dir | ~15 s |
| `npm run test:domain` | synthetic domain smokes: unit + pipeline suites (21 scripts) | ~1 min |
| `npm run test:domain:full` | all six suites — unit, pipeline, renderer, runtime, daemon, packs (46 scripts, includes ~30 s daemon acceptance) | ~2–3 min |
| `npm run test:packs` | the packs suite alone: registry smokes, 8 conformance fixtures, 3 provider-Pack tests, all-Pack acceptance (14 scripts) | ~10 s |
| `npm run test:launch` | the launch/access suite on its own | ~10 s |
| `npx electron-vite build` | main/preload/renderer bundles into `out/`, and runs the service bundler as its `closeBundle` step | ~6 s |
| `npm run build` | `typecheck` + `check:boundaries` + `check:docs` + Pack projection `--check` + catalog roster check + `electron-vite build` | ~40 s |
| `node tools/e2e.mjs [scenario]` | CDP-driven end-to-end run against `out/` with `tools/mahas-fake.mjs`; needs a prior build | minutes |
| `node tools/domain-ui-smoke.mjs` | real Electron + real mahasd end-to-end: synthetic Codex file → auto collection → stored ledger → preload/UI | minutes |

## Observed on 2026-09-20 (final integration)

| check | result | log |
| --- | --- | --- |
| `npm run typecheck` | **pass** — node, web, 6 packages / 331 program files | `/tmp/mahas-final-types.log` |
| `npm run lint -- --quiet` | **pass** | `/tmp/mahas-final-lint2.log` |
| final `npm run check:docs` / `git diff --check` | **pass** — after final documentation cleanup | `/tmp/mahas-docs-release-final.log` |
| `npm run test:boundaries` | **pass** — 17 policy fixtures | `/tmp/mahas-boundary-final.log` |
| `npm run test:domain:full` | **pass** — 46 scripts across all six suites | `/tmp/mahas-domain-final-candidate.log` |
| auth routing smoke, after the final collision guard change | **pass** — 19 checks, including per-offering routing, concurrent starts, cross-Pack flow-id collision refusal and exact quota pin | `/tmp/mahas-auth-routing-final.log` |
| `npm run build` | **pass** — typecheck, boundaries, docs, desktop/service bundles and isolated service boot; subsequent file-import UI bundle also passed | `/tmp/mahas-integration-build12.log`, `/tmp/mahas-fileimport-ui-build.log` |
| `node tools/domain-ui-smoke.mjs` | **pass** — 34 checks against the real Electron/daemon/preload path, no renderer exceptions; 13 tracked processes exited and scratch was removed | `/tmp/mahas-domain-ui-fileimport.log` |
| full shell `node tools/e2e.mjs` | **pass** — 45/0; earlier snapshot before the final auth/usage UI changes | `/tmp/mahas-resume-e2e-full.log` |
| focused resume / lifetime E2E | **pass** — 6/0 and 5/0; same earlier shell snapshot | `/tmp/mahas-resume-e2e-resume3.log`, `/tmp/mahas-resume-e2e-lifetime.log` |
| `npm run build:linux` | **pass** — 0.5.0 deb + AppImage; root typecheck, boundaries, docs, desktop/service build and isolated boots | `/tmp/mahas-release-0.5.0.log` |
| packaged UI | **pass** — 34/34 using `dist/linux-unpacked/mahas`; 13 fixture processes exited and scratch removed | `/tmp/mahas-packaged-ui-0.5.0.log` |
| artifact inspection | **pass** — version/architecture, archive exclusions, PTY resources; actual deb has the same asar, 3 services and 9 Pack manifests as the tested tree | `/tmp/mahas-artifacts-0.5.0.log` |
| apt install, live provider auth/quota APIs, real user session logs | **not run** — auth/quota tests use synthetic files and stubbed fetch | — |

The packaged UI screenshot is `/tmp/mahas-tokens-packaged-0.5.0.png`.
The inspected Debian payload installs under `/opt/Mahas` (case-sensitive).

The domain UI checks cover the independent global total (14, cache 6), provider /
offering / requested and served native model breakdowns, all three statistics,
canonical session navigation with minimized pane/tab restoration, unbound
connections, the quota refresh signal, selected-file import through main/preload,
idempotent re-import, legacy display deduplication, and removal without deleting
the user's file or reviving a removed connection. They do not drive the native
file-picker dialog or a live vendor login.

Resolved intermediate failures are retained here as history: the unused auth
helper and empty fixture method caused type/lint failures (`/tmp/ver-tc2.log`,
`/tmp/ver-lint2.log`); both were fixed before the final passes. Three mid-edit
fixtures failed in `/tmp/ver-domain-full.log` and passed after integration.
UI6 reported 27/29 (`/tmp/mahas-domain-ui6.log`): exact global selection was fixed,
and the final expanded UI run passes 34/34. An emitting `tsc -b` produced source
siblings that shadowed TypeScript; those generated files were removed and the
root no-emit typecheck is the supported command.

`tools/run-domain-smoke.mjs` runs 46 distinct scripts in the full suite, including
the client connector, actual daemon auth, durable channel workflow, explicit
locator import and renderer rollup fixtures. Duplicate suite membership runs a
script only once. The default unit + pipeline subset contains 21 scripts.

### Domain smoke coverage (all synthetic fixtures)

| script | covers | result |
| --- | --- | --- |
| `storage/domain-migration.smoke.ts` | fresh schema through current version, v1 upgrade, reopen, backup image, rollback, downgrade | pass |
| `catalog/repository.smoke.ts` | catalog identities, reference checks, immutability | pass |
| `inventory/repository.smoke.ts` | installations, credentials, connections, bindings, alias intervals | pass |
| `recovery/session-handles.smoke.ts` | canonical session/handle bridge and legacy backfill over the real schema | pass |
| `sessions/hook-stream.smoke.ts` | hook event stream: bounded pass, durable cursor, partial line, malformed gap, truncation, rotation, missing file, oversized line, conflict, dedup, parent identity, stored reads, reader lifecycle | pass |
| `sessions/desktop-import.smoke.ts` | desktop legacy resume records: true migration before the store query, placement-only metadata, unknown harnesses reported not guessed | pass |
| `inspector/inspector-contract.smoke.ts` | inspector wire contract against the runtime's canonical responses | pass |
| `packages/mahas-client/src/client.smoke.ts` | operator connection file, reconnect, receipt mapping — pure client side, no daemon | pass |
| `domain-pipeline.smoke.ts` | external Pack snapshot/run → scheduler → atomic ledger → stored queries → replay, partial lines, source loss → DB reopen + rebuild | pass |
| `integration/pack.smoke.ts` | registry digest/immutability, runner identity echo, conformance verdicts, durable admission and effect/transaction separation (29 checks) | pass |
| `integration/builtin-packs.smoke.ts` | registration, content digest, and contract resolution for all 9 shipped built-in Pack revisions | pass |
| `observation/collection/collection.smoke.ts` | bounded collection pipeline | pass |
| `metering/usage/ledger.smoke.ts` | session/collection/usage ledger commits | pass |
| `metering/aggregates/aggregates.smoke.ts` | aggregates, null/unknown correction, pool enrichment | pass |
| `metering/statistics/statistics.smoke.ts` | statistics, 5200-entry rebuild, DST calendar buckets, coverage | pass |
| `inventory/auth/auth.smoke.ts` | provider auth coordinator flows, locator import/adoption, quota loop, Pack selection, dedicated socket, admission pipeline and multi-Pack routing (19 checks) | pass |
| `inventory/auth/locator-import.smoke.ts` | 10 checks: idempotence, missing connection repair, removed/adopted history, changed material and same-path offering separation | pass |
| `inventory/auth/channel-workflow.smoke.ts` | durable user-channel completion: atomic rollback/retry, idempotent status, autonomous callback, local machine | pass |
| `metering/quota/poll.smoke.ts` | quota polling: rotation, same-time observations, pinned provenance, null time coverage, single flight, shutdown, atomic failure, material revision guard and redacted read errors | pass |
| `api/registry.smoke.ts` | operation registry, admission | pass |
| `api/admission.deferred.smoke.ts` | deferred/durable admission (9 checks) | pass |
| `launch/workspace-gate.smoke.ts` | resource-gate regression: rejected/unknown workspace never spawns | pass |
| `launch/f064-recovery.smoke.ts` | F-064 recovery fixture | pass |
| `launch/launch-host-integration.smoke.ts` | launch ↔ host integration | pass |
| `access/f062-assignment-service.smoke.ts` | assignment authorization and the narrow service principal | pass |
| `domain-daemon.smoke.ts` | real daemon acceptance: auto collection keeps running after the client disconnects, reconnect reads stored entries, restart preserves them, a repeated UI read does not collect (~31 s) | pass |
| `domain-auth.smoke.ts` | assembled daemon + built-in Pack + real auth socket with synthetic secrets; in-process stubbed fetch — operator channel, built-in login/cancel/list, automatic legacy import, managed ownership, quota provenance, explicit file import/removal, secret-free receipts | pass |
| `src/renderer/src/workbench/store.smoke.ts` | workbench scope/queue/mapper logic with synthetic data (20 checks) | pass |
| `src/main/agentEventIngest.smoke.ts` | agent event ingest | pass |
| `src/main/state/persistence.smoke.ts` | state persistence | pass |
| `src/main/runtime/serviceBootstrap.smoke.ts` | desktop service bootstrap | pass |
| `src/main/runtime/authResponse.smoke.ts` | auth response projection | pass |
| `src/renderer/src/features/sessions/view-model.smoke.ts` | sessions panel view-model | pass |
| `src/renderer/src/features/usage/rollup.smoke.ts` | usage rollup selection/projection | pass |
| packs suite (8 conformance + 3 provider tests + acceptance) | each shipped Pack's own conformance fixture through the real registry + `runPack` against synthetic vendor files/SQLite; all-Pack acceptance commits into the real ledger | pass |

### What the Pack smokes do *not* prove

`integration/pack.smoke.ts` and `integration/builtin-packs.smoke.ts` cover the
registry and runner: manifest validation, content digests, immutability, the
pinned identity echo, conformance verdict handling, and durable admission. They do
**not** run any vendor collector.

The collectors are covered separately by `npm run test:packs`, which runs each
Pack's own conformance fixture through the real registry and `runPack` against
synthetic vendor files/SQLite databases, then drives all seven through
`integrations/all-packs.acceptance.smoke.ts` into the real ledger. Both layers are
synthetic: no real installation, session log, credential, or network endpoint is
read, so a collector that no longer matches a live vendor schema can still pass.
That is a regression net, not a compatibility claim — see
[authoring](../integrations/authoring.md#verification-status).

The auth and quota coverage is synthetic in the same way: `domain-auth.smoke.ts`
and `auth.smoke.ts` stub `fetch` inside the test process, so no request can
leave the machine. A real provider login, a real quota API response, and a real
user credential file have never been exercised.

## What each check proves, and what it does not

- **Boundaries.** The checker resolves each specifier to a file or package before
  applying the rules, so `../` depth cannot hide a violation, and it reads inline
  `import { type X }` / `export { type X }` specifiers. It does not check runtime
  behavior, dynamic specifiers built at runtime, or links in prose.
- **Typecheck.** `typecheck:packages` fails when a package source file is excluded
  from its own tsconfig program (the failure mode that silently hides errors), then
  runs `tsc --noEmit`. It does not prove the code runs: these packages execute under
  Node type stripping, and `noEmit` never exercises a real daemon.
- **Service artifacts.** `build-services.mjs` fails the build if an expected bundle
  is missing or does not parse, then boots each artifact in an isolated scratch
  environment (empty `HOME`/`XDG_*`/`MAHAS_CONFIG_DIR`/`MAHAS_BUILTIN_PACKS_DIR`,
  explicit `MAHAS_EVENTS_FILE`/`MAHAS_NOTIFY_LOG`). It does not prove the daemon
  answers an operation under the desktop's real wiring.
- **Docs links.** Only repo-relative targets are checked; external URLs, anchors,
  and link labels are not.
- **E2E.** `tools/e2e.mjs` drives the built app over CDP with a fake harness. It
  needs a successful `npm run build` first, and it does not cover provider APIs,
  credentials, or a packaged install.

## Rules for recording a result

- Record the command, the exit code, and the environment; a partial run is reported
  as partial, and a check that was skipped is reported as not run.
- Never re-present a historical record (`mahas-architecture/verification-plan/`,
  `records/`, or an older `requirements/*.md`) as evidence for current code.
- Use synthetic fixtures and temporary databases. Real credentials, provider APIs,
  and user session logs are not test inputs.
- When a check starts failing for work owned elsewhere, keep the observed failure in
  this file with its owner rather than deleting the entry.
- A check still in flight is recorded as in progress with its log path, never as
  passed.

## Related

- Setup, hot reload, and the command table: [setup.md](setup.md).
- Packaging and the service artifacts: [packaging.md](packaging.md).
- Pack-level checks and the fixture matrix: [../integrations/authoring.md](../integrations/authoring.md).
- Contract-level checks: [../architecture/contracts/README.md](../architecture/contracts/README.md).
