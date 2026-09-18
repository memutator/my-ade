# ReviewRecord — REV-01

- reviewTaskId: REV-01
- codeRevision: 83a6d21204ab6f164f2ff519a12ba6043188be14
- specRevision: 99eb5f5
- scope: IMP-02 contracts, IMP-03 SQLite storage, IMP-04 model persistence and publication, IMP-05/06 discovery and responsibility lookup, IMP-07 realization interfaces, and IMP-13/14 coordination/task-spec boundaries. Traced contract types, migration DDL, transaction/blob handling, model publication, realization snapshots/profiles, discovery handlers/visibility/availability, coordination runs/plans/tasks/dispatches, input pinning, work envelopes, source snapshots, access target resolution, and runtime JSON validation.
- disposition: changes-required

*Note on numbering:* this record re-sequences all findings F1–F16, consolidating every issue verified against code across both review passes.

## Verified aligned (no findings)

- **Model publication** (`model/publisher.ts`, `model/ops.ts`, `model/change-set.ts`): candidate commit re-materializes from stored base+edits, recomputes digest, re-runs structural rules, CAS-protects `active` pointer, inserts immutable version rows, and rebuilds search projections + `ModelPublished` events in the same transaction.
- **Source snapshot integrity** (`realization/source-snapshots.ts`, `realization/compiler.ts`): paths reject absolute/NUL/backslash/drive-letter/`.`/`..`; pins require lowercase sha256; bytes are read and digest-verified before `content_blobs` insertion; conflicting duplicate paths fail; sections may only reference pinned sources.
- **Dispatch DDL** (`storage/migrations.ts:660-681`): exact `(task_id, task_revision)` FK, envelope/member/execution FKs, partial unique indexes `one_active_dispatch_per_task`/`one_active_dispatch_per_execution`.
- **Admission pipeline** (`api/admission.ts`): visibility→authorize→idempotency→write-tx ordering; in-tx target re-resolution + grant re-check + pre-commit re-check; receipt persistence for mutations; `emitEvent`/`intendEffect` facades throw for non-mutations (but see F5 — handlers bypass via direct `txn.db`).
- **Selection tokens** (`discovery/selection-token.ts`, `composition.ts:344-358`, `coordination/member.ts:193-228`): HMAC integrity only, never authorization; fail-closed when verifier unwired; projectId/modelVersion pins enforced at assign.
- **Discovery visibility** (`discovery/visibility.ts`, `model-read.ts`): per-item filtering delegated to injected IMP-10 `decide`; denied items silently omitted; page cursors bind modelVersion+visibilityDigest+normalized filter; FTS parameterized and re-joined to real rows; roleId-only cache is safe within the fixed-modelVersion scope (`rdd_roles` PK makes role→boundary functional).
- **Harness profile registration** (`realization/profile-registry.ts:191-268`): revision 1 in `draft` only; injection routes validated against a closed set; `admit` enforces executable-identity digest pin and requires non-`documentation` evidence for `verified`; revisions immutable; `inspect` never fabricates observations and scrubs secret-keyed settings.
- **Work envelopes** (`coordination/member.ts:1023-1067`): immutable digest-pinned body+bindings, content-addressed.
- **`run.close` CAS**: expected-plan-revision compare in the `UPDATE … WHERE COALESCE(current_plan_revision,0)=?` guard (run.ts:462-475); residuals are reported, never implicitly collected.

## Findings

### F1. `role_interfaces.requirements_json` is stored and read with an inconsistent JSON shape [implementation]

