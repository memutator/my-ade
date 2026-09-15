# Notification behavior spec

The notification system's job: **pull the user's attention to an agent event
they are not already looking at**. Everything below follows from that.

## What an agent event means

ade normalizes every harness's lifecycle hooks into one taxonomy
(`resources/ade-hook.cjs`). The question that decides the class: *does the user
need to act, or is this just news?*

| ade event        | user must act? | semantics                                          |
| ---------------- | -------------- | -------------------------------------------------- |
| `needs-input`    | **yes**        | agent is blocked on a decision (permission/question/elicitation) — work stops until the user answers |
| `turn-complete`  | no             | turn finished normally; the result waits            |
| `error`          | no             | turn/session failed abnormally (rate limit, max_turns, crash) |
| `turn-cancelled` | —              | the *user* stopped it — they already know. Never notifies |
| `idle`           | —              | post-settle backstop ping (grok `idle_prompt`). Never notifies |
| `turn-start`, `session-start`, `session-end`, `other`, `session-rename` | — | lifecycle tracking. Never notifies |

User-initiated aborts are never errors: grok `StopCancelled` with a userish
reason, and opencode `session.error` whose error is `Aborted`, classify as
`turn-cancelled`.

### Per-harness source mapping

| provider       | raw event                          | ade event        | notes |
| -------------- | ---------------------------------- | ---------------- | ----- |
| claude         | `Stop`                             | `turn-complete`  | |
| claude         | `Notification` (permission prompt) | `needs-input`    | payload carries a display `message` only |
| claude         | `Notification` "waiting for your input" | `needs-input` | idle ≥60 s — the user must respond, so it *notifies* (was misclassified as silent `idle`) |
| codex          | `notify` `agent-turn-complete`     | `turn-complete`  | codex's only signal; no needs-input channel exists |
| codex          | `agent-turn-complete` with `{"recap":…}` | `other`    | auto-compaction summary — mid-turn bookkeeping, the agent keeps going |
| codex          | internal catch-up thread (`input-messages` = "Write a brief catch-up…") | `other`, sessionId stripped | no rollout/threads row exists — registering it would offer a `resume` that can't resolve ("No saved session found with ID") |
| grok           | `Stop`                             | `turn-complete`  | `reason: channel_closed`/`shutdown` → `session-end` |
| grok           | `StopCancelled`                    | `turn-cancelled` / `error` | by `cancelledBy`/`reason` — user vs runtime |
| grok           | `StopFailure`                      | `error`          | |
| grok           | `Notification` `permission_prompt` | `needs-input`    | any non-idle `notificationType` counts as an ask |
| grok           | `Notification` `idle_prompt`       | `idle`           | post-settle backstop — silent |
| devin / zcode  | `Stop`                             | `turn-complete`  | |
| devin / zcode  | `PermissionRequest`                | `needs-input`    | passive observe — the real prompt still shows in the terminal |
| opencode       | `session.idle`                     | `turn-complete`  | fires per session — **bursts are coalesced** (see below); sub-agent sessions (`parentID` seen via `session.created`/`updated`) demote to `other` |
| opencode       | `session.idle` (sub-session)       | `other`          | task-tool fan-out — the parent's idle is the user-visible unit |
| opencode       | `session.error` (not abort)        | `error`          | |
| opencode       | `session.error` `Aborted`          | `turn-cancelled` | user pressed Esc |
| opencode       | `permission.asked` / `question.asked` | `needs-input` | held ~800 ms — auto-approved asks (`*.replied` in ~20 ms) never ring |
| opencode       | `permission.updated`               | — (unmapped)   | rule/config churn, not a pending ask |

This table is validated empirically — see **Raw capture** below. When the raw
log shows a harness emitting something unmapped, the correct class is decided
by the same question: does the user need to act on it?

## Attention levels

A notification's interrupt level depends on where the user already is. The
target of an event is resolved to `{workspace, pane, tab}` (see Resolution).

| level      | condition                                                                 | in-app list     | OS banner |
| ---------- | ------------------------------------------------------------------------- | --------------- | --------- |
| `attended` | hosting window focused **and** workspace active **and** pane on-screen (not minimized; a detached pane counts when its own window is focused) **and** the emitting tab is the pane's active tab | recorded, pre-read | no |
| `ambient`  | hosting window focused but the target isn't fully on-screen (background tab, minimized pane, unfocused pane, or an inactive workspace) | unread + toast  | no        |
| `away`     | hosting window not focused / minimized (for a detached pane: its own window unfocused or minimized) | unread          | yes       |

Rules:

- **`needs-input` is never pre-read**, even when `attended` — it represents
  pending work, not news. It clears when the turn resumes (any later event
  for the same session/tab settles it) or when the user attends the target —
  read-on-view below; the badge marks work you haven't seen, not work you're
  already looking at.
