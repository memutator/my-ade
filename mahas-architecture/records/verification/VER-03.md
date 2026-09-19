---
taskId: VER-03
codeRevision: 83a6d21
specRevision: 99eb5f5
verdict: failed
---

# VER-03 — 권한·비노출·폐기 검사 (authorization / non-exposure / revocation)

VerificationRecord for the access, launch, and common verification contracts.
Prerequisites VER-01 (`a9dcd65`, verdict failed) and VER-02 (`92d77c`, verdict
failed) are recorded; this run was executed directly against a clean detached
copy of `83a6d21` in `/tmp/mahas-ver-03/` — the main worktree's unrelated WIP
was never touched and the pinned implementation was not modified.

## environment

| 항목 | 값 |
|---|---|
| code revision | `83a6d21` (coordinator handoff, all 32 IMPs landed) |
| spec revision | `99eb5f5` |
| runtime | node v24.20.0, `node:sqlite` (SQLite 3.53.4) |
| OS | Linux 7.0.0-31-generic x86_64 |
| world A | real `mahasd` daemon, `/tmp/mahas-ver-03/config/` (`mahasd.sock`, `mahas.sqlite`) — raw unix-socket RPC target |
| world B | in-process wired runtime, `/tmp/mahas-ver-03/inproc/` (`config/`, `db/mahas.sqlite`, `execution-host.sock`) — dispatch-level probes |
| fixture | `/tmp/mahas-ver-03/state.json` + `probe/fixture.ts` — operator, coordinator lead, ordinary worker (r-auth/b-api), reviewer (r-doc/b-docs), provisioning grants provAll/provLeadOnly/provMember, plan `t-auth`/`t-docs`, implementations `hp-main@2` (verified) |

## probe inventory

| artifact | checks | result |
|---|---|---|
| `out/s0-fixture-{A,B}.json` | — | fixture seeded (members, grants, executions, deliveries, plans) |
| `out/s1-surfaces.json` | 23 | per-subject surfaces captured; 1 expectation artifact (bootstrap ctx `inbox.check` → `UNAVAILABLE_OPERATION`, correct non-exposure) |
| `out/s2-foreign.json` | 12 | **all pass** — foreign member/run/delivery denied, inbox filtered, run isolation, no side effects |
| `out/s3-bypass.json` | 13 | **1 real fail** — member↔principal binding bypass committed; socket principal spoof confirmed |
| `out/s4-revoke.json` | 11 | **1 real fail** — self-revocation rollback defect; all other fencing passes |
| `out/s5-read.json` | 10 | **2 real fails** — `access.inspect` self-view unreachable (contract gap) |
| `out/s6-cover.json` | 9 | **3 real fails** — boundary-scope unreachable, provisioning allowlist bypass, foreign-grant attestation escalation |

Raw probe sources: `/tmp/mahas-ver-03/probe/{common,fixture,s0..s6}.ts`.
No secrets in evidence; credentials used were fixture-generated nonces.

### evidence digests (sha256, `/tmp/mahas-ver-03/out/`)

```
0185cc6209f1b77c8964646f3d2243b95b38139c9e9f55b1c9cb4f451d011eaa  s0-fixture-A.json
be1615ca512f57555a9047324cb9f545976d83261804cbf8c0eeaa09e2d6786e  s0-fixture-B.json
688db6190f52d8e9f1994a2139701e8357b7d126b9dd5aa6af359098b979ef6a  s1-surfaces.json
8a1b08a07936adcfbb9270ef3151371bd35cb14282898ba5314f94f5c6a7ad42  s2-foreign.json
eb9e85ce6ae8f0cf230ca92e5eafabc767051dcf7ddbbf83278c087a50cfa908  s3-bypass.json
f856985dfd6d506d716ee984c5a4ffc72d11023b97ea441ce53ac11469adc7bd  s4-revoke.json
7cfcd70c8f2c2d89f338a56c4a5bf45d964d9f5b66d9962e674fe67333e86db5  s5-read.json
f80eef01327b1ce7099e6193cc485f42df24b8ad2e86ba491af4e10301334895  s6-cover.json
```

