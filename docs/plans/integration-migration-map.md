# Integration migration map

This map turns the source inventory **as it was when the map was written** into migration ownership. It is a historical record: the left-hand column names the old call sites (some of which have since been deleted, e.g. `src/main/ledger-worker.ts` and the `resources/mahas-hook.cjs` copy), and the right-hand column names where that responsibility was intended to move. Read it as provenance and ownership history, never as a description of the current tree — for what exists now see [../architecture/domains/README.md](../architecture/domains/README.md) and [../development/verification.md](../development/verification.md). The relevant milestone sequence is A (contracts and inventory), B (catalog/inventory storage), C (first adapter and session/usage collectors), D (all integration capabilities), E (attribution and read models), and F (consumer and duplicate cleanup), as described in `milestone-plan.md` and `domain-model-design.md`.

## Destination ownership

Use the call-site meaning when mapping an existing `provider` or `agent` string. A string is not a canonical identity by itself.

| Destination area | Intended owner | Current inputs |
| --- | --- | --- |
| Catalog | `packages/mahas-contracts/src/catalog` and the catalog service | Manifest descriptors, provider/plan labels, model strings from usage responses |
| Inventory and credentials | `packages/mahas-contracts/src/inventory` | CLI presence checks, native credential files, managed usage accounts, account/identity observations |
| Integration Packs | `integrations/packs` and integration runtime | Hook installers/normalizer, process identification, launch/resume recipes, quota clients, provider checks |
| Sessions and events | `packages/mahas-contracts/src/sessions` and session runtime | Hook NDJSON, pty identity/cwd, renderer live session and resume records, local ledger session IDs |
| Collection | `packages/mahas-contracts/src/metering` collection types | Provider-owned session files, SQLite databases, event tailer, quota polling |
| Metering and quota | `packages/mahas-contracts/src/metering` | `UsageResult`, ledger token totals, quota windows, plan/account labels |
| Shell/UI compatibility | `src/main`, `src/preload`, `src/renderer` until callers migrate | Pty transport, pane/tab state, attention routing, widget caches, persisted `mahas-state.json` |

The contract files under `packages/mahas-contracts/src/catalog`, `inventory`, `sessions`, and `metering` describe the destination shapes. When this map was written they had no runtime writer in the Electron app; the daemon now persists them (schema v3) and serves them over RPC — see [../architecture/migration.md](../architecture/migration.md). What is still accurate is the direction of travel: the desktop call sites in the left-hand column are the ones being replaced.

## Source-to-destination ownership map

