# packages/ — mahas service boundaries (IMP-01)

New code for the `mahasd + reattachable execution-host` architecture
(spec/architecture.md §1–2) lives here. The Electron app under `src/`
becomes a CLIENT of these services; this file fixes the conventions all
downstream tasks follow.

## Packages and dependency direction

| package | role | may import |
| --- | --- | --- |
| `mahas-contracts` | shared contract port — pure types/constants only, no I/O, no Node | nothing (no sibling packages, no `src/`) |
| `mahas-harness-config` | harness profile registry (detection patterns, resume recipes) — data, not provider adapters | contracts |
| `mahas-execution-host` | reattachable daemon owning PTY/process incarnations — `src/main.ts` is the service entrypoint | contracts |
| `mahas-runtime` | control-plane client-side composition — `src/bootstrap.ts` endpoint resolution + readiness probe, `RuntimeClient` | contracts, harness-config |
| `mahas-cli` | `mahas` operator/agent CLI — collaboration-API client | contracts, runtime, harness-config |
| `src/main` (desktop) | composition seam — `src/main/runtimeClient.ts` owns the app's runtime attachment + `exec:*`/`runtime:*` IPC | contracts, runtime, harness-config (spawns execution-host by path, never imports it) |
| `src/preload`, `src/renderer` | UI client surface — `window.mahas.exec`/`runtime` + type imports | contracts (**type imports only**), never runtime/execution-host/cli/harness-config internals |

The direction is enforced by `no-restricted-imports` blocks in
`eslint.config.mjs` — `npm run lint` fails on a violation.

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

## What exists vs what is injected later (honest status)

- **Real today:** endpoint resolution (`<configDir>/mahasd.sock`,
  `MAHASD_ENDPOINT` override), a genuine reachability probe, honest
  `ServiceStatus` verdicts (`unavailable` / `degraded` when a socket answers
  without a negotiated session), the `exec:*` IPC feature boundary, the
  view↔execution binding port types, the execution-host entrypoint shell
  (`hello` op + lifecycle lines + clean shutdown), `mahas status` in the
  CLI, and the manifest loader in harness-config.
- **Not here (injected by later tasks):** mahasd itself, daemon spawn,
  ControllerLease, the versioned RPC transport, mahas.sqlite /
  execution-host.sqlite, process managers, reconciliation. The runtime
  client answers `CONTROL_UNAVAILABLE` for every operation — that is the
  truth, not a stub. IMP-17/23 inject real service lifetime behind
  `bootstrapRuntime`'s `sessionFactory` without reshaping callers.
- **UI must not claim daemon-backed persistence yet** — `exec:*` exists as
  a port; nothing in the UI advertises it.

## Migration seam — existing call sites → new boundary (§6.3)

Existing behavior is preserved (REQ-27): the unmanaged terminal path, the
state file, resume records and detached relays all stay exactly where they
are. This table maps each call site to its future seam so later tasks
migrate deliberately instead of ad hoc.

| existing call site | file:lines | today | migration seam |
| --- | --- | --- | --- |
| terminal spawn / attach / write / resize / kill / events | `src/renderer/src/components/TerminalPane.tsx` (~L326–538); `src/renderer/src/resume.ts` L44–132; `src/renderer/src/store.ts` L783; `src/renderer/src/components/LeafPane.tsx` L226 | `window.mahas.pty.*` → `pty:*` IPC → `src/main/pty.ts` → `resources/pty-host.cjs` | **unmanaged terminals stay on `pty:*`.** Managed executions use `window.mahas.exec.*` → `exec:*` → `src/main/runtimeClient.ts` → `packages/mahas-runtime` → mahasd/execution-host (IMP-17+). `TerminalTab.binding` holds the view↔Execution/Terminal link once bound. |
| pty-host process create/kill | `src/main/pty.ts` L83–154; `src/main/index.ts` L594 (`startPtyHost`), L617 (`stopPtyHost`) | child process owned by the app; dies at `will-quit` | stays app-owned until IMP-17/23 move session ownership to the execution-host daemon. Lifecycle port = `disconnectDesktopRuntime()` in `will-quit` (detach only — UI close never drain-stops). |
| renderer persistence (hydrate/save/saveSync) | `src/renderer/src/main.tsx` L13–28; `src/renderer/src/App.tsx` L90–123; `src/main/index.ts` L423–457 (`state:*` IPC) | `userData/mahas-state.json` written by main-window renderer | stays — UI state remains renderer-owned. Control-plane state belongs to mahasd (not migrated here). `TerminalTab.binding` rides the existing save path. |
| session resume records | `src/renderer/src/resume.ts`; `upsertResumeSession`/`dropResumeSession`/`dropResumeWhere` in `src/renderer/src/store.ts`; `src/renderer/src/attention.ts` | observation records → typed resume commands into fresh shells | stays observation data — never converted into managed Tasks/Executions (IMP-01 §4.4, REQ-27). |
| detached-window relay | `src/main/index.ts` `registerWindowIpc` (`pane:hello`, `pane:cmd`, `pane:syncUp`, `pane:reattach`, `win:detach`); `src/renderer/src/components/DetachedApp.tsx` | view plumbing between main renderer and detached pane windows | stays; view bindings (`viewId` = pane/tab) flow through `exec:bindView`/`client.view.bind` when a runtime exists. |
| agent hook event ingest | `src/main/hooks.ts` (`startEventIngest`, `registerHookIpc`), `src/main/hookInstallers.ts`, `resources/mahas-hook.cjs` | NDJSON event tail → `agent:event` → renderer attention policy | unchanged — observation domain (owned by later observation tasks, not this seam). |
| harness manifest read | `src/main/index.ts` L476–551 (`AGENTS_DIR`, `agents:manifest`, `agents:icon`, `pushAgentConfig`) | reads `resources/agents/manifest.json` ad hoc | `packages/mahas-harness-config` owns the registry port (`loadHarnessProfiles` reads the same format). The renderer's copy keeps flowing via `agents:manifest` IPC until the workbench rewires. |
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
- `packages/mahas-execution-host/src/main.ts` — daemon entrypoint shell
  (`hello` op, NDJSON lifecycle, clean shutdown; everything else answers
  `UNIMPLEMENTED`).
- `packages/mahas-cli/src/main.ts` — `mahas` CLI shell (`status` works;
  other ops route to the client and report `CONTROL_UNAVAILABLE`).
- `packages/mahas-harness-config/src/index.ts` — `HarnessProfile`,
  `loadHarnessProfiles(dir)`, `resumeCommand(profile, sessionId)`.
- `src/main/runtimeClient.ts` — `initDesktopRuntime`, `registerRuntimeIpc`,
  `runtimeHandle`, `requestRuntimeShutdown`, `disconnectDesktopRuntime`.
- `src/preload/index.ts` — `window.mahas.exec.*`, `window.mahas.runtime.status`.
