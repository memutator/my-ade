# Claude collector Pack

This Pack reads the project JSONL transcripts under an installation's projects namespace. It never writes to them and never reads anything else in the installation.

## Measurement semantics

Each `assistant` record carries its own `message.usage`, so readings are `delta` and the stable record key is the native message uuid. Cache read and cache creation are contained in `input_tokens` under the semantics the legacy ledger used, so the calculated total is input plus output and the containment is declared in `componentRelations`. `cacheWriteInput` and `reasoningOutput` stay `null` when the record does not carry them.

## Checkpoints, revisions and deletion

The checkpoint is a confirmed-newline byte offset, so an incomplete trailing record is re-read once completed and a retried batch emits nothing. A complete but unreadable record is reported as a coverage gap while the cursor advances past it. A shrinking file restarts from the beginning of the file, and a replaced file is a new source generation that requires rediscovery. Sessions mode reads the same source without emitting usage readings; usage batches carry the session they belong to, because the ledger resolves session identity from the batch.

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
node --experimental-transform-types integrations/packs/claude/conformance.smoke.ts
```
