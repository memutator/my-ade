# Codex collector Pack

This Pack reads the rollout JSONL files under an installation's sessions namespace. It never writes to them and never reads anything else in the installation.

## Measurement semantics

A `token_count` record carries a cumulative `total_token_usage`, so readings are `cumulative` under an explicit counter scope and epoch. Cache read is contained in `input_tokens`, so it never enters the calculated total a second time; a total is only derived when input and output were both observed. `total_tokens` is preserved as the reported total and a mismatch against the calculated total is recorded rather than overwritten.

## Checkpoints, revisions and deletion

The checkpoint is a confirmed-newline byte offset: the cursor advances only past records whose terminating newline was observed, so an incomplete trailing record is re-read once it is completed. Re-reading a confirmed range emits nothing, which makes a retried batch a no-op. A complete but unreadable record is reported as a `record.invalid-json` coverage gap while the cursor moves past it, so one bad line cannot wedge collection. A shrinking file restarts the offset, a decreasing cumulative counter opens a new counter epoch with the reset record as the new baseline, and a replaced file is a new source generation that requires rediscovery. Deleting the source updates coverage only; the collector never rewrites already collected usage.

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
node --experimental-transform-types integrations/packs/codex/conformance.smoke.ts
```