| Current source | Actual responsibility today | Destination owner and migration phase | Removal or handoff condition |
| --- | --- | --- | --- |
| `resources/agents/manifest.json:2-87` and `src/renderer/src/agents.ts:14-35` | Harness match patterns, labels/icons, and optional shell resume recipes | Catalog `Harness` plus a harness-config Adapter Pack descriptor (A/B/C) | Every caller reads a versioned catalog/Pack descriptor; the renderer no longer imports the manifest directly; retain a compatibility importer for old state until the supported state version advances. |
| `resources/pty-host.cjs:18-32,87-170` and `src/main/pty.ts:83-178` | Generic shell spawn/attach/write/resize/kill, process-tree identification, cwd and agent observations | Integration identify capability and SessionAttachment transport (C/D); pty remains a terminal transport | The replacement preserves exact pane/tab attribution, attach/scrollback, cwd, exit, and process observations. Do not remove pty-host merely because a Pack is added. |
| `src/main/hookInstallers.ts:1-13,142-431` | Provider-specific hook configuration, backup, refresh, and status based on `command -v` | Adapter Pack `install`/`events`/maintenance checks (C/D) | Each installed provider has an equivalent Pack revision, backup/forwarding behavior, and an IntegrationCheck. Remove duplicate installer branches only after the Pack owns install and upgrade behavior. |
| `resources/mahas-hook.cjs:67-165,217-260,262-420` | Normalize harness payloads into generic event names; stamp session, pane, tab, and Mahas run | Pack event decoder plus `SessionEvent` ingest (C/D) | Durable event ingest accepts all current event kinds, preserves raw/provider provenance, filters foreign runs and subagents, and passes attention/resume regression checks. |
| `resources/mahas-opencode-plugin.js:1-35,77-181` | OpenCode session/error/ask event bridge and delayed auto-approved ask handling | OpenCode Pack event implementation (D) | Pack revision owns plugin install/refresh and event semantics; keep the plugin as its vendor-facing adapter rather than deleting the bridge before event parity. |
| `src/main/eventsFile.ts:14-44,76-127,141-213` and `src/main/hooks.ts:21-78` | Tail a global NDJSON log from EOF, mark `ours`, deduplicate notifications, expose hook IPC | Session event collector and IntegrationCheck result (C/D) | New collector can replay/checkpoint events, retain provenance, and feed the attention policy; then remove direct renderer dependence on the global tailer's wire DTO. |
| `src/main/usageAuth.ts:72-99,173-336,423-717` | OAuth/device/code/API-key flows and managed native-shaped credential files | Inventory `ProviderCredential`/`ProviderConnection` plus Pack `auth` (B/D) | Credential import, refresh, revoke/discard, account identity, errors, and redaction are represented by the new lifecycle. Delete direct UI-to-flow calls only after managed-account import/discard behavior is equivalent. |
| `src/main/usage.ts:191-329,331-382,384-430,432-491,493-582,584-668,670-720,723-862,864-992` | Nine provider quota/rate-limit clients with provider-specific credential discovery and response parsing | Pack `quota` capability emitting `QuotaReading`; inventory owns credential selection (D/E) | Every existing fetcher has a Pack query with the same error, plan/account, window, reset, and freshness semantics. Preserve an explicit unsupported result; do not silently turn missing credentials into zero usage. |
| `src/main/ledger.ts:1-124,207-251,281-427,429-511,525-620` and `src/main/ledger-worker.ts:1-10` | Provider-specific full scans of local files/SQLite into cached token totals and tracked sessions | Collection sources/cursors/batches plus `UsageReading`/`UsageEntry` (C/E) | A checkpointed collector stores source identity, coverage, parse errors, and last-seen position. Remove old scanner dispatch only after historical totals and undercount/error semantics are imported. |
| `src/main/devinLocks.ts:1-104`, `src/main/index.ts:599-624`, `src/main/pty.ts:121-154` | Devin stale session-lock safety sweep on startup, session end, pty exit, and quit | Devin Pack `maintenance` capability and IntegrationCheck (D) | A maintenance implementation performs the same flock/pid safety checks and has shutdown/pty-exit coverage. There is no equivalent current maintenance module for other harnesses. |
| `src/renderer/src/store.ts:631-675,702-713,755-758,840-841,1665-1755` and `src/renderer/src/resume.ts` | Live session registry and bounded resume candidates, pruned on end/exit/close | `HarnessSession`, `SessionHandle`, `SessionAttachment`, Pack `resume` (C/D) | A session store owns lifecycle, exact tab attachment, native handle/namespace, cwd, and resume policy; the current records are imported and the old maps have no remaining writers. |
| `src/renderer/src/components/WidgetView.tsx:25-115,380-525,701-845` | Poll quota clients, register extra credential paths, expand old provider widget tabs, aggregate tracked ledger rows | Quota/usage read models and catalog selection (E/F) | The widget consumes canonical Provider/Offering IDs and read models; direct `window.mahas.usage.*`, provider-string expansion, and in-memory caches are removed after parity. |
| `src/preload/index.ts:120-222,500-526`, `src/renderer/src/types.ts:25-375`, and main DTOs | Repeated wire/interface declarations for hooks, usage, ledger, accounts, sessions | Generated/shared contract adapters at the view↔execution boundary (A/F) | All callers use one versioned wire schema or a deliberate UI read model; duplicate DTOs and unsafe casts are deleted after the migration compiler boundary is green. |
| `src/main/index.ts:35-70,426-455,479-551,589-624` | Persist UI JSON, migrate `ade` paths, register IPC, start pty/event/usage services | Shell compatibility owner while control-plane storage is introduced (A/F) | Keep UI state persistence until the new store can hydrate it; remove only obsolete `ade` compatibility after the supported state migration and hook-pointer rewrite have shipped. |

## Per-harness migration inventory

The target Pack owns only capabilities that have evidence in the current source or a clearly recorded gap. A documented recipe is not counted as runtime support.

