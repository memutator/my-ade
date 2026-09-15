# ade

Personal ADE (Agent Development Environment) — a minimal tiling shell in the spirit of
Wave Terminal. Chrome-style workspace tabs sit in the title bar; each workspace is a
splittable pane layout scoped to a project directory.

## Domain model

- **project** = a directory (`{id, name, path}`), global registry. The `+`
  workspace menu lists them with a two-click trash action: `removeProject`
  drops the project's workspaces (killing their ptys/agents), its todos,
  project-scoped bookmarks and resume records, and re-points a dangling
  `activeWorkspaceId` at a survivor — the directory on disk is untouched.
- **workspace** = a tab = one split-pane layout, belongs to a project (`project:workspace = 1:N`).
  All workspaces across projects share the single `WorkspaceStrip` in the title bar.
  Switching happens only via workspace tabs; project is chosen when creating a workspace.
- Terminal cwd defaults to the workspace's `project.path`. File-tree roots are
  re-pickable via `TreeRootMenu` (MRU `treeRoots` → other projects → dir
  picker): the sidebar/peek-overlay share `sidebarRoots[projectId]` (default
  `project.path`), while an editor pane owns `pane.treeRoot` (default project
  path, materialized onto the pane on float/detach).
- **terminal pane** owns an internal `TabStrip` of shell tabs (`tabs[]` +
  `activeTabId`); every tab keeps a mounted xterm + live pty in the background,
  and closing the last tab closes the pane. New tabs spawn in `project.path`.
- **pane content never remounts on layout changes.** `PanePortals`
  (SplitView.tsx) renders each non-detached pane's `PaneFor` exactly once into
  a per-pane `.pane-mount` div it owns; that node is `appendChild`-ed into
  whichever registered slot hosts it (leaf `.node.leaf` in `SplitView` /
  `.float-inner` in `FloatLayer`, or a hidden `.pane-stash` when slotless).
  Changing a `createPortal` container remounts the subtree — so the portal
  target is the stable mount node, never the slot. Slots register via
  `registerPaneSlot` (`paneSlots.ts`) with identity-guarded cleanups.
- **pty lifetime = tab record lifetime**, not view lifetime. Unmount cleanup
  kills a session iff no workspace still holds a tab owning that exact
  session id — layout churn, detach handoff, cross-workspace moves and
  StrictMode remounts all re-`attach` to the live session instead. Closing a
  tab/pane/workspace removes the record → cleanup kills; `restartTab` kills
  its session explicitly before clearing `pty`.
- **editor pane** owns an internal `TabStrip` of file tabs; tree clicks open files there.
  Tree single-click / Enter / ctx "Open" open a VS Code-style **preview tab**
  (italic label — replaced in place by the next preview open); double-click on
  the tree row or the tab, "Keep Open" in the tab menu, or making the buffer
  dirty pins it. Explicit opens (file dialog, terminal links, create-and-open)
  are always pinned. Files are editable (CodeMirror); `.md`/`.markdown` open in
  Milkdown live-rendered WYSIWYG; `dirty` dots mark unsaved tabs; all open tabs
  stay mounted. Closing
  the last tab closes the pane (`closeFilesUnder` does the same when a tree
  delete empties it). The pane icon is the tree control — identical docked,
  floating, detached: hover ~350ms dwell pops a portaled peek overlay
  (`pane.treeRoot` + `TreeRootMenu` + `FileTree`, opens into this pane),
  press-and-hold then move starts the pane drag.
- **closing the last tab of any pane closes the pane** (terminal, editor,
  browser). In a detached window the close routes through `pane:cmd` → the
  main store's `closePane`, which kills detached ptys and tears the window
  down via `closeDetached`.
- **todo items** live per project (`todos: Record<projectId, TodoItem[]>`) — checklist
  with `todo`/`doing`/`done`, arbitrary `parentId` depth, `dependsOn` blocking, drag
  reorder. Surfaced as a sidebar section and as a `'todo'` pane type.
