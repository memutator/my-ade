# ver-infra — bootable control-plane recipe for VER tasks (proven end-to-end)

- Repo: `/home/pyosechang/projects/ade-wt-mahas-architecture`, branch `mahas-architecture`, HEAD `83a6d21` (+ `8f69594` records commit).
- Node: `v24.20.0` — runs `.ts` directly (type stripping); `node:sqlite` builtin. **No npm install/build/dev needed** — the three entrypoints import only `node:*` builtins and relative `.ts` files.
- Runtime state root: `/tmp/mahas-ver-infra/` — **all** state lives there (sockets, DBs, endpoint files, secrets, logs). `~/.config/mahas` and `~/.local/share` are never touched (`MAHAS_CONFIG_DIR` is honored by every entrypoint).
- Copy-pasteable boot script: `/tmp/mahas-ver-infra/boot-control-plane.sh` (stale-safe, idempotent). Host-RPC helper: `/tmp/mahas-ver-infra/host-call.mjs`.
- Raw daemon logs (append-only NDJSON): `/tmp/mahas-ver-infra/logs/{host,mahasd}.ndjson`. Prior-attempt logs archived under `logs/prior-attempt/`.

## TL;DR — does it work?

**Yes.** A fully isolated control plane boots in ~1s per daemon and serves real RPC over unix sockets: `mahas status` → `"readiness": "ready"`, 91 operations registered, operator credential auto-resolved, mutations commit with durable receipts (`operation get` replays them), restart reconciles cleanly onto the same DB with a monotonically increasing controller epoch.

**Degraded/broken at this HEAD (all verified live — see "Verified failure modes"):**
1. `runtime.reconcile` via RPC always rejects `ERR_SQLITE_ERROR` (nested-transaction bug). Startup/restart reconcile is unaffected.
2. mahasd **crashes** (unhandled `ECONNREFUSED`) when booting against a *stale* execution-host endpoint file (host dead, file left behind). Workaround: delete the stale file or start the host first — the boot script does this automatically.
3. `host.process.spawn` with `spec.pty` spawns the process but the terminal row INSERT violates its FK (ordering bug) → spawn receipt `unknown`, no `host_terminals` row → `host.terminal.*` unusable through this path. Non-pty spawn is fully healthy.
4. A host that appears *after* mahasd's boot is not attached spontaneously — attach is lazy (first host-needing op) or next mahasd restart. `runtime status` keeps reporting the stale mirror verdict until then.

## Exact recipe

### 0. Environment

```bash
export MAHAS_CONFIG_DIR=/tmp/mahas-ver-infra/config   # the ONLY env var strictly required
cd /home/pyosechang/projects/ade-wt-mahas-architecture
mkdir -p "$MAHAS_CONFIG_DIR" /tmp/mahas-ver-infra/logs
```

Every entrypoint resolves `configDir = --config-dir flag ?? $MAHAS_CONFIG_DIR ?? ~/.config/mahas`. Keep `MAHAS_CONFIG_DIR` exported for every CLI call too — the CLI reads the same dir (`connection.ts` `defaultConfigDir`).

### 1. Boot the execution host (FIRST — order matters)

```bash
node packages/mahas-execution-host/src/main.ts < /dev/null >> /tmp/mahas-ver-infra/logs/host.ndjson 2>&1 &
# (in the script: setsid … & — detaches from the spawning shell's process group)
```

- Flags: `--endpoint <path>` `--config-dir <dir>` `--db <path>` (defaults: `<configDir>/execution-host.sock`, `<configDir>/execution-host.sqlite`).
- **stdin caveat**: `process.stdin.on('end')` is a shutdown trigger (`src/main.ts:146`). A *paused* stdin never emits `end`, so `< /dev/null` is safe; do **not** put the daemon on a pipe that can close.
- Ready line (stdout NDJSON):

```json
{"t":"ready","hostId":"host-pyosechang-MS-7D76","hostIncarnation":"2556193f-…","protocolVersion":0,"endpoint":"/tmp/mahas-ver-infra/config/execution-host.sock","endpointFile":"/tmp/mahas-ver-infra/config/execution-host.sock.endpoint.json","dbPath":"/tmp/mahas-ver-infra/config/execution-host.sqlite","pid":379574,"endpointIncarnation":"…"}
```

- The **endpoint file** (`execution-host.sock.endpoint.json`, mode 0600) is what mahasd reads to find + authenticate to the host: `{service, protocolVersion, hostId, hostIncarnation, pid, birthEvidence, bootId, launchNonce, endpointIncarnation, endpoint, dbPath, authToken, publishedAt}`. `authToken` is required by `host.hello`.
- The **pid-of-record** is the endpoint file's `pid` field — never `$!` (a refused/late daemon can fork differently).

### 2. Boot mahasd (SECOND — it *attaches* to the host, it does not spawn it)

