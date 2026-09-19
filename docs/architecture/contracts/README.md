# Contract index

What counts as a machine contract in this repository, where each one lives,
and which boundaries must stay compatible. Documentation explains meaning and
constraints and links to the definition — it never copies field lists that
would drift from the type or schema.

## Authority

| kind of contract | authority | notes |
| --- | --- | --- |
| public types and constants | `packages/mahas-contracts/src/**` | The renderer-safe port: no Node imports, no third-party dependencies, no sibling packages. Enforced by [check-boundaries.mjs](../../../tools/check-boundaries.mjs) and the `mahas-boundaries/resolved-package-imports` ESLint rule. |
| Pack capability payloads | `packages/mahas-contracts/src/integration/schema.ts` | `CAPABILITY_PAYLOAD_SCHEMAS` plus `PACK_BOUNDARY_SCHEMAS` are the machine authority; exported payload types are inferred from them (`InferIntegrationSchema`), and `validatePackBoundaryPayload` performs the deep validation. |
| capability contract revisions | `IntegrationContract` (`packages/mahas-contracts/src/integration/index.ts`) resolved through a `resolveContract` port | Pack manifests reference `{ id, revision }` (for example `mahas.integration.usage@1`). `integration/contracts.ts` builds the canonical registry from shared payload schemas and versioned semantics; `composition-domains.ts` supplies its resolver to integration operations. The registry is composed at boot, not seeded as contract rows by a migration. |
| physical storage schema | the migration that actually runs (`packages/mahas-runtime/src/storage/migrations.ts`, composing the additive domain fragments) | Documents describe relationships, invariants, and migration policy; they do not restate DDL. Fixture-local `applySchema` calls do not establish a production schema. |
| service/operation surface | operation registration in `packages/mahas-runtime/src/**` plus the control-plane contracts (`service.ts`, `client.ts`, `common.ts`, `ops.ts`) | A registration function existing does not mean an operation is reachable: composition, operation metadata/surface, and grants must include it. |

## Contract modules

| area | module |
| --- | --- |
| control plane and client | `packages/mahas-contracts/src/service.ts`, `client.ts`, `common.ts` (envelopes, error codes, receipts) |
| executions and terminals | `packages/mahas-contracts/src/execution.ts`, `binding.ts` |
| observation, sessions, metering | `packages/mahas-contracts/src/observation.ts`, `sessions/`, `metering/` |
| catalog and inventory | `packages/mahas-contracts/src/catalog/`, `inventory/` |
| integrations | `packages/mahas-contracts/src/integration/index.ts`, `integration/schema.ts` |
| collaboration and discovery | `packages/mahas-contracts/src/operations/`, `role.ts`, `work.ts`, `access.ts`, `resource.ts`, `identity.ts`, `rdd.ts`, `mail.ts` |

## Compatibility boundaries

- **Desktop imports.** `src/main` composes `mahas-contracts`, `mahas-harness-config`,
  `mahas-runtime`, and `mahas-client`; `src/preload` and `src/renderer` may import
  `mahas-contracts` **type-only**. Relative `.ts` specifiers with explicit
  extensions are the convention across boundaries; see [packages/README.md](../../../packages/README.md).
- **Shared wire types have one definition.** `AgentHookEvent` comes from
  `mahas-contracts`; `workbench/contracts.ts` re-exports the canonical operation
  DTOs, and `workbench/view-model.ts` owns explicit UI projections. Legacy
  `TokenUse`, `UsageResult`, and ledger wire types are defined in
  `src/preload/index.ts` and reused by main and renderer. They remain compatibility
  transports over stored domain data. The desktop `ResumeSession` record owns
  placement and migration metadata; it is distinct from the canonical stored
  harness-session contract.
- **Additive revisions.** Pack-facing contracts are versioned by
  `IntegrationContract.revision` with `minimumRunnerProtocol` and
  `backwardCompatibleWith`; Pack revisions are immutable and digest-pinned, so a
  behavior change is a new revision rather than an edit. See
  [authoring](../../integrations/authoring.md).
- **View models stay in the renderer.** UI formatting and feature-local view
  models belong to the feature (`src/renderer/src/features/`), not to contracts.
- **Test-only peer imports.** `mahas-runtime` may reach `mahas-execution-host`
  and `mahas-client` only from `*.smoke.ts` / `*.manual.ts` / fixture
  directories, or through the two compatibility facades (`src/bootstrap.ts`,
  `src/rpc/client.ts`) that are deleted when their callers move. Production
  runtime code keeps the declared direction; the checker and the ESLint rule
  share this policy.

## How contracts are checked

| check | command | what it proves |
| --- | --- | --- |
| package typing | `npm run typecheck:packages` | every package entrypoint and every source file under `packages/*/src` participates in that package tsconfig program, then each program typechecks |
| import direction | `npm run check:boundaries` | every source-file import resolves and respects package direction, type-only UI imports, and the narrow runtime-host/facade exceptions |
| policy self-test | `npm run test:boundaries` | the policy still rejects each violation class with a temporary fixture tree (including inline `import { type X }` forms) |
| Pack conformance | per-Pack conformance run — see [authoring](../../integrations/authoring.md) | capability payloads, digests, and fixture invocation pins match the declared contract for one revision |

Observed results and their limits are recorded in [verification](../../development/verification.md).
