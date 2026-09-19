# ZCode collector Pack

The Pack reads `<data namespace>/cli/db/db.sqlite` through a read-only/query-only native SQLite connection.

## Measurement semantics

`model_usage` is the primary per-request metering stream because it includes main turns, subagents, compaction and verification; `turn_usage` is used only when `model_usage` is absent and coverage reports that degraded fallback explicitly. Cache-read tokens are contained in input and reasoning tokens are contained in output, matching the existing ZCode accounting semantics. Provider, model and time are emitted only when the fields exist on the usage row itself; the native provider string is preserved as evidence rather than asserted as a canonical Provider id, which only the catalog may define.

## Checkpoints, revisions and deletion

Neither stream has a trusted update watermark. Bounded keyset pages form a reconciliation sweep; after a sweep wraps, the next call starts another. Content-derived row revisions make updates idempotent and observable. A real single-column primary key is used when present, then `id`, then SQLite `rowid`; the counter epoch follows the database file identity. A checkpoint presented against a different stream or generation fails closed instead of reusing another stream's position. Deletion is not claimed by the collector: absence from a wrapped sweep is what the runtime compares against its stored checkpoint.

## Discovery

The manifest declares one `discovery.roots` list in the shared declarative form:

- `role: config` / `role: data` marks which root is the installation's config and
  data namespace.
- `base` is one of `home`, `xdg-config-home`, `xdg-data-home`, `environment`
  (with `variable`) or `config` (the resolved path of the first `config` root).
- Roots are priority ordered. `identify` receives every absolute candidate root
  and reports one installation per data namespace, so a config root and its data
  root never produce two installations.

## Conformance fixture

`conformance.smoke.ts` drives the real `PackRegistry` and `runPack` seam against
a temporary fixture only. It never reads a real installation, session log,
database or credential, and it makes no network call. Run it with Node 24:

```
node --experimental-transform-types integrations/packs/zcode/conformance.smoke.ts
```