`composition.ts`: `composeRuntime()` → `attachHost(<configDir>/execution-host.sock)` → `readHostEndpoint()` → `helloHost` → `host.acquire` lease → mirror row in `execution_hosts`. No host is ever spawned by mahasd; `hostEndpoint` defaults to `<configDir>/execution-host.sock` (a `ComposeOptions.hostEndpoint` override exists but is not exposed via argv).

```bash
node packages/mahas-runtime/src/main.ts < /dev/null >> /tmp/mahas-ver-infra/logs/mahasd.ndjson 2>&1 &
```

- Flags: `--config-dir <dir>` `--endpoint <path>` `--db <path>` (defaults: `<configDir>/mahasd.sock`, `<configDir>/mahas.sqlite`).
- Readiness sequence on stdout (healthy, host present — real capture):

```json
{"t":"mahasd.host-attached","hostId":"host-pyosechang-MS-7D76","endpoint":"…/execution-host.sock","leaseEpoch":9}
{"t":"mahasd.composed","operations":91,"host":"host-pyosechang-MS-7D76"}
{"t":"mahasd.endpoint-published","endpoint":"…/mahasd.sock","pid":379628,"epoch":9,"incarnation":"…"}
{"t":"reconcile.pass","epoch":9,"decisions":0,"unresolved":0}
{"t":"mahasd.ready","epoch":9,"unresolved":0,"blockers":[]}
{"t":"mahasd.started","endpoint":"…/mahasd.sock","pid":379628,"epoch":9}
```

Order: crash-loop admission → `mahasd.lock` (single-writer) → DB open → endpoint-file verdict → controller epoch → `composeRuntime` (host attach, 91 ops) → RPC bind → endpoint file publish → **startup reconcile** → `mahasd.ready` (writable gate opens only after the pass *finishes*; unresolved blockers are allowed, reported honestly).

### 3. Use the CLI

```bash
MAHAS_CONFIG_DIR=/tmp/mahas-ver-infra/config node packages/mahas-cli/src/main.ts <verb…>
```

- Endpoint/credential resolution (`connection.ts`): role inferred (`MAHAS_ROLE`, or `MAHAS_CONNECTION_FILE` ⇒ worker, else operator) → operator reads `<configDir>/operator-connection.json` (written by mahasd at compose time, 0600; `{endpoint, credential:{kind:'operator'}}`) → falls back to `<configDir>/mahasd.sock` with `{kind:'operator'}`. `MAHASD_ENDPOINT` env and `--connection-file`/`--as` override.
- Verb→op mapping is dynamic from `surface.describe` — `mahas help` lists the live surface (91 ops for the seeded `operator-local` wildcard grant), `mahas help <op words>` shows a spec summary (server does **not** publish input schemas — read the handler source or use `--input`/`--set`).
- Payload: `--set k=v` / `--<key> <value>` (JSON-parsed) / `--input file.json` / trailing positionals (schema order). **Gotcha**: an empty-object payload (`--input` of `{}` with no other fields) is dropped — `buildPayload` returns `undefined`; ops that require an object (`inbox.check`, `run.create`…) then reject `INPUT_NOT_READY`. Pass at least one field.
- Output contract: stdout = exactly one JSON value (the `CommandReceipt`, or the status verdict); diagnostics on stderr; exit codes `0 committed · 1 rejected · 2 usage/unavailable-op · 3 control unavailable · 4 unauthenticated · 5 outcome unknown`.

### 4. Managed execution — how far you actually get

- **Direct host spawn works end-to-end.** `/tmp/mahas-ver-infra/host-call.mjs` speaks the host's NDJSON RPC: reads `authToken` from `execution-host.sock.endpoint.json` for `host.hello`, and reads mahasd's current lease fence (`epoch` + `proof_json.fenceToken` from `host_controller_lease` in `execution-host.sqlite`) for mutations:

  ```bash
  node host-call.mjs host.inventory
  node host-call.mjs host.process.spawn '{"spawnNonce":"n1","executionId":"e1","generation":0,"spec":{"argv":["/bin/echo","hi"],"cwd":"/tmp","env":{}}}'
  # → {"processIncarnation":{…,"pid":371466,…},"spawn":{"state":"confirmed","effectKey":"spawn:n1",…}}
  node host-call.mjs host.process.probe '{"spawnNonce":"n1"}'   # → liveness "live" + startTime/pgrp evidence
  node host-call.mjs host.process.stop  '{"spawnNonce":"n1","mode":"term"}'  # → SIGTERM→SIGKILL escalation, group-verified
  ```

  Caveat: this is a *host-level* managed primitive — mahasd's intent log never sees it (no execution/effect rows), so mahasd reconcile ignores it. It proves the host RPC + lease fence end-to-end; it is not a mahas "execution".

