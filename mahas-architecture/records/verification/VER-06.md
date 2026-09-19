---
taskId: VER-06
codeRevision: 83a6d21
specRevision: 99eb5f5
verdict: failed
---

# VER-06 — 실행 생명주기 spawn 경계·실패 의미론 검사 (execution lifecycle spawn-boundary & failure semantics)

VerificationRecord for the execution-lifecycle contracts
(`spec/execution-lifecycle.md`, `spec/contracts/execution-host.md`,
`spec/contracts/launch.md`): spawn cut points (materialize → attach → join),
duplicate-spawn suppression, initial-input delivery, crash-gap recovery,
receipt honesty on partial failure (F-007), PID-reuse/birth-identity safety,
checkout writer fencing, revoke/unknown semantics, and the
`worker.start` / `execution.join` / `task.accept` separation. Prerequisite
**VER-05 is satisfied** — its record exists at
`records/verification/VER-05.md` (verdict `failed`, owns F-046…F-051); this
run re-confirms several of its findings against the same revision. Executed
against a clean detached copy of `83a6d21` in `/tmp/mahas-ver-06/` — the
main worktree's unrelated WIP was never touched, the pinned implementation
was not modified, and nothing was git-committed.

## environment

| 항목 | 값 |
|---|---|
| code revision | `83a6d21` (coordinator handoff, all 32 IMPs landed) |
| spec revision | `99eb5f5` |
| runtime | node v24.20.0 (type-stripping), `node:sqlite` (SQLite 3.53.4) |
| OS | Linux 7.0.0-31-generic x86_64 |
| execution host | **dedicated real daemon** `/tmp/mahas-ver-06/config/` (`execution-host.sock`, `execution-host.sqlite`) booted from pinned source `packages/mahas-execution-host/src/main.ts`; SIGSTOP/SIGCONT/SIGKILL/restart used freely |
| control plane | in-process `composeRuntime` (`probe/common.ts wireB`) on `/tmp/mahas-ver-06/inproc/db/mahas.sqlite`, wired to the real host socket; new controller epoch per incarnation; `runtime_instances` rows written as lifecycle would |
| host access | raw NDJSON `hostSession` (hello + `host.acquire` lease + fenced calls) for host-level probes; fenced control path for `worker.start` spawns |
| children | real OS processes — `bin/child.sh` (argv/env recorder + `exec sleep 600`), `bin/child-stdin.sh` (records stdin bytes), `bin/pty-child.sh` (records tty input); nonce `MAHAS_SPAWN_NONCE` + `/proc` birth evidence |
| fixture | `probe/fixture.ts` + `probe/planseed.ts` — real model/project/run/roles/impls/grants via real ops; launch rows mirror the stages' own write shapes (fresh `worker.prepare`/`worker.start` chain is unreachable at this revision — F-046 — so admitted/materialized state is seeded byte-for-byte from the stages' own committed writes, labeled as such) |

## probe inventory

