# Authoring an integration Pack

A **Pack** teaches mahas how to observe one harness, provider, or offering
through declared capabilities: local files, a local SQLite database, a CLI, or
an HTTP API. Vendor-specific paths, schemas, and quirks live in the Pack; the
core keeps the contract, the runner, the checks, and the storage. Adding or
changing a vendor must never require a new switch in the core.

Canonical contracts: [packages/mahas-contracts/src/integration/schema.ts](../../packages/mahas-contracts/src/integration/schema.ts)
(capability payloads) and [integration/index.ts](../../packages/mahas-contracts/src/integration/index.ts)
(Pack/revision/contract types). Registry, runner, and conformance:
[packages/mahas-runtime/src/integration/](../../packages/mahas-runtime/src/integration/).
Machine-readable boundary rules: [architecture/contracts](../architecture/contracts/README.md).

The repository skill [`.codex/skills/pack-authoring`](../../.codex/skills/pack-authoring/SKILL.md)
walks a coding agent through the same workflow with references; copy or symlink
it into `$CODEX_HOME/skills` (or `.codex/skills` of a consuming repo) to load it.

## Layout

```text
integrations/packs/<pack-directory>/
  manifest.json        required: Pack identity, one immutable revision, implementations
  collector.mjs        the script entrypoint a capability declares (may serve several)
  runtime.mjs          alternative for packs that own processes/hooks (see harness-runtime)
  README.md            optional: vendor knowledge that does not belong in core docs
  conformance.smoke.ts optional: synthetic fixture run against a scratch registry
```

Registration walks the packs root recursively (`discoverPackRoots` in
[integration/index.ts](../../packages/mahas-runtime/src/integration/index.ts)): any
directory holding a `manifest.json` registers as a Pack, so nested roots such
as `providers/builtin-offerings` are discovered. The walk refuses symbolic
links — a Pack snapshot must be reproducible from real files.

## Manifest

- `schemaVersion: 1`, then `pack` (`id`, `name`, `publisher`, `createdAt`,
  optional `description`, `metadata`) and `revision`.
- `pack.id` is namespaced by publisher, for example `mahas.codex.files`; `revision`
  is a positive integer and the pair is immutable.
- `revision.subjectRefs` says which harness/provider/offering the Pack is about
  (`{ kind: "harness", harnessId: "codex" }`). Canonical harness ids are
  unprefixed (`codex`, `claude`, `gemini`, `grok`, `devin`, `zcode`, `cursor`,
  `copilot`, `aider`, `opencode`, `amp`, `cline`, `fake`).
- `revision.implementations[]` declares one capability each: `id`, `capability`,
  `contract: { id: "mahas.integration.<capability>", revision: 1 }`,
  `entrypoint: { mode: "script", resource: "collector.mjs", runtime: "node" }`,
  `support` (`{ state: "implemented" }` or `{ state: "unsupported", reason }`),
  bounded `limits` (`timeoutMs`, `maxOutputBytes`, `maxBatchRecords`), and
  `supportDetails` for capability-specific precision (collection mode, cache
  containment, deletion evidence, pagination, attribution availability).
- `revision.requirements[]` lists platform/executable/permission/feature
  preconditions, each with `required`. A missing optional executable degrades the
  capability; it does not silently disable the declaration.
- `revision.contentDigest` may be left empty when authoring: registration computes
  the digest over the snapshot and refuses a different content for the same
  revision (`IMMUTABLE_REVISION`) or a snapshot that drifts (`CONTENT_DRIFT`).
  The source directory may not live inside the snapshot root.
- Capabilities are `identify`, `launch`, `resume`, `wake`, `events`, `sessions`,
  `usage`, `bindings`, `maintenance`, `auth`, `quota`
  (`INTEGRATION_CAPABILITIES` in
  [integration/types.ts](../../packages/mahas-runtime/src/integration/types.ts)).

## Collection rules that decide correctness

- **Unknown is not zero.** Report an unobserved metric as null, and declare
  containment (`excluded`, `unknown`) instead of adding a number you cannot
  attribute. Coverage travels with the batch.
