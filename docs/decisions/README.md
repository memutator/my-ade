# Decisions

Accepted decisions with the place that enforces them, plus proposals that are
not decisions yet. A decision belongs here once code (or a written contract)
actually holds it; until then it is listed under proposals and the current
behavior in [docs/README.md](../README.md) is what a reader should assume.

## Accepted — held by code or a live contract

| decision | held by |
| --- | --- |
| The desktop is a **client** of the control plane (`mahasd`, `execution-host`); UI close means detach, never drain-stop | `src/main/runtimeClient.ts`, `src/main/runtime/serviceBootstrap.ts` |
| Unmanaged shells keep the app-owned pty path and the tab-record lifetime; managed executions use the daemon path — the two are never mixed in one terminal | `src/main/pty.ts`, `src/main/runtimeClient.ts` |
| The domain model (Organization, Offering, Connection, Binding, attribution rules) is the canonical evidence model; semantics live in the design doc, storage in the control DB | [domain-model-design.md](../../domain-model-design.md), `packages/mahas-runtime/src/{catalog,inventory,sessions,observation,metering}` |
| The control DB arrives through one central migration chain (schema v3); no per-domain side databases | `packages/mahas-runtime/src/platform/schema/`, [../architecture/migration.md](../architecture/migration.md) |
| A daemon-resident collection scheduler owns Pack discovery, bounded collection, and atomic batch/cursor commit on its own timer | `packages/mahas-runtime/src/observation/collection/scheduler.ts`, `composition-domains.ts` |
| Auth runs on a dedicated daemon channel (`mahasd-auth.sock`) so secret-bearing flows never share the general RPC socket; each flow routes to the provider Pack revision registered for its offering and commits credential + connection + identity claims + intent atomically — never a Binding | `src/main/runtime/authClient.ts`, `packages/mahas-runtime/src/inventory/auth/` |
| Agent hook events reach the renderer only after durable ingest (`session.hook.ingest` all-record acknowledgement); the daemon hook-stream reader ingests the same file independently | `src/main/agentEventIngest.ts`, `packages/mahas-runtime/src/sessions/` |
| Workbench scope is per widget mount (project/model/run pins and the op queue live in a scoped context), never one global context | `src/renderer/src/workbench/WidgetWorkbench.tsx`, `src/renderer/src/workbench/scope.tsx` |
| Desktop state persists through serial atomic writes (temp file → rename) with a synchronous shutdown write that fences every older queued snapshot | `src/main/state/persistence.ts` |
| Pane content never remounts on layout changes: portals target a stable per-pane mount node, slots are appended into | `src/renderer/src/components/SplitView.tsx`, `src/renderer/src/paneSlots.ts` |
| pty lifetime equals tab-record lifetime; a session is killed only when no workspace still holds its record | `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/store.ts` |
| Package boundaries are enforced by resolving imports, not by string patterns, and UI imports of contracts are type-only | `tools/boundary-policy.mjs`, `tools/check-boundaries.mjs`, `eslint.config.mjs` |
| Cross-boundary imports are relative with explicit `.ts` extensions (Node 24 type stripping, `rewriteRelativeImportExtensions`) | `packages/tsconfig.base.json`, `tsconfig.node.json`, `tsconfig.web.json` |
| Vendor knowledge lives in Packs; adding a provider must not add a core vendor switch | `packages/mahas-contracts/src/integration/schema.ts`, `integrations/packs/` |
| Unknown is not zero: unobserved metrics are null and coverage travels with the batch | `packages/mahas-contracts/src/integration/schema.ts`, ledger/aggregate stores |
| Pack revisions are immutable and digest-pinned; re-registering the same revision with different content is refused | `packages/mahas-runtime/src/integration/registry.ts` |
| Canonical harness ids are unprefixed (`codex`, `claude`, …); organization ids are `org.*` | `packages/mahas-runtime/src/catalog/` |
| Weekly averages default to the last four complete calendar weeks, Monday-start, in the user time zone | `packages/mahas-runtime/src/metering/aggregates/`, `.../statistics/` |
| Services run under **system Node ≥24** as ESM bundles outside the Electron ABI; native modules ship beside them | `tools/build-services.mjs`, `electron-builder.yml`, `src/main/runtime/serviceBootstrap.ts` |
| Dev runs use an isolated profile (`mahas-dev`) so development never rewrites live app data | `package.json` (`dev`), `src/main/index.ts` |

## Proposals — not decisions yet

| proposal | source | state |
| --- | --- | --- |
| Complete the A–G integration milestone | [milestone plan](../../milestone-plan.md) | in progress; the earlier whole-milestone completion claim was withdrawn — see [source audit](../development/milestone-audit.md) |
| Common runtime operation ports and responsibility boundaries | milestone plan F | partial; maintenance/client registry and transaction mirrors remain, while Workbench/hook wire DTO reuse is implemented — see [contracts](../architecture/contracts/README.md) |

## Superseded and historical

- The **ade → mahas rename** removed the old hook path: user configs that still
  point at `ade-hook` are rewritten to `mahas-hook` on start, and the legacy path
  is not restored.
- The normative execution-architecture spec and its review/verification task
  packages remain under [mahas-architecture/](../../mahas-architecture/README.md) as
  the source of intent and as history. Where its rules still hold they are carried
  by the current docs linked above; its recorded results are not evidence for
  current code.
