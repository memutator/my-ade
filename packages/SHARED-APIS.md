# Shared kernel APIs — coordinator-fixed convergence contract

Every IMP task codes against THESE signatures. Owners implement them exactly;
consumers call them and do not invent local duplicates. Cross-domain work is
invoked by **operation name through the OperationRegistry** (spec §operations.md);
services never import sibling service internals.

Import rule: relative paths with explicit `.ts` extension, e.g.
`import { openControlDb } from '../../mahas-runtime/src/storage/db.ts'`.
Type-only imports use `import type`. All public types live in
`packages/mahas-contracts/src/` (IMP-02) under the names fixed in
`spec/common.md` §1–2: `Id`, `Revision`, `ModelVersionId`,
`RoleInterfaceDigest`, `ImplementationRevision`, `BundleDigest`,
`TaskRevision`, `PlanRevision`, `ExecutionGeneration`, `ControllerEpoch`,
`HostIncarnation`, `ContentRef`, `ArtifactRef`, `PathRef`, `CommandRequest`,
`AuthenticatedContext`, `CommandReceipt`, `MahasError`, `QueryResult`,
`EffectIntent`, `EffectReceipt`.

## IMP-03 — packages/mahas-runtime/src/storage/db.ts (owns)

```ts
import { DatabaseSync } from 'node:sqlite';
export function openControlDb(path: string): DatabaseSync;   // pragma WAL/FK/synchronous=FULL/busy_timeout + migrate to schema v1 (spec/storage.md §3)
export function withTx<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T; // BEGIN IMMEDIATE … COMMIT / ROLLBACK
export function sha256Hex(data: string | Uint8Array): string; // lowercase hex, no prefix
export function putContentBlob(db: DatabaseSync, bytes: Uint8Array, mediaType: string): ContentRef; // dedup by digest
export function getContentBlob(db: DatabaseSync, digest: string): { bytes: Uint8Array; mediaType: string } | null;
export function appendDomainEvent(db: DatabaseSync, aggregateId: string, aggregateRevision: number, eventType: string, scope: unknown, payload: unknown): void;
export function insertReceipt(db: DatabaseSync, receipt: CommandReceipt, principalScope: string): void; // operation_receipts upsert
export function findReceipt(db: DatabaseSync, principalScope: string, operation: string, operationId: string): CommandReceipt | null;
```

Host-side twin — `packages/mahas-execution-host/src/storage.ts` (IMP-03 owns): same helpers minus control DDL — `openHostDb(path)` applies spec/storage.md §4 DDL; `withTx`, `sha256Hex` re-exported so host code never imports mahas-runtime.

## IMP-10 — packages/mahas-runtime/src/access/authorize.ts (owns)

```ts
export interface TargetRef { kind: string; id: string }
export function authorize(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): void; // throws MahasError SCOPE_DENIED/GRANT_REVOKED/UNAUTHENTICATED
export function decide(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): { allow: boolean; decision: AuthorizationDecision }; // also records authorization_decisions
export function surfaceFor(ctx: AuthenticatedContext, db: DatabaseSync): CommandSurface; // role-derived visible op set + policy pins
export function isOperationVisible(surface: CommandSurface, operation: string): boolean;
export function issueGrant(db: DatabaseSync, grant: GrantInput): Grant;
export function revokeGrant(db: DatabaseSync, grantId: string, at: number): void;
export function verifySecret(secret: string, secretHash: string): boolean; // scrypt or sha256 — owner's choice, document it
```

## IMP-11 — packages/mahas-runtime/src/api/registry.ts (owns)

```ts
export interface TxnContext { db: DatabaseSync; ctx: AuthenticatedContext }
export type OperationHandler = (txn: TxnContext, payload: unknown) => unknown | Promise<unknown>;
export interface OperationSpec { name: string; visibility: 'operator' | 'member' | 'service' | 'host'; mutation: boolean }
export class OperationRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void;
  describe(ctx: AuthenticatedContext): CommandSurface;
  dispatch(ctx: AuthenticatedContext, req: CommandRequest): Promise<CommandReceipt>; // admission: visibility → authorize → idempotency → tx(handler) → receipt+events+outbox
}
export function makeCaller(registry: OperationRegistry, ctx: AuthenticatedContext): (operation: string, payload?: unknown, expectedRevisions?: Record<string, number>) => Promise<unknown>; // internal cross-domain call — services use THIS, never sibling imports
export const OPERATION_NAMES: readonly string[]; // spec/operations.md list, IMP-02 constants
```