- **Cumulative vs delta is explicit.** A cumulative reading carries its counter
  scope and epoch; a decrease is held until reset/correction evidence exists, and
  a scope change is never treated as a reset by itself.
- **Time is evidence.** Point, interval, and unknown time coverage stay distinct;
  never fill a long interval with an assumed timestamp, and keep the first
  cumulative baseline out of today.
- **Identity is stable per installation.** Qualify namespaces with the installation
  id, use a stable record key per source record, and keep the source id independent
  of the Pack revision so an update does not re-import the same usage.
- **Batches are bounded and resumable.** Return an opaque cursor, cap records and
  bytes, and stop on a deadline. A partial final JSONL line does not advance the
  offset.
- **Deletion is evidence, not inference.** Absence counts only after a complete
  bounded sweep, and it is reported as coverage, never as a silent drop.
- **No secrets in payloads.** Auth material never travels through a normal Pack
  invocation (the contract answers `auth.dedicated-channel-required`); redact
  paths, tokens, and prompt text from diagnostics and evidence.

## Verify before registering

Work against a scratch database and synthetic fixtures — never a real credential,
provider API, or user session log. The shape used by the existing drafts:

1. create a scratch `node:sqlite` database and apply the integration DDL
   (`INTEGRATION_SCHEMA_SQL` from `packages/mahas-runtime/src/integration/migration.ts`)
   — in production that schema arrives through the central control migration
   (`packages/mahas-runtime/src/storage/migrations.ts`), not through a fixture helper;
2. build a `PackRegistry({ db, contentRoot })` and `registry.registerDirectory(packDir)`;
3. drive the Pack with `runPack(registry, envelope)` for `discover-sources` and
   `collect`, asserting the envelope identity is echoed and the batch is bounded;
4. verify each capability with `checkPackCapability(...)`, then persist the verdict
   with `registry.recordCheck(...)` so support and check state stay separate;
5. re-run collection after mutating the fixture (append, rotate, truncate, delete)
   to prove replay, partial-line, reset, and complete-sweep behavior.

Existing worked examples:
[integrations/packs/opencode/conformance.smoke.ts](../../integrations/packs/opencode/conformance.smoke.ts)
and [integrations/packs/zcode/conformance.smoke.ts](../../integrations/packs/zcode/conformance.smoke.ts)
(synthetic SQLite + registry + runner).

## Verification status

- Every shipped collector now has its own conformance fixture, run through the real
  registry and `runPack` against **synthetic** vendor files and SQLite databases:
  `npm run test:packs` covers codex, claude, grok, cline, opencode, zcode, devin and
  the harness-runtime pack, then `integrations/all-packs.acceptance.smoke.ts` drives
  all seven collectors end to end and commits one usage batch into the real ledger.
- **Synthetic means synthetic.** Those runs prove a Pack against the fixture shape its
  author encoded, not against a real installation. No real session log, database,
  credential, or network endpoint is exercised, so a collector that no longer matches a
  live vendor schema can still pass. Treat the fixtures as a regression net, not as a
  compatibility claim.
- The provider auth/quota pack has mock tests only, and the manifest-level smoke
  (`integration/builtin-packs.smoke.ts`) proves registration, digests and contract
  resolution — never collector behavior.

## Remaining limits

- Runtime registration of a new Pack goes through `integration.pack.register`
  on the deferred-admission path: the durable request is stored first, the
  Pack's effects run outside the transaction, and the result commits
  atomically. A failed effect never leaves a half-registered Pack.
- Discovery metadata keys are resolved by the daemon's scheduler
  (`collectionCandidates` in
  `packages/mahas-runtime/src/observation/collection/scheduler.ts`), which is the
  authority for what each key means today: `home` / `home-relative`,
  `xdg-config-home`, `xdg-data-home`, `environment` (with a `variable`), and a
  `config` / `config-relative` base that resolves to the root previously seen as
  config. Fields `roots`, `configRoots`, `configDirectories`, `dataRoots` and
  `dataDirectories` are all read; `role: config` marks the root that later
  config-relative entries resolve against. Declare what the vendor actually has,
  and check a new Pack against that function rather than against prose here.
- Observed check results, not claims: [development/verification](../development/verification.md).
