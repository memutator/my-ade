# Orchestration note — client/view/subscribe surface probe

**Status:** PRELIMINARY evidence for VER-07 leading questions (client view
binding, subscription/event delivery, detach/reconnect). Not a formal VER
record.
**Repo:** `/home/pyosechang/projects/ade-wt-mahas-architecture`, branch
`mahas-architecture`, probed at pinned HEAD `83a6d21` (verification worktree
`/tmp/mahas-ver-cli2/src`, `git worktree add … 83a6d21 --detach`; impl files
untouched).
**World:** reused the live `/tmp/mahas-ver-03` control plane — mahasd pid
467291 on `/tmp/mahas-ver-03/config/mahasd.sock` (epoch 1, 91 ops composed),
execution-host pid 467248 attached. World already held a C-WORK fixture:
`run_d65cece3-…` (3 members `mem-ver03-r-{lead,auth,doc}-*`, tasks `t-auth`/
`t-docs`, assignments+grants), 27 committed `domain_events`, **0 executions,
0 terminal_records, 0 client_view_bindings**. Daemon left running.
**Probes:** `/tmp/mahas-ver-cli2/probe/*.ts` driving `connectRpc`
(`packages/mahas-runtime/src/rpc/index.ts` at 83a6d21) over the real socket;
DB read via `node:sqlite` `DatabaseSync({readOnly:true})`. Outputs in
`/tmp/mahas-ver-cli2/out/`.

## Verdict summary

- **The client surface exists and mostly works** — 9 client/observation ops
  are registered and reachable on the operator surface: `client.view.bind`,
  `client.view.unbind`, `terminal.{attach,input,resize,snapshot,detach}`,
  `runtime.snapshot`, `runtime.subscribe`.
- **`runtime.subscribe` is a PULL op, not a push channel.** The wire protocol
  has exactly 6 frame kinds (`hello`, `hello-ok`, `hello-error`, `call`,
  `result`, `error` — `rpc/framing.ts:36-77`); there is no server-initiated
  event frame and no client API to receive one. "Subscription" = a
  client-held cursor `{streamId:'domain-events', epoch, lastSequence,
  visibilityDigest}` re-presented on each `runtime.subscribe` call.
- **Missed events are replayable, not lost** — the cursor walks the durable
  `domain_events` ledger; a disconnected-then-reconnected client replays
  from `afterSequence` and receives everything committed meanwhile
  (verified live: seq 30 `intervention.raised` delivered after reconnect).
- **The returned `subscriptionId` is a dead handle.** Every
  `runtime.subscribe` call opens a fresh server-side `SubscriptionHub`
  entry (`subscriptions.ts:341`), but **no operation consumes a
  subscriptionId**: `pollSubscription` (`subscriptions.ts:368`) and
  `SubscriptionHub.closeSession` (`:251`) are dead code — nothing calls
  them (`grep` confirms zero call sites). `runtime.unsubscribe`,
  `subscription.poll`, `runtime.poll`, `client.subscription.poll`,
  `subscription.close` → all `UNAVAILABLE_OPERATION`.
- **`client.view.bind` positive path is BLOCKED in this world** — binding
  requires an existing `executions` or `terminal_records` row
  (`views.ts:52-63` → `SNAPSHOT_REQUIRED`), and none can be produced at
  this HEAD through the op surface (see "Blocked items"). All negative
  paths verified.
- **Per-principal:** client ops are operator-grant-only in this world;
  member principals see none of them (`UNAVAILABLE_OPERATION`). F-001
  caveat stands: `principalId` is a client claim, and — sharper here —
  the authenticator never sets `ctx.memberId`, so the member-redaction
  branch of `eventVisible`/`visibilityRuleFor` is unreachable via the
  socket; any principal whose grant covers `runtime.subscribe` reads the
  **unrestricted** event stream.

## 1. Op enumeration (registry → surface)

`OPERATION_TABLE` (`api/registry.ts:89-182`, 92 spec names) contains the
C-CLIENT/C-OBSERVATION client surface: `terminal.*` ×5, `client.view.*` ×2,
`runtime.snapshot`, `runtime.subscribe` (all IMP-28/IMP-26). `observation.ingest`
is in the table but deliberately **not registered** (`observation/index.ts:8-11`,
trusted-ingress policy) — 91 ops composed (`mahasd.composed` log line).

Registration facts (`client/ops.ts`, `observation/index.ts:79-85`):

| op | registered | spec `visibility` | mutation |
|---|---|---|---|
| `client.view.bind` | yes | operator | true |
| `client.view.unbind` | yes | operator | true |
| `terminal.attach` | yes | operator | true |
| `terminal.input` | yes | operator | true |
| `terminal.resize` | yes | operator | true |
| `terminal.snapshot` | yes | operator | false |
| `terminal.detach` | yes | operator | true |
| `runtime.snapshot` | yes | member | false |
| `runtime.subscribe` | yes | member | false |
| `observation.ingest` | **no** | — | — |

