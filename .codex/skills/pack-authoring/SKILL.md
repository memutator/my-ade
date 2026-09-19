---
name: pack-authoring
description: Author or update a mahas integration Pack that observes a harness, provider, or offering through the mahas capability contracts. Use when adding local file, SQLite, CLI, auth, or quota observation to this repository, or when a Pack registration/conformance check fails. Do not use for ordinary mahas desktop features, for editing the core runtime domains, or for unrelated plugin work.
---

# Mahas Pack Authoring

A Pack teaches mahas how to observe one vendor from local evidence. It owns
vendor knowledge (paths, schemas, quirks); the core owns the contract, runner,
checks, and storage. The result of authoring is a registered, conformance-checked
Pack revision — not a new switch in the runtime.

## Ground yourself before writing code

1. Read the human-facing entry point: [docs/integrations/authoring.md](../../../docs/integrations/authoring.md).
2. Read the machine contract for the capability you need in `CAPABILITY_PAYLOAD_SCHEMAS`
   (`packages/mahas-contracts/src/integration/schema.ts`) and the Pack/revision types in
   `packages/mahas-contracts/src/integration/index.ts`. Those files are the authority:
   never restate their fields in a Pack README, and never invent a field the schema does
   not allow.
3. Read the registry rules in `packages/mahas-runtime/src/integration/registry.ts`
   (manifest validation, digest, immutability) and the runner in `runner.ts`.
4. Copy the shape of a working sibling: `integrations/packs/opencode/` (SQLite) or
   `integrations/packs/codex/` (JSONL with a byte cursor).

## Workflow

1. **Find the contract.** Identify the capability (`identify`, `sessions`, `usage`,
   `quota`, `auth`, `launch`, `resume`, `wake`, `events`, `bindings`, `maintenance`)
   and which fields its request/response schema actually carries. If the data the
   vendor exposes cannot be expressed, report that as an `unsupported` implementation
   with a reason instead of widening the schema.
2. **Investigate the source with fixtures.** Determine the real file/database shape,
   then build a **synthetic fixture** that reproduces it. Never test against a real
   credential file, a user session log, or a provider API.
3. **Implement** `integrations/packs/<pack-directory>/manifest.json` plus the
   entrypoint (`collector.mjs` for script capabilities). Keep it read-only, bounded,
   and dependency-free: the runner executes it under system Node.
4. **Declare honestly.** Per capability: `support.state`, bounded `limits`, and
   `supportDetails` that record what you actually observed — collection mode, cache
   containment, deletion evidence, attribution availability, pagination strategy.
5. **Verify** with a scratch registry: register, discover, collect, and run
   conformance, then repeat after mutating the fixture (append, rotate, truncate,
   delete, replay the same batch). Details and the harness pattern:
   [references/verification.md](references/verification.md).
6. **Keep revisions immutable.** A behavior change is a new `revision` number with new
   release notes. Editing content that a digest already pinned is refused by the
   registry, and re-importing old usage under a new revision is a bug.

## Non-negotiables

- **Unknown is not zero.** Emit null for unobserved metrics; declare containment as
  `excluded`, `included`, or `unknown` instead of summing what the vendor does not
  separate.
- **Cumulative vs delta is explicit**, with counter scope and epoch; a decrease needs
  reset/correction evidence, and a scope change alone is not a reset.
- **Time is evidence**: point, interval, and unknown coverage stay distinct; never
  backfill a long interval with an assumed instant, and never assign the first
  cumulative baseline to today.
- **Identity is installation-qualified and stable**: a stable record key per source
  record, and a source id that does not change when the Pack revision changes.
- **Batches are bounded and resumable**: opaque cursor, record/byte caps, deadline,
  and no offset advance past an incomplete JSONL line.
- **Deletion only after a complete sweep**, reported as coverage rather than as a
  silent disappearance.
- **Secrets never travel in payloads, diagnostics, or receipts.** Auth uses the
  dedicated channel (`auth.dedicated-channel-required`), and logs carry redacted
  paths at most.

## Reference

- Manifest fields, validation rules, capability list, discovery metadata:
  [references/contracts.md](references/contracts.md).
- Fixture harness, commands, and the fixture matrix to replay:
  [references/verification.md](references/verification.md).
- Current limits of the Pack path (unverified pieces, scheduler, central migration):
  [docs/integrations/authoring.md](../../../docs/integrations/authoring.md) and
  [docs/development/verification.md](../../../docs/development/verification.md).
