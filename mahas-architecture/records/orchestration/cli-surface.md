# Orchestration note — `mahas` CLI exposed command surface

**Status:** PRELIMINARY evidence for VER-03 (command non-exposure/authorization)
and VER-06. Not a formal VER record.
**Repo:** `/home/pyosechang/projects/ade-wt-mahas-architecture`, branch
`mahas-architecture`, evidence gathered at HEAD `8f69594` (descendant of `83a6d21`).
**Isolation:** `MAHAS_CONFIG_DIR=/tmp/mahas-ver-cli/config`; daemon + probes
only under `/tmp/mahas-ver-cli/` — no repo files, real `~/.config/mahas`, or
sibling agents' dirs touched.

## Verdict summary

**Leaks found: YES — critical, but located in transport authentication, not in
the surface projection.**

1. **Worker credentials are never verified and collapse to full operator
   authority.** A forged worker credential
   (`{kind:'worker', credentialId:'cred-nonexistent', secret:'forged'}`)
   connected to `mahasd.sock`, was authenticated as `operator-local`, saw the
   complete 72-op operator surface, and **committed** the operator-only
   mutation `access.grant` (receipt `cac1bc64-d188-4c5a-a55a-c35dad1d9c71`,
   issued grant `grt_c12affb3-d5f5-4ec7-8167-1f937b19218c`).
2. **No credential at all = operator.** Absent, `null`, malformed (bare string,
   number), or wrong-kind credentials all receive `hello-ok` as
   `operator-local` — the seeded principal holding a wildcard-scope grant over
   all 92 `OPERATION_NAMES`.
3. **`principalId` is a client claim.** `credential:{principalId:'X'}` is
   echoed back verbatim in `hello-ok`. Any same-uid process can impersonate any
   existing principal (including `operator-local`, a hardcoded string) — a real
   member surface is reachable by claim alone.
4. **The worker endpoint does not exist.** `mahasd-worker.sock` is defined
   (`rpc/endpoints.ts:22`) but `serveRpc` is called exactly once
   (`main.ts:378`). Launch writes worker connection files pointing at
   `opts.endpoint` = the **operator** socket (`composition.ts:416`), despite
   the comment "mahasd worker endpoint (mahasdWorkerEndpoint), never the
   operator path" (`launch/worker-connection.ts:33`).

The non-exposure machinery itself is **correct**: the admission pipeline
answers an identical `UNAVAILABLE_OPERATION / operation is not available` for
hidden, unknown, and granted-but-unimplemented ops; a restricted member
surface shows exactly `grants ∩ registered+implemented + always-surface ops`;
CLI help/completion is generated from `surface.describe` with no static op
dictionary. The failure is upstream: the `AuthenticatedContext` is forged at
hello, so VER-03's "non-exposure" holds while its "authorization" premise is
void in this build.

## Method

Isolated daemon: `node packages/mahas-runtime/src/main.ts --config-dir
/tmp/mahas-ver-cli/config` → `mahasd.ready` (epoch 1, pid 372144,
`mahasd.composed operations:91`, host absent → degraded-capable start).
Probes: `packages/mahas-cli/src/main.ts` (status/help/completion/--as worker)
plus raw-RPC scripts under `/tmp/mahas-ver-cli/probe/` driving `connectRpc`
with crafted credentials and hand-rolled NDJSON frames.

## Credential classes the implementation actually supports

`main.ts:353-367` — the only `authenticate` wired into `startMahasd`:

```ts
const c = (credential ?? {}) as { principalId?: string }
return { principalId: c.principalId ?? 'operator-local', controllerEpoch, grantRevisions: {}, transportSessionId }
```

| Wire credential | hello result | Surface |
|---|---|---|
| `{kind:'operator'}` (what `operator-connection.json` ships — **no secret field**) | `operator-local` | 72 ops |
| `{kind:'operator', secret:'anything'}` | `operator-local` — secret ignored | 72 ops |
| `{kind:'worker', credentialId, secret}` — real or forged | `operator-local` — **id+secret never read** | 72 ops (LEAK) |
| `{principalId:'<existing principal>'}` | claimed id echoed | that principal's surface |
| `{principalId:'<nonexistent>'}` | claimed id echoed | every op `UNAVAILABLE_OPERATION` |
| `undefined`, `null`, `'totally-malformed'`, `12345` | `operator-local` | 72 ops (LEAK) |

- `authenticateWorkerCredential` (`launch/bootstrap-credential.ts:160`) —
  credentialId+secret → `execution_credentials.secret_hash` via scrypt/sha256
  `verifySecret`, produces the member-bound ctx (`memberId`, `executionId`,
  `executionGeneration`, `grantRevisions`) — **is dead code**: nothing calls
  it outside its own module. `isBootstrapOperationAllowed` (same file, :57)
  likewise. The desktop connects with `{kind:'operator'}`
  (`src/main/runtimeClient.ts:70`).
