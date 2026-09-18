# ver-drill — hostile-restart orchestration drills (preliminary evidence)

> **Status:** preliminary orchestration evidence note feeding VER-06/07/08
> (reattachment, recovery, operations). This is **not** a formal VER record —
> verdicts below are drill observations, not conformance sign-off.

## Scope & environment

| | |
|---|---|
| Code under test | pristine worktree `/tmp/mahas-ver-drill/src` @ `83a6d21` (`mahas-architecture` baseline), plus one delta check against the live worktree |
| Runtime | Node `v24.20.0` (direct `.ts` execution, builtin `node:sqlite`); no npm install/build |
| Isolation | all state under `/tmp/mahas-ver-drill/` (config, config2, config3, logs/, evidence/, bin/host-call.mjs). Nothing under `~/.config` or the sibling's `/tmp/mahas-ver-infra/` was touched |
| Entrypoints | `node packages/mahas-runtime/src/main.ts` (mahasd), `node packages/mahas-execution-host/src/main.ts` (host), `node packages/mahas-cli/src/main.ts` (CLI) |
| Evidence | daemon stdout NDJSON in `/tmp/mahas-ver-drill/logs/`, request captures in `evidence/req-*.json`, durable state in `config/mahas.sqlite` |

Baseline (healthy): host pid 374221 incarnation `76c22953` + mahasd epoch 1 pid 374262, `host-attached leaseEpoch:1`, `reconcile.pass decisions:0`, `ready` (`logs/mahasd-1.log`, `logs/host-1.log`).

## Per-drill summary

| # | Scenario | Expected | Observed | Verdict |
|---|----------|----------|----------|---------|
| 1 | `kill -9` execution host while mahasd runs | mahasd survives; host judged unreachable; restarted host reattached or honestly unresolved | no crash cascade; host restart republishes under a **new incarnation** (`dd300141`) and mahasd re-attaches on **its own next boot** (`host-attached leaseEpoch:2`). Live reattachment could not be exercised: `runtime.reconcile` RPC is dead on arrival (D-02) and attach is not spontaneous | **PARTIAL** |
| 2 | `kill -9` mahasd mid-boot (DB open, pre-ready) + stale lock | reboot reconciles cleanly; stale lock safe | epoch-3 instance killed mid-boot was marked `crashed` by epoch-4 boot (`process verdict: dead`); a fabricated lock on a live pid was refused `LOCK_UNVERIFIABLE` — no takeover on a guess | **PASS** |
| 3 | boot vs. dead socket file, no listener | honest degraded verdict, no crash, no fake-ready | **3a** endpoint-file present + dead socket: mahasd **crashes** — unhandled `ECONNREFUSED` re-emitted on a `readline` Interface (twice, epochs 6–7). **3b** endpoint-file absent + dead socket: `host-absent` → `ready` `unresolved:1` `blockers:[host:…]` — honest, but evidence rendered `[object Object]` | **FAIL** (3a crash is the realistic stale-endpoint case) |
| 4 | two mahasd on one DB | second refused; single writer enforced | same config dir: second exits `ALREADY_RUNNING` naming lock+pid — **pass**. Different config dir, **same DB file**: second daemon takes its own lock, opens the shared DB, marks the **live** epoch-9 instance `interrupted`, publishes its own endpoint and serves ops concurrently | **FAIL** (cross-config split-brain) |
| 5 | `host.process.spawn` → `kill -9` mahasd → reboot | execution tracked through resume/reattach/unknown | spawn OK — `exec-drill5` pid 454058 `pgid:454058` birth `6911239`; child survived mahasd SIGKILL (detached by design). Host kept inventory and positively probed it live. mahasd reconcile never obtained inventory (token-less hello, D-01) → `left-unknown`, exec stays `awaiting_join`/`unverifiable` | **FAIL** (persistence yes, reattach no) |
| 6 | SIGTERM mahasd → reboot | staged shutdown record; clean reboot; resume | `mahasd.signal`→`shutdown.recorded`→`teardown`→`stopped`; durable `runtime_shutdowns` row `completed` with 5 stages + `left-running` residual for `exec-drill5`. Reboot epoch 14 clean, epoch-13 stays `stopped` (not re-marked — correct), exec still `unverifiable` — no resume | **PARTIAL** (shutdown pass, resume fail) |

