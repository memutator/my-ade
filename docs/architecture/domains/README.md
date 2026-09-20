# Domain index

Where each domain lives, who owns its semantics, and what consumes it. Meaning
is defined by [domain-model-design.md](../../../domain-model-design.md) (the
semantic source) and staged by [milestone-plan.md](../../../milestone-plan.md)
— both are root-level proposal documents; this page describes what the code
does today. Migration ownership per source path is in
[integration-migration-map.md](../../plans/integration-migration-map.md)
(historical), and observed check results are in
[verification.md](../../development/verification.md).

Status vocabulary:

- **current** — schema, service code, operation registration, and composition
  wiring all exist; the domain runs inside `mahasd` and is reachable through
  the paths listed.
- **current, with limits** — the path is wired; the listed limits are real and
  documented rather than implied away.

## Service-side domains (packages/mahas-*/src)

All of these are composed by
[`composition-domains.ts`](../../../packages/mahas-runtime/src/composition-domains.ts)
inside `mahasd`, share the control DB through the central migration chain
(schema v3 — see [migration.md](../migration.md)), and register their
operations on the common `OperationRegistry`.

| domain | meaning | canonical types | service code | status |
| --- | --- | --- | --- | --- |
| catalog | Organization, Harness, Provider, Offering, and Model identities are independent; the built-in seed maps harnesses to provider/offering IDs | `packages/mahas-contracts/src/catalog/` | `packages/mahas-runtime/src/catalog/` (SQL, repository, seed) | current — seeded at boot, operations registered |
| inventory | Machine, HarnessInstallation/Revision, ProviderCredential (secret reference), ProviderConnection, and time-bounded Installation–Connection Binding | `packages/mahas-contracts/src/inventory/` | `packages/mahas-runtime/src/inventory/` (SQL, repository, local machine identity) | current — the scheduler upserts discovered installations and executable-identity revisions |
| integration (AdapterPack) | Packs observe a harness/provider through declared capabilities; revisions are immutable and digest-pinned | `packages/mahas-contracts/src/integration/` (schema is the machine authority) | `packages/mahas-runtime/src/integration/` (registry, runner, conformance, contract registry, SQL) plus Packs under `integrations/packs/` | current — built-in Packs register at boot via a nested manifest walk; source identity hashes product files only (`isPackIdentityFile`); same-revision digest drift logs `integration.builtin-revision-held` and keeps the old snapshot; runtime registration of a new Pack goes through `integration.pack.register` on the deferred-admission path |
| sessions | Harness session records, including child and foreign sessions; discovery alone never creates a Task or Execution | `packages/mahas-contracts/src/sessions/` | `packages/mahas-runtime/src/sessions/` (store, queries, hook ingest, hook stream reader, desktop import) | current — durable ingest, stream checkpointing, and legacy-record import all commit through operations |
| observation / collection | Sources, opaque cursors, batches, readings, coverage gaps; a reading and its ledger effects commit atomically | `packages/mahas-contracts/src/observation.ts` | `packages/mahas-runtime/src/observation/collection/` | current — the daemon scheduler owns discovery, bounded collection, and atomic batch/cursor commit on its own timer |
| metering / usage | Usage ledger entries with per-item attribution, revisions, corrections, and stable-ID cursor scans | `packages/mahas-contracts/src/metering/` | `packages/mahas-runtime/src/metering/usage/` | current — dedup, cumulative baseline/epoch, overlap, and correction rules are stored-ledger behavior |
| metering / aggregates and statistics | Persisted summaries, time buckets, coverage and freshness; rebuilds read the ledger, never the original logs | `packages/mahas-contracts/src/metering/` | `packages/mahas-runtime/src/metering/aggregates/`, `.../statistics/` | current — refresh runs inside the scheduler tick; default statistics (weekly average, hourly-by-date, hour-of-day distribution) register at composition; grouping axes and unknown/null semantics survive the contract → DTO → desktop projection, and the UI selects exact rollup shapes |
| metering / quota | Quota readings distinct from token usage; last success value and timestamp survive fetch failures | `packages/mahas-contracts/src/metering/` | `packages/mahas-runtime/src/metering/quota/` | current — daemon-owned polling (`metering/quota/poll.ts`) stores latest/last-success/failure plus provider evidence and pool claims; each connection polls through its own provider-api source with an atomic batch/quota/coverage commit, a null time interval (poll time is never claimed as usage time), and exact Pack+credential-revision evidence. A UI refresh signals `auth.quota.collect` rather than probing inside a transaction |
| auth | Per-Offering login flows, refresh serialization, and managed secret files | contracts (operation payloads) | `packages/mahas-runtime/src/inventory/auth/` plus `integrations/packs/providers/builtin-offerings/` | current — the dedicated channel serves start/poll/status/cancel/list/submit/secret operations on its own socket, routes each flow to the provider Pack revision registered for that offering, and commits the credential, connection, identity claims, and intent before completing a flow (including callback flows with no UI). Sign-in never creates a Binding — bindings come from evidence elsewhere |


