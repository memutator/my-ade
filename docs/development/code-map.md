# Code map

Responsibility → source → owner document. Use this when a change spans layers,
or when a doc and the code disagree: the listed source is what runs, and the
linked document is what the change must update.

## Electron app (`src/`)

| responsibility | source | owner document |
| --- | --- | --- |
| composition root: profile/paths, window registry, per-feature IPC wiring | `src/main/index.ts`, `src/main/windowState.ts`, `src/main/platform/` (windows, file + agent IPC) | [architecture/overview](../architecture/overview.md) |
| desktop state file: serial atomic writes (temp → rename), `saveSync` shutdown fence | `src/main/state/store.ts`, `src/main/state/persistence.ts` | [lifecycle](../architecture/lifecycle.md) |
| pty sessions, cwd/agent polling, attach/kill forwarding | `src/main/pty.ts`, `resources/pty-host.cjs` | [lifecycle](../architecture/lifecycle.md), [terminal](../user/terminal.md) |
| file/fs operations, file + directory watching, worktrees | `src/main/fsops.ts`, `src/main/filewatch.ts`, `src/main/dirwatch.ts`, `src/main/worktree.ts` | [editor](../user/editor.md) |
| agent hook install/ingest, event tail, devin lock sweep | `src/main/hooks.ts`, `src/main/hookInstallers.ts`, `src/main/eventsFile.ts`, `src/main/devinLocks.ts`, `src/main/harnessPack.ts`, `integrations/packs/harness-runtime/` (hooks + installer/harness data) | [agents](../user/agents.md) |
| durable-ingest gate: forwards hook records to `session.hook.ingest`, renderer sees events only after the all-record ack | `src/main/agentEventIngest.ts` | [lifecycle](../architecture/lifecycle.md), [domains](../architecture/domains/README.md) |
| legacy usage/quota/auth IPC — compatibility projections over stored domain reads (no credential, log, or endpoint I/O) | `src/main/usage.ts`, `src/main/usageAuth.ts`, `src/main/ledger.ts` | [domains](../architecture/domains/README.md) |
| desktop runtime attachment, managed-execution IPC, service spawn | `src/main/runtimeClient.ts`, `src/main/runtime/serviceBootstrap.ts` | [lifecycle](../architecture/lifecycle.md) |
| domain reads (stored data only) and the dedicated auth channel client | `src/main/runtime/domainIpc.ts`, `src/main/runtime/authClient.ts` | [domains](../architecture/domains/README.md) |
| preload surface (`window.mahas`, `window.mahas.domain`) | `src/preload/index.ts`, `src/preload/domain.ts` | [architecture/overview](../architecture/overview.md) |
| store, hydration, save, layout math | `src/renderer/src/store.ts`, `src/renderer/src/shell/`, `src/renderer/src/main.tsx` | [lifecycle](../architecture/lifecycle.md) |
| pane/tab rendering, portals, dock, drag/drop | `src/renderer/src/components/SplitView.tsx`, `LeafPane.tsx`, `FloatLayer.tsx`, `PaneDock.tsx`, `TabStrip.tsx`, `src/renderer/src/paneSlots.ts`, `src/renderer/src/paneDnd.ts` | [panes](../user/panes.md), [lifecycle](../architecture/lifecycle.md) |
| terminal/browser/editor blocks and the file tree | `src/renderer/src/components/TerminalPane.tsx`, `BrowserPane.tsx`, `FileView.tsx`, `FileTree.tsx`, `MarkdownEditor.tsx` | [terminal](../user/terminal.md), [browser](../user/browser.md), [editor](../user/editor.md) |
| attention policy, status dots, bells/toasts | `src/renderer/src/attention.ts`, `src/renderer/src/components/NotificationBell.tsx`, `PaneToasts.tsx` | [notifications](../user/notifications.md) |
| session resume prompt and command replay | `src/renderer/src/resume.ts`, `src/renderer/src/components/ResumePrompt.tsx` | [agents](../user/agents.md) |
| workbench views (scoped per mount; shared operation DTOs and explicit view-model projections) | `src/renderer/src/workbench/` | [contracts](../architecture/contracts/README.md) |
| usage + sessions UI — the domain read client (stored reads plus explicit collection/auth mutations) | `src/renderer/src/features/usage/`, `src/renderer/src/features/sessions/` | [domains](../architecture/domains/README.md), [usage](../user/usage.md) |

## Packages (`packages/`)

| package | responsibility | owner document |
| --- | --- | --- |
| `mahas-contracts` | shared types, capability payload schemas, operation DTOs; renderer-safe | [contracts](../architecture/contracts/README.md) |
| `mahas-client` | authenticated mahasd client session (desktop + CLI) | [architecture/overview](../architecture/overview.md) |
| `mahas-runtime` | control plane: composition, storage/migrations, domain services (catalog, inventory, integration, sessions, observation/collection, metering, access, coordination, discovery, launch, recovery, resources, artifacts, maintenance, inspector), RPC | [domains](../architecture/domains/README.md) |
| `mahas-execution-host` | daemon that owns PTY/generic process incarnations | [lifecycle](../architecture/lifecycle.md) |
| `mahas-cli` | `mahas` operator/agent CLI | [development/setup](setup.md) |
| `mahas-harness-config` | harness profile registry (detection patterns, resume recipes) as data | [agents](../user/agents.md) |

## Integration Packs (`integrations/packs/`)

| directory | content | owner document |
| --- | --- | --- |
| `codex`, `claude`, `grok`, `cline` | file/JSONL collectors | [authoring](../integrations/authoring.md) |
| `opencode`, `zcode`, `devin` | read-only SQLite collectors | [authoring](../integrations/authoring.md) |
| `harness-runtime` | identify/launch/resume/wake/events/maintenance declarations, harness + installer data, hook scripts | [agents](../user/agents.md), [authoring](../integrations/authoring.md) |
| `providers/builtin-offerings` | provider auth flows and quota readings | [capabilities](../integrations/capabilities.md) |

## Tooling and configuration (repo root)

| responsibility | source | owner document |
| --- | --- | --- |
| import boundary policy + fixture self-test | `tools/boundary-policy.mjs`, `tools/check-boundaries.mjs` | [contracts](../architecture/contracts/README.md), this map |
| whole-package typecheck | `tools/typecheck-packages.mjs` | [verification](verification.md) |
| service bundles for packaging | `tools/build-services.mjs`, `electron.vite.config.ts`, `electron-builder.yml` | [packaging](packaging.md) |
| end-to-end harness | `tools/e2e.mjs`, `tools/mahas-fake.mjs` | [agents](../user/agents.md) |
| lint rules (including the boundary rule) | `eslint.config.mjs` | [setup](setup.md) |
| typecheck projects | `tsconfig.node.json`, `tsconfig.web.json`, `packages/tsconfig.base.json` | [setup](setup.md) |

## Documentation and history

| location | meaning |
| --- | --- |
| `docs/` | current explanation; the entry point is [docs/README.md](../README.md) |
| `mahas-architecture/spec/` | normative execution-architecture specification for the service work; [its README](../../mahas-architecture/README.md) says what is spec versus record |
| `mahas-architecture/{implementation,review,verification}-plan/`, `records/`, `orchestration/` | historical task packages and their evidence; never re-presented as verification of current code |
| `requirements/<version>.md` | per-release verification checklist for the user |
| `domain-model-design.md`, `domain-model-needs.md`, `milestone-plan.md` (root) | domain design and the active milestone plan; see HANDOFF and the stage audit for remaining work |
| `HANDOFF.md`, `docs/plans/` | work state and migration ownership records |