- The `credential.kind` field is decorative: `{kind:'operator',
  principalId:'member-probe-1'}` → member surface (probe
  `probe/mixed-cred.ts`).
- **Bootstrap class unreachable on this transport:** the authenticator never
  sets `ctx.executionId`/`executionGeneration`/`memberId`, so
  `decideOn`'s bootstrap branch (`authorize.ts:280-289`,
  `BOOTSTRAP_OPERATIONS` = `execution.join, assignment.show, surface.describe,
  operation.get`) can never trigger via the socket.
- Operator principal seeded at every boot: `seedLocalOperator`
  (`composition.ts:148-171`) inserts `principals('operator-local','operator',
  'active')` + `grants('grant-operator-local', kind='assignment',
  scope=[{*,*}], actions=[all 92 OPERATION_NAMES])`.

## Per-principal surfaces (`surface.describe`, raw JSON in `probe/`)

| Principal | How reached | digest | ops |
|---|---|---|---|
| `operator-local` | operator file / worker file / no cred / forged | `9103fbc8…bcfb` | **72** |
| `member-probe-1` (member, grant: 11 mail/assignment actions) | `principalId` claim | `b3232706…f75d` | **10** |
| `ghost-principal-xyz` (nonexistent) | `principalId` claim | — | 0 (all ops rejected) |

### Operator surface — 72 of 92 OPERATION_TABLE ops

`probe/out-operator-surface.json` (full descriptors). Missing 20
(`probe/operator-ops.json` vs `registry.ts:89-182`):

- **15 `host.*` ops** — execution-host-owned, never registered on mahasd:
  `host.hello, host.acquire, host.inventory, host.effect.get,
  host.process.{spawn,probe,stop}, host.terminal.{attach,input,resize,snapshot,
  detach}, host.workspace.{prepare,probe,release}`.
- **5 unimplemented/unregistered ops**: `task.report, outcome.decide,
  worker.release, execution.wake, observation.ingest` (HANDOFF confirms
  `observation.ingest`/`worker.release` deliberately unregistered).

Note: the spec `visibility` tag is advisory only — the operator surface
includes `member`-visibility ops (`inbox.check`, `task.accept`, …) because the
seed grant covers all names (`surface.ts:60-100`: surface = `surfaceFor(ctx)`
∩ registered+implemented).

### Member surface (member-probe-1) — 10 ops

`assignment.show, delivery.ack, execution.heartbeat, inbox.check, inbox.wait,
message.replyAndAck, message.send, operation.get, surface.describe,
task.accept` — `task.report` was granted but correctly dropped (no handler).
`operation.get`/`surface.describe` ride along via `ALWAYS_SURFACE_OPERATIONS`
(`authorize.ts:75`) **and** must also be grant-covered to invoke (see F8).

### Worker surface — identical to operator (byte-diff `cli-help-*`,
`cli-completion-*` identical, same digest)

`mahas --as worker help` with a launch-shaped worker connection file (mode
0600, endpoint `mahasd.sock`) lists all 72 ops including `access grant`,
`access policy publish`, `backup create`, `runtime shutdown`; `mahas --as
worker runtime status` **committed**. `mahas status` reports `role:"worker"`
with `principalId:"operator-local"` — the client believes it's a worker; the
server made it an operator.

## Denial receipts (raw-RPC)

| Call | Credential | Receipt |
|---|---|---|
| `access.grant` | member-probe-1 | `UNAVAILABLE_OPERATION / operation is not available` |
| `runtime.shutdown` | member-probe-1 | `UNAVAILABLE_OPERATION` (identical body) |
| `task.dispatch` (implemented, ungranted) | member-probe-1 | `UNAVAILABLE_OPERATION` (identical) |
| `totally.bogus` (unknown) | member-probe-1 | `UNAVAILABLE_OPERATION` (identical — hidden ≡ unknown, `admission.ts:172-200`) |
| `task.report` (granted, unimplemented) | member-probe-1 | `UNAVAILABLE_OPERATION` (identical) |
| `inbox.check` (visible) | member-probe-1 | handler reached → `INPUT_NOT_READY` payload validation |
| **`access.grant`** | **forged worker** | **`committed`** — grant `grt_c12affb3` issued (LEAK) |
| `access.revoke` | forged worker | handler reached → `SCOPE_DENIED` 'grant not found' (admitted as operator) |
| `surface.describe` | `ghost-principal-xyz` | `UNAVAILABLE_OPERATION` |
| call frame before hello | — | `error` frame `UNAUTHENTICATED / first frame must be hello`, socket dropped |
| hello `protocolVersion:0` | — | `hello-error` `HOST_PROTOCOL_MISMATCH` |
| non-JSON frame | — | `error` frame `MODEL_INVALID / unparseable NDJSON frame` |