- Location: `packages/mahas-runtime/src/realization/interfaces.ts:378-395` (writer), `:354-356` (realization reader); `packages/mahas-runtime/src/discovery/model-read.ts:537-557` (discovery reader)
- Contract: `spec/domains/role-realization.md` (`RoleInterfaceRequirements`); `packages/mahas-contracts/src/role.ts`; REQ-05.
- Evidence: `storeInterfaceSnapshot` writes `canonicalJson(derived.contextRequirements)` — a bare `DerivedRequirement[]` — into `requirements_json`, not the contract shape `{responsibilityRefs, contextRequirements}`. `responsibilityRefs` survive only inside `judgment_scope_json` (reconstructed at interfaces.ts:362); discovery readers never read that column, silently degrade malformed JSON to `[]` (model-read.ts:554-556), while realization's bare `JSON.parse` throws a raw `SyntaxError` — inconsistent failure modes on the same column.
- Consequence: `responsibility.inspect`'s coordination view can report requirements missing despite an authored interface; the stored value cannot round-trip the contract DTO; different consumers observe different role semantics.
- Requested correction: Establish one canonical persisted shape (or an explicit storage DTO normalized in every reader); persist `responsibilityRefs` + `contextRequirements`; reject malformed JSON rather than silently emptying; compatibility migration for existing rows.
- Target: IMP-07 (discovery consumer changes IMP-06).

### F2. Candidate implementations are advertised as assignable in discovery [implementation]

- Location: `packages/mahas-runtime/src/discovery/implementation-availability.ts:79-83`; consumed unfiltered at `discovery/search.ts:563-565,604`; `discovery/types.ts:131-150`
- Contract: `spec/contracts/discovery-assignment.md` (implementation availability); `spec/domains/role-realization.md` (`candidate | published | retired` lifecycle); REQ-04/05.
- Evidence: `availabilityForRole` filters only `status !== 'retired'` — `candidate` revisions flow into `role.implementations` and every `CandidateCard.implementationAvailability`. `ImplementationAvailability` has **no lifecycle/status field at all** — `support` describes the profile, not the impl — so consumers cannot distinguish candidate from published. `implementationPrepare` (publisher.ts:212) only reports uncovered clauses; publication is the only enforcement of coverage/component/semantic gates.
- Consequence: Discovery advertises non-publication-complete implementations as selectable; nothing in the card marks them unavailable.
- Requested correction: Exclude or explicitly flag `candidate` rows; add a lifecycle/status field to `ImplementationAvailability`; verify role.implementations, search cards, and token issuance consistently.
- Target: IMP-06.

### F3. `team.assign` admits `candidate` implementations — the publication gate is bypassed end-to-end [implementation]

- Location: `packages/mahas-runtime/src/coordination/member.ts:275-282` (`recheckImplementation`)
- Contract: `spec/domains/role-realization.md` (publication lifecycle); `spec/contracts/discovery-assignment.md`; REQ-05.
- Evidence: The status check blocks only `'retired' | 'withdrawn' | 'disabled'` — `'candidate'` passes. Combined with F2, the entire path `implementation.prepare` → `responsibility.search` → `team.assign` works on never-published content: a candidate with uncovered clauses (prepare only reports them; `implementationPublish` at publisher.ts:348-356 is the sole gate) is assignable.
- Consequence: The prepare→publish lifecycle is void — an unverified, structurally incomplete implementation can be pinned to a member and dispatched.
- Requested correction: Require `status === 'published'` in `recheckImplementation` (reject `candidate` explicitly); treat this together with F2 so discovery and assignment agree.
- Target: IMP-13 (with IMP-07 lifecycle contract).

### F4. Profile attestation/admission revision-keying mismatch — no single-admit revision satisfies all consumers; dead vocabulary literals [implementation]

