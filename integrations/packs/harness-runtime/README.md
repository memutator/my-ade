# builtin.harness-runtime

The built-in Pack revision that owns everything vendor-specific about the agent
harnesses mahas knows: process identity, lifecycle events, hook installation,
launch/resume recipes, wake policy and safe maintenance.

Core (the Electron main process, the control-plane runtime and the renderer) reads
this revision through `packages/mahas-harness-config/src/runtime-pack.ts`; there
is no per-harness branch left in core. Adding a harness means editing Pack data
and re-projecting the descriptor file:

```sh
node integrations/packs/harness-runtime/project.mjs           # write resources/agents/manifest.json
node integrations/packs/harness-runtime/project.mjs --check   # drift check (the fixture also asserts this)
node integrations/packs/harness-runtime/conformance.smoke.ts  # fixtures: capabilities + hook attribution + lock safety + installer safety
```

## Files

| File | Owner | Consumer |
| --- | --- | --- |
| `manifest.json` | Pack revision (capabilities, limits, support declarations) | PackRegistry / runPack |
| `harnesses.json` | labels, match patterns, domains, colors, publishers, resume recipes, launch profiles, hook-stream contract, lock declarations | main (identify, installer engine, lock sweep), runtime (recipe lowering), renderer (resume command) |
| `installers.json` | hook installer declarations (kind, config path, events, owned document, file sets, refresh policy) and the shared token/legacy rules | main (hook installer engine) |
| `runtime.mjs` | identify / launch / resume / wake / events / maintenance implementations | runPack (script entrypoint) |
| `hooks/mahas-hook.cjs` | the vendor-facing NDJSON transport installed into `$MAHAS_CONFIG_DIR` | every harness that runs command hooks |
| `hooks/mahas-opencode-plugin.js` + `hooks/opencode-runtime.js` | the opencode plugin entry and its runtime module — installed **together** (the entry imports its sibling by relative path) | opencode's plugin directory |
| `conformance.smoke.ts` | synthetic fixtures for all of the above | `node` (no electron, no real harness) |

## Identity contract for hook events

Every transport line carries the native identity the harness reported —
`nativeEvent`, `sessionId`, `parentSessionId`, `child`, `internalRun`,
`external`, `paneId`, `tabId` — plus the notification policy the transport
recommends (`policy.demote`, `policy.stripSession`).

The rule is: **identity is never deleted to express an exclusion.** The durable
record keeps the child/foreign session and its parent link; the renderer's
attention/resume path applies the recorded policy afterwards
(`attentionProjection` in `src/main/eventsFile.ts`), which reproduces the
previous user-facing behavior exactly (subagent/internal runs demote to
`other` and do not claim a resume record).

The `events` capability preserves that identity in the durable store: child
sessions become session rows with `parentNativeSessionKey`, foreign runs become
sessions with `resumeSupport: unknown`, and the policy travels in the event
payload and the handle locator instead of being applied by the collector.

A hook stream is shared by every harness, so the `events` source carries the
harness id in its config namespace; lines emitted by another harness are skipped
for that source and reported as `events.foreign-harness-skipped`.

Handle `resumeSupport` is derived from evidence, never assumed: a child or
internal run is `unsupported` (the exclusion policy also rides in its locator), a
run emitted without `MAHAS_SESSION` is `unknown` (no verified route), a harness
whose Pack entry declares no resume recipe is `unsupported`, and only a root
session of a harness that does declare one — observed with a native id — is
`supported`.

## Durable ingest

The desktop relays a hook event to the renderer **only after the daemon reports
it durably ingested**. The port lives in `src/main/eventsFile.ts`
(`AgentEventIngestPort`, `AgentEventGate`) with the adapter in
`src/main/agentEventIngest.ts`; the desktop attaches a live port by default
(`createLiveRuntimeIngestPort` resolves the runtime handle on every call, so it
is non-null from the first event and survives a reconnect). There is no
"commit locally anyway" path: while the daemon is unreachable or answers that it
cannot take hook events yet, records wait in a bounded in-memory queue and the
renderer sees nothing. Only a non-retryable rejection drops the *attention*
delivery (the line stays in the NDJSON file), and queue overflow drops the oldest
record with a logged reason.

```text
operation   session.hook.ingest                      visibility: service
payload     AgentHookIngestRequest
              { source: AgentHookIngestSource,
                records: AgentHookIngestRecord[] }
receipt     CommandReceipt
              { status: 'committed',
                result: { committed: true, recordKeys: string[] } }
            | { status: 'rejected'|'unknown'|'pending',
                error: { code, message, retry } }

semantics   · resolve only after the events, their session rows (child/parent
              links included) are committed — the desktop forwards to attention
              immediately after;
            · a retry with the same sourceRecordKey is idempotent; the desktop
              retries the same batch until it commits;
            · identity fields and the recorded policy are stored as evidence;
            · the desktop never asks the daemon to advance a cursor — the
              daemon's own reader owns the persisted stream cursor, and the
              desktop keeps a separate local tail position only so its own
              replay cannot skip the crash backlog.
```

### Offset semantics (shared by both readers)

`AgentHookIngestRecord.offset` is the **byte offset of the line START** in the
stream file (0-based, counting every byte of preceding lines *including* their
`\n`). A reader consumes only complete lines, so a partially written trailing
line never advances a cursor; the pack's `events` collector reports the same
start offsets, and the desktop tailer builds `<path>#<generation>:<offset>` keys
from them. The `generation` counter exists only so a truncated/rotated stream
cannot make a reused offset collide with an older record; the daemon's canonical
observation key (resolved source path + offset + SHA256 of the raw line) is what
actually deduplicates a replay.

### Identity the transport can carry

`namespace` is always `hook`. `installationId` / `machineId` are emitted when
the spawning shell exported `MAHAS_INSTALLATION_ID` / `MAHAS_MACHINE_ID`
(stamping them at pty spawn is a desktop wiring item — without them the daemon
records an unknown installation for the hook namespace, which is an honest
"unknown" rather than a guess). `resumeSupport` is resolved from the Pack's
handle data, not guessed by the transport: a session without an explicit
supported handle stays `unknown`.

## Safety rules the fixtures pin

- Installs are additive and idempotent; a user's existing hook group is kept and
  the file is backed up as `<file>.mahas-bak`.
- A displaced single-slot command (codex `notify`) is recorded in
  `notify-forward.json` and re-invoked by the transport with the same payload.
- Pre-rename `ade-hook` pointers are ours and are rewritten in place; owned
  artifacts (transport copy, grok's hook document, cline's event files, the
  opencode plugin set) track the shipped revision.
- A plugin file set is installed together; a set missing a dependency reports
  not-installed and is repaired on the next install.
- Session locks are dropped only when nothing holds the inode **and** the
  recorded pid is dead or belongs to another program.
- Launch/resume answers carry the pinned `{packId, revision, contentDigest,
  implementationId}`; an unknown profile fails with `profile.unknown` and a
  handle without a native id answers `support: unknown` instead of a claim.