- **`spec.pty` spawn is broken at this HEAD** (bug #3): the `host_terminals` INSERT (FK → `host_processes.spawn_nonce`) runs *before* `persistProcess` writes the parent row → `FOREIGN KEY constraint failed` → spawn receipt `state:"unknown"`, process stays live (pts allocated) but no terminal row → `host.terminal.*` ops unreachable. `process-manager.ts:373-391` — `persistProcess` must run before the terminal INSERT.

- **The CLI/mahasd managed path** (`worker.start` → `host.process.spawn` under the Dispatch) requires the full C-WORK chain first: `project.create` → commit+publish a ModelVersion with roles (`model.change.*`) → `implementation.publish` (+ `harness.profile.*` for `purpose=work`) → `run.create` → `assignment.preview`/`team.assign` (selection token) → `task.dispatch` → `worker.prepare` (pins LaunchPlan) → `worker.start` (spawn+attach). Verified stopping point: `run.create` rejects `MODEL_INVALID` on the draft model version (only a *published* MV with a `rdd_roles` row authorizes runs). Nothing was faked — the chain was not completed.
- `worker.start`/`inbox.check` etc. are member-visible ops: the operator wildcard grant passes admission, but member-*scoped* credential checks still reject (`inbox.check` → `UNAUTHENTICATED`, exit 4). `worker.start` itself validated payload shape first (`launchPlanId and planDigest are required`).

### 5. Graceful restart drill (verified)

```bash
kill -TERM $(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/mahas-ver-infra/config/mahasd.endpoint.json","utf8")).pid)')
sleep 2   # logs: signal → shutdown.recorded(mode=leave-executions) → teardown → stopped
          # socket + endpoint file removed. Host + its processes keep running.
node packages/mahas-runtime/src/main.ts < /dev/null >> /tmp/mahas-ver-infra/logs/mahasd.ndjson 2>&1 &
# logs: host-attached (leaseEpoch+1) → composed → endpoint-published (epoch+1)
#       → reconcile.prior … (only when a prior boot died badly)
#       → reconcile.pass → ready → started
```

Observed: epoch 1→2 (SIGTERM restart), →3 (kill -9 → `marked-crashed` for the dead epoch), →6 (two crash-loop attempts burned epochs 4,5 — crashed boots still consume an epoch row), →7 (recovery once host was back). `project.get` after restart returns the pre-restart row — DB persistence confirmed. Boot journal `mahasd-boots.log` records `boot`/`ready`/`stopped` per launch nonce — a `boot` with no `ready` is a crash-loop failure unit.

## Files & layout (`/tmp/mahas-ver-infra/`)

```
config/
  mahasd.sock                        operator RPC socket (srw-------) — removed on graceful stop
  mahasd.endpoint.json               mahasd identity+endpoint publication
  mahasd.lock                        single-writer lock (pid + processIdentity)
  mahasd-boots.log                   crash-loop journal (boot/ready/stopped markers)
  mahas.sqlite[ -wal -shm ]          THE control DB — survives restarts
  execution-host.sock                host RPC socket — removed on graceful stop
  execution-host.sock.endpoint.json  host publication incl. authToken (0600)
  execution-host.sqlite[ -wal -shm ] host DB (identity, lease, effects, processes, terminals)
  operator-connection.json           CLI operator credential file (0600, written once)
  selection-token.key                HMAC secret for discovery tokens (0600, written once)
  executions/  backups/  content-blobs/   (created lazily by ops)
logs/{host,mahasd}.ndjson            append-only daemon lifecycle logs
boot-control-plane.sh                proven boot script (stale-triage + offset-grep)
host-call.mjs                        host NDJSON RPC driver (hello + lease-fenced ops)
{host,mahasd}.pid                    pid-of-record files (from endpoint files)
```

## Verified failure modes + fixes

| Symptom | Cause | Fix |
|---|---|---|
| `mahasd.boot-failed` `ALREADY_RUNNING`, exit 3 | live `mahasd.lock` / live endpoint | `kill -TERM <pid>` first; this is intended refusal, not a bug |
| host `{"t":"error","code":"ENDPOINT_IN_USE"}`, exit 1 | live host answers the socket | intended refusal; kill the live host |
| mahasd exits with bare `ECONNREFUSED … execution-host.sock` stack (**bug #2**) | stale `execution-host.sock.endpoint.json` (host dead, file left) → `helloHost` dial fails → the readline Interface's unhandled `error` event kills the process before `attachHost`'s catch can log `host-attach-failed` (`hostClient.ts:146` has no `rl.on('error')`) | `rm` the stale host endpoint file (→ clean `mahasd.host-absent` degraded start) or boot the host first; boot script triages this automatically |
| `mahas status` → `unavailable`, `ECONNREFUSED`/`ENOENT`, exit 3 | mahasd down or stale `mahasd.sock` | stale socket+endpoint+lock are safe to `rm`; next boot marks the dead epoch `marked-crashed` (`reconcile.prior`) and continues |
| `runtime.reconcile` → `ERR_SQLITE_ERROR` (**bug #1**) | op is `mutation:false` → admission wraps it in `BEGIN DEFERRED` (`admission.ts:254`); reconcile then does `withTx`→`BEGIN IMMEDIATE` on the same connection — `txDepth` is 0 because admission's raw `db.exec('BEGIN')` bypasses the tracker | none at CLI level; startup/restart reconcile works. (Dev fix candidates: admit `runtime.reconcile` outside a wrapping tx, or make reconcile use the ambient txn/`SAVEPOINT` path) |
| `host.process.spawn` pty → `spawn.state:"unknown"` + FK error (**bug #3**) | `host_terminals` INSERT before `host_processes` INSERT | none at caller level (ordering fix in `process-manager.ts`) |
| boot refused `CRASH_LOOP` | ≥5 `boot` markers w/o `ready` in 120s — **refused boots count too** (marker is written before the lock check) | wait out the window or accept the throttle; don't hammer boot |
| host reachable:`false`/`unverifiable` in `runtime status` while host is up | mirror reflects the **last reconcile pass**; no background re-attach after a late host start | restart mahasd, or fire a host-needing op (lazy attach); `runtime.reconcile` can't be used (bug #1) |
| `inbox.check`/member-scope ops → `UNAUTHENTICATED` exit 4 | operator credential is not a Member | expected; needs a launch-issued worker connection file (`MAHAS_CONNECTION_FILE`) |
| op rejects `INPUT_NOT_READY: payload must be an object` | CLI drops an empty `{}` payload | send ≥1 field (`--set`, `--input` + fields) |
| `run.create` → `MODEL_INVALID` (no message field — minor UX gap) | model version not `published`/no such role | complete the C-WORK chain (§4) |
| `project.create` → `MODEL_INVALID` | wrong fields — it wants `name`, `repositoryRoot` (absolute), `goal` | `mahas project create --name X --repositoryRoot /abs --goal "…"` |
| pid files ≠ live pid | pid-of-record must come from endpoint files, not `$!`/stale files | re-read `<svc>.endpoint.json` `.pid` |

## Stale-socket detection (cheap rules the script uses)

1. Read `<svc>.endpoint.json` → `pid` → `kill -0`: alive ⇒ live (refuse); dead ⇒ stale (file removable).
2. No endpoint file but socket exists ⇒ inert leftover — `connect` would `ECONNREFUSED`; safe to `rm`.
3. Never trust the socket file's mere existence — unix socket files persist after death.
4. `mahas status` is itself the honest probe: `unavailable`+exit 3 = nothing answered; `degraded`+exit 0 = socket answered but session refused.

## Teardown / re-launch

```bash
# graceful (both daemons record honest shutdowns; owned host processes survive
#  — leave-executions semantics, they're reattachable by the next controller)
kill -TERM $(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/mahas-ver-infra/config/mahasd.endpoint.json","utf8")).pid)')
sleep 2
kill -TERM $(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/mahas-ver-infra/config/execution-host.sock.endpoint.json","utf8")).pid)')

# RPC alternative for mahasd: mahas runtime shutdown --mode leave-executions
# (SIGTERM/SIGINT are honestly recorded AS leave-executions — never drain)

# re-launch: /tmp/mahas-ver-infra/boot-control-plane.sh   (stale-safe)
# full reset:  teardown, then rm -rf /tmp/mahas-ver-infra/config
```

## Evidence index (this run)

- Clean boot epoch 1: `mahasd.ready` `unresolved:0`; `runtime status` → `writableReady:true`, host `reachable:true`.
- `project.create` committed `prj_27d4174f-…` (rootProbe verified); `operation get` replayed its stored receipt; `project.get` re-read after restart = persistence.
- `host.process.spawn` → pid 371466 `confirmed`; `host.process.probe` `liveness:live`; `host.process.stop` verified kill.
- `host.process.spawn` pty → pid 376475 live on `pts/13`, effect `unknown` (bug #3).
- kill -9 mahasd → stale socket: CLI `unavailable`/ECONNREFUSED → reboot `marked-crashed`, epoch +1, ready.
- kill -9 host + stale endpoint file → mahasd boot crash (bug #2, 100% repro); `rm` stale file → degraded `host-absent` ready with honest blocker `host:host-pyosechang-MS-7D76`.
- Double-boot refusals: `ALREADY_RUNNING` (exit 3), `ENDPOINT_IN_USE` (exit 1).
- Surface digest `9103fbc8…`, 91 ops (`mahasd.composed`), worker endpoint `mahasd-worker.sock` defined in code but not bound in this composition.
