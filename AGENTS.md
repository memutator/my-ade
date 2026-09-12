# ade

Personal ADE (Agent Development Environment) — a minimal tiling shell in the spirit of
Wave Terminal. Chrome-style workspace tabs sit in the title bar; each workspace is a
splittable pane layout scoped to a project directory.

## Domain model

* **project** = a directory (`{id, name, path}`), global registry.
* **workspace** = a tab = one split-pane layout, belongs to a project (`project:workspace = 1:N`).
  All workspaces across projects share the single `WorkspaceStrip` in the title bar.
  Switching happens only via workspace tabs; project is chosen when creating a workspace.
* Terminal cwd and the file-tree root come from the workspace's `project.path`.
* **terminal pane** owns an internal `TabStrip` of shell tabs (`tabs[]` +
  `activeTabId`); every tab keeps a mounted xterm + live pty in the background,
  and closing the last tab closes the pane. New tabs spawn in `project.path`.
* **editor pane** owns an internal `TabStrip` of file tabs; tree clicks open files there.
  Files are editable (CodeMirror); `.md`/`.markdown` open in Milkdown live-rendered
  WYSIWYG; `dirty` dots mark unsaved tabs; all open tabs stay mounted.
* **todo items** live per project (`todos: Record<projectId, TodoItem[]>`) — checklist
  with `todo`/`doing`/`done`, arbitrary `parentId` depth, `dependsOn` blocking, drag
  reorder. Surfaced as a sidebar section and as a `'todo'` pane type.
* **bookmarks** are global or project-scoped (`bookmarks: Bookmark[]`, `scope:
  'global' | projectId`); browser panes own a `tabs[]` + `activeTabId` list exposed
  via header dropdowns (no room for a tab strip).

## Commands

* `npm run dev` — start dev (sets `ELECTRON_DISABLE_SANDBOX=1`; required because
  `chrome-sandbox` lacks setuid root on this machine)