## Desktop-side domains that stay in the app

These are shipped and are **not** moving into the control plane:

- Layout and pane/tab records — `src/renderer/src/store.ts`,
  `src/renderer/src/shell/` (`persist.ts` is the on-disk field list,
  `tabs.ts` is close-tab policy including exec unbind), rendered by
  [SplitView.tsx](../../../src/renderer/src/components/SplitView.tsx).
- Workbench domain project pin — widget tab `domainProjectId` is a daemon
  `projects.id` (empty = unconnected). It is never the desktop folder uid.
- Notification/attention policy — [attention.ts](../../../src/renderer/src/attention.ts),
  spec [notifications](../../user/notifications.md). Policy stays with the window
  that can judge attention; events arrive from the hook channel after the
  durable-ingest gate.
- Resume placement — [resume.ts](../../../src/renderer/src/resume.ts): a domain
  read that imports the legacy desktop records once (`session.desktop.import`),
  then places candidates from canonical session/handle/attachment data. The
  persisted desktop map is only a fallback while the store cannot answer.
- Bookmarks, file-tree roots, and settings — desktop state; see the state file
  section of [lifecycle.md](../lifecycle.md).

## Desktop compatibility adapters over the domains

The legacy IPC channels keep their wire shape but no longer do the work they
were named for. They are migration seams, not domain owners:

| current path | today | removal condition |
| --- | --- | --- |
| `src/main/usage.ts` | projects the newest stored QuotaReading into the old `usage:fetch` wire shape; never touches a credential, log, or endpoint | consumers read domain quota operations directly |
| `src/main/usageAuth.ts` | resolves a harness to its stored offering and forwards start/submit/poll calls to the daemon auth channel | the migrated UI (`features/usage`) already calls the domain; the channel retires with its last consumer |
| `src/main/ledger.ts` | projects the stored usage ledger into the legacy `usage:ledger` DTO, reporting unobserved components as unknown (never a silent zero) | legacy wire consumers move to `domain:usage.ledger` |
| `src/main/hooks.ts`, `src/main/hookInstallers.ts`, `src/main/harnessPack.ts` | hook install/status/test mechanics driven by the harness-runtime Pack's declarations; the event tailer gates renderer delivery on durable ingest | per-Pack install/maintenance capabilities take over the mechanics |
| `src/renderer/src/features/usage/`, `.../sessions/` | the UI's domain read client — stored reads only, plus explicit collection/auth mutations | none — this IS the destination |

## Related canonical sources

- Machine contracts and compatibility rules: [../contracts/README.md](../contracts/README.md).
- Control DB schema chain and upgrade paths: [../migration.md](../migration.md).
- Pack authoring and capability checks: [../../integrations/authoring.md](../../integrations/authoring.md).
- Verification commands and their real scope: [../development/verification.md](../../development/verification.md).
