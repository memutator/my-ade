# Agents

mahas notices agent CLIs running inside its terminals and tells you when a turn
finishes. Two mechanisms cooperate: **process detection** (always on, works for
any CLI in the manifest) and **harness hooks** (opt-in per provider, real
turn-complete signals instead of a process-exit proxy).

## Process detection

Terminal sessions are owned by `resources/pty-host.cjs`, a separate _system
Node_ child process (Electron's ABI can't load the prebuilt node-pty). For each
spawned shell it polls `/proc` every ~1.2 s:

- `readlink /proc/<pid>/cwd` → the tab's live cwd (`{t:'cwd'}` event).
- Breadth-first walk of the process tree (`/proc/<pid>/task/<pid>/children`,
  six levels counting the shell itself). Each pid's signature is `comm` + its
  cmdline **basenames**, lowercased; a substring match against any enabled
  pattern means that agent owns the shell → `{t:'agent', id, agent}` event.

Patterns come from `resources/agents/manifest.json` — each entry is
`{match, label, domain, color, resume?}` where `resume` is
`{cmd, args}` producing the shell command `<cmd> <args…> '<sessionId>'` used to
reopen a session after an app restart (see [Session resume](#session-resume)).
Providers without `resume` (cursor, copilot, aider, amp) are detected and
tracked but never offered for restore. Main pushes all `match` arrays to the
host at
startup; the renderer re-pushes the set filtered by the Settings → agents
provider toggles whenever they change (`agents:config` IPC). If the manifest is
missing the host falls back to a built-in pattern list.

Agent _loss_ is debounced — process trees flap while helpers spawn and die, so
`agent → idle` is only declared after two consecutive misses.

The renderer records the agent on the terminal tab (icon + label in the tab
strip). Provider icons follow Chrome's favicon model: the manifest `domain`'s
favicon (Google s2, falling back to `<domain>/favicon.ico`) is disk-cached
under `userData/agent-icons/` and served as a data URL; without one the tab
falls back to a brand-colored letter monogram (`color`).

## Harness hooks

Per-harness lifecycle hooks append one NDJSON event per line to
`~/.config/mahas/agent-events.log`; the main process tails the file and forwards
each event to the renderer as `agent:event`. A file (not a socket) so events
are never lost while mahas is closed — they drain on next launch — and no ports
or extra permissions are needed.

Installers live in `src/main/hookInstallers.ts` and run only when you click
**Install** in Settings → agents. They are additive and idempotent, never
remove existing hooks, and back up any file they mutate (`<file>.mahas-bak`).
The hook script itself is copied to `~/.config/mahas/mahas-hook.cjs` and registered
as `node "<dest>" <provider>`. The section only lists providers whose CLI is on
`PATH`.

| Provider | Mechanism                                               | Config touched                          |
| -------- | ------------------------------------------------------- | --------------------------------------- |
| claude   | `Stop` + `Notification` + `SessionStart`/`SessionEnd` hook groups | `~/.claude/settings.json`               |
| codex    | `notify = ["node", <hook>, "codex"]` top-level key      | `~/.codex/config.toml`                  |
| grok     | `Stop`, `StopCancelled`, `StopFailure`, `Notification`, `SessionStart`, `SessionEnd` | `~/.grok/hooks/mahas.json`                |
| devin    | `Stop` + `PermissionRequest` + `SessionStart`/`SessionEnd` hook groups | `~/.config/devin/config.json`           |
| zcode    | `Stop` + `PermissionRequest` + `SessionStart`/`SessionEnd` in `hooks.events` + `hooks.enabled` | `~/.zcode/cli/config.json`   |
| opencode | plugin `MahasEventsPlugin` on `session.idle`, `session.error`, `session.created`, `session.deleted`, `permission.asked`, `question.asked` | `~/.config/opencode/plugins/mahas-events.js` |
| cline    | event-named hook files (`TaskStart`, `TaskComplete`, `TaskError`, `TaskCancel`, `UserPromptSubmit`, `SessionShutdown`) — stdin JSON payload | `~/.cline/hooks/<Event>` |

The hook script copy under `~/.config/mahas`, grok's hook file, the opencode
plugin file and cline's `~/.cline/hooks/<Event>` files are refreshed to the
shipped version on every app start — fixes to them don't need a re-Install.
(Cline note: an existing user-owned `<Event>` file is backed up to
`<Event>.mahas-bak` and our script re-pipes the stdin payload to it — the
displaced hook keeps working.) User-owned configs (claude `settings.json`,
devin/zcode `config.json`, codex `config.toml`) are not claimed from scratch
on start, but a leftover `ade-hook` pointer (from the ade→mahas rename) is
rewritten to `mahas-hook` automatically — those absolute paths 404 after the
config dir moved, and without the rewrite Codex never fires `turn-complete`.
New providers still need an **Install** click.

Codex note: `notify` is a single slot. If you already had one, the installer
records it in `~/.config/mahas/notify-forward.json` and the hook script
re-invokes it with the same payload — your existing notify keeps working.

### Event pipeline

`resources/mahas-hook.cjs` is the bridge every command-style hook calls. It reads
the harness's hook payload (stdin JSON, or the JSON argv for codex `notify`),
normalizes event names into a shared taxonomy, pulls `cwd`/`sessionId`/a
clipped `message` out of payload or harness env vars, stamps `mahasSession`, and
appends the event line. It never writes stdout and always exits 0 — hook
failures must not disturb the agent. Harnesses that compat-load
`~/.claude/settings.json` (grok, devin) get relabeled by env so events
attribute correctly.

The shared taxonomy — three kinds notify, the rest are tracking-only:

| mahas event        | meaning                                        | sources |
| ---------------- | ---------------------------------------------- | ------- |
| `turn-complete`  | turn finished normally                         | `Stop`, `agent-turn-complete` (codex notify), `session.idle`, grok `task_complete` |
| `needs-input`    | agent waits on a user decision                 | `PermissionRequest` (devin/zcode), `Notification` (all claude messages — permission prompts and the ≥60 s "waiting for your input"; grok `permission_prompt` etc.), opencode `permission.asked`, `question.asked` (800 ms grace — cancelled on a fast `*.replied`) |
| `error`          | turn failed or the runtime aborted it          | `StopFailure`, `StopCancelled` with `cancelledBy: runtime`/`unknown` (`max_turns`, `no_progress`), `session.error`, Devin/zcode `Stop` whose last message is a TUI error banner, pty `[Error]` / `Rate limited:` / `Quota exhausted:` banners (Devin rate-limits fire no hook) |
| `turn-cancelled` | the user stopped the turn                      | `StopCancelled` with `cancelledBy: user` / `user_interrupt`/`permission_*` reasons, opencode `session.error` `Aborted` |
| `idle`           | post-settle backstop ping, redundant with the turn-end report | grok `idle_prompt` |
| `turn-start` / `session-start` / `session-end` / `other` | lifecycle tracking | `UserPromptSubmit`, `SessionStart`, `SessionEnd`, a grok teardown `Stop` (`reason: channel_closed`/`shutdown`) |

The tailer (`EventLogTailer`, `src/main/eventsFile.ts`):

- starts at EOF — history is not replayed; truncates the file past 2 MB
- `fs.watch`, with a 1 s stat-poll fallback when inotify is exhausted
- stamps `ours` (`mahasSession === process.env.MAHAS_SESSION`) — the renderer drops
  everything else, so foreign sessions never notify. One exception: an event
  whose stamped `paneId`/`tabId` exists in our restored workspaces is adopted
  anyway — an agent orphaned by a previous run still carries those env values,
  foreign agents can't forge them, and another instance's ids never collide.
  This is how a surviving session re-registers (and keeps notifying) after a
  restart instead of being silently filtered out
- dedupes notifying events on provider+session+cwd+kind+message —
  compat-loaded hooks re-emit the identical payload ~0 ms apart, while
  distinct turns/prompts carry different messages and must not collapse
  (10 s window — only needs to span re-emit latency; real turns can finish
  seconds apart)

`MAHAS_SESSION` is a per-run UUID set in main and inherited down the chain:
pty-host → spawned shell → agent → hook script. Hooks are installed globally,
so every codex run on the machine appends to this file — `mahasSession` is how
mahas tells its own sessions apart. The same env chain carries `MAHAS_PANE` /
`MAHAS_TAB` (parsed out of the pty id `paneId:tabId:uuid` at spawn): events
stamp `paneId`/`tabId`, so the renderer attributes them to the exact emitting
tab instead of guessing by cwd — which collapses whenever several tabs share
a directory.

### Renderer policy

The full behavior spec lives in [notifications.md](notifications.md) — event
taxonomy, attention levels, coalescing. Short version:

Every agent signal (hook events, pty process-detection idle, detached-window
relays) flows through `src/renderer/src/attention.ts`, which resolves a
workspace/pane/tab target — the event's stamped `paneId`/`tabId` first, then
the session registry, then longest-prefix `cwd` matching — and applies the
attention level:

- **attended** (you're looking at the emitting tab): records pre-read, no
  banner — except `needs-input`, which always badges (it's pending work).
- **ambient** (app focused, target off-screen): unread badge + a dot on the
  workspace tab + an in-app toast, no OS banner.
- **away** (hosting window unfocused): unread badge + OS notification.

Process-detection idle is suppressed for providers with an installed hook —
the hook owns completion there. A pending `needs-input` settles to read on the
next event for its session or tab. Unread pings also clear without a click
once you're attending their target (read-on-view: the main window sweeps on
store changes + focus; a detached window reports via `pane:cmd` `attended`).

Clicking the in-app notification or the OS notification jumps to the
workspace, focuses the pane (or raises the detached window it lives in), and
activates the emitting tab.

Settings → agent hooks also has **Test** (writes a synthetic `turn-complete`
through the real file channel — end-to-end check) and shows each provider's
status and mechanism.

## Session resume

mahas keeps a bounded, persisted set of the agent sessions that were **alive at
last shutdown** (`resumeSessions` in `mahas-state.json`, keyed by harness
`sessionId` — a current set, never a history). On the next launch, activating a
workspace with resumable sessions pops a dialog offering to reopen them all in
one click.

**Tracking** (`src/renderer/src/resume.ts` + `attention.ts`): every `ours`
hook event carrying a `sessionId` upserts a record `{sessionId, provider, cwd,
wsId, paneId, tabId}` — providers without lifecycle hooks are still picked up
by their first turn event (e.g. codex `notify`). A tab hosts one live
session: a new record claims its tab outright, and weaker signals
(`idle`/`other`) never displace the recorded session — sub-session churn
demoted to `other` would otherwise steal records from the resumable parent.
Records leave the set when the session actually ends:

- `session-end` hook events (`SessionEnd`, opencode `session.deleted`, grok's
  teardown `Stop`),
- the agent process leaving the tab's process tree (`agent → idle`),
- the tab's pty exiting, or its tab/pane/workspace being closed,
- hydration-time pruning of records whose pane/tab no longer exists.

**Restore**: the workspace's terminal tabs restart as plain shells on boot
(their persisted pty ids respawn). Accepting the dialog types the manifest's
resume command — `claude --resume <id>`, `codex resume <id>`,
`opencode --session <id>`, `grok|devin|zcode --resume <id>`,
`cline --id <id>` — into each
session's old tab in layout pane order then tab order, activating the
leftmost resumed tab per pane. Two records claiming one tab collapse to the
newest — both typing into a single shell would land in the first agent's
prompt. Tabs whose shell hasn't spawned yet (a detached window still
booting) get the command queued until their `spawned` event; tabs already
running an agent are skipped. The resumed harness's own `session-start` then
re-registers it as live.

**Shutdown**: `will-quit` kills the pty-host so its shells and agents die
with the app instead of lingering as orphans (closing the pty master SIGHUPs
the children). Their `session-end` events land in the log file after the
renderer is gone — the tailer starts at EOF next launch, so the records
survive and stay resumable. A `beforeunload` guard keeps dying sessions'
`exit` events from stripping the set mid-persist.

## Testing

Two tools live under `tools/` (both plain Node, lint-ignored):

- **`mahas-fake.mjs`** — a fake harness that runs inside a mahas terminal tab like
  a real agent CLI: it inherits `MAHAS_SESSION`/`MAHAS_PANE`/`MAHAS_TAB` from the
  shell env, emits lifecycle events through the installed `mahas-hook.cjs`, and
  stays alive until `x`/Ctrl-C/a signal. Interactive keys emit events
  (`n` needs-input, `c` turn-complete, `e` error, `i` idle, `u` turn-start,
  `r` session-rename, `x` end+exit); `--session-id` pins the id, `--resume`
  re-attaches one, `--emit <ev>` fires once and exits, `--quiet` skips the
  start/end pair. The `fake` manifest entry gives it process detection (cmdline
  `mahas-fake`) and a resume spec (`node tools/mahas-fake.mjs --resume '<sid>'` —
  cwd must be the repo root).
- **`e2e.mjs`** — a CDP driver that boots the built app (`npm run build` →
  `electron .`, not electron-vite dev) under a fresh `XDG_CONFIG_HOME` and
  drives it via `window.__mahas` (the store handle `main.tsx` exposes) +
  `Runtime.evaluate`. Runs **headless**: `MAHAS_TEST=1` creates the window with
  `show:false`/`focusable:false` (never maps, never steals focus), and
  `MAHAS_FAKE_FOCUS=focused|visible|…` pins the `win:state` verdict so all three
  attention levels are deterministic. Scenarios (`node tools/e2e.mjs
  [name…]`): `orphans` (quit kills agent processes), `resume` (two sessions,
  one pane, distinct tabs → reboot → both offered and re-injected into their
  own tabs), `attention` (attended/ambient/away verdicts, ambient toast,
  read-on-view), `status` (close-slot agent dots: working pulse on turn-start,
  amber/red for unread needs-input/error, cleared by read-on-view),
  `adopt` (previous-run orphan events re-register),
  `projectrm` (project removal drops its workspaces/resume records, kills
  their agents, fixes `activeWorkspaceId`, leaves the directory on disk),
  `browserfile` (`openUrlInBrowser` opens a `file://` url — encoded names
  survive — and `newTab` appends rather than replacing), `tabdnd` (real
  `Input.dispatchMouseEvent` hold-drags on a leaf tab: in-strip reorder,
  self-edge split, restack onto another leaf's strip, cross-workspace move,
  pty sessions preserved). Harness
  diversity is covered by replaying captured `hook-raw.log` payloads rather
  than simulating CLIs — the normalizer accepts canonical event names
  idempotently so tools can emit `needs-input`/`turn-complete` directly.

## Caveats

- Process detection is an exit/idle proxy: an interactive agent that _stays
  running_ between turns produces no `agent → idle` transition and no
  notification. Install the harness hook for a real turn-complete signal.
- `agent:event` is forwarded to the main window only; pty events (`agent`,
  `cwd`, `data`, …) are broadcast to every window. Detached pane windows relay
  their process-idle to the main renderer via `pane:cmd` `agentIdle` so the
  notification list has a single owner.
- Environment overrides: `MAHAS_CONFIG_DIR`, `MAHAS_EVENTS_FILE` relocate the event
  channel; `MAHAS_NOTIFY_LOG` relocates the decision log; `MAHAS_HOOK_DEBUG=1`
  adds script-internal failure detail to `~/.config/mahas/hook-debug.log`.
  Raw payload capture is always on in `~/.config/mahas/hook-raw.log`;
  `MAHAS_NODE`/`NODE_BINARY` pick the Node binary for pty-host (see
  [troubleshooting](troubleshooting.md)).