CLI-side controls (client-side only): worker connection file mode ≠0600 →
`UNAUTHENTICATED` before connect (`worker-auth.ts:106-112`); operator file
requires `credential.kind==='operator'` and normalizes to `{kind,secret}` —
extra fields like `principalId` are **stripped**, so the claim vector needs
raw RPC, not the CLI file path.

## Help/completion derivation (VER-03 non-exposure check)

- `mahas help`, `mahas help <op>`, `mahas completion`, verb matching — all
  generated from `surface.describe` for the authenticated principal
  (`dynamic-help.ts`; `main.ts:322-395`). **No static op dictionary exists in
  the CLI.** "closest allowed" suggestions only come from the allowed set
  (`matchOperation`, `dynamic-help.ts:89-103`).
- Surface unavailable → `staticHelp()` prints only built-in verbs
  (`status/help/completion/--version/--help`) — no op names leak
  (`main.ts:244-274`, verified live).
- Exit codes: 0 committed · 1 rejected · 2 usage/not-in-surface · 3
  control-unavailable · 4 unauthenticated · 5 unknown-outcome
  (`command-client.ts:20-32`).

## Secondary observations

- **F8 (minor):** `surface.describe`/`operation.get` are *listed* via
  `ALWAYS_SURFACE_OPERATIONS` but still require a grant to invoke —
  member-probe-1 pre-grant got `SCOPE_DENIED` (not `UNAVAILABLE_OPERATION`).
  An op-name probe can therefore distinguish "always-surface-ungranted"
  (SCOPE_DENIED) from "hidden/unknown" (UNAVAILABLE_OPERATION) — a 2-name
  oracle over public ops only; also an inconsistency: an op can appear in the
  surface listing yet deny on invoke.
- `eventCursor` advances and `authorization_decisions` rows persist per
  dispatch (`dec*`), keyed by the **claimed** principal — forged-identity
  calls are attributed to the forged id.
- Operator connection file `operator-connection.json` (0600) contains no
  secret: `{version:1, endpoint, credential:{kind:'operator'}}` — the v1 trust
  boundary is literally the 0600 socket bit (`composition.ts:174-188`,
  `main.ts:356-359` comment).

## Leak findings (op + surface + evidence)

1. `access.grant` — operator-only op — **worker surface** — committed receipt
   `cac1bc64` (probe `worker-forged access.grant`).
2. All 72 operator ops incl. `runtime.shutdown`, `backup.*`, `access.*`,
   `project.create`, `worker.start` — **worker credential class** — same
   digest `9103fbc8…` as operator (`cli-help-worker.txt` ≡ `cli-help-operator.txt`).
3. `surface.describe` + every op — **no-credential / malformed credential
   class** — `hello-ok operator-local` (probe cases `no-credential`,
   `malformed-string`, `malformed-number`, `null`, `bad-hello-credential-string`).
4. Impersonation — **`principalId` claim class** — member surface reached by
   claim alone (`forged-member`/`mixed-cred` probes); operator surface via
   `{principalId:'operator-local'}`.

Root cause of all four: `main.ts:353-367` — the authenticator trusts
`credential.principalId` and defaults to `operator-local`;
`authenticateWorkerCredential` + worker socket unwired;
`endpoints.ts:22-24` + `worker-connection.ts:33` promise a worker endpoint
that `composition.ts:416` replaces with the operator path.

## Evidence inventory (`/tmp/mahas-ver-cli/`)

- `logs/mahasd.ndjson` — daemon lifecycle log
- `probe/surface-probe.ts`, `raw-frames.ts`, `mixed-cred.ts`, `seed-member.ts`
- `probe/out-operator-surface.json`, `out-member-surface.json`,
  `operator-ops.json`, `member-ops.json`
- `probe/cli-{help,completion}-{operator,worker}.txt`, `cli-static-help.txt`
- `worker-connection.json` (0600, forged), `worker-0644.json`,
  `forged-member-connection.json`
- `config/` — mahasd.sqlite, `mahasd.sock`, `operator-connection.json`,
  endpoint/lock files (daemon left stopped at note close)

## Open items for the formal VER records

- VER-03: non-exposure mechanics PASS at admission; authorization FAIL at
  transport (findings 1-4). Formal verdict needs a decision on whether the
  "v1 local trust" socket-perms model satisfies spec C-ACCESS §6 worker/operator
  separation — the code's own comments say it does not.
- VER-06: worker/socket separation absent; launched workers inherit operator
  authority by construction. Re-verify after `authenticateWorkerCredential` +
  second `serveRpc` land.
- A real (non-forged) worker credential could not be produced without the full
  launch pipeline; unnecessary — the server never reads `credentialId`/`secret`.