- `turn-complete` / `error` at `attended` land pre-read: the list doubles as an
  activity log, but nothing demands a click.
- OS banners exist only for `away`. While the app is focused the workspace
  tab carries an unread dot **and** `ambient` events raise an in-app toast
  (slide-down card, top-center; click jumps to the target, ~6 s auto-expire)
  — that's the discovery path, so nothing is lost by skipping the banner.
- An event that resolves to no workspace at all can't be attended (nothing on
  screen shows it): focused window → `ambient`, unfocused → `away`.

### Read-on-view

An unread ping clears without a click once its target is being attended —
seeing the thing is the acknowledgement. `sweepAttended` runs in the main
window on every store change (workspace switch, tab activate, pane layout,
new ping) and on window focus: a ping reads when its workspace is active, its
pane is on screen, and (for tab-scoped pings) its emitting tab is the pane's
active tab. A detached window reports its own attendance via `pane:cmd`
`action:'attended'` — its focus isn't observable from the main renderer. A
ping whose recorded pane or tab no longer exists degrades to the coarsest
live level (pane gone → workspace-level, tab gone → pane-level) so a stale
target can't badge a workspace forever.

## Coalescing

Three layers, each closer to the user:

1. **Tailer dedupe** (`EventLogTailer`): identical events (provider+session+
   cwd+kind+message) collapse — 45 s for `turn-complete`, 10 s for
   `needs-input`/`error`. Catches compat-loaded double registration
   (grok/devin reading `~/.claude/settings.json`).
2. **Renderer target dedupe** (`attention.ts`): same provider+target+kind
   within the window lands pre-read instead of re-pinging — `turn-complete`
   45 s, `needs-input` 60 s, `error` 20 s. This is where the hook path and the
   process-detection path stop double-firing: they resolve to the same tab.
   A *different* `needs-input` message for the same target within the window
   still records (pre-read) — the pending badge already exists.
3. **Burst coalescing**: `turn-complete` for the same provider+workspace within
   3 s of the previous one records pre-read (opencode task-tool fan-out
   finishes N sub-sessions at once — one ping, not N).

## Delivery paths, unified

All agent attention goes through `attention.ts` — one policy, one dedupe, one
decision log. Sources:

- **Hook events** (`agent:event` IPC → `handleHookEvent`): real harness
  signals, the primary path.
- **Process-detection idle** (pty `agent → null` transition →
  `reportProcessIdle`): the fallback for CLIs without hooks. **Suppressed for
  providers whose hook is installed** — for those the hook owns completion, and
  the process exit is usually the user quitting the agent themselves. Delivered
  as `turn-complete` through the same pipeline otherwise.
- **Detached windows** relay their process-idle via `pane:cmd`
  `action:'agentIdle'` to the main renderer — a detached pane's `st.notify`
  would otherwise land in a store nobody sees, and only the main renderer owns
  the notification list.

## Resolution

An event targets a workspace/pane/tab by:

1. **session registry** — `agentSessions[sessionId]` remembers which
   ws/pane/tab a session was last attributed to. Authoritative once known
   (survives `cd`, distinguishes two agents sharing a cwd).
2. **cwd match** — longest project-path prefix picks the workspace; inside it,
   the terminal tab whose live `cwd` equals the event's. Fallback: the
   workspace's focused pane.
3. **no match** — the active workspace, pane-less.

Every `ours` event (any kind, including tracking-only) refreshes the registry
entry — first event binds the session to a tab, later events reuse it. The
same upsert feeds `resumeSessions`, the persisted set of live sessions offered
for reopen after a restart (see [agents.md → Session resume](agents.md#session-resume)) —
`session-end` removes the record again.

## Settling

A pending (unread) `needs-input` is marked read by the next event for the same
session or tab — turn resumed, cancelled, or ended; the prompt is stale either
way. `notify()` itself keeps its title+workspace 15 s collapse for true
double-clicks.

## Observability

Three append-only NDJSON logs under `~/.config/ade/` trace the pipeline end to
end — raw input, normalized stream, and the decision each event produced:

| file                    | written by            | contents |
| ----------------------- | --------------------- | -------- |
| `hook-raw.log`          | `ade-hook.cjs`, opencode plugin | every invocation: `{ts, provider, arg, env presence, normalized event, sessionId, cwd, raw payload}` — the evidence base for the per-harness table above. Always on, tail-kept at ~1 MB |
| `agent-events.log`      | hook script / plugin  | normalized events — the actual ingest channel |
| `notify-decisions.log`  | renderer (via `notify:decision` IPC) | per ours-event verdict: `{ev, target, level, action, reason}` — why something did or didn't ping |

`hook-debug.log` still exists behind `ADE_HOOK_DEBUG=1` for script-internal
failures; `hook-raw.log` needs no flag.