| Harness | Current evidence | Destination Pack/inventory work | Owner and removal gate |
| --- | --- | --- | --- |
| `claude` | Manifest match/resume; Stop/Notification/session hooks; Anthropic usage/auth; Claude JSONL ledger | Identity, events, resume, auth, quota, session collection; split Anthropic Provider from Offering labels | Claude Pack owner with inventory/metering owners. Retire direct hook/usage/ledger callers after Pack event, credential, quota, and collection parity. |
| `codex` | Manifest match/resume; `notify` installer with forwarding; ChatGPT usage/auth; Codex rollout ledger | Same as Claude, including native account identity and forwarded existing notify command | Codex Pack owner. Removal requires forwarding, legacy pointer rewrite, auth refresh, quota windows, and ledger import parity. |
| `grok` | Manifest match/resume; owned hook file; XAI usage/auth; session usage JSON | Identity, events, resume, auth, quota, collection, raw event provenance | Grok Pack owner. Remove direct branches only after token refresh/writeback and event teardown/error semantics are represented. |
| `devin` | Manifest match/resume; Stop/permission/session hooks; Codeium status/auth; session DB/transcript; stale-lock sweep | Identity, events, resume, auth, quota, collection, and maintenance | Devin Pack owner. Lock cleanup is removed from `devinLocks.ts` only when the Pack preserves flock/pid safety and all four existing trigger paths. |
| `zcode` | Manifest match/resume; config event hooks; Z.AI API-key quota/auth; SQLite ledger | Identity, events, resume, auth, quota, collection | Zcode Pack owner. Preserve config locations, unsupported-key behavior, and SQLite parse errors before removing direct branches. |
| `opencode` | Manifest match/resume; owned plugin; Zen usage/auth; OpenCode SQLite ledger | Identity, events, resume, auth, quota, collection; carry child-session demotion and ask/reply delay | OpenCode Pack owner. Remove plugin/usage/ledger dispatch only after event classification and auto-approved ask behavior match. |
| `cline` | Manifest match/resume; event-file hooks with displacement backup; Cline usage/auth; message JSON ledger | Identity, events, resume, auth, quota, collection | Cline Pack owner. Preserve user hook re-piping, subagent demotion, and token-metric parsing before deleting legacy event-file installation. |
| `gemini` | Manifest match/resume; pty process observation; Cloud Code quota/auth | Identity, resume, auth, quota; explicitly record events and collection as unsupported until a source is found | Gemini Pack owner. Do not remove usage/auth clients until a Pack query has equivalent account/quota/error semantics; do not invent a session source. |
| `copilot` | Manifest process observation; GitHub Copilot quota/auth/device flow | Identity, auth, quota; no current hook or local ledger | Copilot Pack owner. Keep absent event/session capabilities as IntegrationIssues until a real source is implemented. |
| `cursor` | Manifest process observation only | Catalog descriptor and identify check; no inferred auth/quota/session support | Catalog/integration owner. No source branch is removable beyond the generic manifest path until a real capability is added. |
| `aider` | Manifest process observation only | Catalog descriptor and identify check | Catalog/integration owner; preserve an explicit unsupported status. |
| `amp` | Manifest process observation only | Catalog descriptor and identify check | Catalog/integration owner; preserve an explicit unsupported status. |
| `fake` | Test manifest/process and test resume command | Test-only Pack fixture or adapter test data | E2E/test owner. Do not publish it as a provider offering or move it into production auth/quota tables. |

For all rows, process-name matching is evidence for `identify` only. It does not prove installation, version, authentication, launch, wake, or usage support. The pty detector also has fallback patterns not represented in the manifest; those patterns need a catalog decision before becoming canonical harnesses.

## Duplicate interfaces and their callers

These are the current boundaries that should be removed or narrowed during phase F. The same conceptual data is declared in multiple layers today.