## IMP-17/18 — packages/mahas-execution-host + runtime client (IMP-17 owns service, IMP-18 owns process ops; the CLIENT side lives in packages/mahas-runtime/src/hostClient.ts, IMP-17 owns)

```ts
export interface HostClient {
  call<T = unknown>(operation: string, payload?: unknown): Promise<T>; // NDJSON over the host unix socket; op names per spec/operations.md C-HOST block
  close(): void;
}
export function connectHost(endpoint: string): Promise<HostClient>;
export interface SpawnSpec { argv: string[]; cwd: string; env: Record<string, string>; pty?: { cols: number; rows: number } }
// host.process.spawn payload: { spawnNonce, executionId, generation, spec: SpawnSpec }
// host.process.spawn result: { processIdentity, terminalId? }
```

## IMP-12 — packages/mahas-runtime/src/rpc/ (owns) + packages/mahas-cli

```ts
export interface RpcServer { endpoint: string; close(): Promise<void> }
export function serveRpc(registry: OperationRegistry, endpoint: string, authenticate: (credential: unknown) => AuthenticatedContext): RpcServer; // unix socket NDJSON CommandRequest→CommandReceipt
export function connectRpc(endpoint: string, credential: unknown): Promise<{ call(op: string, payload?: unknown, opts?: { operationId?: string; expectedRevisions?: Record<string, number> }): Promise<unknown>; close(): void }>;
```

All cross-domain calls: `caller = makeCaller(registry, ctx); await caller('workspace.prepare', payload)` —
never `import { WorkspaceService } from '../workspaces/…'`.

## Canonical domain type names (IMP-02 exports from mahas-contracts — import by THESE names)

model (`src/rdd.ts`): `Project`, `ModelVersion`, `Boundary`, `Criterion`, `BoundaryPath`, `BoundaryEdge`, `HorizontalRole`, `Role`, `RddContext`, `BoundaryContext`, `HorizontalContext`, `RddContract`, `ContractConsumer`, `NonGoal`, `ModelChange`, `ModelChangeEdit`, `SearchRow`

role (`src/role.ts`): `RoleInterface`, `ContextRequirement`, `HarnessProfile`, `RoleImplementation`, `ImplementationComponent`, `CoverageBinding`, `MaintenanceBinding`, `ContextBundle`

access (`src/access.ts`): `Principal`, `RolePolicy`, `Grant`, `AssignmentGrant`, `ProvisioningGrant`, `ContinuationGrant`, `CommandSurface`, `AuthorizationDecision`

work (`src/work.ts`): `Run`, `Member`, `Assignment`, `Plan`, `PlanCandidate`, `Task`, `TaskSpec`, `InputBinding`, `OutputSlot`, `TaskEdge`, `RuntimeInstance`, `ExecutionHost`, `ControllerLease`, `ExecutionRecord`, `ExecutionCredential`, `WorkEnvelope`, `LaunchPlan`, `Dispatch`, `InjectionReceipt`, `WorkerJoin`, `AttemptObservation`, `ResidualResource`, `Handoff`

mail (`src/mail.ts`): `Message`, `Delivery`, `InboxRead`, `WakeRequest`, `Artifact`, `Outcome`, `OutcomeOutput`, `Settlement`, `RunDecision`

resource (`src/resource.ts`): `Resource`, `Checkout`, `Workspace`, `ResourceClaim`, `ResourceTransfer`, `TerminalRecord`, `InputLease`, `RetentionPin`

observation (`src/observation.ts`): `Observation`, `Intervention`, `DomainEvent`, `ClientViewBinding`, `ResumeCandidate`, `ImpactCandidate`, `BackupSet`, `RuntimeShutdown`, `SupportAttestation`

envelope (`src/common.ts` — already exists): `Id`, `Revision`, `ModelVersionId`, `RoleInterfaceDigest`, `ImplementationRevision`, `BundleDigest`, `TaskRevision`, `PlanRevision`, `ExecutionGeneration`, `ControllerEpoch`, `HostIncarnation`, `ContentRef`, `ArtifactRef`, `PathRef`, `CommandRequest`, `AuthenticatedContext`, `CommandReceipt`, `MahasError`, `ErrorCode`, `QueryResult`, `EffectIntent`, `EffectReceipt`, `EffectState`

If a needed type is not yet exported from mahas-contracts (IMP-02 may still be in flight), define NOTHING local — import the name anyway; typecheck for it settles when IMP-02 lands. Structural field names follow the DDL column names in spec/storage.md §3 converted to camelCase (e.g. `model_version` → `modelVersion`, `responsibility_statement` → `responsibilityStatement`); JSON-payload columns keep their spec object shape.
