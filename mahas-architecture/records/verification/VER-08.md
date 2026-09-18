---
taskId: VER-08
codeRevision: 83a6d21
specRevision: 99eb5f5
verdict: failed
---

# VER-08 — 종료·자원 인계·업데이트·운영 복구 검사 (shutdown / resource handoff / update / operational recovery)

VerificationRecord for the operational lifecycle contracts — REQ-12, REQ-14,
REQ-15, REQ-16, REQ-27 against `spec/contracts/recovery-operations.md`,
`spec/contracts/resources.md`, `spec/execution-lifecycle.md`,
`spec/storage.md`. Executed against a clean detached copy of `83a6d21` in
`/tmp/mahas-ver-08/src` — the main worktree's unrelated WIP was never touched
and the pinned implementation was not modified. All daemons were spawned fresh
under `/tmp/mahas-ver-08/`; the shared VER-03 world was never used for
shutdown/crash drills.

## environment

| 항목 | 값 |
|---|---|
| code revision | `83a6d21` (coordinator handoff, all 32 IMPs landed) |
| spec revision | `99eb5f5` |
| runtime | node v24.20.0, `node:sqlite` (SQLite 3.53.4) |
| OS | Linux 7.0.0-31-generic x86_64 |
| world-a | real `mahasd` + real `execution-host`, `/tmp/mahas-ver-08/world-a/config/` — unix-socket RPC target, killed & rebooted repeatedly (epochs 1–6) |
| world-schema | `/tmp/mahas-ver-08/world-schema/{empty,newer,unmanaged,foreign}/config` — schema-gate boots |
| world-crash | `/tmp/mahas-ver-08/world-crash/config` — crash-loop admission (schema-broken DB) |
| world-proto | `/tmp/mahas-ver-08/world-proto/{vmismatch,live,stale,lock}/config` — endpoint/lock assessment boots |
| world-restore | `/tmp/mahas-ver-08/world-restore/` — backup restore target + restored-world boot (epoch 7) |
| shutdown modes | `runtime.shutdown` op, `leave-executions` + `drain-and-stop`; OS scope = unix-domain socket daemons, no service manager |

## dependencies

| task | status |
|---|---|
| VER-02 | done — `records/verification/VER-02.md` (verdict failed; F-003/F-004 cited below) |
| VER-06 | pending — no record in `records/verification/` at report time |
| VER-07 | pending — no record in `records/verification/` at report time |

## probe inventory

| artifact | checks | result |
|---|---|---|
| `out/s1-shutdown.json` | 24 | **all pass** — leave-executions: durable receipt→exit 0, identity-scoped file cleanup, host+child survive, claims preserved |
| `out/s2-drain.json` | 15 | **all pass** — drain-and-stop: admission closes, stop-intents stage honest (`stop-not-attempted`, caller unwired), targeted drain splits honestly |
| `out/s3-restart.json` | 20 | **all pass** — kill -9: stale files left, dead-controller window, lease fence matrix, impostor dead-evidence takeover, honest reboot |
| `out/s4-resources.json` | 24 | **all pass** — canonical checkout exclusivity (same/symlink/`/./` spellings), handoff/release matrix, abandon frees checkout |
| `out/s5-schema.json` | 9 | **all pass** — empty→v1 migration+receipt, newer/unmanaged/foreign-owner refusals with zero writes, crash-loop after 5 failed boots |
| `out/s6-protocol.json` | 15 | **all pass** — hello v0 refused, v999 negotiated to 1, envelope mismatch refused, host mutation-gate, endpoint-file verdicts, foreign-lock refusal |
| `out/s7-backup.json` | 14 | **all pass** — reconcile RPC defect reconfirmed, backup manifest sha-verified, restore guards, restored world boots degraded without writer authority |
| `out/s8-teardown.json` | 8 | **7/8** — final graceful stop + host stop + orphan kill verified; sweep check failed on a probe-harness artifact (matched its own bash wrapper) |
| `out/s8b-sweep.json` | 3 | **all pass** — post-teardown re-verification: zero VER-08 processes, all recorded pids dead, mahasd files gone |

