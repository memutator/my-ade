# ReviewRecord — REV-04

- reviewTaskId: REV-04
- codeRevision: 83a6d21204ab6f164f2ff519a12ba6043188be14
- specRevision: 99eb5f5
- scope: Independent semantic review of IMP-13/14/15/20/21/31 — Run/Plan/Member/Dispatch lifetimes (`coordination/*`), durable mailbox and artifact APIs (`mail/*`, `artifacts/*`), worker join/accept (`launch/*`), admission/registry transaction boundaries (`api/*`), and the workbench wire layer (`src/renderer/src/workbench/*`), against REQ-01/17/18/19/20, D-WORK, D-MAIL, C-WORK, C-MAIL.
- disposition: changes-required

Verified aligned (no findings): Run is not a scheduler — `run.create`/`run.get`/`run.close` perform no dispatch or process effects; `run.close` records an explicit coordinator-attributed `RunDecision` (not an AND of child success) and emits only `effect_intents` for stops/claim releases (run.ts:391-437, 488-506). Plan revisions are immutable with CAS, cycle checks, and required active-attempt dispositions (plan.ts). `task.accept` enforces execution-bound credentials, exact taskRevision/envelopeDigest pins, join ordering, current grant re-read, and atomic phase+delivery-ack (acceptance.ts:101-244). `message.replyAndAck` enqueues the reply and acks the original in one transaction (message-service.ts:322-357). Generation fencing + lazy rebind of outstanding deliveries matches D-MAIL §2 (shared.ts:192-221). Peer-to-peer `message.send` needs no team-lead relay. Plan edges are execution-order only and both sides of an initial negotiation can be assigned independently — no circular-wait design (PlanView.tsx:9-12, TeamView.tsx:5-7). Artifact publish/read pin exact digests and never trust live paths. `reserveDispatch`/`buildTaskEnvelope` enforce exact revision, assignee, and assignment-coverage invariants.

## Findings

**1. [implementation] IMP-21's outcome/settlement/wake surface is absent — the entire "result → acceptance → downstream eligibility" pipeline is dead**

- Location: `packages/mahas-runtime/src/coordination/index.ts:56-86` (registers only run.*/plan.*/team.*/assignment.*/task.dispatch); `packages/mahas-runtime/src/api/registry.ts:126-127,144` (OPERATION_TABLE lists `task.report`, `outcome.decide`, `execution.wake` as IMP-21-owned); `packages/mahas-runtime/src/coordination/member.ts:174-184` (grants these actions to members).
- Contract: C-WORK `task.report`/`outcome.decide` (spec/contracts/work.md:139-165); D-MAIL §4-5; REQ-20; IMP-21 instruction §4, §6 (expects `coordination/{outcome,settlement,handoff}.ts` and `mail/{wake-service,continuation}.ts`).
- Evidence: none of those files exist (`coordination/{outcome,settlement,handoff}.ts`, `mail/{wake-service,continuation}.ts` → none). `INSERT INTO outcomes|settlements|outcome_outputs|wake_requests` appears only in a smoke fixture (`maintenance/smoke.ts:500`). The ops are not registered at all → `UNAVAILABLE_OPERATION` (admission.ts:173-185). `settleDispatch` exists (dispatch-authority.ts:365-394) but is reachable only via the internal `dispatch.settle` service op — nothing can move a dispatch to `reported`/`settled`. `assignment.show` is a registered stub that only throws UNAVAILABLE (index.ts:76-84).
- Consequence: members hold granted actions (`task.report`, `outcome.decide`, `execution.wake`) that always fail; no Outcome can ever be recorded → no Settlement → dispatch phase `reported`/`settled` unreachable → eligibility states `reported`/`accepted` unreachable → every `task-output` input stays `INPUT_NOT_READY` forever → DAG successors can never be dispatched. Owner-declaration settlement, designated acceptance, handoff events, and wake orthogonality (review directives 3 and 5) cannot be verified because the code does not exist.
- Requested correction: implement IMP-21's declared surface — Outcome write pinned to `(taskId, taskRevision, dispatchId)` of the active attempt via `checkAttemptAuthority`; owner-declaration self-settlement vs designated-acceptance `outcome.decide` on the exact outcome revision; artifact-bound handoff events; `execution.wake` gated on ContinuationGrant/recipe/budget with no message mutation on failure. Until registered, remove the ops from member grant vocabulary or document them as pending.
- Target: IMP-21.

