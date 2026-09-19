# Devin collector Pack

The Pack reads `<data namespace>/cli/sessions.db` through Node's native SQLite driver with read-only/query-only connections. It extracts only session metadata and the small `metadata.metrics` object from `message_nodes.chat_message`; prompts, responses and other transcript content are never emitted. The ATIF transcript export is deliberately not used because it is a compacted export that undercounts cache reads.

## Measurement semantics

Streaming and retries can write several `message_nodes` rows for one message. Usage is keyed by `session_id + message_id` and the latest SQLite row is the deterministic representative; rows without a message id keep their own row identity instead of being merged into a neighbour. Input and cache-read counters are separate components, matching the existing Devin accounting, and nothing establishes the containment of reasoning tokens, so they stay out of the calculated total. Provider, model and time are emitted only when they exist in message metadata; the native provider string is preserved as evidence rather than asserted as a canonical Provider id.

## Checkpoints, revisions and deletion

The tables have no update watermark, so collection pages through the logical keyspace in bounded reconciliation sweeps and re-emits every row it reads with a content revision. A wrapped sweep is what makes absence observable to the runtime; the collector itself never claims a deletion. Usage pages report one session record per referenced session, because the ledger resolves session identity from the same batch.

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
node --experimental-transform-types integrations/packs/devin/conformance.smoke.ts
```
