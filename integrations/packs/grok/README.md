# Grok collector Pack

This Pack reads the per-session `usage.json` snapshots under an installation's sessions namespace. It never writes to them and never reads anything else in the installation.

## Measurement semantics

The snapshot is a cumulative per-session counter, so readings are `cumulative` under an explicit counter scope and epoch. Cache read is contained in `inputTokens`; a total is only derived when input and output were both observed. The model name on the snapshot is reported as an observed `servedModel` with the Pack's namespace.

## Checkpoints, revisions and deletion

The source is a mutable snapshot rather than an append-only log, so the cursor is the content signature: an unchanged snapshot ends the sweep without re-emitting rows, and a rewritten snapshot re-emits the same stable record key with a new revision under the same counter scope and epoch, which the ledger records as a correction of that counter. An unreadable snapshot or one larger than `maxBytes` holds the cursor instead of advancing past it. A replaced file is a new source generation that requires rediscovery, and a deleted file is a coverage gap that leaves collected usage untouched.

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
node --experimental-transform-types integrations/packs/grok/conformance.smoke.ts
```
