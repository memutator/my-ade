# Cline collector Pack

A Cline session lives in `<data>/sessions/<sessionId>/`: an optional `<sessionId>.json` manifest (cwd, prompt) plus one `<name>.messages.json` conversation per run, including team and sub-agent runs. This Pack reads those conversation snapshots and the manifest; it never writes to them.

## Measurement semantics

Each assistant message carries per-request `metrics`, so readings are `delta` and keyed by the native message id. Cache read and cache write are contained in `inputTokens` under the semantics the legacy ledger used, so the calculated total is input plus output and the containment is declared in `componentRelations`. The manifest supplies cwd and an unwrapped prompt title; a missing manifest does not stop the metrics from counting.

## Checkpoints, revisions and deletion

A page is bounded by `maxRecords` and the cursor holds the file signature plus the message index, so a long conversation is read in bounded pages and a rewritten file restarts the sweep at index 0. Rewriting one message re-emits the same record key with a new revision, which the ledger records as a correction. An unreadable snapshot or one larger than `maxBytes` holds the cursor. A deleted file is a coverage gap. Handles report `resumeSupport: unknown`, because no verified native resume invocation was established for this source.

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
node --experimental-transform-types integrations/packs/cline/conformance.smoke.ts
```