`visibility` is descriptor metadata only (`surface.ts:79`); the actual gate
is grant coverage ∩ registered+implemented (`projectCommandSurface`,
`surface.ts:60-100`). The operator wildcard grant covers all 92 names → the
`member`-tagged `runtime.snapshot`/`runtime.subscribe` still land on the
operator surface (72 ops, digest `9103fbc8…` — same as cli-surface.md).

Surfaces observed live (`surface.describe`):

| principal | reached via | ops | client ops? |
|---|---|---|---|
| `operator-local` | `{kind:'operator'}` | 72 | all 9 |
| `mem-ver03-r-auth-oqqcsq` | `{principalId}` claim | 13 | none |
| `mem-ver03-r-lead-mnt4c0` | `{principalId}` claim | 32 | none |
| `ghost-principal-xyz` | `{principalId}` claim | 0 | `surface.describe` itself rejected |

Member surfaces carry no `runtime.subscribe`/`runtime.snapshot`/
`client.view.*`/`terminal.*` — their grants simply don't list them
(member grant actions: `artifact.*`, `assignment.*`, `delivery.ack`,
`execution.*`, `inbox.*`, `message.*`, `operation.get`, `surface.describe`,
`task.*`; lead adds run/plan/team/worker.*). `task.report` is again granted
but absent (no handler). The closest member-facing "wait" op is
`inbox.wait` — a bounded server-side mail poll (`mail/api.ts:107`), scoped
to deliveries, not the domain-event stream.

## 2. client.view.bind / unbind — what the ops do

Handlers (`client/views.ts`): `client_id = ctx.principalId` — bindings are
scoped to the authenticated client; `view.bind` upserts one
`client_view_bindings` row per (client, view) with a CAS `revision` inside
`layout_binding_json`, and appends `client.view.bound`; `view.unbind`
deletes the row + appends `client.view.unbound`, releasing nothing else
(REQ-11/23/27 — view ≠ execution). Bind **requires** `executionId` or
`terminalId` and the target must exist (`executionExists`/`getTerminal` →
`SNAPSHOT_REQUIRED` naming `runtime.snapshot` as the recovery path).

Live receipts (operator):

| call | result |
|---|---|
| `bind{viewId}` (no target) | **`unknown`** — handler throws bare `TypeError` ('requires executionId or terminalId'); non-MahasError escapes admission → dispatch throws → `CONTROL_UNAVAILABLE` unknown-receipt (`admission.ts:261-267`, `local-server.ts:280-301`). Not persisted. |
| `bind{}` | `unknown` — same TypeError path (`viewId must be a non-empty string`) |
| `bind{viewId, executionId:'exe-nonexistent'}` | `rejected` `SNAPSHOT_REQUIRED` `{executionId}` |
| `bind{viewId, terminalId:'term-nonexistent'}` | `rejected` `SNAPSHOT_REQUIRED` `{terminalId}` |
| `unbind{viewId:'view-never-bound'}` | **`committed`** `{unbound:true, viewId}` — idempotent no-op, receipt persisted (`probe-vu-missing`) |
| `unbind{viewId, expectedRevision:3}` | `rejected` `STALE_REVISION` |
| member principal: bind / unbind | `rejected` `UNAVAILABLE_OPERATION` (hidden ≡ unknown) |

`client_view_bindings` rows after all probes: **0** — correct, every bind
was rejected. No committed bind could be produced (see "Blocked items").

`terminal.*` with correct payloads (operator): `attach{terminalId,viewId}`,
`attach{inputIntent:'claim'}`, `input{terminalId,inputLeaseRevision,
inputBytes}`, `resize{…,columns,rows}`, `snapshot{terminalId}` → all
`rejected SNAPSHOT_REQUIRED` (unknown terminal checked before any host
call). `detach{subscriptionId:'sub-nonexistent'}` → `rejected
CONTROL_UNAVAILABLE` — detach proxies `host.terminal.detach` to the live
host even for unknown subs; the host's refusal passes through
(`mapHostError`, `terminal.ts:99-113`).

**Wart (verified):** payload-shape violations throw `TypeError`, which is
not `isMahasError` → escapes `runAdmission` → dispatch() throws → client
sees `status:'unknown'` + `CONTROL_UNAVAILABLE`, receipt **not persisted**
(`operation.get` → `UNAVAILABLE_OPERATION 'no receipt …'`). Domain
rejections (`SNAPSHOT_REQUIRED`/`STALE_REVISION`) are clean `rejected`
receipts. So malformed input is indistinguishable from a genuine
ambiguous-outcome dispatch failure — honest under REQ-14 but noisy: a
client bug produces a reconcile-required `unknown` instead of a
`MODEL_INVALID`/`INPUT_NOT_READY` rejection. Same wart on
`terminal.input{data:…}`/`resize{cols:…}` (wrong field names).

