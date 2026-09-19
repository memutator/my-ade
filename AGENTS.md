# mahas

Personal Mahas (Agent Development Environment) — a minimal tiling shell in the spirit of
Wave Terminal. Chrome-style workspace tabs sit in the title bar; each workspace is a
splittable pane layout scoped to a project directory.

## Domain model

- **project** = a directory (`{id, name, path}`), global registry. The `+`
  workspace menu lists them with a two-click trash action: `removeProject`
  drops the project's workspaces (killing their ptys/agents),
  project-scoped bookmarks and resume records, and re-points a dangling
  `activeWorkspaceId` at a survivor — the directory on disk is untouched.
- **workspace** = a tab = one split-pane layout, belongs to a project (`project:workspace = 1:N`).
  All workspaces across projects share the single `WorkspaceStrip` in the title bar.
  Switching happens only via workspace tabs; project is chosen when creating a workspace.
- **a pane (leaf) has no type** — `PaneState` is a stack of kind-tagged
  blocks (`PaneTab = TerminalTab | BrowserTab | EditorTab`, `kind:
  'term' | 'web' | 'file'`); `LeafPane.tsx` renders the shared `TabStrip`
  plus the active block's content (`TerminalTabView` / `BrowserTabView` /
  `FileView`), and inactive blocks stay mounted (hidden) so shells, web
  pages and dirty buffers all keep running. Block chrome lives inside the
  content: a file block gets a top-right `.tree-fab` whose ~350ms hover pops
  the directory-tree overlay (`pane.treeRoot` + `TreeRootMenu` + `FileTree`,
  opens into that leaf); a web block floats a translucent `.web-head`
  omnibox/nav card over the page.