- Location: `packages/mahas-runtime/src/realization/profile-registry.ts:526-559` (attestation@source rev, state minted on rev+1); `discovery/model-read.ts:594-607` (`latestAttestation` exact-revision keyed); `discovery/implementation-availability.ts:86-123`; `coordination/member.ts:304-318`
- Contract: `spec/domains/role-realization.md` §2 (admission state, attestations, immutable revisions); instruction §4.5 (documented ≠ verified).
- Evidence: `harnessProfileAdmit` records the attestation at the **attested source revision** and mints `newRevision` carrying `state = decision`; the source revision's state is never updated (immutable). Consumers then disagree per pinned revision: (a) discovery `support` uses `attestation?.decision ?? profileState` but the `profile-admission` blocker (lines 107-111) checks raw `profileState !== 'verified'` — an impl on the attested rev reports `support='verified'` **and** an admission blocker simultaneously (contradictory); (b) the `host-unverified` check requires `attestation.decision==='verified'` at the pinned rev — impossible on the minted rev, so pinning the revision `admit` returns always fails host-scoped checks; (c) `recheckImplementation` queries `decision='admitted'` and states `'admitted'|'active'` — literals **never written** (vocabulary is `verified|documented|disabled`) — so the attestation branch is dead and only `profState==='verified'` counts, rejecting impls pinned to the genuinely attested revision. In a single-admit flow no revision passes both `team.assign` and host-scoped discovery. `discovery/smoke.ts:216,240` hand-seeds `state='verified'`+attestation at one revision — unreachable via real admit — masking the defect.
- Consequence: Verified profiles cannot be consumed correctly: either assignment is blocked or host-scoped availability always reports `host-unverified`; availability output is internally contradictory.
- Requested correction: Make attestation resolution consistent across consumers — record/copy the attestation onto the minted revision, or resolve "latest attestation for the profile family" rather than exact-revision; unify the decision/state vocabulary (remove `admitted`/`active` literals); make the admission blocker check consistent with `effective` support; add a smoke case through the real `harness.profile.admit` path.
- Target: IMP-07 (writer semantics), IMP-06 + IMP-13 (consumers).

### F5. `plan.prepare` is registered `mutation: false` but writes `plan_candidates` and a domain event [implementation]

- Location: `packages/mahas-runtime/src/coordination/index.ts:68`; `coordination/plan.ts:498-519`; semantics at `api/admission.ts:254,293-307,413-431`
- Contract: `spec/common.md` §3 (operationId idempotency for mutations); `spec/operations.md` (operation classification); D-WORK (prepare→commit with stored candidate).
- Evidence: `memberOp('plan.prepare', false, planPrepare)` registers it as a query, but the handler INSERTs into `plan_candidates` and calls `appendDomainEvent` directly on `txn.db` — bypassing the `emitEvent`/`intendEffect` facade guards that throw for non-mutations (the guard exists but is not a write boundary). It runs under `BEGIN DEFERRED` (write still commits), requires no `operationId`, and stores no `operation_receipts` row.
- Consequence: A retried `plan.prepare` mints duplicate candidates and duplicate `plan.prepared` events — exactly what spec §3 idempotency prevents; registry metadata misrepresents a mutating op as a query.
- Requested correction: Register `mutation: true` (commit reads the stored candidate — persistence is required by design). Recommended hardening: give non-mutation txns a read-restricted `db` facade so direct writes throw instead of relying on facade-method guards.
- Target: IMP-13 (registration); hardening IMP-11.

### F6. `runCreate`'s `coordinatorRoleId` is validated but never persisted or enforced [implementation]

- Location: `packages/mahas-runtime/src/coordination/run.ts:139-178` (NOTE at 175-177 admits the gap); `coordination/member.ts:553-560,615-623`
- Contract: `spec/contracts/work.md` (`run.create` coordinator role scope); D-WORK §2 (single coordination owner).
- Evidence: `coordinatorRoleId` is validated as a model role and recorded only in the `run.created` event payload — `runs` has no `coordinator_role_id` column. `team.assign` installs `coordinator_member_id` for **any** role with `assignmentKind='coordination'`; the declared role is never compared.
- Consequence: A run created for coordinator role X can be coordinated by a member realizing any other role — the declared composition constraint is unenforceable after creation.
- Requested correction: Persist the declared coordinator role (column or decision record) and require `pins.roleId === declaredCoordinatorRoleId` when installing the coordinator member.
- Target: IMP-13 (DDL note to IMP-03).

### F7. `run.close` `resourceDisposition` values are never validated — typos silently no-op [implementation]

