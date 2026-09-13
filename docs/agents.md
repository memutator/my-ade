# Agents

ade notices agent CLIs running inside its terminals and tells you when a turn
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
`{match, label, domain, color}`. Main pushes all `match` arrays to the host at
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
`~/.config/ade/agent-events.log`; the main process tails the file and forwards
each event to the renderer as `agent:event`. A file (not a socket) so events
are never lost while ade is closed — they drain on next launch — and no ports
or extra permissions are needed.

Installers live in `src/main/hookInstallers.ts` and run only when you click
**Install** in Settings → agents. They are additive and idempotent, never
remove existing hooks, and back up any file they mutate (`<file>.ade-bak`).
The hook script itself is copied to `~/.config/ade/ade-hook.cjs` and registered
as `node "<dest>" <provider>`. The section only lists providers whose CLI is on
`PATH`.

| Provider | Mechanism                                               | Config touched                          |
| -------- | ------------------------------------------------------- | --------------------------------------- |
| claude   | `Stop` hook — command group in `hooks.Stop[]`           | `~/.claude/settings.json`               |
| codex    | `notify = ["node", <hook>, "codex"]` top-level key      | `~/.codex/config.toml`                  |
| grok     | `Stop`, `StopCancelled`, `StopFailure`, `Notification` (idle_prompt matcher) | `~/.grok/hooks/ade.json` |
| devin    | `Stop` hook in `hooks.Stop[]`                           | `~/.config/devin/config.json`           |
| zcode    | `Stop` hook in `hooks.events.Stop[]` + `hooks.enabled`  | `~/.zcode/cli/config.json`              |
| opencode | plugin `AdeEventsPlugin` on `session.idle`              | `~/.config/opencode/plugins/ade-events.js` |

Codex note: `notify` is a single slot. If you already had one, the installer
records it in `~/.config/ade/notify-forward.json` and the hook script
re-invokes it with the same payload — your existing notify keeps working.

### Event pipeline

`resources/ade-hook.cjs` is the bridge every command-style hook calls. It reads
the harness's hook payload (stdin JSON, or the JSON argv for codex `notify`),
normalizes event names (`Stop`/`taskcomplete`/… → `turn-complete`,
`sessionstart` → `session-start`, `userpromptsubmit` → `turn-start`, a grok
teardown `Stop` → `session-end`), pulls `cwd`/`sessionId`/a clipped `message`
out of payload or harness env vars, stamps `adeSession`, and appends the event
line. It never writes stdout and always exits 0 — hook failures must not
disturb the agent. Harnesses that compat-load `~/.claude/settings.json` (grok,
devin) get relabeled by env so events attribute correctly.

The tailer (`EventLogTailer`, `src/main/eventsFile.ts`):

- starts at EOF — history is not replayed; truncates the file past 2 MB
- `fs.watch`, with a 1 s stat-poll fallback when inotify is exhausted
- stamps `ours` (`adeSession === process.env.ADE_SESSION`) instead of dropping
  foreign events
- dedupes `turn-complete` bursts (same provider+sessionId+cwd within 45 s —
  compat-loaded hooks can fire twice)

`ADE_SESSION` is a per-run UUID set in main and inherited down the chain:
pty-host → spawned shell → agent → hook script. Hooks are installed globally,
so every codex run on the machine appends to this file — `adeSession` is how
ade tells its own sessions apart.

### Renderer policy

On `agent:event` the renderer resolves a target from the event's `cwd`: the
workspace whose project path is the longest prefix, then the terminal tab whose
`cwd` matches exactly (background tabs count; fall back to the workspace's
focused pane). Then:

- `session-rename` events update the session registry and the mapped tab's
  title — no notification.
- Only `turn-complete` / `needs-input` notify.
- A disabled provider toggle drops the event.
- `ours` events always notify; foreign events notify only when the cwd sits
  inside a registered project — agents in unrelated directories stay silent.
- The notification title is "{agent} finished" / "{agent} needs input"; the
  session label prefers a renamed session, then the tab title, then the
  shortened cwd. Duplicate signals (same title + workspace within 15 s — a hook
  event and the process-detection idle can both fire) collapse into one.

Clicking the in-app notification or the OS notification jumps to the
workspace, focuses the pane (or raises the detached window it lives in), and
activates the emitting tab.

Settings → agent hooks also has **Test** (writes a synthetic `turn-complete`
through the real file channel — end-to-end check) and shows each provider's
status and mechanism.

## Caveats

- Process detection is an exit/idle proxy: an interactive agent that _stays
  running_ between turns produces no `agent → idle` transition and no
  notification. Install the harness hook for a real turn-complete signal.
- `agent:event` is forwarded to the main window only; pty events (`agent`,
  `cwd`, `data`, …) are broadcast to every window, so detached pane windows
  still get process-detection completion.
- Environment overrides: `ADE_CONFIG_DIR`, `ADE_EVENTS_FILE` relocate the event
  channel; `ADE_HOOK_DEBUG=1` makes the hook script log to
  `~/.config/ade/hook-debug.log`; `ADE_NODE`/`NODE_BINARY` pick the Node
  binary for pty-host (see [troubleshooting](troubleshooting.md)).