| artifact | checks | result |
|---|---|---|
| `out/s1-host-spawn.json` | 14 | **1 real fail** — spawn dedupe is keyed on `effectKey` only: same exec + same nonce + different key → second child spawned, `host_processes` row overwritten, first child orphaned and uncontrollable (F-054) |
| `out/s2-pty-spawn.json` | 9 | **all pass** — F-007 partial failure honest end-to-end: pty spawn → `unknown` (FK violation), child live + managed, journal `unknown`, replay deduped, probe/stop work through processIncarnation |
| `out/s3-host-restart.json` | 11 | **all pass** — children survive host SIGKILL/restart; process rows recovered probe-able but not adopted; forged birth identity → exited/pid-reused, zero signals; journal replay durable; stale endpoint exercised |
| `out/s4-worker-start.json` | 20 | **all pass** — as-wired `worker.start` reaches `resources_claimed` → `unknown` (UNAVAILABLE_OPERATION — F-046 wall); deep-seeded chain → real spawn pid, all stages confirmed, `awaiting_join`; duplicate/same-plan starts replay without respawn; `STALE_REVISION` on wrong digest; second writer `RESOURCE_BUSY`; dispatch stays `assigned` (start ≠ accept); `worker.prepare` → `INVALID_TRANSITION` |
| `out/s5-crashgap.json` | 35 | **1 real fail** — kill-first gap: host daemon **dies** writing the response to a SIGKILLed client's socket (`write EPIPE`, `host.ts:719`) — **F-052 confirmed**; post-restart recovery replayed to `awaiting_join` with exactly one live child/one host row; timed kills at 0/3/10/60/150/500 ms roll back or recover honestly; B1 wedge → `INVALID_TRANSITION` not `START_UNKNOWN` (F-053); B2 fingerprint conflict → honest `unknown`/`start_unknown`, no respawn; B3 resources `attempting` → honest `unknown` |
| `out/s6-revoke-unknown.json` | 13 | **1 real fail** — **F-006 reconfirmed**: dead host + leftover endpoint file → subprocess `composeRuntime` dies on unhandled `ECONNREFUSED` (readline `error` event); documented workaround (file removed) → clean `host-absent` degraded start; `access.revoke` op commits + reports `affectedExecutions`; revoked pinned grant → `inputs_pinned:failed GRANT_REVOKED`, never admitted; revoked caller grant → boundary rejection, 0 children; `start_unknown` owner still `RESOURCE_BUSY` to a second writer |
| `out/s7-stdin-join.json` | 18 | **6 real fails** — payload-level `initialStdin` ContentRef (the real control shape) → child got **0 bytes**, spawn `confirmed` (**F-047 reconfirmed**); `execution.join` → `SCOPE_DENIED` at commit-time reauthorization, whole tx rolled back (**F-049 reconfirmed**); with coverage satisfied via `*`-scope scaffold, join **commits** (`ready` + `worker_joins` + credential→full) yet dispatch stays `assigned` → `task.accept` → `INVALID_TRANSITION` (**F-050 reconfirmed**, now proven through a real committed join); `spec.initialStdin` raw string delivers bytes; `terminal.input` unjournaled → identical calls write twice; missing `inputLeaseRevision` → `SCOPE_DENIED`; join fencing negatives (`SCOPE_DENIED`/`STALE_EXECUTION`) pass |

Raw probe sources: `/tmp/mahas-ver-06/probe/{common,fixture,planseed,s1..s7,s5-victim,s5-recover,s5-gap,s5-spawnorphan,s6-stale}.ts`.
Child-side evidence files under `/tmp/mahas-ver-06/out/children/`
(`<nonce>.meta` / `.stdin` / `.stdin-meta` / `.pty-in` / `.pty-meta`).
No secrets in evidence; all credentials were fixture/seed-generated nonces.

### evidence digests (sha256, `/tmp/mahas-ver-06/out/`)

```
a8077b5c444875db1934aada4d1d71065faedb7e486c05942f8352f18919b910  s1-host-spawn.json
0cf552cdda7c4de17b8d6aa3767f47b3c71d94844eff96659e9f357327f5334e  s2-pty-spawn.json
e9ab51acc4a29b7f2776de4b9a1c086f7d9783fc4f7ecc40bbc14f8c768fdce6  s3-host-restart.json
e4d758ebbd68a6fa75c55a0108faf08e7ad624f7a6284d947a1f635aaa4b413b  s4-worker-start.json
57b06d6b92035e77fe9fab7274f202bc5ce060f3203ec4c945a1f76016b8b1d9  s5-crashgap.json
7962738fa6f42d27d9acd34c0fb391907c23bb30a269594a1a5ee3e03e7d3dfc  s6-revoke-unknown.json
8a1a877d3b050b03de411b95568b4b7b76291f6011ed49814f92450388c53133  s7-stdin-join.json
```

Aggregate: **111/120 checks pass**; every failing check is a reproduced
defect (or its documented probe), not a harness artifact.

## findings confirmed at this revision

### critical — new candidates

**F-052 (new) — a dead client can take down the execution-host daemon.**
In the kill-first crash gap (host SIGSTOP → victim `worker.start` dispatch →
victim SIGKILL → host SIGCONT), the host processes the queued
`host.process.spawn`, writes the response to the dead socket, and the whole
daemon dies on `Error: write EPIPE`
(`mahas-execution-host/src/host.ts:719`). The orphan child + `confirmed`
journal row survive; after a manual restart, recovery reaches
`awaiting_join` without respawning. One killed controller connection kills
every managed session — a single-client liveness fault. Owner: IMP-17.