Raw probe sources: `/tmp/mahas-ver-08/probe/{common,daemon,util,fixture,s1..s8b}.ts`.
Daemon logs: `/tmp/mahas-ver-08/logs/*.ndjson.*` (per-boot NDJSON, one file per spawn).
No secrets in evidence; credentials used were fixture-generated nonces and the
same-uid endpoint-file authToken (read from the probe's own world, not embedded
in evidence files).

### evidence digests (sha256, `/tmp/mahas-ver-08/out/`)

```
e6f4505986dc4d4cfc353d8250a3d5934a13c1ee60e08ccd369979cc2fa66264  s1-shutdown.json
32d0f42c5ec3fa3b4907b69b5ef7d4a5a340ac511e17653bd9e8f2dc9a229c94  s2-drain.json
81c0703fa870f4560611b2fd3b269b4b1978515f69dc492db4c1ddb8c231fffd  s3-restart.json
c8dbbde8ff2f02b06ecde04f74ca768cfa1a9c83c6fb5a89d44523eca3c1216f  s4-resources.json
4113ea9148e9325747b50fbdcc4a14369b96ab35ec713d07416b5051077b82f3  s5-schema.json
b0eece5b57ae41ee0192e24c8846853bdbd5e93243162c9f5ec79e117eb28fb6  s6-protocol.json
5af4d523419c76e697173345f61265a9bad46fc74706eb5f75dee0d7a009adfc  s7-backup.json
fb2c9d2ece6eaf5496c2f317b180e46c7eb1b49611b6f4448f80be71577da131  s8-teardown.json
d2a56a85d8943518e848cbdca2720e3c61c0c51d81db5b09643693b840ffa788  s8b-sweep.json
```

## confirmed new finding candidates (F-034+, owner referral)

**F-034 (new) — `workspace.prepare` commits a durable write-claim but its host
effect is never delivered — `effect_outbox` has no wired pump.**
`workspace.prepare` commits workspace+checkout+claim rows and stages a
`host.workspace.prepare` intent (`state='prepared'`), yet the only pump
(`recovery/reconciler.ts:626 drainEffectOutbox`) (a) drives only
`process.stop` kinds — `host.workspace.*` is `skipped-foreign` — and (b) is
never invoked from lifecycle/composition at `83a6d21`. Observed: two
`workspace.prepare` commits → `/tmp/mahas-ver-08/repo/` stayed empty,
workspaces frozen `prepare-unknown`, `filesystem_identity` stuck
`pending:<effectId>`, while the held claim keeps the canonical path
`RESOURCE_BUSY` for every later caller. The resource is wedged: claim held,
checkout claimed, physical resource never materialized, no settlement path.
Owner: IMP-16/IMP-30 (resource seam) — same unwired-caller class as F-027.

**F-035 (new) — `host_controller_lease.expires_at` is written but unenforced
on the mutation path.** `lease.ts:352 requireLeaseProof` checks epoch +
fenceToken but never `expires_at`, while `workspaces/common.ts:114
assertLease` refuses expired leases with `SCOPE_DENIED`. Observed (s3): with
the controller SIGKILLed, a direct host call bearing the dead epoch's
persisted fence token still confirmed `host.process.spawn` — the fence
survives indefinitely until a takeover. Takeover correctly requires
dead-evidence ("TTL expiry is not evidence"), but on the mutation side the
30s TTL is decorative: an expired-but-untaken lease keeps authorizing
process effects while refusing workspace effects — inconsistent expiry
semantics across two lease checks. Owner: IMP-17.

**F-036 (new) — mahasd RPC transport does not serialize frame handling;
calls pipelined behind `hello` race authentication.**
`local-server.ts:161` runs `void onLine(line)` per decoded line — frames are
processed concurrently, and `helloSeen` is set before `await authenticate`
resolves (`ctx` stays `null` until then). Observed twice: a call frame sent
in the same burst as `hello` was answered **before** `hello-ok` (ordering
inversion); the raced call landed either `unknown/CONTROL_UNAVAILABLE` (ctx
null) or `committed` (auth settled first) — timing-dependent, never a wrong
identity. Fail-safe but violates ordered-session semantics; any client that
pipelines hello+first-call gets nondeterministic results. Owner: IMP-11.