- **bookmarks** are global or project-scoped (`bookmarks: Bookmark[]`, `scope:
'global' | projectId`); browser panes own a `tabs[]` + `activeTabId` list exposed
  via header dropdowns (no room for a tab strip). `openUrlInBrowser(url, wsId?,
newTab?)` navigates the focused/first browser pane or creates one; the file
  tree's "Open in browser" ctx item (`.html`/`.htm`) passes `newTab` so a file
  open never clobbers a loaded page — `file://` urls are per-segment encoded.

* **minimized panes** (`pane.minimized`) keep their leaf in the layout tree —
  `SplitView` hides fully-minimized subtrees with the `hidden` attr, so the pane
  stays mounted and its pty/webview keeps running (removing the leaf would
  unmount it and kill the session). A `.pane-dock` strip at the bottom of the
  workspace lists chips; restoring clears the flag and the pane reappears in its
  exact slot. Minimized terminals respawn their pty on app restart (they re-mount
  hidden — acceptable).

## Commands

- `npm run dev` — start dev (sets `ELECTRON_DISABLE_SANDBOX=1`; required because
  `chrome-sandbox` lacks setuid root on this machine)
- `npm install` fails at the `electron-builder install-app-deps` postinstall
  (node-gyp rebuild needs make, which isn't installed) — deps still install fine;
  ignore it or use `--ignore-scripts`.
- `npm run typecheck` / `npm run lint` / `npm run build`
- `node tools/e2e.mjs [scenario]` — CDP-driven e2e against `out/` (needs
  `npm run build` first); `tools/ade-fake.mjs` is the fake harness it drives.
  See `docs/agents.md` → Testing.
- `npm run build:linux` — package via electron-builder

## Releases

Packaging is versioned — before every `npm run build:linux`, do all three
without being asked:

1. **Bump `version` in `package.json`** (patch by default; minor for
   milestones). Never repackage an unchanged version — an installed `ade`
   can't be told apart from the previous build under the same number.
2. **Write `requirements/<version>.md`** from `requirements/_template.md` —
   one `- [ ]` item (+ a `비고:` line) per user-facing behavior change in
   that release, grouped by area, so the user can verify each item while
   using the app. Files for older versions stay untouched.
3. After packaging, report the artifacts and the reinstall command
   (`sudo apt install --reinstall ./dist/ade_<version>_amd64.deb`).

## Architecture

- **Electron main** (`src/main/index.ts`): frameless `BrowserWindow`; IPC for files,
  dir listing/picker, JSON state (`userData/ade-state.json`), OS `Notification`
  (click forwards `notify:clicked` with workspace/pane meta), agent manifest.
  `webPreferences.webviewTag: true` enables `<webview>` browser panes.
  `ozone-platform-hint=auto` keeps it on native Wayland (XWayland renders blurry text).
- **pty-host** (`resources/pty-host.cjs`): separate _system Node_ child process that owns
  `node-pty` sessions (Electron 39 ABI 140 can't load the prebuilt native module).
  Newline-delimited JSON over stdio. Polls `/proc` for shell cwd **and walks the
  process tree to detect agent CLIs** (claude/codex/gemini/…), emitting
  `{t:'agent',agent}` events. Patterns come from `resources/agents/manifest.json`
  (`match`/`label`/`domain`/`color`), filtered by the provider toggles in
  settings (`agents:config` IPC). Provider icons follow Chrome's favicon model:
  `agents:icon` IPC fetches `domain`'s favicon (google s2 → site `/favicon.ico`),
  disk-caches under `userData/agent-icons/`, returns a data URL; `AgentIcon.tsx`
  falls back to a brand-colored letter monogram.
- **agent hooks** (`src/main/hooks.ts` + `hookInstallers.ts` + `eventsFile.ts`):
  per-harness hooks append NDJSON events to `~/.config/ade/agent-events.log`;
  a tailer forwards them to the renderer as `agent:event`. `ade-hook.cjs`
  normalizes every harness into one taxonomy — `turn-complete` / `needs-input`
  / `error` notify, `idle` / `turn-cancelled` / `turn-start` /
  `session-start` / `session-end` are tracking-only — and logs every raw
  invocation to `hook-raw.log` (always on, tail-kept). Installers: codex
  (`~/.codex/config.toml` notify), grok (`~/.grok/hooks/ade.json` — Stop,
  StopCancelled→error-or-silent, StopFailure→error, Notification classified by
  `notificationType`: `permission_prompt`→needs-input, `idle_prompt`→idle,
  SessionStart/SessionEnd), claude (`~/.claude/settings.json` Stop+Notification
  +SessionStart/SessionEnd — every Notification is needs-input, incl. the ≥60s
  "waiting for your input"), devin/zcode (Stop+PermissionRequest+SessionStart/
  SessionEnd), opencode (plugin: session.idle/error/created/deleted — Esc-abort
  classifies as turn-cancelled, sub-session lifecycles demote to `other` —
  permission/question.asked, held ~800ms so auto-approved asks never notify).
  `hooks:test` writes a synthetic event through the
  real channel — the Settings "agent hooks" section has status/install/test
  per provider. Events carry `adeSession` (`process.env.ADE_SESSION`, a per-run
  UUID set in main) plus `paneId`/`tabId` — the pty id's first two segments,
  stamped as `ADE_PANE`/`ADE_TAB` at spawn and echoed by the hook — so events
  attribute to the exact emitting tab (cwd guessing collapses when tabs share
  a directory). The tailer stamps `ours` (`adeSession === ours`); the renderer
  drops every event that isn't ours — hooks are global so agents in foreign
  terminals never notify. Ade-owned hook artifacts (script copy, grok's hook
  file, opencode plugin) refresh to the shipped version on app start;
  user-owned configs need a re-Install click.
- **session resume** (`src/renderer/src/resume.ts`, spec: `docs/agents.md` →
  Session resume): `resumeSessions` is the persisted, bounded set of sessions
  alive at last shutdown — `{sessionId, provider, cwd, wsId, paneId, tabId}`
  upserted on any `ours` event carrying a sessionId, dropped on `session-end`,
  agent→idle, pty `exit`, tab/pane/workspace close, and hydration-time
  structural pruning. On boot, activating a workspace with candidates shows
  `ResumePrompt`; accepting types `cd '<rec.cwd>' && <cmd> <args> '<sid>'`
  into each session's tab — freshly spawned on boot in `project.path`, so the
  cd puts the agent back in the session's own directory —
  via `pty.write` (queued on `spawned` when the shell isn't up yet, e.g. a
  detached window still opening). `will-quit` kills the pty-host so agents die
  with the app instead of orphaning; a `beforeunload` guard keeps dying
  sessions' `exit` events from stripping the set mid-shutdown.
- **attention policy** (`src/renderer/src/attention.ts`, spec:
  `docs/notifications.md`): every agent signal (hook events, pty agent→idle
  fallback, detached-window `agentIdle` relays) funnels through one policy —
  resolve target (session registry first, then cwd prefix), then attention
  level: **attended** (emitting tab on screen in the focused window → pre-read
  record, `needs-input` still badges), **ambient** (app focused but target
  off-screen → unread + workspace-tab dot, no OS), **away** (hosting window
  unfocused → unread + OS banner). Target-keyed dedupe collapses
  hook/pty-idle double-fires; 3s burst coalescing collapses subagent fan-out.
  Process-idle never notifies for providers with an installed hook. Pending
  `needs-input` settles to read on the next event for the same session/tab.
  Verdicts append to `~/.config/ade/notify-decisions.log` via `notify:decision`.
- **Preload** (`src/preload/index.ts`): `window.ade` — `pty`, `file`, `fs`, `state`,
  `notify`, `agents`, `win`, `openExternal`.
- **Renderer** (`src/renderer/src`): React 19 + zustand. Store holds `projects`,
  `workspaces[]` (each with `root`/`panes`/`focusedPaneId`), `settings`,
  `notifications`. `TabStrip.tsx` is the shared Chrome-curved-tab component used by
  `WorkspaceStrip` (title bar) and `EditorPane`/`TerminalPane` (pane title bar).
  `FileTree` backs both
  the app-icon hover overlay and the pinned `Sidebar`. Persisted state is saved
  debounced via `state:save` and hydrated before first render in `main.tsx`.
- PTY session ids are `paneId:tabId:uuid` — unique per terminal tab mount so
  stale `exit` events from a killed session (StrictMode remount, HMR, tab
  restart) can't corrupt a new one. Each session's events write back to its own
  tab (`patchTerminalTab`), including background tabs.
- Agent "completion" = harness hook events when installed, else the detected
  agent → idle transition (suppressed for hooked providers) → the attention
  policy above; clicking the in-app or OS notification jumps to the
  workspace/pane/tab. (Process-exit proxy — interactive agents ending their
  turn may not be captured without hooks.)

## Visual system

Hierarchy: **app shell → workspace surface → pane content**, one step darker each level.

- `--chrome` top bar/strips → `--tab-active` active tab + `.layout`/`.workspace-area`
  background + `.pane` card + `.pane-titlebar` → `--bg-pane` content islands.
- Active tab = fill + curved wings (`radial-gradient` pseudo-elements) colored by a
  shared `--tab-fill` var — `.pane-tabs` overrides it to `--bg-pane` so an active
  editor tab sinks into the content color.
- Panes carry `border: 1px solid var(--border-strong)` and are flush; the divider is
  a transparent 9px hit area with `margin: 0 -5px` so adjacent borders collapse into
  a single visible line. Hover/drag shows an accent divider line.
- Focused pane: `z-index` raise + 2px accent bar via `.pane-titlebar::before` on the
  left edge of the header only.
- Dark theme is neutral gray (no blue tint): `#101011 / #1a1a1c / #262629 / #151516`.

## Shortcuts

| Key                           | Action                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Alt+T / Alt+B / Alt+E / Alt+L | new terminal / browser / editor / todo pane                                                                                                                        |
| Alt+D / Alt+S                 | split focused pane right / down                                                                                                                                    |
| Alt+W                         | close focused pane                                                                                                                                                 |
| Alt+H                         | minimize focused pane to the dock                                                                                                                                  |
| Alt+] / Alt+\[                | cycle focus                                                                                                                                                        |
| Alt+Arrow keys                | move focus to the pane in that direction                                                                                                                           |
| Alt+M                         | toggle dark/light theme                                                                                                                                            |
| Alt+1 … Alt+9                 | activate workspace N (clamped to last)                                                                                                                             |
| Ctrl+Alt+→ / Ctrl+Alt+←       | next / previous workspace (wraps)                                                                                                                                  |
| Ctrl+Tab / Ctrl+Shift+Tab     | next / previous tab inside the focused pane                                                                                                                        |
| hold pane icon + drag         | move pane — center drop swaps, edge drop splits; drop on a workspace tab (or hover it \~0.4s mid-drag to switch workspaces) to move across workspaces; Esc cancels |

## Gotchas

- `webview.loadURL` throws before `dom-ready`; `BrowserPane` retries via a ready flag.
- Pane drag & drop (`paneDnd.ts`) is pointer-event based, not HTML5 DnD — a
  `<webview>` swallows all mouse events, so an armed drag sets
  `body.pane-dragging` which forces `pointer-events: none` on every webview,
  keeping `elementFromPoint` hit-testing and window pointermove/up alive.
- A focused `<webview>` also keeps its keydowns — `resources/webview-preload.cjs`
  runs inside every guest (`preload` attr) and relays Alt+\* / Ctrl+Tab via
  `ipc-message` → `ade:key` to `applyShortcut` in `shortcuts.ts` — the same
  dispatch the window keydown listener uses.
- No build tools (make/gcc) on this machine — never add deps that require node-gyp
  builds; prefer prebuilt binaries.
- Preload changes are NOT hot-reloaded — restart `npm run dev` after editing
  `src/preload/*` or `src/main/*`.
- Vite may cache a stale transform across rapid consecutive edits (CSS AND tsx
  modules — it once served a mid-edit `t0 is not defined` build for minutes) —
  `touch` the file + reload when live behavior doesn't match the source.
- inotify limits were raised to `fs.inotify.max_user_instances=512` /
  `max_user_watches=524288` (`/etc/sysctl.d/99-inotify.conf`); stray dev processes
  still waste instances — kill stale `electron-vite dev` before restarting.
- Debug renderer via CDP: start dev with `-- --remote-debugging-port=9222`,
  then `Page.captureScreenshot` / `Runtime.evaluate` against `localhost:9222/json`.
  Screenshots are physical pixels — `devicePixelRatio` is 1 here.