## 3. Subscription / event flow — pull, never push

`runtime.snapshot` → `{epoch, sequence, visibilityDigest, entities{…}}`
(`projection.ts:199-216`); `runtime.subscribe{scope?, epoch,
afterSequence, visibilityDigest}` → `{subscriptionId, cursor, events[],
hasMore}` (`subscriptions.ts:304-345`). The `visibilityDigest` is computed
over principalId+memberId+grantRevisions+rule+scope (`projection.ts:91-110`)
— **a snapshot taken at scope X cannot serve scope Y** (digest mismatch →
`SNAPSHOT_REQUIRED 'visibility-changed'`; take a scoped snapshot first).

Verified live (operator):

- `runtime.snapshot{}` → `epoch:1, sequence:27, visibilityDigest:
  aeaf1493…` — all entity lists empty.
- `runtime.subscribe{epoch:1, afterSequence:0, digest}` → **committed**,
  all 27 events in ledger order, `subscriptionId:08d0f4d4…`,
  `cursor.lastSequence:27, hasMore:false`. Event types seen:
  `ProjectRegistered, ModelChangePrepared, ModelPublished,
  interface.snapshot.stored, harness.profile.{registered,admitted},
  implementation.{candidate.stored,published}, run.created,
  access.grant.issued, plan.{prepared,committed}`.
- Scoped `snapshot{scope:{runId}}` → different digest `4a997a9f…`;
  `subscribe{scope:{runId}, after:0}` → exactly the 3 run-scoped events
  (`run.created` seq18, `plan.prepared` seq22, `plan.committed` seq23).
  Scope filtering is event-side AND digest-bound (`eventVisible`,
  `subscriptions.ts:130-154`).
- **Live delivery**: `intervention.raise` committed → next
  `subscribe{after:27}` returned `seq:28 intervention.raised`
  `scope:{runId,memberId}`. Domain events written by any mutation land in
  the shared outbox and reach later polls — the ledger IS the event
  channel (client-side poller pattern).
- **Push check**: with a subscription "open" on one connection, a second
  connection fired `intervention.raise`; the first connection received
  nothing passively (protocol has no event frame kind — `framing.ts`); an
  explicit poll then delivered `seq:29`. **There is no push delivery at
  this revision.**
- Cursor validation (`cursorStaleness`, `subscriptions.ts:174-192`), all
  `rejected SNAPSHOT_REQUIRED` with `details.reason`:
  `malformed-cursor` (missing epoch/afterSequence), `visibility-changed`
  (bad digest / wrong scope digest), `epoch-mismatch` (epoch+99),
  `cursor-gap` (afterSequence 99999 > max). (`cursor-expired` unexercised —
  needs a pruned ledger; retention not tested.)

## 4. Detached / reconnect semantics

- Server-side subscription state is **ephemeral by design**
  (`subscriptions.ts:17-22`): `Subscription` lives in an in-process
  `Map`, keyed by `transportSessionId`; `closeSession(tsId)` exists to
  drop a dead session's subs but **is never called** — the transport has
  no session-close hook wired (dead code). Disconnect leaks the hub entry
  (harmless: unreachable, dies with daemon).
- The **durable** subscription state is the client's cursor over
  `domain_events` (AUTOINCREMENT `sequence`). Verified: subscribed on
  session s1 (`sub id e5c53896…`), dropped the socket with no unsubscribe
  (none exists), fired `intervention.raise` from a second session, then
  reconnected (new `transportSessionId`) and re-subscribed with the held
  cursor → `seq:30 intervention.raised` replayed. **Nothing committed is
  lost; "missed" events are always replayable while the ledger retains
  them and the epoch holds.**
- Reconnect gets a new `subscriptionId` (`1de243a1…`); the old one is
  orphaned — unreachable anyway (no poll op).
- Stale epoch after a daemon restart → `SNAPSHOT_REQUIRED
  'epoch-mismatch'` — the honest re-snapshot gate (verified with epoch+1).
- `terminal.detach` is the only "detach" op and is about terminal streams,
  not event subscriptions; there is no view-detach/re-attach state model
  beyond `client_view_bindings` rows (which persist — bindings survive
  disconnects by design, though none could be created here).

## 5. F-001 caveat — per-principal client surface

`main.ts:353-367`: the authenticator reads only `credential.principalId`
(default `operator-local`), stamps `controllerEpoch`, `grantRevisions:{}`,
`transportSessionId` — and **never sets `memberId`, `executionId`, or
`executionGeneration`**. Consequences on the client surface:

- Claimed `principalId:'mem-ver03-r-auth-oqqcsq'` → `hello-ok` echoes the
  claim verbatim → 13-op member surface; all 9 client ops
  `UNAVAILABLE_OPERATION`. Same for `member-lead` (32 ops).