**F-037 (new) — `drain-and-stop` cannot issue worker stops — the stop-intent
caller is unwired.** The `stop-intents` shutdown stage records
`completed` while every open execution residual is `stop-not-attempted`
("no cross-domain caller wired (worker.stop is IMP-22) — intent not
issued"). Honest residuals (nothing is faked as stopped, executions stay
`unverifiable`, targeted drain splits `stop-not-attempted`/`left-running`
correctly), but at `83a6d21` drain-and-stop structurally cannot drain: the
stage name promises `worker.stop` issuance the runtime never performs.
Owner: IMP-22 (also see s2 evidence, all 5 residuals honest).

## findings reconfirmed / exercised

- **F-005 reconfirmed (socket-level):** `runtime.reconcile` over
  `mahasd.sock` still rejects `ERR_SQLITE_ERROR` (nested-tx defect — op
  registered `mutation:false`, internal `BEGIN IMMEDIATE`). Startup reconcile
  unaffected (runs inside boot, not through the op).
- **F-014 exercised (reattach dead):** after kill -9 and after restore,
  every seeded execution demoted `live→unverifiable` and none regained
  `live` — the token-less `host.hello` path gathers no inventory.
- **F-006 cited (stale host endpoint):** not re-drilled (ver-drill/ver-infra
  cover the mahasd crash on a stale execution-host endpoint file). The
  mahasd-side variant IS covered fresh here: s3 showed stale
  `mahasd.sock`/`.endpoint.json`/`.lock` reclaimed on reboot; s6 showed a
  fabricated dead-owner endpoint file replaced under a new incarnation.
- **F-015 cited (same-DB split-brain):** not re-drilled (ver-drill). Related
  gate exercised in s5: `schema_owner≠'control'` refuses — but that gate
  cannot cover two `control` daemons on one DB via different config dirs,
  which remains F-015's open scope.
- **F-017 exercised (lease reclaim):** the restored world's epoch-7 boot was
  refused host attach — "recorded controller for epoch 6 is verifiably
  alive" — and booted degraded with a `host:` blocker. Same family as
  F-017's never-reclaim: a behind-epoch controller gets no silent takeover.
- **F-027 cited:** `worker.prepare` unreachable — not re-run (needs the full
  model fixture; ver-drill/client-probe records stand).

## supported scope — verified at this revision

- **Graceful shutdown (leave-executions):** durable `runtime_shutdowns`
  receipt committed `in-progress` → async drain → process exit 0;
  `shutdown.recorded→teardown→stopped` in NDJSON; socket/endpoint/lock
  removed by **identity** (incarnation check); boot journal `stopped`
  marker; runtime instance → `stopped`; executions stay `live`
  (leave-mode), claims stay `held`; host + host-side children survive
  (pid/birth evidence). Second shutdown and mutations during drain are
  refused honestly (`CONTROL_UNAVAILABLE`); invalid mode →
  `INVALID_TRANSITION`.
- **drain-and-stop:** admission closes, stop-intents stage runs (F-037
  caveat: nothing actually issued), unknown executions preserved,
  `targetedExecutionIds` splits residuals honestly.
- **restart after graceful stop:** epoch advances, prior instance stays
  terminal (`stopped`, not re-marked crashed), endpoint incarnation changes,
  prior shutdown visible via `runtime.status`.
- **restart after kill -9:** stale socket/endpoint/lock left behind (crash
  window honest); killed epoch marked `crashed`; new incarnation/pid on
  endpoint file; stale lock reclaimed; no old/new identity mixing. In the
  dead-controller window the host still fences on the persisted lease:
  same-epoch foreign identity → `SCOPE_DENIED`, lower epoch →
  `STALE_EXECUTION`, higher epoch + dead-evidence → takeover granted
  (spec-correct); the impostor-leased boot stays honest (attach refused,
  degraded ready, no crash). Orphan host-side spawn remains invisible to
  control (no orphan sweep — D-01 territory).