- Location: `packages/mahas-runtime/src/coordination/run.ts:69-79` (documented enums), `:372-389` (presence checks), `:395-437` (action branches)
- Contract: `spec/contracts/work.md:45` (`resourceDisposition` input); C-WORK run.close stored-effect rule.
- Evidence: Presence of each key is required when residuals exist, but the *value* is never validated: `executions: 'terminate'` or any typo satisfies the gate, matches no `===` branch, and the run settles while live executions receive **no** stop intent. Sibling op `member.retire` does validate its disposition enums (`member.ts:668-672`) — inconsistent hygiene.
- Consequence: Callers believe residuals were disposed while nothing was staged — a silent no-op at a settlement boundary, worse than rejection.
- Requested correction: Validate each provided value against its documented enum (`keep|revoke`, `keep|request-stop`, `keep|fence`, `keep|release-requested`); `badInput` on unknown values.
- Target: IMP-13/IMP-14.

### F8. `task-output` input bindings resolve across runs with no producer-side constraint [implementation]

- Location: `packages/mahas-runtime/src/coordination/input-resolver.ts:141-182` (`resolveTaskOutput` keys `o.task_id` only); `coordination/task-spec.ts:59-60,143-164` (bindings persisted verbatim)
- Contract: spec D-WORK §4 (input pinning to immutable artifacts); C-WORK task/binding scoping.
- Evidence: A `task-output` binding names an arbitrary `taskId`; resolution joins outcomes→settlements→artifacts without checking that the producer task belongs to the consumer's run, and no spec-write validation constrains it either. The artifact pin itself is exact and immutable (integrity holds), but accepted outputs of tasks in other runs — including runs the caller cannot see — are consumable by naming the task id; `artifacts` is run-scoped in DDL yet `loadArtifact` never checks run.
- Consequence: Cross-run data flow bypasses the visibility model: hidden runs' outputs leak if task ids are known; the run-boundary scoping of task outputs is undefined.
- Requested correction: Either constrain `task-output` bindings to same-run tasks at spec-write and resolve time, or document cross-run consumption as intended and add a visibility/access check on the producer task. Contract clarification may be required.
- Target: IMP-14 (possibly spec-issue if the contract intended cross-run references).

### F9. Eligibility "current dispatch" picks the most-transitioned row, not the latest attempt [implementation]

- Location: `packages/mahas-runtime/src/coordination/eligibility.ts:336`; writers at `coordination/member.ts:1107` (insert `revision=1`), `coordination/dispatch-authority.ts:259,287,340,383` (`revision = revision + 1` per transition)
- Contract: D-WORK §2 (per-task display state from current dispatch/settlement).
- Evidence: Dispatch `revision` is a per-row counter — each attempt inserts at 1 and increments per phase change. `ORDER BY revision DESC LIMIT 1` therefore selects the *most-transitioned* dispatch row, not the latest attempt: a revoked/settled dispatch at revision 8 outranks a fresh active attempt at revision 2, hiding the live dispatch and mis-projecting the task as `unassigned`/`blocked`/`eligible` or stale `accepted`.
- Consequence: The eligibility projection can show a task as undispatched while an active attempt exists, or as settled while re-dispatched — the "no auto-dispatch / explicit disposition" boundary is misreported.
- Requested correction: Order by `rowid DESC` (insertion = attempt order) or prefer `authority_state='active'` rows first. Also pin the `outcomes` revision convention for the unlanded IMP-21 writer — `latestOutcome` (eligibility.ts:68) has the same pattern and `outcomes` PK `(id,revision)` permits new ids at revision 1 per report, which would make ordering arbitrary.
- Target: IMP-14 (outcome convention note to IMP-21).

### F10. Settlement decision vocabulary drift — `'accept'` vs `'accepted'` [implementation]

