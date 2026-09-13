# Architecture

ade is an Electron app: one main process, one or more renderer windows (React 19
with a zustand store), a separate **system-Node** child process that owns every
pty session, and `<webview>` guests inside the renderers. The main window's
zustand store is the single source of truth; detached-pane windows run their own
renderer + store and sync back up.

## Process topology

```
┌─ electron main ──── src/main/index.ts, pty.ts, hooks.ts, fsops.ts, …
│     IPC handlers: pty · file · fs · dir · git · state · notify ·
│                   agents · hooks · win · webview · openExternal
│
│     ├─► BrowserWindow "main"       frameless, webviewTag:true
│     │      └─ renderer: App + zustand store (source of truth)
│     │            └─ <webview> guests ── resources/webview-preload.cjs
│     │                                 relays Alt+*/Ctrl+Tab → 'ade:key'
│     │
│     ├─► BrowserWindow "detached"   one per detached pane (?detached=ws:pane)
│     │      └─ renderer: DetachedApp, own store ── pane:syncUp / pane:cmd
│     │
│     └─► pty-host (child_process)   resources/pty-host.cjs, system Node
│            NDJSON over stdio; events broadcast to ALL windows
│            └─ node-pty → shells → agent CLIs
│                 └─ /proc poll (1.2 s): cwd changes + agent tree detect
└──────────────────────────────────────────────────────────────────────
   persists:   userData/ade-state.json     (main window only, debounced)
   hook log:   userData/agent-events.log   (NDJSON tail → 'agent:event')
   icon cache: userData/agent-icons/
```

`userData` resolves to `~/.config/ade` (`ADE_CONFIG_DIR`/`XDG_CONFIG_HOME`
honored by `eventsFile.ts`).

## Electron main (`src/main/index.ts`)

- `app.commandLine.appendSwitch('ozone-platform-hint', 'auto')` keeps the app
  on native Wayland — XWayland renders blurry text.
- `process.env.ADE_SESSION ??= randomUUID()` — per-run session tag inherited by
  pty-host → spawned shells → agent CLIs → hook scripts, which stamp it onto
  each event so the tailer can tell our terminals from foreign ones.
- `createWindow()` — frameless `BrowserWindow` (min 480×320, clamped to the
  work area under the cursor), `backgroundColor: '#0b0d10'`,
  `webPreferences: { sandbox: false, webviewTag: true }`. `webviewTag` enables
  the `<webview>` browser panes. `window.open` is denied and routed to
  `shell.openExternal`.

### IPC surface

| Channel                                                                                                         | Purpose                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pty:spawn/attach/write/resize/kill`                                                                            | forwarded to pty-host as NDJSON                                                                                                                                                                                                                 |
| `file:openDialog/read/write/stat`                                                                               | file ops; `read` caps at 20 MiB and sniffs a kind (`image`/`video`/`audio`/`pdf`/`text`/`binary` by extension + NUL-byte probe); `write` returns post-write `mtimeMs` for the FileView save guard                                               |
| `file:watch/unwatch` → `file:changed`                                                                           | per-file watch for open editor tabs (`src/main/filewatch.ts`)                                                                                                                                                                                   |
| `fs:list`, `fs:resolve`, `dialog:pickDirectory`                                                                 | dir listing (dirs first, cap 500), `~`/relative path resolution, project picker                                                                                                                                                                 |
| `fs:create/rename/trash/copy/move/exists/reveal`                                                                | file-tree ops (`src/main/fsops.ts`)                                                                                                                                                                                                             |
| `dir:watch/unwatch` → `dir:changed`                                                                             | listing watch for expanded tree dirs (`src/main/dirwatch.ts`)                                                                                                                                                                                   |
| `git:info`, `git:worktreeAdd/Remove`                                                                            | worktree support (`src/main/worktree.ts`)                                                                                                                                                                                                       |
| `state:load`, `state:save`                                                                                      | `userData/ade-state.json`; **only the main window's webContents may save** (sender check) so detached renderers can't clobber it                                                                                                                |
| `notify:show` → `notify:clicked`                                                                                | OS `Notification`; a click focuses the main window and forwards `{workspaceId, paneId, tabId}`                                                                                                                                                  |
| `agents:manifest/icon`, `agents:config`                                                                         | `resources/agents/manifest.json`; `icon` fetches the provider domain's favicon (google s2 → site `/favicon.ico`), mime-sniffs, disk-caches to `userData/agent-icons/<id>.img`, returns a data URL; `config` pushes match patterns into pty-host |
| `hooks:status/install/test/emit` → `agent:event`                                                                | per-harness hook management (`src/main/hooks.ts` + `hookInstallers.ts`); `test`/`emit` write through the real event file                                                                                                                        |
| `win:minimize/maximize/close/alwaysOnTop`                                                                       | sender-scoped window controls (main or detached)                                                                                                                                                                                                |
| `win:detach`, `pane:hello`, `win:reattach`, `win:closeDetached`, `win:focusDetached`, `pane:cmd`, `pane:syncUp` | detached-pane window coordination                                                                                                                                                                                                               |
| `webview:preloadPath`                                                                                           | `file://` URL of `resources/webview-preload.cjs` for the `<webview preload>` attribute                                                                                                                                                          |
| `shell:openExternal`                                                                                            | `http(s)` URLs only                                                                                                                                                                                                                             |