* `npm install` fails at the `electron-builder install-app-deps` postinstall
  (node-gyp rebuild needs make, which isn't installed) — deps still install fine;
  ignore it or use `--ignore-scripts`.
* `npm run typecheck` / `npm run lint` / `npm run build`
* `npm run build:linux` — package via electron-builder

## Architecture

* **Electron main** (`src/main/index.ts`): frameless `BrowserWindow`; IPC for files,
  dir listing/picker, JSON state (`userData/ade-state.json`), OS `Notification`
  (click forwards `notify:clicked` with workspace/pane meta), agent manifest.
  `webPreferences.webviewTag: true` enables `<webview>` browser panes.
  `ozone-platform-hint=auto` keeps it on native Wayland (XWayland renders blurry text).
* **pty-host** (`resources/pty-host.cjs`): separate *system Node* child process that owns
  `node-pty` sessions (Electron 39 ABI 140 can't load the prebuilt native module).
  Newline-delimited JSON over stdio. Polls `/proc` for shell cwd **and walks the
  process tree to detect agent CLIs** (claude/codex/gemini/…), emitting
  `{t:'agent',agent}` events. Patterns come from `resources/agents/manifest.json`
  (`match`/`label` only — no icons), filtered by the provider toggles in settings
  (`agents:config` IPC).
* **agent hooks** (`src/main/hooks.ts` + `hookInstallers.ts` + `eventsFile.ts`):
  per-harness Stop/idle hooks append NDJSON events to a userData file; a tailer
  forwards them to the renderer as `agent:event` (`turn-complete` / `needs-input`
  → notification). Installers: codex (`~/.codex/config.toml` notify), grok
  (`~/.grok/hooks/ade.json`), devin (`~/.config/devin/config.json`), zcode
  (`~/.zcode/cli/config.json`), opencode (plugin). `hooks:test` writes a synthetic
  event through the real channel — the Settings "agent hooks" section has
  status/install/test per provider. Process-detection idle is the fallback.
  Events carry `adeSession` (`process.env.ADE_SESSION`, a per-run UUID set in
  main): the env chain is pty-host → spawned shell → agent → hook, so the
  tailer drops events from agents launched outside ade — hooks are global, so
  without this every codex run on the machine would notify here.
* **Preload** (`src/preload/index.ts`): `window.ade` — `pty`, `file`, `fs`, `state`,
  `notify`, `agents`, `win`, `openExternal`.
* **Renderer** (`src/renderer/src`): React 19 + zustand. Store holds `projects`,
  `workspaces[]` (each with `root`/`panes`/`focusedPaneId`), `settings`,
  `notifications`. `TabStrip.tsx` is the shared Chrome-curved-tab component used by
  `WorkspaceStrip` (title bar) and `EditorPane`/`TerminalPane` (pane title bar).
  `FileTree` backs both
  the app-icon hover overlay and the pinned `Sidebar`. Persisted state is saved
  debounced via `state:save` and hydrated before first render in `main.tsx`.
* PTY session ids are `paneId:tabId:uuid` — unique per terminal tab mount so
  stale `exit` events from a killed session (StrictMode remount, HMR, tab
  restart) can't corrupt a new one. Each session's events write back to its own
  tab (`patchTerminalTab`), including background tabs.
* Agent "completion" = detected agent → idle transition → in-app notification +
  OS notification; clicking either jumps to the workspace/pane. (Process-exit proxy —
  interactive agents ending their turn may not be captured. Real per-harness hooks
  are in progress on `feat/harness-hooks`.)

## Visual system

Hierarchy: **app shell → workspace surface → pane content**, one step darker each level.

* `--chrome` top bar/strips → `--tab-active` active tab + `.layout`/`.workspace-area`
  background + `.pane` card + `.pane-titlebar` → `--bg-pane` content islands.
* Active tab = fill + curved wings (`radial-gradient` pseudo-elements) colored by a
  shared `--tab-fill` var — `.pane-tabs` overrides it to `--bg-pane` so an active
  editor tab sinks into the content color.
* Panes carry `border: 1px solid var(--border-strong)` and are flush; the divider is
  a transparent 9px hit area with `margin: 0 -5px` so adjacent borders collapse into
  a single visible line. Hover/drag shows an accent divider line.
* Focused pane: `z-index` raise + 2px accent bar via `.pane-titlebar::before` on the
  left edge of the header only.
* Dark theme is neutral gray (no blue tint): `#101011 / #1a1a1c / #262629 / #151516`.

## Shortcuts

| Key                           | Action                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Alt+T / Alt+B / Alt+E / Alt+L | new terminal / browser / editor / todo pane                                                                                                                        |
| Alt+D / Alt+S                 | split focused pane right / down                                                                                                                                    |
| Alt+W                         | close focused pane                                                                                                                                                 |
| Alt+] / Alt+\[                | cycle focus                                                                                                                                                        |
| Alt+Arrow keys                | move focus to the pane in that direction                                                                                                                           |
| Alt+M                         | toggle dark/light theme                                                                                                                                            |
| Alt+1 … Alt+9                 | activate workspace N (clamped to last)                                                                                                                             |
| Ctrl+Alt+→ / Ctrl+Alt+←       | next / previous workspace (wraps)                                                                                                                                  |
| Ctrl+Tab / Ctrl+Shift+Tab     | next / previous tab inside the focused pane                                                                                                                        |
| hold pane icon + drag         | move pane — center drop swaps, edge drop splits; drop on a workspace tab (or hover it \~0.4s mid-drag to switch workspaces) to move across workspaces; Esc cancels |

## Gotchas

* `webview.loadURL` throws before `dom-ready`; `BrowserPane` retries via a ready flag.
* Pane drag & drop (`paneDnd.ts`) is pointer-event based, not HTML5 DnD — a
  `<webview>` swallows all mouse events, so an armed drag sets
  `body.pane-dragging` which forces `pointer-events: none` on every webview,
  keeping `elementFromPoint` hit-testing and window pointermove/up alive.
* A focused `<webview>` also keeps its keydowns — `resources/webview-preload.cjs`
  runs inside every guest (`preload` attr) and relays Alt+\* / Ctrl+Tab via
  `ipc-message` → `ade:key` to `applyShortcut` in `shortcuts.ts` — the same
  dispatch the window keydown listener uses.
* No build tools (make/gcc) on this machine — never add deps that require node-gyp
  builds; prefer prebuilt binaries.
* Preload changes are NOT hot-reloaded — restart `npm run dev` after editing
  `src/preload/*` or `src/main/*`.
* Vite may cache an intermediate CSS state across rapid consecutive edits —
  `touch` the file + reload if a style looks stale.
* inotify limits were raised to `fs.inotify.max_user_instances=512` /
  `max_user_watches=524288` (`/etc/sysctl.d/99-inotify.conf`); stray dev processes
  still waste instances — kill stale `electron-vite dev` before restarting.
* Debug renderer via CDP: start dev with `-- --remote-debugging-port=9222`,
  then `Page.captureScreenshot` / `Runtime.evaluate` against `localhost:9222/json`.
  Screenshots are physical pixels — `devicePixelRatio` is 1 here.