- **programmatic opens stack, never split** — `newBlock` / `openFile` /
  `openUrlInBrowser` resolve a leaf via `stackTarget` (explicit requester >
  kind-affine visible leaf for content kinds — docs bundle with docs, web
  tabs with web tabs; `term` stays focus-driven — > focused visible > last
  visible) and append a tab; a new leaf is inserted only when nothing
  visible exists. Invariant: **the focused leaf is never implicitly split**
  — `splitPane` is reachable only from explicit user gestures (Alt+D/Alt+S,
  the `⋯` menu, drag-to-edge). One exception (`soleLeafSplit`): appending a
  NEW tab when the workspace has a single visible leaf splits that leaf
  right — stacking would hide the only thing on screen (tab-reuse paths
  like openFile's dedup/preview slot still stay in place).
- Terminal cwd defaults to the workspace's `project.path`. File-tree roots are
  re-pickable via `TreeRootMenu` (MRU `treeRoots` → other projects → dir
  picker): the sidebar/peek-overlay share `sidebarRoots[projectId]` (default
  `project.path`), while a leaf owns `pane.treeRoot` (default project
  path, materialized onto the pane on float/detach).
- **terminal blocks** keep a mounted xterm + live pty per tab in the
  background. New tabs spawn in `project.path`.
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
- **file blocks** use VS Code-style **preview tabs**: tree single-click /
  Enter / ctx "Open" open an italic preview replaced in place by the next
  preview open; double-click on the tree row or the tab, "Keep Open" in the
  tab menu, or making the buffer dirty pins it. Explicit opens (file dialog,
  terminal links, create-and-open) are always pinned. Files are editable
  (CodeMirror); `.md`/`.markdown` open in Milkdown live-rendered WYSIWYG;
  `dirty` dots mark unsaved tabs; all open tabs stay mounted.
  `closeFilesUnder` closes file tabs under deleted paths (and the leaf when
  it empties).
- **closing the last tab of any leaf closes the leaf**. In a detached window
  the close routes through `pane:cmd` → the main store's `closePane`, which
  kills detached ptys and tears the window down via `closeDetached`.
- **bookmarks** are global or project-scoped (`bookmarks: Bookmark[]`, `scope:
'global' | projectId`); a web block's floating header exposes them via the
  star dropdown. `openUrlInBrowser(url, wsId?, newTab?, paneId?)` stacks a
  web block into the target leaf — or navigates its active web tab when
  `newTab` is false; the file tree's "Open in browser" ctx item
  (`.html`/`.htm`) passes `newTab` so a file open never clobbers a loaded
  page — `file://` urls are per-segment encoded.

* **minimized panes** (`pane.minimized`) keep their leaf in the layout tree —
  `SplitView` hides fully-minimized subtrees with the `hidden` attr, so the pane
  stays mounted and its pty/webview keeps running (removing the leaf would
  unmount it and kill the session). A `.pane-dock` strip at the bottom of the
  workspace lists chips; restoring clears the flag and the pane reappears in its
  exact slot. Minimized terminals respawn their pty on app restart (they re-mount
  hidden — acceptable). Inserting into a tree whose leaves are all hidden makes
  the new pane the sole root — orphaned hidden leaves re-insert on restore
  (`insertAt` also splits the last visible leaf instead of root-appending when
  hidden leaves exist, so their slots aren't demoted a level).
* **minimized tabs** (`tab.minimized`) leave the leaf's tab strip for ghost
  `.dock-chip`s in the title-bar `PaneDock` (next to the minimized-pane
  chips) — the block stays mounted and keeps running. Minimizing hands the
  active slot to the nearest visible tab; restoring un-tucks, activates it
  and raises a minimized pane / focuses a detached window when needed. Opens
  that re-activate a docked tab (openFile dedup, moved tabs) un-tuck it;
  `cyclePaneTab` skips docked tabs.

## Commands

- `npm run dev` — start dev (sets `ELECTRON_DISABLE_SANDBOX=1`; required because
  `chrome-sandbox` lacks setuid root on this machine). Dev runs an isolated
  profile: `userData` → `appData/mahas-dev` (state file, window state, icon
  cache, webview sessions) and `MAHAS_CONFIG_DIR` → `~/.config/mahas-dev` (event
  channel, hook script copy, decision log) — it never touches the installed
  app's live data. Agents spawned in dev terminals inherit `MAHAS_CONFIG_DIR`
  so their hook events route into the dev channel; harness hook installs
  still target the user's real configs (hooks are global by nature).
  `MAHAS_TEST` (e2e) opts out — it isolates via `XDG_CONFIG_HOME` instead.
  Dev runs stamp `MAHAS_DEV=1` into the env — the renderer reads it for the
  red "dev" badge left of the titlebar bell.
- `npm install` fails at the `electron-builder install-app-deps` postinstall
  (node-gyp rebuild needs make, which isn't installed) — deps still install fine;
  ignore it or use `--ignore-scripts`.
- `npm run typecheck` / `npm run lint` / `npm run build`
- `node tools/e2e.mjs [scenario]` — CDP-driven e2e against `out/` (needs
  `npm run build` first); `tools/mahas-fake.mjs` is the fake harness it drives.
  See `docs/agents.md` → Testing.
- `npm run build:linux` — package via electron-builder

## Releases

Packaging is versioned — before every `npm run build:linux`, do all three
without being asked:

1. **Bump `version` in `package.json`** (patch by default; minor for
   milestones). Never repackage an unchanged version — an installed `mahas`
   can't be told apart from the previous build under the same number.
2. **Write `requirements/<version>.md`** from `requirements/_template.md` —
   one `- [ ]` item (+ a `비고:` line) per user-facing behavior change in
   that release, grouped by area, so the user can verify each item while
   using the app. Files for older versions stay untouched.
3. After packaging, report the artifacts and the reinstall command
   (`sudo apt install --reinstall ./dist/mahas_<version>_amd64.deb`).

## Architecture

- **Electron main** (`src/main/index.ts`): frameless `BrowserWindow`; IPC for files,
  dir listing/picker, JSON state (`userData/mahas-state.json`), OS `Notification`
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
  per-harness hooks append NDJSON events to `~/.config/mahas/agent-events.log`;
  a tailer forwards them to the renderer as `agent:event`. `mahas-hook.cjs`
  normalizes every harness into one taxonomy — `turn-complete` / `needs-input`
  / `error` notify, `idle` / `turn-cancelled` / `turn-start` /
  `session-start` / `session-end` are tracking-only — and logs every raw
  invocation to `hook-raw.log` (always on, tail-kept). Installers: codex
  (`~/.codex/config.toml` notify), grok (`~/.grok/hooks/mahas.json` — Stop,
  StopCancelled→error-or-silent, StopFailure→error, Notification classified by
  `notificationType`: `permission_prompt`→needs-input, `idle_prompt`→idle,
  SessionStart/SessionEnd), claude (`~/.claude/settings.json` Stop+Notification
  +SessionStart/SessionEnd — every Notification is needs-input, incl. the ≥60s
  "waiting for your input"), devin/zcode (Stop+PermissionRequest+SessionStart/
  SessionEnd — Devin has no StopFailure; a rate-limit kills the turn after 3
  retries with a TUI `[Error]` banner and no hook, so the renderer also
  classifies that banner from pty output as `error`), opencode (plugin: session.idle/error/created/deleted — Esc-abort
  classifies as turn-cancelled, sub-session lifecycles demote to `other` —
  permission/question.asked, held ~800ms so auto-approved asks never notify),
  cline (event-named files under `~/.cline/hooks/` — TaskComplete→turn-complete,
  TaskError→error, TaskCancel→turn-cancelled, TaskStart→session-start,
  UserPromptSubmit→turn-start, SessionShutdown→session-end; stdin JSON payload
  carries `taskId`/`workspaceRoots`; runs with `parent_agent_id` demote to
  `other` with the sessionId stripped; a displaced user `<Event>` file is kept
  at `.mahas-bak` and our script re-pipes stdin to it).
  `hooks:test` writes a synthetic event through the
  real channel — the Settings "agent hooks" section has status/install/test
  per provider. Events carry `mahasSession` (`process.env.MAHAS_SESSION`, a per-run
  UUID set in main) plus `paneId`/`tabId` — the pty id's first two segments,
  stamped as `MAHAS_PANE`/`MAHAS_TAB` at spawn and echoed by the hook — so events
  attribute to the exact emitting tab (cwd guessing collapses when tabs share
  a directory). The tailer stamps `ours` (`mahasSession === ours`); the renderer
  drops every event that isn't ours — hooks are global so agents in foreign
  terminals never notify. Mahas-owned hook artifacts (script copy, grok's hook
  file, opencode plugin, cline's `~/.cline/hooks/<Event>` files) refresh to the
  shipped version on app start;
  leftover `ade-hook` pointers in user-owned configs (codex `config.toml`,
  claude/devin/zcode settings) are rewritten to `mahas-hook` on start — the
  ade→mahas rename deleted that path, so without the rewrite Codex never
  emits `turn-complete`. New providers still need a re-Install click.
- **devin session-lock sweep** (`src/main/devinLocks.ts`): `devin` CLI leaves
  `~/.local/share/devin/cli/session_locks/*.lock` behind on kill/crash and
  then refuses the session with `session_locked`. mahas sweeps on app start,
  on each devin `session-end` event, on pty `exit`, and (quit delayed ~400ms)
  on `will-quit` — a lock drops only when no flock is held on the inode AND
  its recorded pid is dead/not-devin, so live sessions are never unlocked.
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
  Verdicts append to `~/.config/mahas/notify-decisions.log` via `notify:decision`.
  A term tab's close slot is also a live status light (`TabItem.status` →
  `.ctab-st`): `working` pulse driven by `tab.working` (pty output activity
  while an agent is detected, refined by hook turn-start/end events — spec:
  `docs/notifications.md` → Tab status dots; `idleLocked` after turn-complete
  so a dense idle TUI cannot relight the pulse), amber for unread `needs-input`,
  red for unread `error`; hovering the tab swaps the dot back to the close X.
- **Preload** (`src/preload/index.ts`): `window.mahas` — `pty`, `file`, `fs`, `state`,
  `notify`, `agents`, `win`, `openExternal`.
- **Renderer** (`src/renderer/src`): React 19 + zustand. Store holds `projects`,
  `workspaces[]` (each with `root`/`panes`/`focusedPaneId`), `settings`,
  `notifications`. `TabStrip.tsx` is the shared Chrome-curved-tab component used by
  `WorkspaceStrip` (title bar) and `LeafPane` (the leaf's block strip).
  `FileTree` backs the
  app-icon hover overlay, the pinned `Sidebar`, and the file block's corner-fab
  overlay. Persisted state is saved
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
| Alt+T / Alt+B / Alt+E         | stack a terminal / browser / editor block into the focused leaf                                                                                                    |
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
| hold tab + drag               | move tab — inside the strip reorders; center/strip drop on another pane stacks; edge drop splits (own pane too); workspace-tab drop moves it to a new leaf there    |

## Gotchas

- `webview.loadURL` throws before `dom-ready`; `BrowserPane`'s `syncUrl` retries
  on a bounded timer.
- Pane/tab drag & drop (`paneDnd.ts`) is pointer-event based, not HTML5 DnD —
  a `<webview>` swallows all mouse events, so an armed drag sets
  `body.pane-dragging` which forces `pointer-events: none` on every webview,
  keeping `elementFromPoint` hit-testing and window pointermove/up alive. One
  engine serves both: pane drags come from the titlebar grip, tab drags from a
  `.ctab` press — inside the source strip a tab drag resolves to an `insert`
  reorder target instead of a pane/ws drop.
- A focused `<webview>` also keeps its keydowns — `resources/webview-preload.cjs`
  runs inside every guest (`preload` attr) and relays Alt+\* / Ctrl+Tab via
  `ipc-message` → `mahas:key` to `applyShortcut` in `shortcuts.ts` — the same
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