---

## Drill details

### Drill 1 — hostile host kill (`kill -9` host, mahasd keeps running)

- **Setup:** host pid 374221 (incarnation `76c22953`) + mahasd epoch 1, attached.
- **Action:** `kill -9` the host; observe; restart the host.
- **Expected:** mahasd unaffected by host death; no fake "exited" verdicts for host processes; restarted host either reattached or honestly unresolved.
- **Observed:**
  - Immediate host restart attempt was refused `ENDPOINT_IN_USE` — "a live execution-host already answers" (`logs/host.log`). Positive-liveness check on the socket, safe behavior; retry after the dead endpoint was cleared succeeded.
  - Restarted host published a **new** incarnation `dd300141` pid 385159 (`logs/host.log`) — incarnation rotation works, so "same pid/different boot" is detectable.
  - mahasd did not crash; on its next boot it re-attached under `leaseEpoch:2` (`logs/mahasd.log` epoch-2 block).
  - **Live** reattachment could not be exercised: `runtime.reconcile` over RPC always rejects `ERR_SQLITE_ERROR` (D-02), and a host appearing after mahasd's boot is not attached spontaneously (lazy attach, also noted in `ver-infra.md`).
- **Verdict:** PARTIAL — safe degradation and incarnation handling; reattach path not demonstrable on the live daemon.

### Drill 2 — hostile mahasd kill mid-boot + stale lock

- **Action:** `kill -9` mahasd after DB open / before ready (epoch-3 instance pid 384740 left a `runtime_instances` row but no `ready` line — `config/mahasd-boots.log` shows `boot` without `ready` for mid-boot deaths); reboot; separately fabricate `mahasd.lock` pointing at a live pid.
- **Expected:** next boot marks the dead prior `crashed`; refuses to break a lock it cannot verify.
- **Observed** (`logs/mahasd.log`):

```json
{"t":"reconcile.prior","targetId":"rt-ab272e88-…","decision":"marked-crashed","evidence":"prior controller epoch 3 process verdict: dead"}
{"t":"mahasd.boot-failed","code":"LOCK_UNVERIFIABLE","error":"lock holder pid 387520 answers but birth evidence cannot be verified — refusing to take over on a guess"}
```

- `runtime_instances` final states corroborate: epochs 1–8, 11–12 `crashed`; only `stopped`/`ready`/`interrupted` rows carry other states — dead priors are never resurrected.
- **Verdict:** PASS — reconciliation is honest, lock takeover requires verifiable death.

### Drill 3 — stale socket, no listener

- **3a — endpoint file present, socket dead** (the realistic stale-endpoint case): booted twice (epochs 6, 7); both died identically (`logs/mahasd.log`):

```text
node:events:505  throw er; // Unhandled 'error' event
Error: connect ECONNREFUSED /tmp/mahas-ver-drill/config/execution-host.sock
Emitted 'error' event on Interface instance at:
    at Socket.onerror (node:internal/readline/interface:264:10)
```

  The daemon dies mid-startup — no degraded verdict, no `boot-failed` line; the orphaned `starting` instance row is only marked `crashed` by the *next* boot. Root cause D-03.
- **3b — endpoint file absent, socket file present:** honest degraded boot (epoch 8):

```json
{"t":"mahasd.host-absent","detail":"no endpoint file — not attached"}
{"t":"reconcile.pass","epoch":8,"decisions":1,"unresolved":1}
{"t":"mahasd.ready","epoch":8,"unresolved":1,"blockers":["host:host-pyosechang-MS-7D76"]}
```

  `runtime.status` showed `reachable:false` / `host-unreachable` — but the user-facing reason rendered as `[object Object]` (D-05).
- **Verdict:** FAIL — the variant most likely to occur in the field crashes the daemon.

