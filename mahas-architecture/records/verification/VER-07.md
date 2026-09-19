---
taskId: VER-07
codeRevision: 83a6d21
specRevision: 99eb5f5
verdict: failed
---

# VER-07 — UI 분리·재접속·터미널 I/O·라이프사이클 정체성·리스·거짓성공 방지

VerificationRecord for the lifecycle/terminal/reattach contract: UI close
and detached movement must preserve the process incarnation; an
execution-host or mahasd crash must reattach honestly with the same
identity; the worker CLI must never report success while control is
unavailable; output retention, reconnect cursors, resize and input leases
must degrade honestly; hooks/survival must not mint Task success.

Prerequisite **VER-06 is pending** — no formal `records/verification/VER-06.md`
exists; VER-03 (`83a6d21`, verdict failed) is recorded. This run executed
against the same detached copy of `83a6d21` at `/tmp/mahas-ver-07/src/` —
the pinned implementation and the main worktree were never modified, and
nothing was committed. World-A daemons (shared VER-03 infrastructure,
mahasd pid 467291, execution-host pid 467248) were never killed or
restarted; every lifecycle experiment ran on VER-07-owned instances.

## environment

| 항목 | 값 |
|---|---|
| code revision | `83a6d21` (coordinator handoff, all 32 IMPs landed) |
| spec revision | `99eb5f5` |
| runtime | node v24.20.0, `node:sqlite` |
| OS | Linux x86_64 |
| world A | shared live `mahasd` `/tmp/mahas-ver-03/config/mahasd.sock` + execution-host `/tmp/mahas-ver-03/config/execution-host.sock` — RPC probes only, daemons untouched. Host session inside mahasd was dead at probe time (see blocked). |
| world B | VER-07-owned execution-host `/tmp/mahas-ver-07/inproc/config/execution-host.sock` (+ own DB) fronted by an in-process composed mahasd (`composeRuntime`, pinned source) served on a real unix socket `/tmp/mahas-ver-07/inproc/mahasd-b.sock` via the real `serveRpc` transport — identical op handlers/authorize/store/host-proxy, socket is only transport. |
| lifecycle host | second VER-07-owned host `/tmp/mahas-ver-07/life/` (own socket+DB) — deterministic crash/restart drills. |
| probes | `/tmp/mahas-ver-07/probe/*.ts` → artifacts `/tmp/mahas-ver-07/out/*.json`, host logs `/tmp/mahas-ver-07/logs/` |
| seeding (disclosed) | `host_processes` rows pre-seeded with `state='pre-seeded'` before spawn (works around F-007 FK ordering); one `host_terminals` row hand-written mid-drill to test recovery; `resources`/`terminal_records` mirror rows inserted into the world-B mahas DB so client ops can resolve terminals. No other DB writes. |

## probe inventory