- Claimed `principalId:'operator-local'` → full 72-op surface incl. all
  client ops — impersonation vector, as documented in cli-surface.md.
- **Sharper edge found here:** `visibilityRuleFor` (`projection.ts:60-66`)
  derives the member-redaction rule from `ctx.memberId`. Since the socket
  authenticator never sets it, `rule` is always `{kind:'unrestricted'}` on
  this transport — the member-class filtering in `eventVisible`
  (`subscriptions.ts:137-148`: foreign-member facts withheld, non-run
  events withheld) is **dead code over the wire**. In this world no
  member grant covers `runtime.subscribe`, so nothing leaks in practice —
  but any member whose grant did include it would read the unrestricted
  operator-grade stream (all `access.grant.issued`, all runs), not their
  run-scoped redacted view. Same for `runtime.snapshot` (member rule
  redacts foreign fact payloads + drops unboundObservations —
  `projection.ts`, dead via socket).
- `authorization_decisions`/`operation_receipts` attribute calls to the
  *claimed* principal (unchanged from cli-surface.md finding).

## Blocked items

1. **Committed `client.view.bind` — unreachable in this world.** Needs an
   `executions` or `terminal_records` row; both tables are empty and no op
   surface path produces one at this HEAD:
   - `worker.prepare` on task assignment `asg-ver03-r-auth-z02e7i@1` →
     `rejected INVALID_TRANSITION` "assignment does not cover task @0" —
     **probable bug**: composition's `ensureEnvelope` reads
     `req.assignment.taskId`/`taskRevision` (camelCase) off the raw
     snake_case `AssignmentRow` (`composition.ts:395-402` vs
     `planner.ts:44-54`) → always `''`/`0` for task-kind assignments.
   - `worker.prepare` on coordination assignment `asg-ver03-r-lead-zgq6v9@1`
     → `rejected INPUT_NOT_READY` blockers: `context.build` needs
     `sourceSnapshotPins` (world lacks them) AND seeded profile `hp-main@2`
     recipe has no `process.executable`/`argv` (`INJECTION_UNSUPPORTED`).
   - `terminal_records` rows are written only via launch/host terminal
     mirror; host `spec.pty` spawn is broken at this HEAD anyway
     (ver-infra.md bug #3).
   ⇒ `client.view.bound`/`client.view.unbound` domain events,
   `layout_binding_json` CAS flow, cross-client binding denial, and
   bind→snapshot/subscribe integration are all **untested**.
2. **No execution liveness/terminal stream evidence** — same root cause.
3. `cursor-expired` (retention-pruned ledger) unexercised — no event
   pruning occurred.
4. Member-class `eventVisible` redaction untestable via socket (dead code
   — see §5); would need a wired `ctx.memberId` authenticator.

## Evidence inventory

- Probes: `/tmp/mahas-ver-cli2/probe/{surface,subscribe,eventflow,
  viewbind,terminal,reconnect}.ts`
- Outputs (`/tmp/mahas-ver-cli2/out/`, sha256:16):
  `surface-operator.json` `31c68a2a…` (72 ops) ·
  `surface-member-auth.json` `ca37b96f…` (13) ·
  `surface-member-lead.json` `64f7c02e…` (32) ·
  `snapshot-operator.json` `251b9d5d…` (epoch 1, seq 27) ·
  `subscribe-full.json` `5d73cb48…` (27 events) ·
  `subscribe-run-scoped.json` `14b8b2d9…` (3 events) ·
  `subscribe-after-grant.json` `02deac92…` (seq 28 delivery) ·
  `reconnect-replay.json` `7dccf29b…` (seq 30 replay)
- DB delta from probes (read-only inspection): `domain_events` 27→33
  (3 `intervention.raised` + 3 `intervention.resolved`),
  `interventions` +3 rows (resolved after evidence), `operation_receipts`
  +7 committed probe receipts, `client_view_bindings` unchanged 0.
- Unique operationIds `probe-*` throughout; no impl files modified; no
  git writes; daemon left running (pid 467291).

## Open items for VER-07

- Decide whether the `TypeError→unknown` wart is a spec violation or
  honest REQ-14 behavior (payload contract breach vs ambiguous outcome).
- Decide whether `subscriptionId`/`pollSubscription`/`closeSession` dead
  code is "unimplemented poll transport" (acceptable v1: pull-via-op
  works) or a required unsubscribe/poll surface gap.
- The ensureEnvelope snake/camel bug blocks any worker.prepare on
  task-kind assignments — flag for the C-WORK verification records
  (VER-13?) independent of this note.
- Positive client.view.bind/unbind needs a world with a launched
  execution (worker.start chain or a seeded executions row via a
  legitimate op path).
