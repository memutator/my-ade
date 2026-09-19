---
taskId: VER-04
codeRevision: 83a6d21
specRevision: 99eb5f5
verdict: failed
evidence: VER-04
---

# VER-04 — META DAG·직접 통신·결과 revision 검사 (META DAG · direct member messaging · outcome revision)

VerificationRecord for the work, mail/artifact, and messaging-outcomes
contracts. Prerequisites VER-02 (`92d77c`, verdict failed) and VER-03
(`83a6d21`, verdict failed) are recorded; this run was executed against a
clean detached copy of `83a6d21` (`83a6d21204ab6f164f2ff519a12ba6043188be14`)
in `/tmp/mahas-ver-04/` — the main worktree's unrelated WIP was never
touched and the pinned implementation was not modified.

## environment

| 항목 | 값 |
|---|---|
| code revision | `83a6d21` (coordinator handoff, all 32 IMPs landed) |
| spec revision | `99eb5f5` |
| runtime | node v24.20.0, `node:sqlite` (SQLite 3.53.4) |
| OS | Linux 7.0.0-31-generic x86_64 |
| world A | reused live VER-03 `mahasd` daemon (pid 467291), `/tmp/mahas-ver-03/config/` (`mahasd.sock`, `mahas.sqlite`) — raw unix-socket RPC target |
| world B | in-process wired runtime, `/tmp/mahas-ver-04/inproc/` (`config/`, `db/mahas.sqlite`, `execution-host.sock`) — dispatch-level probes; dedicated execution host attached (`host-pyosechang-MS-7D76`, lease epoch 3+) |
| fixture | `/tmp/mahas-ver-04/state.json` + `probe/fixture.ts` — project+mv1+run, 11 members (lead + 10 task members over r-lead/r-auth/r-web/r-doc), provisioning grants provAll/provLeadOnly/provMember, plan rev1 (canonical bindings: consult-a/b → impl-a/b → join), rev2 (identity bindings + probe tasks t-impl-c/t-own/t-des), rev3/4 (t-impl-c binding-shape flips), seeded executions/joins/checkouts |

Fixture provenance note: member assignment grants, plan revisions, team
assignments are all **real op commits**. Executions/worker-joins/checkouts/
resource-claims and outcome/settlement rows are **seeded** — the producing
paths (`worker.prepare`/`worker.start`, `task.report`, `outcome.decide`,
`dispatch.settle`) are unreachable at `83a6d21` (see blocked section). Every
seeded row carries a `VER-04 seeded …` rationale string in the row itself;
no seeded row is passed off as operation output.

## probe inventory

| artifact | checks | result |
|---|---|---|
| `out/s0-fixture.json` | 13 | **all pass** — plan.commit creates zero Dispatch/Message rows; member-driven `team.assign` for all 10 task members; rev2 pins impl@2/consult@1 correctly |
| `out/s1-dag.json` | 43 | 33 verified-correct, **6 defect-observed** (rejected/unaccepted output consumed, canonical binding unreadable, provenance bypass, taskIds narrowing dead), 4 unavailable-observed (`task.report`/`outcome.decide`) |
| `out/s2-mail.json` | 16 | **all pass** — direct member↔member mail, read≠ack, atomic replyAndAck, opId replay/conflict, generation fencing |
| `out/s3-transport.json` | 7 | 6 verified-correct — disconnect-before/after-commit receipt durability over the real socket; 1 unavailable-observed (member op unreachable over wire — F-001/F-023 family) |

Raw probe sources: `/tmp/mahas-ver-04/probe/{common,fixture,s0..s3}.ts`.
No secrets in evidence; credentials used were fixture-generated tokens.

### evidence digests (sha256, `/tmp/mahas-ver-04/out/`)