### Drill 4 — single-writer enforcement (two mahasd, one DB)

- **Same config dir:** second boot refused, exit code 3 (`logs/mahasd-dup.log`):

```json
{"t":"mahasd.boot-failed","code":"ALREADY_RUNNING","error":"mahasd already running (pid 391003, lock /tmp/mahas-ver-drill/config/mahasd.lock)"}
```

- **Different config dir (`config2`), same `mahas.sqlite`:** second daemon booted fully (`logs/mahasd-dup2.log`):

```json
{"t":"reconcile.prior","targetId":"rt-1b9076d1-…","decision":"marked-interrupted","evidence":"prior controller epoch 9 process verdict: alive"}
{"t":"mahasd.endpoint-published","endpoint":"…/config2/mahasd.sock","pid":391690,"epoch":10}
{"t":"mahasd.host-attach-failed","detail":"recorded controller for epoch 9 is verifiably alive — takeover refused (TTL expiry is not evidence)"}
{"t":"mahasd.ready","epoch":10,"unresolved":1,"blockers":["host:host-pyosechang-MS-7D76"]}
```

  Both daemons stayed up and served their own sockets while sharing `mahas.sqlite`. The **host-layer** defense held — the impostor's lease takeover was refused on positive-liveness grounds — but the **control-plane** single-writer invariant failed: the DB was marked up by a second writer (epoch-9 row still shows `interrupted` despite its process being alive). Root cause D-04.
- **Verdict:** FAIL — per-config-dir locking does not cover same-DB-across-configs.

### Drill 5 — process tracking through mahasd death

- **Action:** via `bin/host-call.mjs` (`evidence/req-spawn.json`): `host.process.spawn` `exec-drill5` → `/bin/sleep 600`; `kill -9` mahasd (epoch 11, pid 453807); reboot (epochs 12–14); inspect host inventory + control DB.
- **Observed:**
  - Spawn succeeded: child pid `454058`, `pgid:454058`, birth evidence `6911239`; the child **survived mahasd's SIGKILL** — detached-by-design confirmed.
  - `host.inventory` retained the row; direct `host.process.probe` (`evidence/req-probe.json`) returned **live** with pid/birth/pgid match.
  - mahasd-side, with no `executions` row present, startup reconcile produced `decisions:0` — the live host-side process was invisible (no orphan sweep; `recovery/reconciler.ts` exists but is not wired into `runReconcile`).
  - With a synthetic `executions` row inserted (pre-kill `state:'awaiting_join'`, `liveness:'live'`), the epoch-13/14 reconciles produced exactly one decision: `left-unknown` — `host host-pyosechang-MS-7D76 gave no inventory`. The row was demoted `live`→`unverifiable`, `revision` 1→2.
  - Root cause (D-01): the reconcile host-probe sends `host.hello` **without** the endpoint credential → `UNAUTHENTICATED` → probe error swallowed (`reachable:true`, no host decision recorded) → inventory never fetched → every execution judged `left-unknown`. The token-less hello fails deterministically; through `runtime.reconcile`/startup reconcile the reattach path is dead code.
- **Verdict:** FAIL — durable tracking and process persistence work; control-plane reattachment does not.

### Drill 6 — SIGTERM staged shutdown → reboot

- **Observed** (`logs/mahasd-pristine.log`, epoch 13 → 14):

```json
{"t":"mahasd.signal","signal":"SIGTERM"}
{"t":"shutdown.recorded","operationId":"shutdown-446586df-…","mode":"leave-executions","residuals":1}
{"t":"mahasd.teardown"} / {"t":"mahasd.stopped"}
```

  Durable `runtime_shutdowns` row: `state:'completed'`, stages `admission-stopped/stop-intents:skipped/evidence-recorded/resources-preserved/db-checkpoint-close` all `completed`, residual:

```json
{"kind":"execution","id":"exec-drill5","disposition":"left-running",
 "detail":"left on host host-pyosechang-MS-7D76 — process keeps running; control unavailable until next reconcile"}
```