| Current interface/field | Current declarations and callers | Destination mapping | Removal condition |
| --- | --- | --- | --- |
| `AgentHookEvent` | `src/main/eventsFile.ts:14-44`, `src/main/hooks.ts:21-78`, `src/preload/index.ts`, `src/renderer/src/types.ts:216-240`; consumed by hook IPC, attention, session/resume updates | Versioned `SessionEvent` plus raw provider event/provenance and an attention projection | Session ingest and renderer projection use the shared contract; pane/tab/run attribution, subagent demotion, and foreign-run filtering are retained. |
| `UsageWindow` / `UsageResult` | `src/main/usage.ts:1-19`, preload usage API, renderer types and `WidgetView` | `QuotaReading` plus Provider/Offering read models | All nine fetchers map plan/account/window/reset/error/freshness into the new shape, including unsupported and missing-credential states. |
| `TokenUse`, `LedgerQuery`, `LedgerSession`, `LedgerProfile`, `LedgerResult` | `src/main/ledger.ts`, `src/main/ledger-worker.ts`, preload, renderer types, `WidgetView` | `UsageReading`, `UsageEntry`, `UsageAttribution`, `UsageSummary`, `UsageStatistic` | A collection source and cursor own provenance/coverage; widget no longer aggregates raw ledger DTOs. |
| `UsageAccount` | `Settings.usageAccounts` in `src/renderer/src/types.ts:229-240`; account registration/discard in `WidgetView`; managed files in `src/main/usageAuth.ts` | `ProviderCredential` and `ProviderConnection`, with explicit account/identity claim | Import, refresh, discard, account selection, and redaction have a canonical owner; old settings records are migrated and no longer written. |
| `AgentProviderInfo` / manifest descriptor | `resources/agents/manifest.json`, `src/renderer/src/agents.ts`, `packages/mahas-harness-config/src/index.ts` | Catalog `Harness` plus Pack revision and capability declarations | One catalog/config loader provides descriptors, while test fixtures and compatibility import are explicit. |
| `AgentSessionInfo` | `src/renderer/src/types.ts:282-291`, store `agentSessions`, hook event handlers and attention lookup | `HarnessSession` plus `SessionAttachment` | Session registry owns native namespace, handle, lifecycle, and tab attachment; old map is read-only compatibility during import, then removed. |
| `ResumeSession` | `src/renderer/src/types.ts:272-280`, store `resumeSessions`, `src/renderer/src/resume.ts` | `SessionHandle` and Pack `resume` capability | New session lifecycle persists the same cwd/tab/workspace semantics and can restore detached tabs; old map has no writers. |
| Free-form `provider` strings | `WidgetTab.provider/providers`, `LedgerQuery.provider`, usage/ledger results, session records, settings account rows | Canonical Provider ID, Offering ID, Harness ID, and explicit identity claim | Every persisted value is migrated with a call-site-specific mapping; no caller compares vendor strings as IDs. |
| `TerminalTab.agent` | `src/renderer/src/types.ts:25-70` and terminal status/attention code | Observed Harness/Session reference, separate from the terminal transport | UI derives status from the session projection; the field is deleted only after old hydrated tabs have been converted. |
| `TerminalTab.pty` and `MAHAS_PANE`/`MAHAS_TAB` stamps | Terminal remount/attach and hook attribution in `src/main/pty.ts`, `resources/mahas-hook.cjs`, renderer `TerminalTab` | `SessionAttachment.sourceRef`/transport metadata | Keep the pty transport, but move exact attribution into the session contract before deleting ad hoc wire fields. |
| `TerminalTab.binding` | `src/renderer/src/types.ts:53-69`; future `ExecutionBinding`, no current control-plane writer | Managed execution/view binding | Do not retrofit existing plain pty tabs. Remove the field only if a replacement binding API has an explicit migration for managed tabs. |

## Legacy state and compatibility fields

| Legacy/current field | Current behavior and evidence | New mapping | Removal condition |
| --- | --- | --- | --- |
| `stateVersion` | Optional persisted marker; v2/v3 migrations in `src/renderer/src/store.ts:355-405,631-675` | UI-state migration version, separate from domain/control-plane schema version | Keep until the oldest supported `mahas-state.json` has passed the final importer; never use it as a Harness/Pack revision. |
| Pane-level `type`, `title`, `url`, `cwd`, `shell`, `exited`, `agent` | Old pane model is normalized into kind-tagged tabs; `todo` panes and tabless strays are dropped | No domain entity; import only into current UI tabs | Delete compatibility normalization after the supported state-version window closes and a backup/repair path exists. |
| Tabs without `kind` and legacy `todo` panes | `normalizePane` infers terminal/web/file kind and drops `todo` | Current `PaneTab.kind`; no integration meaning | Same state-version gate as above; do not map a UI kind to a Harness. |
| `Settings.providers` | Provider toggle map passed to agent pattern configuration (`src/main/index.ts` and agent config IPC) | Harness/Pack enablement or identify policy, with a schema that distinguishes provider from harness | Migrate toggles to the new policy owner and keep old values only for import; do not reinterpret them as credentials or bindings. |
| `Settings.usageAccounts` | Extra credential paths for the usage widget; persisted in UI settings | Credential/Connection references and selected identity claims | New inventory can import and discard each path with equivalent safety; then stop writing account paths in general UI settings. |
| `WidgetTab.provider` and `WidgetTab.providers` | Old usage tabs hydrate provider-string selections; `WidgetView` expands them to the current catalog | Provider/Offering selection IDs or read-model filters | All old widget tabs are rewritten on hydration and the widget uses canonical catalog data. |
| `agentSessions` | Persisted map of live hook observations; pruned on end/exit/close | `HarnessSession`/`SessionAttachment` projection | New session store is authoritative and old map has no readers/writers except one-time import. |
| `resumeSessions` | Persisted bounded set of sessions alive at shutdown, not history | `SessionHandle` plus resume candidate/attachment records | New resume service owns pruning, cwd, native handle, and command policy; old records have been imported or intentionally discarded with a reason. |
| `TerminalTab.agent`, `working`, `workingSince`, `turnEndedAt`, `quietUntil`, `idleLocked` | Live UI status and attention state; persisted live flags are explicitly cleared during hydration | Session/attention read model; live UI flags may remain shell-local | Migrate the authoritative event/session projection first; keep transient rendering flags until the new projection drives status. |
| `TerminalTab.pty` | Live pty-host session ID used to attach on remount/detach | SessionAttachment transport reference | Keep until the replacement can attach and kill by tab/session ownership; this is not a provider identity. |
| `mahas-state.json` and `ade-state.json` fallback | Main process migrates old app data path and persists UI state (`src/main/index.ts:35-70`) | UI-state compatibility store, separate from domain DB | Remove the old `ade` fallback only after state migration telemetry/repair coverage and the release support window. |
| Legacy `ade-hook` pointers | Startup rewrites user-owned Codex/Claude/Devin/Zcode configs; installer artifacts are refreshed | Pack installer revision and migration marker | Keep rewrite code until all supported user configs have been rewritten and the shipped old pointer is no longer referenced; do not delete user configuration blindly. |