### Detached pane windows

`win:detach {wsId, paneId, pane}` → `createDetachedWindow(key)` opens a second
frameless `BrowserWindow` loading the same renderer bundle with
`?detached=<wsId>:<paneId>`. The fresh pane snapshot is stashed in
`pendingPanes` and claimed by the booting detached renderer via `pane:hello` —
it carries live pty session ids and newest tabs that the disk-hydrated state
may lack. `pane:cmd` / `pane:syncUp` relay detached-renderer intents to the
main window (`pane:cmd` → close etc., `pane:syncUp` → `pane:applySync` merges
content fields while the main store keeps the `detached`/`minimized`/`floating`
flags). Closing a detached window sends `pane:reattach` to the main window,
which clears the flag and drops the pane back into its layout slot.

## pty-host (`resources/pty-host.cjs` + `src/main/pty.ts`)

pty sessions run under a **separate system-Node process**, not Electron:
Electron 39 (ABI 140) can't load
`@homebridge/node-pty-prebuilt-multiarch`'s prebuilt native module, so
`startPtyHost()` spawns `<node> pty-host.cjs` and speaks newline-delimited
JSON over stdio (stderr inherited into the main process's console).

**Node binary resolution** (`nodeBinary()`): `ADE_NODE` env → `NODE_BINARY`
env → `node --version` PATH probe → fixed paths (`/usr/bin/node`,
`/usr/local/bin/node`, `/snap/bin/node`, linuxbrew, `~/.volta/bin/node`,
`~/.local/bin/node`, `~/.asdf/shims/node`) → newest semver dir under
nvm/mise/fnm/asdf install roots (`bin/node` or `installation/bin/node`).
Desktop launches don't inherit interactive-shell PATH, so version-manager
installs must be found by scanning. If nothing resolves, the app still runs —
terminals just stay dead.

**Protocol** (one JSON object per line):

- in: `{t:'spawn',id,cols,rows,cwd,command,args}` · `{t:'attach',id,cols,rows}`
  · `{t:'write',id,d}` (base64) · `{t:'resize'}` · `{t:'kill'}` ·
  `{t:'config',agents}`
- out: `{t:'ready'}` · `{t:'spawned',pid,shell}` · `{t:'attached'}` ·
  `{t:'attach-failed'}` · `{t:'data',d}` (base64) · `{t:'exit',code}` ·
  `{t:'cwd'}` · `{t:'agent',agent}` · `{t:'error',msg}`

Behavior:

- Main queues outbound messages until `{t:'ready'}` arrives.
- `pty:attach` awaits `attached`/`attach-failed` with a 3 s timeout. The host
  keeps a 512 KiB scrollback tail per session and replays it on attach, so
  remounts and detached windows resume live sessions instead of spawning fresh
  shells.
- Poll loop every 1.2 s per session: `readlink /proc/<pid>/cwd` → `{t:'cwd'}`
  on change; breadth-first walk of `/proc/<pid>/task/<pid>/children` (depth ≤ 6)
  matching `comm` + cmdline basenames against agent patterns → `{t:'agent'}`.
  Agent→idle is declared only after two consecutive misses — process trees flap
  during title updates.
- Patterns come from a built-in fallback table, replaced by `{t:'config'}`:
  main pushes the manifest's `match` lists filtered by the provider toggles in
  settings (`agents:config`).
- Main **broadcasts every host event to all `BrowserWindow`s** — detached
  panes live in separate renderers that need their session's data too.
- Spawn uses `command || $SHELL || /bin/bash` with `TERM=xterm-256color`,
  `COLORTERM=truecolor`.

Session ids are `paneId:tabId:uuid` minted in `TerminalPane.tsx` and stored on
the tab (`tab.pty`) — unique per tab mount, so a stale `exit` event from a
killed session (StrictMode remount, HMR, tab restart) can't corrupt a new one.
Each session's events write back to its own tab via `patchTerminalTab`,
including background tabs.

## Preload (`src/preload/index.ts`)

`contextBridge` exposes `window.ade` (plus `window.electron`):

- `pty` — `spawn`, `attach` (resolves `false` when the session is gone),
  `write`, `resize`, `kill`, `onEvent`
- `file` — `openDialog`, `read`, `write`, `stat`, `watch`/`unwatch`, `onChanged`
- `fs` — `list`, `pickDirectory`, `resolvePath`, `create`, `rename`, `trash`,
  `copy`, `move`, `exists`, `reveal`
- `dir` — `watch`, `unwatch`, `onChanged`
- `git` — `info`, `addWorktree`, `removeWorktree`
- `state` — `load`, `save`
- `notify` — `show`, `onClicked`
- `agents` — `manifest`, `icon`, `configure`
- `hooks` — `status`, `install`, `test`, `emit`, `onEvent`
- `win` — window controls + detached-pane coordination (`detach`, `hello`,
  `reattach`, `paneCmd`, `paneSyncUp`, `onPaneReattach`, `onPaneCmd`,
  `onPaneSync`, …)
- `webview` — `preloadPath`
- `openExternal`

Binary payloads cross the bridge as base64 (`pty.write` input, `data` events,
`file.read` results).

## Renderer (`src/renderer/src`)

React 19 + a single zustand store (`store.ts`, `useStore`).

### Persisted state

`PersistedState`: `projects`, `workspaces`, `activeWorkspaceId`, `settings`,
`sidebarOpen`, `bookmarks`, `todos`, `agentSessions`. A `useStore.subscribe`
in `App.tsx` debounces 400 ms and calls `state:save`; `main.tsx` awaits
`state.load()` + the agent manifest **before first render** and runs
`hydrate()`, which migrates older saves (`normalizeWorkspace`/`normalizePane`
— e.g. pre-tab terminal panes get a seeded tab).

### Workspace + split-tree model

`Workspace = {id, name, projectId, root, panes, focusedPaneId}`. `root` is a
binary layout tree (`types.ts`):

```ts
type LayoutNode =
  | { kind: 'leaf'; id: string; paneId: string }
  | { kind: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode }
```

`ratio` is `a`'s share of the split (clamped 0.1–0.9 by `setRatio`).
`insertAt` splits a target leaf at a `DropEdge` (left/right → `row`, top/bottom
→ `col`; left/top inserts first), or wraps the root in a row split with ratio
`n/(n+1)` so existing panes keep their relative share when appending.
`removeLeaf` collapses a split back to its surviving child; `movePane` is a
strip+graft (or `swapPaneIds` for a center drop).

Pane presentation flags (`PaneBase`):

- `minimized` — the leaf **stays** in the tree; `SplitView` hides fully
  minimized subtrees with the `hidden` attribute so the mounted xterm/webview
  (and its pty) keeps running. A `.pane-dock` strip at the bottom of the
  workspace lists chips; restoring clears the flag and the pane reappears in
  its exact slot.
- `floating` — the leaf is **removed** (space reclaimed) and the pane renders
  as a `FloatLayer` overlay positioned by a `FloatRect` (`x/y/w/h` as 0..1
  fractions of the workspace area + `z` stacking).
- `detached` — the leaf stays (reattach lands on the same slot) but the content
  unmounts here; a separate `BrowserWindow` owns it. Terminal sessions survive
  via pty `attach` on the stored session id.

### Shared components

- `TabStrip.tsx` — the Chrome-curved tab strip (drag reorder, dbl-click rename,
  dirty dots, wheel→horizontal scroll, overlay thumb) used by `WorkspaceStrip`
  in the title bar **and** by `EditorPane`/`TerminalPane` inside the pane
  title bar.
- `Menu.tsx` — shared popup primitives, all portaled to `document.body`:
  `Popup` (`position:fixed`, viewport-clamped, closes on outside mousedown /
  Escape / scroll / resize / **focus theft** — a focused `<webview>` emits no
  keydown or click to the host, only a capture-phase focus event), `Dropdown`
  (trigger wrapper, click or hover mode), `Select` (themed `<select>`).

### Shortcuts

`applyShortcut` (`shortcuts.ts`) is the single dispatch for both the window
keydown listener and `ade:key` ipc-messages relayed from
`resources/webview-preload.cjs` inside every `<webview>` guest — a focused
guest keeps its own keydowns, which would otherwise kill every app shortcut
while typing in a browser pane. User bindings live in `settings.bindings`
(`'ctrl+alt+shift+key'` combos); Alt+1…9 (workspace N) and Ctrl+Tab (cycle tabs
inside a pane) stay hardcoded but lose to an explicit user binding.

### Agent awareness

Two signal paths land in `notifications[]` (+ optional OS notification;
clicking either jumps to workspace/pane/tab):

1. **Process detection** — pty-host `{t:'agent'}` events; an agent→idle
   transition fires `agentFinished` (the completion proxy).
2. **Harness hooks** — installed per-provider hooks append NDJSON to
   `userData/agent-events.log`; the main-process tailer stamps `ours`
   (`adeSession === ADE_SESSION`) and forwards `agent:event`. Renderer policy:
   ours → always notify; foreign → notify only when the event's cwd sits
   inside a registered project.