| artifact | checks | result |
|---|---|---|
| `out/p0-preflight.json` | 4/4 | mahasd hello, operator surface 12 ops, member surface hides client ops, world-A lease held |
| `out/p1-spawn.json` | 14/16 | world-B host spawn semantics; 2 fails = deaf-stream evidence (F-007 mechanism — no `terminal.data` pushes, empty snapshot despite live pty) |
| `out/p1b-livepty.json` | 5/5 | real pty spawn confirmed on world-B, process identity {pid, birthEvidence, pgid} persisted |
| `out/p2-seed.json` | 6/6 | committed execution/terminal mirror rows + durable identity projection |
| `out/p3-bind.json` | 15/15 | `client.view.bind`/`unbind` commit + negative paths; receipts replay committed ops |
| `out/p4-terminal-a.json` | 11/11 | world-A control-unavailable honesty: hello + `runtime.snapshot` work while every `terminal.*` rejects `CONTROL_UNAVAILABLE`; member surface hides them `UNAVAILABLE_OPERATION`; no false success |
| `out/p4-terminal-b.json` | 27/30 | full world-B terminal lifecycle (below); 3 fails = F-038/F-039/F-040 evidence |
| `out/p5-hostwedge.json` | — | incident capture: host ~80% CPU, 932M `syscw`, `host.hello` timed out after `/bin/cat` flood (F-045) |
| `out/p5-overflow-b.json` | 4/7 | real ring overflow produced (`truncated`, `droppedThrough=60`, window 61..176, 520,983 B); 3 fails = F-038/F-039 evidence |
| `out/p6-disconnect-b.json` | 10/12 | first disconnect run — 2 fails trace to a harness opId collision (also proof the receipt fingerprint guard rejects same-id/different-payload with `OPERATION_CONFLICT`); superseded by b2 |
| `out/p6-disconnect-b2.json` | 12/12 | disconnect/reconnect, durable binding+lease, replay, subscription ownership/orphans |
| `out/p7-hostlife.json` | 22/23 | dedicated host SIGKILL→restart: process retention, incarnation, terminal recovery, honest fences; 1 fail = F-043 |
| `out/p7b-mahasd-life.json` | 13/13 | mahasd↔host session lifecycle: dead-session corpse, fresh-compose reattach, same-identity re-probe, stale-incarnation input fence |
| `out/p8-cli.json` | 12/12 | worker CLI honesty under missing/permissive/dead control; scope refusal; survival≠success |
| `out/p9-cleanup.json` | 9/9 | teardown honesty; world-B/life hosts stopped, spawned procs swept, world-A daemons confirmed alive |

Raw check total: **164 ok / 175 checks** across 15 artifacts (the first
disconnect artifact is retained for its idempotency-collision evidence; its
2 failed checks were harness-caused and re-verified 12/12 in `p6b2`).

### evidence digests (sha256, `/tmp/mahas-ver-07/out/`)

```
1e1bf680aa0978b9613efce639dc1073e357df6b064f222aba4103267da88d7a  p0-preflight.json
266168fdbcc1475911b6b25a03c845d132b2e3800999aae1e6d99b99e609106d  p1-spawn.json
d57f06e45e26df566e7bda5d5ef287b3b7009fd4b202718eec92a9de582acb34  p1b-livepty.json
5f526d20b200ed0616a9b327b591e3248f06f97ab76857ebeacd4393a4594545  p2-seed.json
9550140349ca69994d574c99d50840066bde64727f4cbae37538992d1d6138c8  p3-bind.json
b99a4c915dcd8c42f44f93183751b63a6066f88a1a57033ad10987723a9f5d07  p4-terminal-a.json
4ed1ae8d307cf9a87927dc1dfc7e4db2b03f90881081502a76fe76856c693b8d  p4-terminal-b.json
efa35fbfbfd5aef027b0f56867c3b9916686fb466b82cd56aa8720ba8ffb83da  p5-hostwedge.json
b9b8eb0a798f8f5dbc944d0fa573062906bbeef552e92d2a47d35718061da8ca  p5-overflow-b.json
8ec00a37c3c946d949b2ded00490f7f14cba734817245a7cdef06a21e118cae9  p6-disconnect-b.json
0ec63a9281de6d33f8cede620de1c387950fc0632e8407ed69f9d823565f14a1  p6-disconnect-b2.json
ca97a4c5f78e2332ce90608269d9bbb6875caf22131e63e96db15a996dfd7a72  p7-hostlife.json
cb390342589692e9c19d0afa9355c5370bed487790a5474c100d677bb8017c4a  p7b-mahasd-life.json
bd5c68d642f68d828cfeeb634275ca33812c99ad3761a342fae0d68713fc908b  p8-cli.json
7e5fde5d42fa0a5528d1c02a1cde387cca5285baa38a0de16a0cbd8f17e39908  p9-cleanup.json
```