**2. [implementation] `inbox.wait` executes inside a transaction — blind poll plus single-writer starvation**

- Location: `packages/mahas-runtime/src/mail/wait.ts:15-19,55-62`; `mail/index.ts:26-27` (`mutation:false`); `api/admission.ts:254` (`runInTransaction(deps.db, entry.spec.mutation ? 'IMMEDIATE' : 'DEFERRED', …)` wraps **every** op); `mail/inbox.ts:122-132` (`openMailbox` → `rebindOutstandingDeliveries` UPDATE).
- Contract: REQ-19 and D-MAIL §5 — bounded `inbox.wait` must observe the deliveries ledger and return honest empty on timeout; C-MAIL.
- Evidence: the handler's own contract (wait.ts:15-19) requires running *outside* any wrapping transaction, but admission wraps `mutation:false` ops in `BEGIN DEFERRED`. `openMailbox`/`rebindOutstandingDeliveries` (wait.ts:55,61) issues an UPDATE inside that tx, upgrading it to a write transaction held for the whole poll (up to `maxWaitMs`, default 60s). Read snapshot pins at first SELECT, so deliveries committed mid-wait are invisible; concurrently, any other dispatch on the shared `deps.db` hits `BEGIN` inside an open tx → non-MahasError propagates (admission.ts:116, 262-267) rather than a rejected receipt.
- Consequence: the bounded wait can only ever return deliveries that were already outstanding at entry (blind to new mail), and while waiting it either holds the single-writer lock — starving the very `message.send`/`task.dispatch` writers it waits for — or crashes concurrent ops with an infrastructure fault. REQ-19's explicit-wait mechanism is functionally broken.
- Requested correction: admission needs a genuine no-transaction/autocommit dispatch mode for long-poll reads (e.g. an OperationSpec flag honored at admission.ts:254), or `inbox.wait` must take a dedicated connection outside the registry tx; the UPDATE rebind must move out of the poll loop's transaction.
- Target: IMP-15 (with IMP-11 admission support).

**3. [implementation] Workbench sends `expectedRevisions` no coordination op can resolve, while stripping the payload field the handlers read — `plan.commit`/`team.assign` can never succeed from the UI**

- Location: `src/renderer/src/workbench/ops.ts:110-117` (`assignTeam` strips `expectedPlanRevision` → `expectedRevisions: {plan: N}`), `ops.ts:133-139` (`commitPlan` always sends `expectedRevisions: {plan: N}`); backend: `coordination/member.ts:461,480-488`, `coordination/plan.ts:533,566-573`; `api/admission.ts:343-364`; `coordination/index.ts:60-85`.
- Contract: C-WORK `plan.commit`/`team.assign` — `expectedPlanRevision` is a declared *payload* input (spec/contracts/work.md:73,87); spec/common.md §3 expectedRevisions semantics.
- Evidence: `memberOp`/`operatorOp` register `{name, visibility, mutation}` only — no `resolveRevisions` (contrast launch ops, join.ts:490-491,533-534). `checkExpectedRevisions` then computes `actuals = {}` and throws STALE_REVISION for any expectedRevisions key (admission.ts:352-361). Simultaneously the handlers read `expectedPlanRevision` from the payload the UI removed → `?? 0` → STALE_REVISION whenever `currentPlanRevision ≥ 1`.
- Consequence: `plan.commit` always fails from the workbench (envelope rejects before the handler). `team.assign` fails whenever a plan exists — empty field → `expected 0 vs current ≥1`; filled field (the "From run" button auto-fills, TeamView.tsx:143-151) → envelope STALE_REVISION. The two central IMP-31 mutations are dead.
- Requested correction: send `expectedPlanRevision` in the op payload per the contract (and stop emitting unresolvable `expectedRevisions.plan`), or add `resolveRevisions` to the coordination op specs so the envelope mechanism works. One side must own the contract.
- Target: IMP-31 (primary; IMP-13 if resolved via op-spec resolvers).

