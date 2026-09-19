# Plans

Proposals and in-flight work. **Current, shipped behavior is never documented
here** — it lives in [docs/README.md](../README.md) (user guides and
[architecture](../architecture/overview.md)). When an item below lands, its
behavior moves into the current docs and the plan entry is marked done or removed
rather than left as a second description.

Root state files (`HANDOFF.md`, `milestone-plan.md`, `domain-model-design.md`,
`domain-model-needs.md`) are owned by the integration coordinator; this directory
does not duplicate their content.

## Active

| plan | scope | owner | state |
| --- | --- | --- | --- |
| [integration-migration-map.md](integration-migration-map.md) | source-to-destination handoff map for each existing desktop path | integration coordinator | active; the map is the authority for who moves what |
| [integration-status.md](integration-status.md) | pointer to the root handoff as the single status source | integration coordinator | active |
| [milestone-plan.md](../../milestone-plan.md) stages A–G | domain contracts, storage, collection, aggregation, consumer switch, cleanup, docs | integration coordinator | in progress — whole-milestone completion withdrawn; see the [source audit](../development/milestone-audit.md) |
| [domain-model-design.md](../../domain-model-design.md) | meaning of the new domain (identity, binding, attribution, coverage, statistics) | integration coordinator | implemented — the semantic source; see [domains](../architecture/domains/README.md) for what exists where |

## How to tell current from proposed

- A page under `docs/user/`, `docs/architecture/`, or `docs/integrations/capabilities.md`
  describes behavior that exists now, with its limits stated.
- A page here or a root proposal describes intended behavior; it may name modules
  that exist without a consumer.
- [verification.md](../development/verification.md) records what was actually
  executed and what remains unverified — a plan is not evidence.

## Historical

- `mahas-architecture/implementation-plan/`, `review-plan/`, `verification-plan/`,
  `records/`, `orchestration/`: archived task packages and their evidence. They are
  preserved for provenance, not as plans for current work, and their results are
  never re-presented as verification of current code.