## Removal gates by capability

| Existing path | Required evidence before removal |
| --- | --- |
| Direct manifest imports | Catalog/Pack loader serves every current consumer, preserves labels/matches/icons/resume recipes, and has an explicit entry for unsupported/fake harnesses. |
| Generic hook normalizer and event-file wire | Every installed provider has a Pack decoder, raw provenance is retained, events can be replayed or checkpointed, and the attention/resume consumers pass pane/tab/run attribution checks. |
| `usageAuth` provider switch | Credential/connection lifecycle supports each current flow, refresh/writeback policy is explicit, managed-account discard is scoped, and UI can explain unsupported credentials without exposing them. |
| `usage.ts` fetcher switch | Each supported provider maps to a Pack `quota` capability with identical window/reset/error semantics and a canonical Provider/Offering mapping; the UI no longer relies on provider strings. |
| `ledger.ts` scanner switch | Collection sources have cursors/checkpoints, coverage/error records, imported historical totals, and a proven policy for cache/under-count behavior. |
| Renderer `usageCache`/`ledgerCache` and direct IPC calls | Widgets consume canonical quota/usage read models and still distinguish live quota from local historical usage. |
| `agentSessions`/`resumeSessions` maps | Session service persists native handle/namespace, exact attachment, cwd, lifecycle, and the current shutdown/resume policy. |
| `devinLocks.ts` | Devin Pack maintenance has flock/pid safety and all startup/session-end/pty-exit/quit triggers; stale locks are never dropped merely because a path looks old. |
| Legacy pane/state normalizers | State version support window has elapsed and old files can be backed up or repaired. |
| `provider`/`agent` free strings | Callers use canonical IDs plus explicit namespace/identity mappings; suffix matching and ambiguous account labels are eliminated. |

## Important gaps to carry into implementation

- No current source enumerates native provider sessions. Hook events and local ledger files are observations, not proof that all sessions were discovered.
- The event tailer starts at EOF, so a restart can lose events that were written before it attached. A checkpointed collector must make this behavior explicit.
- Ledger scans are provider-specific full scans with caps and an empty-on-error cache path. A new collector needs `CollectionCoverage`, cursor position, and parse/error evidence rather than silently returning zero rows.
- There is no current `Offering` identity, model identity, provider identity claim, or usage attribution by model/provider/binding. Plan labels and account strings cannot be reused as canonical keys.
- The current ledger uses exact-then-suffix session lookup. A Pack must establish the provider namespace before accepting a native handle.
- Credential refreshers sometimes write refreshed native files and the managed account directory is separate. Inventory migration must record ownership, refresh, revoke, and redaction policy without copying credential contents.
- Only Devin has a harness-specific maintenance implementation. Launch, automatic wake, and harness/provider binding are absent in the current app; the Claude/Codex package recipes are documented/admission-gated, not runtime proof.

> **Status note (2026-09-20):** this file is the source-to-destination handoff
> map, not a status report. Which parts have since been implemented, and which
> checks were actually executed, are recorded in
> [../architecture/domains/README.md](../architecture/domains/README.md) and
> [../development/verification.md](../development/verification.md).
- Hook coverage is uneven: seven harnesses have installers/plugins, while Gemini, Cursor, Copilot, Aider, Amp, and the fake harness have no provider-specific event installer. Preserve these as explicit capability statuses.
- The process detector fallback and the manifest do not have identical rosters. Resolve that mismatch in catalog migration before using process names as installation evidence.