- **resource handoff:** canonical-checkout exclusivity enforced across
  `same path`/`symlink`/`/./` spellings (`RESOURCE_BUSY`); `claim.handoff`
  refuses TTL/heartbeat-only evidence (`REQUIRED_ACTION_DENIED`, REQ-16),
  wrong owner (`INVALID_TRANSITION`), stale revision (`STALE_REVISION`),
  self-transfer; a valid handoff swaps owner atomically + records a
  confirmed `resource_transfers` row; `claim.release` refuses
  release **and** retain on live/unverifiable owners (`RESOURCE_BUSY`) —
  claims are never silently dropped; explicit `abandon` frees the claim
  (`released` + `claim.abandoned-risk-accepted` event; workspace would be
  `abandoned`); released claims are terminal for handoff; the canonical
  checkout becomes claimable **only** after explicit abandon.
- **schema/migration:** empty DB → v1 DDL + `migration_receipts` row in the
  migration tx; schema v99 → `boot-failed` + byte-identical DB (downgrade
  write-block proven by sha256); unmanaged schema (user tables, no
  `schema_meta`) → refused, nothing written; `schema_owner≠'control'` →
  refused; 5 unsettled boots → `CRASH_LOOP` admission refusal (operational
  protection, not work retry).
- **protocol:** hello v0 → `HOST_PROTOCOL_MISMATCH` + socket close; hello
  999 → negotiated `min=1`; call-envelope `pv≠1` → error frame, never
  dispatched; host session `supportedVersions∌0` → `host.hello` ok but
  mutations refused `HOST_PROTOCOL_MISMATCH` while reads still answer;
  envelope `pv=99` same gate. Endpoint file verdicts: live same-protocol →
  `ALREADY_RUNNING`, live different-protocol → `VERSION_MISMATCH`, dead
  owner → stale → replaced under new incarnation; live foreign lock →
  `ALREADY_RUNNING`, lock never stolen/unlinked.
- **backup/restore:** `backup.create` → manifest + `control.sqlite` image
  (sha256 verified against manifest) + host snapshot entries;
  `backup.restore` requires `expectedRuntimeStopped:true`, refuses the live
  DB path, restores to a scratch path marking `restored-unconfirmed`;
  restored image keeps all executions `unverifiable` and all claims
  as-recorded; the restored world's boot continues epochs honestly
  (e4→`crashed`, e6→`interrupted` — recorded owner verifiably alive),
  cannot take the live host lease, and grants no writer status (F-014).
- **process hygiene:** every VER-08-spawned process accounted for —
  mahasd pids 714962/715993/718701/718763, host 718295, sleep children
  718325/718721, impostor 718736, plus all scratch-world boots — dead or
  gracefully stopped; `ps` sweep empty (`s8b`).

## blocked / not-run

- `worker.prepare` reachability — not run (requires the full model fixture;
  covered by F-027, `orchestration/client-probe.md`).
- Live reattach happy-path — unreachable at this revision by F-014's
  design; evidence gathered indirectly via demotion observations.
- Stale **execution-host** endpoint crash (F-006), same-DB split-brain
  (F-015), lease-reclaim-blocked variant (F-017), pty FK defect —
  deliberately cited from `records/orchestration/ver-drill.md` and
  `records/orchestration/ver-infra.md` rather than re-drilled.
- `s8` check 8 (hygiene sweep) recorded a FAIL on a probe-harness artifact —
  the `ps` pattern matched the probe's own `bash -c` wrapper. Re-verified
  in `s8b` with a daemon-path-only pattern: zero leftovers.

## verdict

**failed** — the operational lifecycle spine is largely correct (shutdown
receipts vs real death, identity-scoped cleanup, crash windows, schema
gates, claim lifecycle, lease fencing, restore hygiene all verified), but
new defects were found at the seams: `workspace.prepare` effects are never
delivered (F-034), lease expiry is unenforced on the mutation path (F-035),
the RPC transport races pipelined calls (F-036), and drain-and-stop cannot
issue worker stops (F-037). Previously recorded operational defects
(F-005, F-014) reconfirmed or exercised; F-003/F-004/F-006/F-015/F-017/F-027
cited per existing evidence.
