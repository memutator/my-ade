# Verifying a Pack

Every check below runs against **synthetic fixtures** in a scratch directory and a
throwaway SQLite database. Never point a Pack at a real credential file, a user
session log, or a provider API while authoring, and never run an effectful
capability to see what happens.

## Harness pattern

The existing drafts under `integrations/packs/{opencode,zcode}/conformance.smoke.ts`
are the working example (run them with the system Node that strips types):

1. `mkdtempSync` a scratch directory; build the vendor-shaped fixture inside it
   (a SQLite file with `node:sqlite`, or JSONL/Directories for file packs).
2. Create a scratch registry DB (`new DatabaseSync(":memory:")` or a file in the
   scratch directory) and apply the integration DDL —
   `INTEGRATION_SCHEMA_SQL` from `packages/mahas-runtime/src/integration/migration.ts`.
   In production that schema arrives through the central control migration
   (`packages/mahas-runtime/src/storage/migrations.ts`); a fixture helper is only
   ever a test convenience.
3. `const registry = new PackRegistry({ db, contentRoot: <scratch>/packs })` and
   `const revision = registry.registerDirectory(packDirectory)`.
4. Drive the Pack with `runPack(registry, envelope)` for action
   `discover-sources` and then `collect`, passing a fresh `operationId` per call and
   the identity from the registration result (`packId`, `revision`, `contentDigest`).
   Assert: `status`, `exhausted`/`nextCursor`, one reading per expected record,
   bounded page sizes, and echoed identity.
5. For a normal capability (for example `sessions` or `usage`), call
   `checkPackCapability(registry, packId, revision, capability, contract)` and then
   persist the verdict with `registry.recordCheck({...})`. A revision starts
   `unchecked`; only concrete schema/case evidence moves it to `compatible`,
   `incompatible`, or `degraded`, and `semanticsVerified` is reported separately.
6. Clean up the scratch directory, and fail the script with a non-zero exit on the
   first unmet expectation.

## Commands

```bash
npm run typecheck:packages   # TS packages only: the Pack entrypoint is .mjs
npm run lint                 # covers integrations/packs/**/*.mjs
node integrations/packs/<pack>/conformance.smoke.ts
```

`runPack` is explicit invocation only: registration, schema checks, and capability
listings never call a Pack.

## Fixture matrix to replay

A Pack is not verified until the fixture has been mutated between runs:

| case | expected behavior |
| --- | --- |
| append new records | only new records are collected; the cursor advances past the confirmed boundary |
| incomplete last JSONL line | the offset does not advance past it, and the line is collected once it completes |
| file rotate/truncate/replace | a new source generation is reported; it is not by itself counter-reset evidence |
| cumulative counter increases | the same range is superseded, not added twice |
| cumulative counter decreases | held until explicit reset/correction evidence |
| counter scope/epoch changes | reported as a scope change, never inferred as a reset |
| two installations sharing a directory shape | namespaces stay separate; records do not collide |
| database row updated, then same cursor replayed | the updated row is re-reported (bounded re-read), not silently skipped |
| rows deleted, then a complete sweep | deletion reported as coverage (`complete-sweep-absence`), not as a silent drop |
| same batch replayed with the same operationId | idempotent; no duplicate usage |
| page caps (`maxRecords`, `maxBytes`) reached | `partial` plus a usable `nextCursor`, never truncated JSON |
| malformed / unreadable record | a diagnostic with position and severity; policy decides whether following records proceed |
| source missing or unreadable | source state/coverage updated; already-collected ledger data preserved |

## What to record when you report the result

- The exact command and the observed outcome, including failures and the fixture
  that produced them.
- Per capability: `support.state`, the check verdict, and whether semantics were
  actually verified (a schema pass is not a semantic proof).
- What stays unknown: cache containment, attribution availability, deletion
  evidence, timestamps the vendor does not expose. Unknown is a finding, not a gap
  to paper over.
- Open an issue row (`registry.openIssue`) for external failures such as a changed
  vendor schema, instead of degrading silently.

## Current limits (do not overstate in a PR or release note)

- No Pack conformance run has been recorded in this repository yet: the shipped
  drafts are unverified, and the central migration, operation metadata/grants, the
  scheduler, and the effect/transaction split for registration are outstanding.
- `docs/development/verification.md` records what was actually executed; keep it in
  sync rather than claiming a green check.