- Reboot epoch 14: `host-attached leaseEpoch:14`, `reconcile.pass decisions:1 unresolved:0`, `ready`. Prior epoch 13 stayed `stopped` — terminal states are correctly skipped by prior-marking (not re-marked `crashed`/`interrupted`). `exec-drill5` remained `awaiting_join`/`unverifiable` — no resume, same D-01 root cause.
- **Verdict:** PARTIAL — staged shutdown is clean and honest; post-reboot execution resume fails.

---

## Notable defects

Line numbers refer to the **pristine** tree (`/tmp/mahas-ver-drill/src`, `83a6d21`).

### D-01 — reconcile host-probe never authenticates; reattach path is dead code *(critical)*

- `lifecycle/reconcile.ts:198-208` — probe calls `host.hello` with `controllerIdentity`+`challenge` but **no `credential.token`**.
- `composition.ts:424` — `connectHost` for reconcile is `hostClientByEndpoint(endpoint)` → a **fresh, unauthenticated** connection (the composition session's auth is not borrowed on pristine).
- `packages/mahas-execution-host/src/host.ts:456-460, 502-513` — host requires `credential.token === authToken` on `host.hello`; everything else requires an authenticated session.
- Result: `UNAUTHENTICATED` at hello → `result.error` set at `reconcile.ts:276` → **swallowed**: `reachable:true`, `lease`/`leaseError`/`protocolMismatch` all unset → falls through every host branch (`:437-470`) producing **no host decision and no unresolved entry** → `judgeExecution` sees `!inventory` → `left-unknown`/`gave no inventory` (`:316-322`).
- Consequence: executions can never reattach through `runtime.reconcile`/startup reconcile; `recovery/reconciler.ts` + `recovery/orphan.ts` are unreachable from this path (orphan host-side processes are invisible: `decisions:0` with a live child in inventory).

### D-02 — `runtime.reconcile` RPC always fails `ERR_SQLITE_ERROR` *(high)*

- `api/admission.ts:254` wraps every op in `runInTransaction` (`:116`, raw `BEGIN DEFERRED|IMMEDIATE`) — **not** tracked in `withTx`'s `txDepth` (`storage/transaction.ts:26`).
- `lifecycle/lifecycle.ts:148-167` — `reconcile(scope, txDb)` receives the dispatch connection but ignores it: `void txDb // nested-tx fallback reserved` (`:167`).
- `runReconcile` then opens `deps.withTx(deps.db)` (`reconcile.ts:536`) on the **same connection already inside the admission tx** → `BEGIN IMMEDIATE` inside an open transaction → `ERR_SQLITE_ERROR`, surfaced to the client as generic "SQL logic error".
- Reproduced on pristine **and** on the live worktree. Corroborated independently by `records/orchestration/ver-infra.md` ("Verified failure modes" §1).

### D-03 — mahasd crashes on stale host endpoint file (unhandled readline `'error'`) *(high)*

- `hostClient.ts:146` — `createInterface({ input: sock })` gets **no** `rl.on('error')` handler. The socket-level handler at `:130` rejects the connect promise, but `readline` re-emits the socket error as an Interface `'error'` event → unhandled → process death (`node:internal/readline/interface:264`).
- Effect: boot against a stale `execution-host.sock.endpoint.json` + dead socket kills mahasd mid-startup; no degraded verdict, no `boot-failed`; the orphaned `starting` instance row is only cleaned by the next boot. Reproduced twice on `83a6d21` (epochs 6, 7) **and** on the live worktree (`logs/mahasd-fixtree.log`). Corroborated by `ver-infra.md` §2.

### D-04 — cross-config-dir split-brain on a shared control DB *(high)*

- `mahasd.lock` is scoped to the config dir (`lifecycle/service-bootstrap.ts`, `main.ts`); `openControlDb` (`storage/database.ts:39`) applies no DB-level single-owner check that survives a second config dir.
- A second mahasd with `--config-dir config2 --db <same mahas.sqlite>` acquires its own lock, allocates epoch 10, and marks the **verifiably alive** epoch-9 controller `interrupted` — `reconcile.ts:684` maps `verdict:'alive'` → `'interrupted'` and records it instead of refusing, exactly the "cannot coexist with our held lock" case its own comment says is handled "before this runs" — except the held lock was a *different* lock.
- Host lease defense held (`takeover refused — verifiably alive`), but both daemons served ops and wrote the shared DB. Single-writer is enforced per config dir, not per database.

### D-05 — `[object Object]` in user-facing evidence *(low)*

- Thrown non-`Error` values (`{code,message}` MahasError-shaped objects) hit `String(err)` fallbacks and render `[object Object]` — observed in drill 3b's `unresolved`/reason output. Sites: `reconcile.ts:242`, `:270`, `:276`; same `instanceof Error ? .message : String(err)` pattern repeats across the codebase.

### D-06 — fresh control DB strands the host lease; attach failure invisible to readiness *(medium)*

- `host.acquire` refuses `epoch < stored` (`STALE_EXECUTION`, `packages/mahas-execution-host/src/lease.ts`). A mahasd on a **fresh** `mahas.sqlite` restarts at epoch 1; demonstrated live: `controllerEpoch 3 is behind current lease epoch 14` → `host-attach-failed`. Losing the control DB permanently strands every outstanding host lease — no re-proving path except an explicit handoff token or deleting the lease row.
- The attach failure is compose-time, so it produces **no** reconcile decision: `mahasd.ready unresolved:0 blockers:[]` while `host:null` — a silently degraded `ready`.

### D-07 — `host.process.spawn` with `spec.pty` → terminal-row FK violation *(info)*

- Reported by the sibling drill run (`ver-infra.md` §3): pty spawn writes the process but the `host_terminals` INSERT violates FK ordering → spawn receipt `unknown`, `host.terminal.*` unusable. Not exercised here (non-pty spawn path is healthy).

---

## Fix-tree delta check (live worktree, `a9dcd65` + uncommitted changes)

Booted the **working tree** against `config3` to see which defects the in-flight rewrite already addresses:

- **D-03 still reproduces** — stale endpoint file → identical unhandled readline `ECONNREFUSED` death (`logs/mahasd-fixtree.log`).
- **D-02 still reproduces** — healthy fix-tree mahasd, `mahas runtime reconcile` → `rejected ERR_SQLITE_ERROR` (`txDb` still ignored in the rewritten lifecycle).
- **D-01 partially patched** — `lifecycle/reconcile.ts:233-244` (worktree) now catches `UNAUTHENTICATED` on the token-less hello and synthesizes a degraded hello, and `:323` adds a per-execution `host.process.probe`. Caveats: it substitutes the **stored** row incarnation for `hostIncarnation` (so `incarnationMatch` reads `same` without a live check) and still presents no credential — it only works where `connectHost` yields an already-authenticated borrowed session.
- New on fix tree: `mahasd.endpoint-published` now carries a `workerEndpoint` (`mahasd-worker.sock`).

## Process hygiene

All drill-spawned processes were killed and verified gone:

| process | pid | disposition |
|---|---|---|
| execution host (pristine) | 453783 | `kill -9` |
| mahasd epoch 14 (pristine) | 455205 | `kill -9` |
| detached drill child `sleep 600` | 454058 | `kill -9` |
| fix-tree mahasd (config3) | 455490, 455965 | `kill -9` / SIGTERM |
| blackhole listener | 384608 | dead (already) |

`pgrep -af mahas-ver-drill` → no matches; `pgrep -af "sleep 600"` → no matches. The user's real Mahas install (`/opt/Mahas/…`) and the sibling's `/tmp/mahas-ver-infra/` processes were never touched.

## Artifacts

- This note: `mahas-architecture/records/orchestration/ver-drill.md` (only repo file written).
- All runtime state/logs/helpers: `/tmp/mahas-ver-drill/` (`logs/`, `evidence/`, `bin/host-call.mjs`, `config*/`).
- Pristine source: `/tmp/mahas-ver-drill/src` @ `83a6d21` (git worktree; `node_modules` symlinked).
