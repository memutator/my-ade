# packages/ — mahas service boundaries

The service side of the `mahasd + reattachable execution-host` architecture
([spec/architecture.md](../mahas-architecture/spec/architecture.md) §1–2) lives
here. The Electron app under `src/` is a **client** of these services. This file
fixes the conventions every package follows; the responsibility-to-code map is
[docs/development/code-map.md](../docs/development/code-map.md) and domain status
is [docs/architecture/domains/README.md](../docs/architecture/domains/README.md).

## Packages and dependency direction

| package | role | may import |
| --- | --- | --- |
| `mahas-contracts` | shared contract port — pure types/constants only, no I/O, no Node | nothing (no sibling packages, no `src/`) |
| `mahas-harness-config` | harness profile registry (detection patterns, resume recipes) — data, not provider adapters | contracts |
| `mahas-execution-host` | reattachable daemon owning PTY/process incarnations — `src/main.ts` is the service entrypoint | contracts |
| `mahas-runtime` | the control plane: composition root, storage + migrations, domain services (catalog, inventory, integration/Packs, sessions, observation/collection, metering, access, coordination, discovery, launch, recovery, resources, artifacts, maintenance, inspector), RPC server | contracts, harness-config, client (facades/tests only) |
| `mahas-client` | shared authenticated mahasd RPC client used by the desktop and the CLI | contracts |
| `mahas-cli` | `mahas` operator/agent CLI — collaboration-API client | contracts, runtime, harness-config |
| `src/main` (desktop) | composition seam — `src/main/runtimeClient.ts` owns the app's runtime attachment + `exec:*`/`runtime:*` IPC | contracts, runtime, harness-config (spawns execution-host by path, never imports it) |
| `src/preload`, `src/renderer` | UI client surface — `window.mahas.exec`/`runtime` + type imports | contracts (**type imports only**), never runtime/execution-host/cli/harness-config internals |