## findings confirmed at this revision

### critical — authorization bypass with durable side effects

**F-001 reconfirmed (wire-level).** The default authenticator
(`main.ts:353-367`) reads `credential.principalId` as a trusted claim — no
secret check, no credential kind dispatch. Over `mahasd.sock`: a hello with a
bogus secret returns a populated operator surface; a hello claiming a real
principal id returns that principal's surface; a lead-principal claim executed
`run.get` coordinator projection and committed an `access.grant` mutation.
`mahasd-worker.sock` is **never bound** (`mahasdWorkerEndpoint` defined in
`rpc/endpoints.ts:22`, never called from `main.ts` — one `serveRpc` on the
operator socket only), so the entire worker-auth path
(`rpc/worker-auth.ts`, `launch/bootstrap-credential.ts`) is dead code.

**F-018 (new) — member↔principal binding is not checked.** A context with the
*worker's* principalId but the *reviewer's* memberId committed
`delivery.ack` on the reviewer's delivery (`status=acknowledged` persisted).
`decide()` resolves grants by `principalId` and never verifies that
`ctx.memberId` belongs to that principal — any memberId can be attached to any
principal's authority. Owner: IMP-10.

**F-022 (new) — foreign-grant attestation escalates provisioning.**
`callerGrantsOfKind`/`recheckCallerGrants` resolve `ctx.grantRevisions` entries
by grant id only — they never compare `grant.principal_id` to
`ctx.principalId`. A lead-member context attesting **operator-local's**
`provAll` (`grt_aaee2913`, allowlist `r-lead/r-auth/r-web/r-doc`) committed
`team.assign` creating r-doc members (`mem_9af55cf9`, `mem_c5c5da41`) whose
grants record `parentProvisioningGrant=provAll`. Combined with F-001, a socket
client can borrow any known grant id as its own attestation. Owner: IMP-10.

**F-009 reconfirmed (end-to-end, durable rows).** `checkProvisioning`
(`member.ts:362-383`) reads flat `scope.allowedRoleIds` / `scope.maxMembers` /
`scope.placementScope` / `scope.profileAdmission`, but grants persist them
nested under `scope.provisioning.*`. Every check is vacuous → a lead context
attesting its own `provMember` (allowlist `r-auth,r-web`, `maxMembers=2`)
committed `team.assign r-doc` twice (`mem_544acd84`, `mem_2b457b15`), each
grant falsely recording `parentProvisioningGrant=provMember`. Role allowlist,
member cap, placement, and profile admission are all unenforced at `83a6d21`.
Owner: IMP-13 + IMP-10 (unchanged from VER-01).

### contract/scope gaps

**F-021 (new) — member grant scope can never cover boundary targets.**
`scopeEntries()` maps an assignment grant's scope to `[{kind:'run'}]` only;
the recorded `boundaryId`/`taskIds` flat keys are ignored. A boundary target's
actual ancestors are `modelVersion→project` — `run` is not in that chain — so
`responsibility.inspect` is SCOPE_DENIED for members even on their **own**
boundary (`b-web` member → `inspect(b-web)` rejected). The op sits in the
member's action set yet is unreachable: the recorded narrowing is dead in both
directions. Owner: IMP-10 + IMP-13.

**F-020 (new) — `access.inspect` self-view unreachable.** Contract says the op
returns the subject's own binding; member grant action sets do not include it,
so both self-inspection and own-grant inspection fail surface visibility with
`UNAVAILABLE_OPERATION` before the handler's self branch can run.
Owner: IMP-11 (grant action sets) / IMP-13.

**F-019 (new) — self-revocation always rolls back.** Spec allows a subject to
revoke its own grant. `accessRevokeOp` authorizes, `revokeGrantTree` revokes,
then the admission post-handler re-authorization re-checks the **now-revoked
attested grant** → `GRANT_REVOKED` → whole txn rolls back (`revoked_at` stays
NULL). The post-check does not exempt the grant the op itself just revoked.
Owner: IMP-10/IMP-11.

