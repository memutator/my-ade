# OpenCode collector Pack

This Pack opens only the `opencode.db` named by an installation data namespace, using Node's native SQLite driver in read-only/query-only mode. It never reads message text.

## Measurement semantics

The `session` table stores cumulative per-session counters. Input, cache read, cache write, output and reasoning are separate components: cache read is additional to `tokens_input`, while nothing in the repository establishes the containment of `tokens_cache_write`, so it is preserved without entering the calculated total. A calculated total therefore requires input, output, reasoning and cache read; when any of them is unobserved the total stays `null` instead of becoming `0`. No provider or model attribution is emitted, because this table does not carry it, and usage time is unknown rather than assigned to collection time.

## Checkpoints, revisions and deletion

The table has no trustworthy update watermark, so collection reconciles the keyspace in bounded keyset pages and re-emits every row it reads with a content-derived revision. `exhausted: true` means the sweep wrapped the keyspace, which is what makes absence observable to the runtime; the collector never claims a deletion by itself. The counter epoch follows the database file identity, so a schema upgrade keeps the same counters while a replaced database file starts a new epoch. A stale checkpoint against a changed generation fails closed and requires rediscovery.

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
node --experimental-transform-types integrations/packs/opencode/conformance.smoke.ts
```