```
2c75062587922b978143053f889800965ca12c680ab63cf4df5476ac11f9fa04  s0-fixture.json
3d726561b3eaeea8516b913e74c0d0f5b8c898c31931cbf9b2459d98467c1f54  s1-dag.json
9f8fd501452a7588fb08a864f979d26ef17d4566bb055838eaf2adba2af84aa4  s2-mail.json
3446c47a9e6ff3cae6e915f4f1e83e519fae5ac55f9aa965995826a67a39e5f4  s3-transport.json
```

## findings confirmed at this revision

### defects — dispatch-path input resolution

**F-029 (new, 치명급) — task-output binding resolution ignores the settlement
decision; rejected and unaccepted outputs are consumable.** `task.dispatch`
resolves `spec.inputs` through `resolveInputBindings`
(`coordination/member.ts:970` → `coordination/eligibility.ts:223-234`), which
takes `latestOutcome(task)` — highest revision, no `settlements` lookup — and
pins its `outcome_outputs` row verbatim. `settlementDecision` is consulted
only on the *edge* path (`edgeSettlementSatisfied`), never on the *binding*
path. Demonstrated twice with durable envelope pins:

- `t-impl-c@3` committed with `spec` pinned to `art_5d40ea53` — the catalog of
  a producer outcome whose settlement is `decision=rejected` (s1 #26).
- `t-join` committed with `implB` pinned to `art_c2047abd` — the output of
  `t-impl-b`'s outcome **rev2, which carries no settlement at all** — while
  the same projection simultaneously reported the edge `blocked:
  predecessor t-impl-b outcome not accepted (decision=none)` (s1 #27/#30).
  The projection's own `resolvedInputs` already names that unaccepted
  artifact — the module contradicts itself (s1 #28).

The strict path behaves correctly: `resolveInputs`/`pinInputs`
(`input-resolver.ts`) resolves the identical canonical binding to the
**accepted rev1** artifact only (s1 #29). Two resolvers, two answers; the
public mutation boundary uses the lax one. §4.4's "old decision must not
carry to a new outcome" holds in the projection but is voided at dispatch —
an unaccepted or explicitly rejected output flows into downstream work.
Owner: IMP-14 (dispatch/binding resolution) + IMP-21 (outcome semantics).

**F-030 (new) — the canonical InputBinding shape (spec 정본) can never
dispatch.** The contract's `InputBinding` puts `taskId`/`taskRevision`/
`outputSlot` (and `artifactId`/`artifactRevision`, `contractId`) at top
level; `identity.{taskId,outputSlot,artifactId}` is listed as a
server-translated *alias* (`spec/contracts/work.md`). `resolveInputBindings`
reads only `b.identity.*` (`eligibility.ts:173, 211-213, 237`) — the
canonical top-level fields are invisible to it. A TaskSpec committed with
the documented canonical binding → `INPUT_NOT_READY` ('task-output binding
missing taskId/outputSlot identity') forever: `plan.prepare` already reports
it as `unresolvedInputs` (informational, s0 evidence), `plan.commit` accepts
it, dispatch hard-fails (s1 #22-23, t-impl-c@2 under plan rev3). The same
spec flipped to `identity.*` commits (s1 #25-26). `pinInputs` reads
canonical correctly, so the strict path and the dispatch path also disagree
on which shape is legal. Owner: IMP-14/IMP-20.

**F-031 (new) — caller-supplied `inputBindings` pins bypass declared
provenance (and run scope).** `member.ts:978-1005`: a caller pin
`{slot, artifactId, artifactRevision, digest}` is validated for artifact
existence + digest match, then **overwrites** the resolved pin for that
slot. It never verifies the artifact is the declared producer task's
output — `t-impl-b`'s `spec` slot (declared `task-output t-consult-b.catalog`)
was pinned to `t-consult-a`'s catalog artifact and committed (s1 #21;
envelope records `kind:'artifact'`). The lookup (`member.ts:981-986`) also
lacks the `run_id` filter the eligibility path applies
(`eligibility.ts:184-189`) — a cross-run artifact pin is reachable
(analytical; same-run wrong-producer demonstrated). Digest forgery itself is
correctly refused (`ARTIFACT_MISMATCH`, s1 #20). Owner: IMP-14.

### defect — assignment narrowing

**F-032 (new) — assignment `taskIds` narrowing is never enforced at
`task.dispatch`.** `member.ts:952-956` fetches the member's latest
assignment `WHERE member_id=? ORDER BY revision DESC LIMIT 1` — no
`asg.taskId === input.taskId` comparison, no `grant.scope.taskIds`
membership check. `m-spare-doc` (r-doc, assignment names **only** t-impl-b)
was dispatched `t-consult-b` → committed (s1 #40; durable second dispatch
`dsp_06a0d7cd` awaiting_accept). The role fence itself works — an r-auth
task to the same r-doc member → `INVALID_TRANSITION` (s1 #41). Same
"recorded narrowing is dead" family as F-010/F-021, distinct enforcement
point. Owner: IMP-13/IMP-14.

### known findings reconfirmed (context, not re-numbered)

- **F-001/F-023 family**: member-scoped ops are unreachable over the live
  socket — `inbox.check` under a member-shaped credential →
  `UNAVAILABLE_OPERATION` (s3 #2); the worker-auth endpoint is never bound.
  This is what forces §4.2's wire-level member-disconnect onto an operator
  mutation (below) and all member probes into world B.
- **IMP-21 ops granted-but-absent** (client-probe.md already noted
  `task.report`): `task.report` and `outcome.decide` are in the operation
  table (`api/registry.ts:126-127`, owner IMP-21) with no handler registered
  in `composition.ts` → `UNAVAILABLE_OPERATION` on every call (s1 #7/#15/
  #32/#36). `execution.wake` (`registry.ts:144`) is the same class.

## verified-correct behavior

- **DAG is a plan, not a dispatcher**: `plan.commit` rev1 created zero
  Dispatch/Message/Delivery rows; every task stayed `unassigned` until an
  explicit member-driven `team.assign`; final count = exactly the 10
  explicit `task.dispatch` calls (s0 #5-6, s1 #42).
- **Exact immutable revisions end-to-end**: catalogs published as
  `ArtifactRef{id,revision:1,digest}`; `t-impl-a`'s envelope pins
  `art_1b21f307@1` with full digest — never "latest" (s1 #6/#14/#19).
  Plan CAS via `expectedPlanRevision` honored; task revisions are per-task
  (impl@2 carried, consult@1, new tasks @1).
- **§4.1 consultation→implementation resolution**: identity-bound
  task-output inputs resolve the producer's exact accepted catalog artifact
  into the WorkEnvelope (s1 #16/#18-19); pending producers block eligibility
  without creating work (s1 #17).
- **Dispatch is an offer**: `accepted=false`, assignment delivery
  `outstanding`, message+delivery+dispatch written atomically (s1 #1-2,
  #9-10); `task.accept` under an execution-bound ctx acks the assignment
  delivery in the same transaction, phase→running (s1 #4-5, #12-13).
- **§4.2 receipt idempotency at both layers**: `replyAndAck` inserts the
  reply and acks the original delivery in one transaction (s2 #4-5); same
  operationId+payload replays the stored receipt with no new rows; same
  operationId+different payload → `OPERATION_CONFLICT` (s2 #6-8). Over the
  real socket: disconnect before the response → reissue replays the durable
  `operation_receipts` row; disconnect after commit → identical
  fingerprint+result replay, exactly one mutation applied (s3 #3-7).
  Business-rejection receipts are honestly never persisted
  (`admission.ts:255-259`) — a retry re-executes.
- **§4.3 durable inbox + consumer fencing**: `inbox.check` returns the
  delivery yet leaves it `outstanding`, revision unchanged — read ≠ ack
  (s2 #2-3). After generation rotation: stale-generation ctx →
  `STALE_EXECUTION` with the row untouched; current-generation check rebinds
  the delivery and acks it; stale ack on the rebound row still fenced;
  foreign-member ack → `SCOPE_DENIED`, no side effects (s2 #9-15).
- **§4.4 projection semantics**: approving the old outcome revision does
  NOT auto-accept the newly produced rev2 — edge blocks with
  `decision=none` (s1 #27). (The dispatch path contradicts this — F-029 —
  but the projection answer itself is correct.)
- **§4.5 settlement policies + post-task messaging**: owner-declaration
  projects `accepted`; designated-acceptance holds `reported` until the
  acceptor's decision flips it to `accepted` — verified on seeded rows since
  the producing ops are unavailable (blocked below). Member→member question
  about an already-settled task delivered without lead relay; the member
  reply (`replyAndAck`) committed — messaging outlives the task (s1 #31-39).
- **Direct member↔member collaboration**: `message.send`/`replyAndAck`
  between two non-lead members committed with deliveries routed peer-to-peer
  (s1 #38-39, s2 #0-5) — no lead relay anywhere in the flow.
- **Role fencing**: cross-role dispatch → `INVALID_TRANSITION` (s1 #41);
  `artifact.publish` requires the caller's active dispatch + held checkout
  claim (committed for all producer members).

## blocked / not-run (honest)

| item | status | reason |
|---|---|---|
| `task.report` (owner-declaration single-tx report+settlement) | blocked | declared in op table (`registry.ts:126`, IMP-21) but no handler — `UNAVAILABLE_OPERATION` (s1 #7/#15/#32). Outcome rows seeded with `VER-04 seeded` rationale for downstream projection checks only |
| `outcome.decide` (designated-acceptance decision) | blocked | same class (`registry.ts:127`) — `UNAVAILABLE_OPERATION` (s1 #36). Settlement rows seeded; projection flip verified on seeded state, not via op |
| `dispatch.settle` / `execution.wake` | blocked/not-run | service-visibility only / IMP-21-owned unregistered — `authority_state='settled'` transitions seeded via UPDATE |
| `replyAndAck` across a real socket disconnect | blocked | member-scoped ops unreachable over the wire (F-001/F-023) — mechanism verified in-process (s2) and transport-level on a committable operator mutation (s3), which shares the identical admission receipt path (`admission.ts:215-243`) |
| `worker.prepare`/`worker.start` real execution pipeline | blocked | worker endpoint never bound (F-023); executions/joins/checkouts/claims seeded |
| DAG cycle rejection (AC-17 "cycle은 거부") | not-run | no cyclic plan patch was submitted; message round-trips verified as non-cyclic (members messaged freely inside a DAG run) |
| cross-run artifact pin via caller `inputBindings` | not-run (analytical) | implied by the missing `run_id` filter in F-031; only same-run wrong-producer demonstrated |
| `inbox.wait`/continuation/wake limits (REQ-19) | not-run | mapped to VER-11 by acceptance.md |

## verdict

**failed.** The plan/DAG discipline, exact immutable ArtifactRef pinning,
direct member↔member mail, inbox durability, consumer-generation fencing,
receipt idempotency across real disconnects, and the projection-level
outcome semantics are all solid — and `plan.commit` demonstrably creates no
work by itself.

But the dispatch boundary is unsafe at `83a6d21`: it consumes **rejected**
and **unsettled** producer outputs (F-029), cannot read the contract's
canonical binding shape at all (F-030), accepts caller pins that substitute
a foreign producer's artifact for a declared task-output slot (F-031), and
ignores the assignment grant's `taskIds` narrowing (F-032). On top of that,
the entire public outcome path (`task.report`/`outcome.decide`, IMP-21) is
unregistered — every outcome/settlement row in evidence is seeded and so
marked. Findings routed to IMP-13/IMP-14/IMP-21 in
`records/orchestration/findings.md` (F-029–F-032); repeat s1's §4.1/§4.4
probes after the owning IMPs land fixes.