Host logs: `logs/host-b.ndjson`, `logs/host-life.ndjson`
(`e3c8d80829c868852fba1c69caaee5c561832dc1c12fc5c2012094a01441ce3e`).
No secrets in evidence — all credentials are probe-generated nonces; the
world-B endpoint authToken lives only in the unpublished endpoint file.

## requirement coverage (procedures → expected → observed)

**1. UI separation / view lifecycle ≠ process lifecycle.** Procedure:
`terminal.attach` → `terminal.detach` (view close) → `host.process.probe`
+ re-attach. Expected: the process incarnation is untouched by view churn;
other viewers unaffected. Observed: after detach the pty child probed
`liveness=live`, a second client's snapshot still answered, re-attach minted
a fresh `subscriptionId` on the same terminal; detach released the lease and
cleared the stored subscription while keeping the durable binding row
(`p4-terminal-b`). The Electron renderer's pane-detach/remount path is not
part of this pinned revision — see not-run.

**2. Host & mahasd crash/restart reattachment with the same identity.**
Procedure: dedicated lifecycle host → spawn pipes `sleep` + pty `cat` →
SIGKILL → reboot → re-acquire lease → probe/inventory/attach. Expected:
retained processes re-probe as the same `ProcessIncarnation`; a new host
incarnation; persisted terminal rows recover honestly. Observed:
`liveness=live` with identical `pid`+`birthEvidence` (`9056862===9056862`),
fresh `hostIncarnation` (`645e11aa→06cbb4af`), lease epoch self-advanced
1→2; pty child died via SIGHUP (recorded informationally); a persisted
`host_terminals` row re-attached with identity+cursor intact and buffer
honestly empty (`droppedThrough=42`, `state=open`, never fabricated);
stale cursor → explicit `gap{droppedThrough:42}`; input →
`PROCESS_UNVERIFIABLE`. At the mahasd layer (p7b): SIGKILL of the world-B
host → `terminal.attach` rejects `CONTROL_UNAVAILABLE`; host reboots with a
new incarnation; the SAME composed mahasd still rejects — its `localSession`
is a non-null corpse that is never re-dialed (F-044 mechanism, the F-014
dead-reattach path confirmed end-to-end); `runtime.reconcile` →
`UNAVAILABLE_OPERATION` cannot repair; a fresh compose (= mahasd restart)
re-acquires the lease (epoch 10) and the retained pipe process re-probes
`live` with identical pid+birth — true reattachment, not respawn; the
recovered terminal attaches + snapshots but leased input is fenced by the
stale `host_incarnation` → `CONTROL_UNAVAILABLE` — never a blind write.

**3. Worker CLI false-success prevention.** Procedure: `mahas --as worker`
with (a) no connection file, (b) a mode-664 connection file, (c) a valid
file pointing at the never-bound `mahasd-worker.sock`. Expected: honest
non-zero exits, no committed receipt on stdout. Observed: exit 4
`UNAUTHENTICATED` (no file); exit 4 `UNAUTHENTICATED` — "mode 664 is too
permissive — expected 600" (secret-material gate fires before dialing);
exit 3 `CONTROL_UNAVAILABLE` (ENOENT on the dead endpoint); `status`
prints `readiness=degraded` — never `ready`; operator-side `status` →
`ready`, `runtime.snapshot` → committed receipt, member-scoped
`inbox.check` under an operator credential → rejected `UNAUTHENTICATED`.
No fabricated success anywhere in the matrix.