**4. [implementation] Workbench PlanPatch field drift: `disposition` vs `action` (+unexpressible `replace`), and `inputBindings`/`outputSlots` silently dropped**

- Location: `src/renderer/src/workbench/PlanView.tsx:71-78,88-90`; `contracts.ts:303-312,327-331`; backend `coordination/plan.ts:76-82,178-211`.
- Contract: C-WORK Plan 문법 (`activeAttemptDisposition`, TaskSpecRevision fields) — REQ-17.
- Evidence: (a) UI emits `{taskId, disposition: 'keep'|'stop'}` for every non-retired existing task; backend `validatePatch` requires `action ∈ {'keep','revoke','replace'}` via `reqStr(o,'action')` → `MODEL_INVALID` on every prepare containing an existing task, and `stop`/`replace` have no correct mapping. (b) UI emits `inputBindings`/`outputSlots` (D-WORK names); backend reads `o.inputs`/`o.outputs` (plan.ts:186-187) → fields are `undefined` → new tasks get empty inputs/outputs and edits to existing tasks' bindings are silently ignored (prior carried forward at plan.ts:353-354).
- Consequence: prepare fails loudly on dispositions and fails *silently* on I/O bindings — authored input pins and output slots vanish from committed TaskSpecs, weakening `INPUT_NOT_READY` gating and output contracts with no error surfaced.
- Requested correction: align the workbench contract types to the backend field names (`action`, `inputs`, `outputs`, vocabulary `keep|revoke|replace`) or add explicit translation; surface silent-drop fields as errors.
- Target: IMP-31.

**5. [implementation] `task.dispatch` reimplements dispatch creation and bypasses canonical invariants**