- Location: `packages/mahas-runtime/src/coordination/eligibility.ts:143,349` vs `coordination/input-resolver.ts:30` (`ACCEPTING_DECISIONS = ['accepted']`)
- Contract: D-WORK/D-MAIL task-state literals (`'accepted'` per input-resolver's own comment).
- Evidence: Eligibility accepts both `'accepted'` and `'accept'` as accepting decisions; the input resolver accepts only `'accepted'`. If the settlement writer ever emits `'accept'`, a task displays `accepted` while downstream pins still fail `INPUT_NOT_READY`.
- Consequence: Display state and dispatch readiness diverge on the same fact.
- Requested correction: Single source of truth for the decision vocabulary constant shared by eligibility, input-resolver, and the IMP-21 settlement writer.
- Target: IMP-14 (constant alignment with IMP-21).

### F11. Runtime `ModelEdit` wire shape diverges from contract `ModelChangeEdit` [implementation]

- Location: `packages/mahas-runtime/src/model/change-set.ts:35-160+` vs `packages/mahas-contracts/src/rdd.ts:190-280`
- Contract: `spec/domains/rdd.md` §3 (typed edits); contract type `ModelChangeEdit`.
- Evidence: The shapes differ structurally, not cosmetically: contract is flat (`boundary.create {boundaryId, name, responsibilityStatement, parentBoundaryId}`); runtime nests payloads (`{boundary: {…responsibility, parentId}}`). Field names differ (`responsibility` vs `responsibilityStatement`, `parentId` vs `parentBoundaryId`). Patch semantics differ (contract `boundary.revise.paths`/`contract.revise.consumerBoundaryIds` are full-set; runtime uses `setPaths|addPaths|removePaths`, `addConsumerBoundaryIds|removeConsumerBoundaryIds`). Runtime adds capabilities the contract lacks (`boundary.retire.remap`, `nonGoalRemap`/`contextRemap`/`contractConsumerRemap` on split) and the contract has none of the runtime's `contextIds`/`criteria` on create. The runtime comment calls it a "proposal for IMP-02's ModelChangeEdit."
- Consequence: The boundary-crossing wire shape for `model.change.prepare` is not the contract's — a conformant contract client cannot drive the runtime, and persisted edit JSON follows the runtime dialect. Either the contract is stale or the implementation diverged; must be reconciled one direction.
- Requested correction: Align the wire shape and field names to `ModelChangeEdit` (or amend the contract deliberately and version it); map add/remove delta semantics vs full-set explicitly; keep remap fields consistent across contract and runtime.
- Target: IMP-04 (with IMP-02 contract ownership).

### F12. TaskSpec persisted JSON: verbatim unvalidated bindings + non-canonical serialization [implementation]

- Location: `packages/mahas-runtime/src/coordination/task-spec.ts:59-60,143-164`; contrast `coordination/plan.ts` (`canonicalJson`)
- Contract: `spec/storage.md` §3 (persisted JSON DTOs); D-WORK TaskSpec immutability.
- Evidence: `inputBindings`/`outputSlots`/`settlementPolicy` are persisted verbatim as `unknown`/`unknown[]` via raw `JSON.stringify` — no structural validation (F16 instance), and non-canonical key ordering unlike `plan.ts`'s `canonicalJson`. If any digest/equality ever spans spec JSON, serialization is not reproducible.
- Consequence: Malformed bindings land durably and fail later at resolve/dispatch; normalization is inconsistent across coordination writers.
- Requested correction: Validate binding/slot/policy DTOs before insert; persist via `canonicalJson` uniformly.
- Target: IMP-14.

### F13. Source readers treat stored paths as authority — no root containment enforcement [implementation]

- Location: `packages/mahas-runtime/src/realization/source-snapshots.ts` (`makeFilesystemReader`), `realization/compiler.ts`, `realization/materializer.ts`
- Contract: `spec/domains/rdd.md` (contexts store paths not bodies); `spec/domains/role-realization.md`; REQ-22.
- Evidence: Lexical path validation is strong (absolute/NUL/backslash/`..` rejected) and pins are digest-verified — but `makeFilesystemReader(root)` does `readFileSync(resolvePath(root, rel))` with no `realpath`/symlink containment check. A symlink inside the repository resolves outside the authorized root; a stored path is treated as sufficient authority to read the file.
- Consequence: A malicious or malformed context path can capture unrelated files into reusable bundles delivered to implementations.
- Requested correction: Root-aware, normalized, authorization-checked reader: `realpath` containment check rejecting symlink/traversal escapes, bound to the context/model/project; record exact digest/path observations.
- Target: IMP-07/IMP-04.

### F14. `probeInstallation` executes inside the write transaction [implementation]

- Location: `packages/mahas-runtime/src/realization/profile-registry.ts:355-397`
- Contract: Admission/effect model (effects staged as intents, not run inside the control-plane tx); single-writer mahasd design.
- Evidence: `await deps.probeInstallation(...)` runs inside `BEGIN IMMEDIATE` — the writer lock is held across host I/O for the probe duration. Deliberate ("diagnostic ran inline"), and honesty is preserved (observation + confirmed intent recorded), but it stalls every other writer.
- Consequence: A slow/hung host probe blocks all writes system-wide.
- Requested correction: Run the probe before the write tx (or as a staged effect executed by the outbox) and persist the observation/intent inside the tx.
- Target: IMP-07 (with IMP-11 transaction ownership).

### F15. `attestationMentionsHost` uses substring matching; empty `hostId` vacuously passes [implementation]

- Location: `packages/mahas-runtime/src/discovery/implementation-availability.ts:55-66`; `validateImplementationsRequest` at `:163-181`
- Contract: `spec/contracts/discovery-assignment.md` (host-scoped availability); provisional per code comment.
- Evidence: `installation_json.includes(hostId)` is a substring check over serialized JSON — `h1` matches `h10` and any unrelated string containing the id; `hostId: ''` passes request validation and `''.includes` is vacuously true, so an empty hostId satisfies the host check for any verified attestation.
- Consequence: Host-scoped availability can report verified where no host binding exists.
- Requested correction: Structured `hostId` field in the attestation's installation DTO with equality check; reject empty `hostId` at request validation; align with IMP-07's attestation shape when landed.
- Target: IMP-06 (attestation shape IMP-07).

### F16. Broad `unknown`/index signatures on persisted domain shapes without runtime validators [implementation]

- Location: `packages/mahas-contracts/src/role.ts` (requirement/binding DTOs), `packages/mahas-contracts/src/work.ts`; instances: `coordination/task-spec.ts:160-162`, `coordination/work-envelope.ts` (generic JSON→typed casts), `realization/profile-registry.ts:96-98,109` (bare `JSON.parse … as`), `discovery/model-read.ts:44-53`
- Contract: `spec/storage.md` §3 (JSON DTOs); REQ-02/03/17; domain JSON shape requirements.
- Evidence: Persisted fields typed `JsonObject`/`unknown`/`[k:string]:unknown` while DDL checks only `json_valid`; TypeScript types don't validate RPC input or legacy/external rows. Concrete instances: task-spec bindings verbatim (F12), profile recipe/capabilities/identity parsed with bare casts, work-envelope bodies reconstructed by casts. Some readers degrade malformed JSON silently (`[]`) while others throw raw `SyntaxError`.
- Consequence: Semantically malformed JSON is accepted as durable control state and fails later at launch/eligibility/publication/discovery with no diagnosis at the write boundary.
- Requested correction: Runtime codecs/validators for every persisted JSON DTO; validate before insertion and after loading external/legacy rows; include shape validation in publication/CAS; keep `unknown` only at untrusted ingress.
- Target: IMP-02/IMP-03/IMP-14.

## Limitations

- **Static review only** — no runtime execution, crash injection, migration test, SQLite concurrency test, filesystem-fault test, or harness compatibility test performed.
- **Unverified dependencies:** `runVisible` relies on IMP-10 `decide` resolving run→project/model ancestry internally (IMP-10 internals not reviewed); `latestOutcome` ordering correctness depends on the unlanded IMP-21 outcome writer's revision convention (F9); `assignment.show` is intentionally unimplemented pending IMP-20's projection.
- **Partial file coverage:** some large files were inspected via targeted ranges (`model/publisher.ts`, `model/structural-rules.ts`, `coordination/plan.ts`, `discovery/search.ts`, `coordination/collaborators.ts`); all cited findings were re-verified at their exact locations.
- **Test data caveat:** smoke fixtures hand-seed states the real writers cannot produce (F4) and omit candidate-status rows (F2/F3); they do not exercise the real admit→pin or prepare→assign flows.