**F-053 (new) — spawn `attempting` crash-gap wedges at `INVALID_TRANSITION`;
`START_UNKNOWN` is unreachable.** With a durable control spawn effect left
`attempting` and a real host orphan under the deterministic nonce, a
`worker.start` retry is rejected `INVALID_TRANSITION` — not the specified
`START_UNKNOWN` ambiguity path (`start-coordinator.ts` attempting→unknown
normalization). The execution stays `preparing`, the effect stays
`attempting`, a second retry is identical, and no live path marks
`start_unknown`/`unverifiable`. Safe against respawn (the orphan is never
duplicated) but permanently wedged — recovery cannot classify the gap.
Owner: IMP-19.

**F-054 (new) — spawn dedupe keyed on `effectKey` only: same exec + same
nonce + different key spawns a second child and overwrites the row.**
`host.process.spawn(effectKey₂, spawnNonce N, exec E)` after a `confirmed`
spawn under `effectKey₁` creates a second real child (`hostKids=[607007,
607011]`); `host_processes.spawn_nonce` is keyed by nonce, so the second row
overwrites the first — child 607007 stays live but is no longer addressable
through the row (orphan: probe/stop by incarnation still find it, the row's
pid is the second child's). The control plane derives a plan-stable
effectKey so the shipped path is protected, but the host boundary itself
does not suppress duplicate spawns for the same execution+nonce.
Owner: IMP-17/IMP-18.

**F-055 (new) — a member's grant can never cover `execution.join`'s target
set: `launchPlan` is an unresolvable target.** `joinResolveTargets`
(`launch/join.ts:438-448`) emits `{execution, member, launchPlan}`;
`expandOne` has no `launchPlan` ancestry, so it can be covered only by an
exact scope entry or `{kind:'*'}`. A run-scoped member assignment grant —
the only grant a worker would plausibly hold — therefore fails the
commit-time re-authorize even though its `actions` include
`execution.join`/`task.accept` and admission authorized via bootstrap scope.
Observed: join authorized (decision `allow=1, bootstrap=true`), handler ran,
post-write re-auth denied (`launchPlan` listed under `unresolvedTargets`),
whole tx rolled back. Satisfying coverage required a probe-seeded `*`-scope
grant — recorded as scaffold. Parallel in shape to F-021 (boundary targets
unreachable by member scope). Owner: IMP-10 + IMP-19.

### reconfirmed at this revision (owned by earlier records)

- **F-052 note**: described above — first reproduction was in this task's s5.
- **F-006** — stale `execution-host.sock.endpoint.json` + dead host → `composeRuntime` subprocess exits 1 on unhandled `ECONNREFUSED` escaping via the readline `error` event (no `host-attach-failed` log line). Removing the file yields the documented clean `host-absent` degraded start (`STALE-RESULT composed:true hostId:null`). Reproduced at `83a6d21` in `s6`.
- **F-007** — pty spawn → `unknown` receipt + live managed child + absent `host_terminals` row, honest journal/replay (s2); the in-memory terminal still exists and admits input even though its row is missing (s7).
- **F-046** — shipped `worker.start` still dies at `resources_claimed` (`unknown`, `UNAVAILABLE_OPERATION`/`INTERNAL workspace.prepare`); downstream stages exercised through seeded equivalents of the stages' own committed writes (s4, s5, s7).
- **F-047** — the exact coordinator payload shape (`spec` without `initialStdin` + payload-level `{digest,mediaType,sizeBytes,bytesB64}`) spawns a confirmed child that receives **0 bytes**; `spec.initialStdin` raw string delivers the bytes — reconfirmed on the real host (s7-A2/B).
- **F-049** — `execution.join` rolls back at commit-time reauthorization (`SCOPE_DENIED`, exec stays `awaiting_join`, `worker_joins` absent, credential stays `bootstrap`). New facet vs VER-05: the deny persists even *with* a member assignment grant covering the op actions — the blocker is target coverage (F-055), not only grant absence (F-048).
- **F-050** — a **committed** join (coverage satisfied via scaffold) still leaves `dispatches.phase='assigned'`; `task.accept` then fails `INVALID_TRANSITION 'assigned'` — the strongest form of the evidence yet: real spawn → real join → real accept rejection (s7-D).

## verified-correct behavior

- **Spawn effect idempotency**: plan-stable `effectKey` + deterministic `spawnNonce` suppress respawn across replays, recoveries, host orphans, and post-mortem spawns — every recovery case converged on exactly one live nonce-bound child and one `host_processes` row (s4, s5).
- **Crash-gap honesty**: mid-dispatch SIGKILL rolls back the op tx cleanly (pre-admission kills leave no execution row/member binding); post-commit kills recover to `awaiting_join`; host journal `attempting`/`confirmed` rows are never rewritten to satisfy control state (s5).
- **Ambiguity honesty**: host-confirmed spawn under the effectKey without a matching control row → `OPERATION_CONFLICT` → control effect `unknown`, execution `start_unknown`/`unverifiable`, and a retry persists `unknown` without respawn (s5-B2); resources `attempting` → honest `unknown` on retry (s5-B3).
- **Revocation fencing**: `access.revoke` commits, durably sets `revoked_at`, and honestly reports `affectedExecutions` + `inFlightEffects`; a revoked pinned grant is re-checked at `inputs_pinned` → `GRANT_REVOKED` (replan), zero children, execution stays `preparing`; a revoked caller grant is rejected at the boundary (`UNAVAILABLE_OPERATION` — non-exposure semantics preserved, no op-name leak); a `start_unknown` execution still holds its checkout claim → second writer `RESOURCE_BUSY` (s6).
- **Receipt honesty on partial failure**: F-007 unknown-receipt is journaled, replayed, and never upgraded; the spawned child remains managed (s2).
- **Process identity / PID reuse**: children survive host restart unadopted; forged birth identity → honest `exited`/`pid-reused`, zero signals delivered (s3).
- **Terminal input fencing**: `inputLeaseRevision` required (`SCOPE_DENIED` when absent); input is `bytesAdmitted` only — never a processing receipt (s7).
- **Join fencing negatives**: unbound ctx → `SCOPE_DENIED`; wrong generation → `STALE_EXECUTION`; digest pinning enforced by `checkPlanDigests` (s7).
- **Refusal over silent loss**: a resumed stdin route whose bytes are unrecoverable fails `process_attempting` `MANDATORY_COMPONENT_MISSING` — the start refuses rather than spawning with empty stdin (s7-A).
- **Lease fencing**: same-process epoch self-advance works; foreign takeover requires dead-evidence — a verifiably-live recorded controller refuses takeover even with a higher epoch (observed directly in s7 harness output; consistent with `lease.ts` contract).

## blocked / not-run (honest)

| item | status | reason |
|---|---|---|
| shipped fresh `worker.prepare`→`worker.start` chain | blocked | F-046/F-051 as-wired walls: `worker.prepare` → `INVALID_TRANSITION`; `resources_claimed` → `unknown` (`UNAVAILABLE_OPERATION`); fresh materialize → nested-tx `ERR_SQLITE_ERROR`. Admitted/materialized state seeded from the stages' own write shapes — labeled wherever used |
| literal mid-flight grant revocation (between stages) | not-run | revocation tested at the durable re-check boundary (`inputs_pinned` → `GRANT_REVOKED`); the sub-stage timing window not exercised |
| `worker.stop` / `worker.resume` / `worker.release` / `worker.inspect` ops | not-run | registry presence verified; dedicated probes not executed in this pass |
| real worker-credential wire round-trip for join/accept | blocked | `mahasd-worker.sock` unbound at `83a6d21` (F-001); exercised via in-process `memberCtx` + a real `execution_credentials` row through the same real registry/admission path |
| native hidden prompt bytes | not-observable | receipt honestly records `nativeHiddenPrompt: "unknown"` (s4) — not directly observable at this revision |
| `host.workspace.*` direct ops | covered by mechanism | exercised indirectly through control `workspace.prepare` effect + `RESOURCE_BUSY` fencing (s4, s6) |

## verdict

**failed.** The boundary machinery is genuinely strong: deterministic
spawn-nonce + effectKey idempotency, honest `unknown`/`start_unknown`
classification, clean crash-gap rollback, real revocation fencing,
checkout-writer fencing under `start_unknown`, and refusal-over-silent-loss
on unrecoverable input. But the lifecycle path at `83a6d21` has a live
single-client daemon crash (F-052), a permanently wedged spawn-gap state
(F-053), a host-boundary dedupe hole that creates uncontrollable orphans
(F-054), and a scope-model gap that makes `execution.join` uncommittable by
any realistic member grant (F-055) — on top of the still-open F-006/F-007
host defects and the F-046/F-047/F-049/F-050 launch-chain breaks
reconfirmed here. New candidates F-052…F-055 are named for routing to
IMP-10/17/18/19 — `records/orchestration/findings.md` and `STATUS.md` were
intentionally not modified in this run; repeat s5–s7 after the owning IMPs
land fixes.