- Location: `packages/mahas-runtime/src/coordination/member.ts:856-867,952-1018,1024-1117`; compare `dispatch-authority.ts:104-137`, `work-envelope.ts:150-176,205-237`, `input-resolver.ts:150-163`.
- Contract: C-WORK `task.dispatch` (전제·인가: exact revision, 선행 output/artifact 재확인, WorkEnvelope carrying the attempt's report conditions); D-WORK §3-4; D-MAIL §3.
- Evidence: (a) checks `ownerRoleId` but never `spec.assignedMemberId` — `reserveDispatch` enforces the assignee pin (dispatch-authority.ts:128-137), so a member-pinned TaskSpec can be dispatched to a different member of the same role; (b) binds the member's *latest* assignment `ORDER BY revision DESC LIMIT 1` (member.ts:952-958) with no `kind='task'` or `taskId/taskRevision` coverage check — `buildTaskEnvelope` hard-fails on exactly that (work-envelope.ts:150-176), so the envelope can carry a stale/other-task mandate; (c) resolves inputs via `resolveInputBindings` (eligibility.ts:210-234), which accepts *any* latest outcome's artifact — no accepting settlement required — while the canonical `pinInputs`/`resolveTaskOutput` demands `s.decision IN ('accepted')` (input-resolver.ts:150-163); a rejected/pending outcome's artifact thus satisfies a required input; (d) verifies only the `plan_tasks` pin, not `tasks.current_revision` (reserveDispatch:111 does) — a spec revised outside plan.commit leaves the plan pinning a stale revision that gets dispatched; (e) the hand-rolled envelope (member.ts:1024-1034) omits `scope`, `peers`, and `reportContract` (outputs+settlementPolicy) that `buildTaskEnvelope` includes — the accepted work lacks its declared report conditions.
- Consequence: dispatch-time guarantees differ by path — the IMP-21 path is strictly weaker than the IMP-14 path it was supposed to compose; unaccepted predecessor output can unblock downstream work, and member-pinned specs can be routed to the wrong member.
- Requested correction: implement `task.dispatch` over `createDispatch`/`buildTaskEnvelope`/`reserveDispatch` (creating or requiring a covering task assignment), or port every listed invariant check; use `pinInputs` for input resolution.
- Target: IMP-21.

**6. [implementation] Outcome consumption is revision-blind and plan-edge settlement requirements have no dispatch-time enforcement**

- Location: `packages/mahas-runtime/src/coordination/eligibility.ts:65-72` (`latestOutcome` orders by outcome revision, no `task_revision` filter), `121-149` (`edgeSettlementSatisfied`), `210-234` (`task-output` binding), `334-352,362-370`; `member.ts:968-975`.
- Contract: D-MAIL §4 — "TaskSpec이 이미 바뀌었다면 이전 결과를 새 요구사항의 성공으로 옮기지 않는다"; D-WORK §4 — edge `settlementRequirement` must hold before successor dispatch; C-WORK `task.dispatch` 전제 (선행 output/artifact 재확인).
- Evidence: after a TaskSpec revision bump, the old outcome (pinned to the old `task_revision`) still satisfies `edgeSettlementSatisfied`, `requiredOutputs`, and `task-output` bindings — directly adopting a previous result as the new requirement's success. Separately, `taskDispatch` consults only `spec.inputs`; `task_edges.settlementRequirement`/`requiredOutputNames` are projection-only (computeEligibility) and are never evaluated at dispatch, so a task with no declared inputBindings can be dispatched while its plan edges demand an accepted predecessor.
- Consequence: stale outcomes under superseded requirements can mark successors accepted/unblocked, and the DAG's settlement semantics are advisory rather than enforced — the exact lifetime confusion REV-04 is charged to catch (currently latent because Finding 1 means no outcomes exist yet).
- Requested correction: qualify outcome lookups by the outcome's `task_revision` against the requirement being satisfied (or reject when the spec moved); evaluate inbound `task_edges` requirements in the dispatch path.
- Target: IMP-13 (eligibility projection) with IMP-21 (dispatch gate) — fix before outcomes exist to be consumed.

**7. [implementation] Coordination ops register no `resolveTargets`/`resolveRevisions` — admission's actual-target authorization and expectedRevisions are vacuous for the whole boundary**

- Location: `packages/mahas-runtime/src/coordination/index.ts:60-85`; `api/admission.ts:368-376,206-207,287-289,313-315`.
- Contract: spec/common.md §3 / D-ACCESS §2-4 — admission authorizes resolved ACTUAL targets, pre- and post-handler; expectedRevisions compare.
- Evidence: every run.*/plan.*/team.*/task.dispatch registration supplies only `{name, visibility, mutation}`; `resolveTargets` returns `[]` so both admission authorize calls and the pre-commit re-check run on empty targets, and `resolveRevisions` is absent (root cause of Finding 3). Handlers do call `authorize` with real targets in-tx, so this is a defense-in-depth gap rather than an open hole.
- Consequence: the pipeline's independent target verification does not apply to the coordination boundary; `expectedRevisions` is unusable for these ops.
- Requested correction: add `resolveTargets`/`resolveRevisions` to the coordination op specs (mapping `run`/`plan`/`task`/`member`/`dispatch` ids to stored rows and revisions).
- Target: IMP-13.

## Limitations

- Static review only — no build, test, smoke, or runtime execution was performed; findings 2 and 3 are stated as code-evidence-plus-reasoning (SQLite transaction semantics and the admission code path), not observed failures.
- Finding 1 means the IMP-21 semantics this review was asked to verify (revision-pinned accepted outcomes, owner vs designated settlement, handoff, wake orthogonality) are largely *unverifiable by inspection* — they are absent rather than misimplemented; disposition reflects that.
- The artifact publisher/reader, worker.start envelope path, host/resource boundaries, and CLI transports were reviewed at the level needed to trace the scoped call chains, not exhaustively.
- `assignment.show` is an honest UNAVAILABLE stub (index.ts:76-84); noted as incomplete-but-honest rather than a violation.
- The workbench contract drift findings assume the backend vocabulary (`action`, `inputs`, `outputs`, payload `expectedPlanRevision`) is the intended wire contract, consistent with C-WORK; if the spec intends the D-WORK display names instead, the backend validator is the side that should move — either way the two sides must be reconciled.