The direction is enforced twice from one policy
(`tools/boundary-policy.mjs`): `npm run check:boundaries` resolves every import
in every source file, and the `mahas-boundaries/resolved-package-imports` ESLint
rule applies the same rules during `npm run lint`. Two narrow exceptions exist
and are scoped on purpose: `mahas-runtime` may reach `mahas-execution-host` and
`mahas-client` from `*.smoke.ts` / `*.manual.ts` / fixture directories, and the
two compatibility facades `src/bootstrap.ts` and `src/rpc/client.ts` may reach
the client until their callers move. Imports inside one package (for example the
central migration importing each domain's SQL fragment) are ordinary composition.

## Module/import conventions

- Each package keeps `package.json` (`"type": "module"`, private, deps
  declared for documentation) and `tsconfig.json` extending
  `packages/tsconfig.base.json` (strict, `module/moduleResolution: NodeNext`,
  `verbatimModuleSyntax`). This repo is **not** an npm-workspaces monorepo;
  nothing requires `npm install` for typecheck — `node_modules` is a symlink.
- **Cross-package and cross-boundary imports are RELATIVE paths with an
  explicit `.ts` extension**, e.g.
  `import { bootstrapRuntime } from '../../mahas-runtime/src/index.ts'`.
  Reasons: (a) typechecks today with zero install/build under both NodeNext
  (packages) and bundler (src/* tsconfigs) resolution;
  (b) Node ≥ 24 runs the entrypoints directly (`node packages/mahas-execution-host/src/main.ts`)
  via type stripping — `.ts` extensions are what its resolver requires;
  (c) `rewriteRelativeImportExtensions` (set in `tsconfig.base.json` and in
  `tsconfig.node.json`/`tsconfig.web.json`) keeps a future `tsc` emit legal.
- Type-only imports use `import type` — the renderer's use of contracts is
  exclusively `import type`, so contract types can never pull control-plane
  code into a view bundle.
- Typecheck any package with `npx tsc -p packages/<pkg>/tsconfig.json`
  (`noEmit` is set in the base config). Emit builds for packaging are a
  later task's choice (`rewriteRelativeImportExtensions` already permits
  `.ts` specifiers to be rewritten to `.js`).

## What runs today vs what is not wired

- **Real today:** the `mahasd` daemon (single-writer lock, endpoint publication,
  readiness sequence, control DB with the v3 migration chain, domain services,
  RPC server), the `execution-host` daemon (endpoint claim, process/PTY and
  workspace ops, terminal streaming), the authenticated client used by both the
  desktop and the CLI, the desktop's service bootstrap and `exec:*` IPC, and the
  `mahas` CLI.
- **Wired but unverified end to end:** the desktop launch path against a real
  installed app (packaging is not exercised here), provider auth/quota against
  real providers (never a test input), and Pack collection against real vendor
  data. See [docs/development/verification.md](../docs/development/verification.md).
- **Compat projections:** the desktop's old `usage:*`/`usage:auth`/`usage:ledger`
  IPC channels now project the daemon's stored domain reads into the legacy wire
  shapes (`src/main/{usage,usageAuth,ledger}.ts`) — they open no credential, log,
  or endpoint. The renderer's usage/sessions features call `window.mahas.domain.*`
  directly. Duplicated DTOs still exist on both sides of the seam (see
  [docs/architecture/contracts](../docs/architecture/contracts/README.md)).

## Migration seam — existing call sites → new boundary (§6.3)

Existing behavior is preserved (REQ-27): the unmanaged terminal path, the
state file, resume records and detached relays all stay exactly where they
are. This table maps each call site to its future seam so later tasks
migrate deliberately instead of ad hoc.

| existing call site | file:lines | today | migration seam |
| --- | --- | --- | --- |
| terminal spawn / attach / write / resize / kill / events | `src/renderer/src/components/TerminalPane.tsx` (~L326–538); `src/renderer/src/resume.ts` L44–132; `src/renderer/src/store.ts` L783; `src/renderer/src/components/LeafPane.tsx` L226 | `window.mahas.pty.*` → `pty:*` IPC → `src/main/pty.ts` → `resources/pty-host.cjs` | **unmanaged terminals stay on `pty:*`.** Managed executions use `window.mahas.exec.*` → `exec:*` → `src/main/runtimeClient.ts` → `packages/mahas-runtime` → mahasd/execution-host (IMP-17+). `TerminalTab.binding` holds the view↔Execution/Terminal link once bound. |
| pty-host process create/kill | `src/main/pty.ts`; `startPtyHost`/`stopPtyHost` wired in the `src/main/index.ts` composition root | child process owned by the app; dies at `will-quit` | stays app-owned until IMP-17/23 move session ownership to the execution-host daemon. Lifecycle port = `disconnectDesktopRuntime()` in `will-quit` (detach only — UI close never drain-stops). |
| renderer persistence (hydrate/save/saveSync) | `src/renderer/src/main.tsx`; `src/renderer/src/App.tsx`; `src/main/state/store.ts` (`state:*` IPC) + `src/main/state/persistence.ts` (atomic writes) | `userData/mahas-state.json` written by main-window renderer | stays — UI state remains renderer-owned. Control-plane state belongs to mahasd (not migrated here). `TerminalTab.binding` rides the existing save path. |
| session resume records | `src/renderer/src/resume.ts`; `upsertResumeSession`/`dropResumeSession`/`dropResumeWhere` in `src/renderer/src/store.ts`; `src/renderer/src/attention.ts` | observation records → typed resume commands into fresh shells | stays observation data — never converted into managed Tasks/Executions (IMP-01 §4.4, REQ-27). |
| detached-window relay | `src/main/platform/windowIpc.ts` `registerWindowIpc` (`pane:hello`, `pane:cmd`, `pane:syncUp`, `pane:reattach`, `win:detach`); `src/renderer/src/components/DetachedApp.tsx` | view plumbing between main renderer and detached pane windows | stays; view bindings (`viewId` = pane/tab) flow through `exec:bindView`/`client.view.bind` when a runtime exists. |
| agent hook event ingest | `src/main/hooks.ts` (`startEventIngest`, `registerHookIpc`), `src/main/hookInstallers.ts`, `src/main/harnessPack.ts` | NDJSON event tail → `agent:event` → renderer attention policy | the hook script and the installer/harness declarations now live in the `builtin.harness-runtime` Pack (`integrations/packs/harness-runtime/hooks/mahas-hook.cjs`, `harnesses.json`, `installers.json`); main reads them through `mahas-harness-config`. |
| harness manifest read | `src/main/platform/agentIpc.ts` (`agents:manifest`, `agents:icon`, `agents:config`) | reads `resources/agents/manifest.json` ad hoc | `packages/mahas-harness-config` owns the registry port (`loadHarnessProfiles` reads the same format). The renderer's copy keeps flowing via `agents:manifest` IPC until the workbench rewires. |
| renderer→contracts | `src/renderer/src/types.ts` (`TerminalTab.binding`) | — | `import type` from `mahas-contracts` is the renderer's only package import (eslint-enforced). |

## Files downstream tasks import

- `packages/mahas-contracts/src/index.ts` — identity (`Execution`, `Terminal`,
  `ProcessIncarnation`, liveness/states), `ServiceEndpoint`/`ServiceStatus`/
  `ShutdownRequest`, `ExecutionBinding`/`BindViewRequest`, `RuntimeClient`,
  `ControlResult`/`ControlErrorCode`, `CreateExecutionRequest`/`ExecutionQuery`.
- `packages/mahas-runtime/src/bootstrap.ts` — `bootstrapRuntime`,
  `RuntimeHandle`, `defaultMahasdEndpoint`, `parseEndpoint`,
  `MAHASD_ENDPOINT_ENV`, `MAHAS_RUNTIME_PROTOCOL_VERSION` (also re-exported
  via `src/index.ts` with `unavailableClient`).
- `packages/mahas-execution-host/src/main.ts` — daemon entrypoint: exclusive
  endpoint claim, host identity publication, authenticated NDJSON RPC,
  process/PTY and workspace ops registered through `host.ts`.
- `packages/mahas-cli/src/main.ts` — `mahas` CLI: verb words map to registry
  operation names; `status` probes `runtime.status`, `--version` prints the
  exact package version, unreachable daemons report honest
  `CONTROL_UNAVAILABLE`.
- `packages/mahas-harness-config/src/index.ts` — `HarnessProfile`,
  `loadHarnessProfiles(dir)`, `resumeCommand(profile, sessionId)`.
- `src/main/runtimeClient.ts` — `initDesktopRuntime`, `registerRuntimeIpc`,
  `runtimeHandle`, `requestRuntimeShutdown`, `disconnectDesktopRuntime`.
- `src/preload/index.ts` — `window.mahas.exec.*`, `window.mahas.runtime.status`.