**4. Output retention, reconnect cursors, passive resize, stale leases.**
Procedure: interactive bash pty `seq 1 120000` (a `/bin/cat` input-flood
was tried first — canonical tty input queues dropped the payload, so no
output was produced; the incident is retained as F-045 evidence) →
snapshot → attach with stale cursor / mid-window cursor / bogus epoch.
Expected: bounded retention with explicit truncation, gap metadata on stale
cursors, tail replay on mid-window cursors, snapshot+gap on stale epochs.
Observed: the ring honestly truncated — `truncated=true`,
`droppedThrough=60`, retained window 61..176 (~512 KiB) — but the mahasd
adapter **drops all of it**: every `terminal.attach` returns `gap:null,
replayFromSequence:null` (F-038) and `outputEpoch` never surfaces (F-039);
a string `outputEpoch` input throws a TypeError that escapes as
`status=unknown, code=CONTROL_UNAVAILABLE`. Lease matrix verified:
input without lease / stale revision / foreign principal / expired lease →
`STALE_REVISION`; foreign claim of a live lease → `OPERATION_CONFLICT`;
expired lease re-claimable (rev 1→2); passive resize → `STALE_REVISION`,
owner resize commits and the snapshot reflects 100×30.

**5. Hook/turn-complete/silence/survival ≠ Task success.** Procedure:
attempt `observation.ingest` (the only hook-ingress op name) + inspect
execution state after live process + full terminal I/O. Observed:
`observation.ingest` → `UNAVAILABLE_OPERATION` — no hook ingress exists at
this revision, so no event can be written at all; the seeded execution
projects `state=ready` (not success) while `liveness=live`; the
`observations` table stays empty; terminal traffic never re-typed the row.
The causal claim is vacuously verified — there is no path by which a hook
event could create success — but a real hook-pipeline run is unexecuted
(no such pipeline exists in the pinned implementation).

**6. Disconnect/subscription ownership.** Procedure: client holds a live
subscription + claim → socket close → inspect durable rows → reconnect.
Expected: binding/lease durable; fresh subscription on re-attach; replay of
missed events. Observed: binding + lease survive the dead session; the
abandoned sub detaches + releases the orphaned lease; re-attach mints a
fresh sub; `runtime.subscribe{after:seq0}` replays the 3 missed events
(detached, lease.released, attached). Host-side: a subscription owned by a
dead host conn can never be detached — `SCOPE_DENIED` forever (F-041);
`client.view.unbind` removes the binding but never calls `host.detach`
(F-042); cross-conn detach of a live sub → `SCOPE_DENIED`, owning conn
detaches fine.

## findings confirmed at this revision

(new findings numbered from F-038 — F-033…F-037 are already allocated to
VER-08/VER-10-prep records)

**F-038 — terminal output gap/replay contract mismatch; clients can never
see output loss.** `host.terminal.attach` returns
`{gap:{droppedThrough}, replay:[…chunks]}` but mahasd's `extractGap` only
recognizes `{expectedSequence, availableFromSequence}` and the replay array
is never forwarded — every `terminal.attach` answer carries
`gap:null, replayFromSequence:null` even when the ring dropped 60
sequences. A reconnecting client cannot detect truncation or recover the
missing tail. Evidence: `p5-overflow-b` (3 fails), every attach receipt in
`p4-terminal-b`. Owner: IMP-16/IMP-17 (client↔host terminal contract).

**F-039 — `outputEpoch` silently dropped + string-epoch input escapes as a
control-plane error.** The host's epoch is a string (`emu7lke4p-3`); the
client response builder reads it with `optNumber()` → `outputEpoch` is
`undefined` in every attach result, so epoch-based cursors are unusable.
Passing a string epoch throws a TypeError that surfaces as
`status=unknown, code=CONTROL_UNAVAILABLE` — a client input defect
misreported as control-plane failure. Evidence: `p4-terminal-b` (epoch
check), `p5-overflow-b` (stale-epoch attach). Owner: IMP-17.

**F-040 — retargeting a bound view loses subscription ownership → foreign
detach commits.** `terminal.attach` on a view already bound to another
terminal swaps the binding row but does not store the new subscriptionId —
`getBindingBySubscription` can no longer resolve the owner, so
`terminal.detach` from a different principal skips the ownership check and
**committed the release of another client's live stream**. Evidence:
`p4-terminal-b` retarget checks (binding.sub=null vs live sub, foreign
detach committed). Owner: IMP-16.

