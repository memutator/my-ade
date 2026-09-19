# Storage and migrations

The control plane owns one SQLite database per profile
(`<configDir>/mahas.sqlite`), written by `mahasd` alone. Its physical schema is
defined by the migrations that run, not by prose: the authority is
[`packages/mahas-runtime/src/storage/migrations.ts`](../../packages/mahas-runtime/src/storage/migrations.ts).

## Current chain

`CONTROL_SCHEMA_VERSION` is the version a fresh install reaches; `CONTROL_MIGRATIONS`
is the ordered list that gets it there. Each entry has a stable id (also its
`migration_receipts` primary key), a `fromVersion`/`toVersion` pair, and the DDL
executed inside one transaction.

| id | from → to | content |
| --- | --- | --- |
| `control-0001-schema-v1` | 0 → 1 | the original control schema (model, roles, work, executions, access, receipts) |
| `control-0002-integration-domains` | 1 → 2 | catalog, inventory, provider auth, integration (Packs), sessions, collection, usage ledger, quota, aggregates, statistics |
| `control-0003-execution-session-references` | 2 → 3 | execution ↔ session references used by recovery |

Each domain fragment lives with its domain (`catalog/migration.ts`,
`inventory/migration.ts`, `inventory/auth/migrations.ts`,
`integration/migration.ts`, `sessions/migrations.ts`,
`observation/collection/migrations.ts`, `metering/usage/migrations.ts`,
`metering/quota/migrations.ts`, `metering/aggregates/schema.ts`,
`metering/statistics/schema.ts`,
`recovery/session-reference-migration.ts`) and is composed by the central
migration. A fragment is never applied on its own in production, and importing a
sibling fragment inside the same package is normal composition — the boundary
checker allows intra-package imports by design.

## Upgrade paths

Both paths are exercised by
[`storage/domain-migration.smoke.ts`](../../packages/mahas-runtime/src/storage/domain-migration.smoke.ts):

- **Fresh install** — the whole chain runs in order and the result is recorded
  with a migration receipt.
- **Existing v1 profile** — `control-0002` and `control-0003` are applied
  additively; the smoke also covers reopen, a backup image, rollback, and
  downgrade refusal.

Drafts of v2 domain tables were never deployed outside fixtures, so there is no
shipped v2 profile to reconcile: the statistics schema's ALTER-style helpers exist
only to keep fixture drafts loadable and are not part of an upgrade path.

## Rules

- **Additive by default.** A new domain adds a migration with the next version;
  existing DDL text is not edited, because a receipt already records it.
- **One transaction per migration**, with the receipt written in the same
  transaction — a partially applied schema is never observable.
- **Secrets stay out.** Provider credentials are stored as material references;
  the auth fragment stores no secret bytes in the control DB.
- **Preservation.** The usage ledger, corrections, and the evidence a rebuild
  needs are not deleted by routine maintenance; GC policies must state what they
  drop, and rollback must not delete new ledger rows or re-add old totals.
- **Fixtures do not define the schema.** A smoke may apply a fragment to a scratch
  database, but that never stands in for the central migration.

## Related

- Domain ownership and status: [../architecture/domains/README.md](../architecture/domains/README.md).
- Contract authority: [../architecture/contracts/README.md](../architecture/contracts/README.md).
- Migration ownership per existing source path:
  [../plans/integration-migration-map.md](../plans/integration-migration-map.md).
- Observed results: [verification.md](../development/verification.md).