**F-024 (new) — grant-revision attestation unchecked at admission.**
`decide()` verifies attested grants exist and are live but not that the
attested **revision** equals the current one — a stale revision attestation
passes admission and is only fenced later by `recheckCallerGrants` at the
mutation boundary (`internal.ts:494-510`, which does compare). Read ops under
a stale attestation are never fenced. Owner: IMP-10.

**F-023 (new) — `execution_credentials.revoked_at` not consulted.** Ordinary
member operations proceed under a member grant even when the seeded
`execution_credentials` row for the execution is revoked — the credential
table is written but never read on the op path (the worker-auth path that
would consult it is unbound, see F-001). Owner: IMP-19/IMP-20.

## verified-correct behavior

- **Non-exposure**: ops absent from the effective surface → `UNAVAILABLE_OPERATION` for workers, bootstrap ctxs, and foreign members — no name confirmation at invoke time.
- **Foreign objects**: cross-member delivery ack, foreign-run `run.get`/`message.send`, foreign task/delivery targeting all denied; inbox returns only same-member deliveries across accumulated durable state; denied mutations left zero side effects (row counts verified before/after).
- **Revocation fencing**: revoked grant denies subsequent calls; attesting a *revoked* grant denies even when another live grant would cover; spare live grant keeps working; revoked provisioning parent blocks child issuance; `access.revoke` returns contract shape `{revocationRevision, affectedExecutions, inFlightEffects}` and honestly names live executions (`exec-ver03-ymzey7…`).
- **Generation fencing**: stale `executionGeneration` → `STALE_EXECUTION` on inbox/ack; current-generation calls rebind outstanding deliveries; old-generation ack rejected, fenced deliveries stay fenced.
- **Receipts**: own receipt readable; other member and operator ctxs cannot read member-scoped receipts; nonexistent artifact returns honest artifact error.
- **Worker connection-file client**: `workerConnectionPath` → `null` when `MAHAS_CONNECTION_FILE` unset — fails closed, **no fallback to the operator endpoint** (spec-correct); file mode 600 enforced; `WorkerCredential` carries no claimable identity fields.
- **MCP/UI/help/completion**: no matching operation names in the 92-op registry.

## blocked / not-run (honest)

| item | status | reason |
|---|---|---|
| real worker-credential wire round-trip | blocked | `mahasd-worker.sock` never bound at `83a6d21`; `worker.prepare` unreachable — no worker endpoint exists to authenticate against |
| `execution.stop` old-gen | not-run (covered by mechanism) | stale-generation fencing verified on the shared `assertCurrentGeneration`/`requireCurrentMember` path; op-specific variant not exercised |
| placement escape via `placementIntent` | covered by mechanism | `checkProvisioning` placement branch reads the same dead flat keys — untestable as a distinct bypass while F-009 stands |
| `model.change` reparent scope widening | not-run | narrowing keys are never read (F-021), so no narrowing exists to escape; documented analytically |
| `responsibility.inspect` foreign-vs-own narrowing | blocked | own-boundary call already SCOPE_DENIED (F-021) — the narrowing question is unreachable |
| CLI help/completion text surface | not-run | no such operations exist in the registry |

## verdict

**failed.** Non-exposure, inbox isolation, revocation fencing, generation
fencing, and receipt isolation are solid. But the authorization core has four
independently-reproduced bypasses with durable side effects at `83a6d21`:
unauthenticated principal claims over the wire (F-001), member↔principal
unbinding (F-018), foreign-grant attestation (F-022), and a fully-vacuous
provisioning allowlist (F-009) — plus five contract gaps around scope
coverage, self-inspection, self-revocation, revision attestation, and the
unread credential table. Findings routed to IMP-10/11/13/19/20 in
`records/orchestration/findings.md`; repeat the affected probes (s3–s6) after
the owning IMPs land fixes.