**F-041 — subscriptions owned by dead host connections are permanent
orphans.** `dropConnection(connectionId)` exists in `terminal-stream.ts`
but the RPC close path only removes the conn from `conns` — it never calls
it. A sub whose owning conn died can never be detached (`SCOPE_DENIED` from
every other conn) and is uncollectable until host restart. Evidence:
`p6-disconnect-b2`. Owner: IMP-17.

**F-042 — `client.view.unbind` never releases the host subscription.** The
handler deletes the binding row without calling `host.terminal.detach` —
the sub stays live on mahasd's host conn, still owning buffer/stream
resources. Evidence: `p6-disconnect-b2` (post-unbind detach from a foreign
host conn → `SCOPE_DENIED`; mahasd's own detach still works). Owner: IMP-16.

**F-043 — escalate-stop re-verify conflates natural death with pid reuse.**
`stopProcess` `send('SIGKILL')` re-verifies identity *after* the SIGTERM
grace window (`stop-controller.ts:96-104`); a process that exited during
the window hits `stat null → PROCESS_UNVERIFIABLE 'identity changed before
signal'`. The SIGTERM actually killed it — the outcome is misreported and
the row is left `stop_unknown`. Reproduced on two consecutive drills.
Related edge: a zombie still reads `live` (stat present, starttime
matches). Evidence: `p7-hostlife` (threw=PROCESS_UNVERIFIABLE,
row=stop_unknown). Owner: IMP-17.

**F-044 — a dead host session inside mahasd is never re-dialed.**
`localSession` remains a non-null corpse after the host socket dies and the
host reboots; every `terminal.*` → `CONTROL_UNAVAILABLE` forever, and
`runtime.reconcile` — the in-band repair path — rejects
(`UNAVAILABLE_OPERATION` on world-B dispatch; `ERR_SQLITE_ERROR` on world-A
— F-005 still stands). Only a fresh compose re-attaches. This is the
session-level confirmation of the F-014 dead-reattach path and the standing
explanation for the world-A blockage below. Evidence: `p7b-mahasd-life`,
`p4-terminal-a`. Owner: IMP-16/IMP-17.

**F-045 — host write path spins on a flooded/dead consumer.** After the
(invalid) `/bin/cat` input flood, the world-B host went ~80% CPU with
~932M write syscalls and stopped answering `host.hello`; it stayed wedged
~16min until killed. The flood itself was not a valid overflow workload —
but a bounded terminal writer that can burn a core on a dead/full
connection is a real backpressure defect. Evidence: `p5-hostwedge.json`.
Owner: IMP-17.

**Reconfirmed:** F-007 — pty spawn commits `state='unknown'` (FK ordering),
the orphan terminal is deaf (no onData wiring: `lastSequence=0`, zero
`terminal.data` pushes, empty snapshot) and is unrecoverable after restart
(`NOT_FOUND` — process alive, terminal identity lost); F-005 — reconcile
rejected on both worlds; F-014 — mahasd-side reattach is dead code,
mechanism reproduced end-to-end (F-044); F-036 — socket-frame
deserialization observed again in the field (a pipelined first call raced
hello once during early runs — fail-safe, nondeterministic).

## verified-correct behavior

- **Process incarnation survives host death**: pipes child re-probes `live`
  with identical pid+birthEvidence+pgid across a SIGKILL→restart cycle —
  retained, not respawned; new `hostIncarnation`; lease epoch self-advances.
- **Honest terminal recovery**: persisted `host_terminals` rows re-attach
  with identity+cursor; buffer declared empty (`droppedThrough=lastSequence`)
  rather than fabricated; stale cursor → explicit `gap{droppedThrough}` at
  the host layer; input → `PROCESS_UNVERIFIABLE` when no live handle exists.
- **Real terminal I/O end-to-end** (client→mahasd→host→pty): observe/claim
  attach, input admitted, typed marker on snapshot screen, owner resize
  commits + reflected, detach releases lease+sub but keeps binding, process
  survives view detach, other viewers unaffected, re-attach mints fresh subs.
- **Lease discipline**: no-lease/stale/foreign/expired input →
  `STALE_REVISION`; live-lease steal → `OPERATION_CONFLICT`; passive resize →
  `STALE_REVISION`; expired lease honestly reported (`details.expiredAt`)
  and re-claimable; `leaseVerified:false` honestly surfaces when no
  authoritative verifier is wired.
- **Bounded retention**: 512 KiB ring truncates honestly
  (`truncated`, `droppedThrough`) — no false completeness at the host.
- **Disconnect durability**: bindings and input leases are durable state,
  not session state; abandoned subs remain detachable; pull-model replay
  (`runtime.subscribe{after}`) delivers missed domain events.
- **Idempotency guard**: same operationId + different payload →
  `OPERATION_CONFLICT` (the collision that broke the first disconnect run
  was the receipt fingerprint check doing its job).
- **Worker CLI honesty**: exit 4/3 codes, `degraded` readiness, permission
  gate on credential files, member-scope refusal — no fabricated success.
- **Scope honesty**: member surface hides all client/terminal/runtime ops;
  `observation.ingest` unregistered; foreign detach of a resolved binding →
  `SCOPE_DENIED`.
- **Teardown honesty**: verified stop outcomes (`exited`,
  `already-exited`), hosts exit on SIGTERM, execution rows untouched by
  process death — stored `liveness` is a claim, not live truth.

## blocked / not-run (honest)

| item | status | reason |
|---|---|---|
| world-A live `terminal.*` ops | blocked | world-A mahasd's host session is dead (pre-existing F-044/F-014 condition) — every call honestly rejects `CONTROL_UNAVAILABLE`; identical code path exercised on world-B instead (`p4-terminal-b`) |
| renderer-level UI close/reopen + detached-window movement | not-run | the Electron renderer is not part of this pinned revision; the backend claim it rests on (view detach ≠ process death, re-attach preserves identity) is verified at the RPC layer; prior `records/orchestration/client-probe.md` + `ver-drill.md` evidence cited |
| hook event → Task success causal run | unexecuted | no hook ingress exists at `83a6d21` (`observation.ingest` → `UNAVAILABLE_OPERATION`); the survival≠success half is verified by projection + table inspection |
| reconnect with retained-cursor replay | blocked (contract) | host emits replay but the mahasd adapter drops it (F-038) — the client-visible behavior is a finding, not a pass |
| stale `outputEpoch` attach | blocked (contract) | string epochs crash the response path (F-039) |
| dead-session repair via `runtime.reconcile` | blocked | rejected on both worlds (F-005/`UNAVAILABLE_OPERATION`) |
| rejected-op receipt replay | observed, not asserted | `operation_receipts` persists only committed ops — replaying a rejection is impossible; recorded as an observation, spec intent unclear |
| SIGHUP-vs-retention for pty children | informational | pty children may die with their host (master fd gone) — recorded, not asserted; pipes children are the reliable retention vehicle |

## verdict

**failed.** The lifecycle core is genuinely strong: process incarnation
survives host death and re-probes with identical evidence; leases,
disconnect durability, bounded retention, subscription ownership scoping,
worker-CLI honesty, and the survival≠success boundary all hold under real
sockets, real ptys, and real kills. But the client-facing terminal layer
has independently-reproduced contract breaks at `83a6d21`: output-loss
metadata is emitted by the host and silently dropped by mahasd (F-038,
F-039), a retargeted binding loses subscription ownership so a foreign
client can kill another client's stream (F-040), dead-connection and
unbind-leaked subscriptions are uncollectable (F-041, F-042), escalate-stop
misreports natural death as identity loss (F-043), a dead host session is
never re-dialed (F-044), and the host write path can wedge on a flooded
consumer (F-045). Eight new findings routed to IMP-16/IMP-17; re-run
p4/p5/p6/p7 after the owning IMPs land fixes.
