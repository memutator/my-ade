# Architecture

mahas is an Electron app plus two system-Node daemons. One main process drives
one or more renderer windows (React 19 with a zustand store), a separate
**system-Node** child process owns every pty session, and `<webview>` guests
run inside the renderers. The main window's zustand store is the single source
of truth for the shell; the daemons own the control-plane state the shell reads.

## Process topology

```
┌─ electron main ──── src/main/index.ts (composition root ~180 lines)
│     feature modules: pty.ts · hooks.ts · eventsFile.ts · agentEventIngest.ts
│       hookInstallers.ts · harnessPack.ts · devinLocks.ts · fsops.ts ·
│       dirwatch.ts · filewatch.ts · worktree.ts · usage.ts · usageAuth.ts ·
│       ledger.ts · runtimeClient.ts · windowState.ts
│     split modules:   platform/{windows,windowIpc,fileIpc,agentIpc}.ts
│                      state/{store,persistence}.ts
│                      runtime/{serviceBootstrap,domainIpc,authClient}.ts
│     IPC: pty · file · fs · dir · git · state · notify · agents · hooks ·
│          win · webview · openExternal · runtime · exec · domain · usage ·
│          usageAuth
│
│     ├─► BrowserWindow "main"       frameless, webviewTag:true
│     │      └─ renderer: App + zustand store (shell source of truth)
│     │            └─ <webview> guests ── resources/webview-preload.cjs
│     │                                 relays Alt+*/Ctrl+Tab → mahas:key
│     │
│     ├─► BrowserWindow "detached"   one per detached pane (?detached=ws:pane)
│     │      └─ renderer: DetachedApp, own store ── pane:syncUp / pane:cmd
│     │
│     ├─► pty-host (child_process)   resources/pty-host.cjs, system Node
│     │      NDJSON over stdio; events broadcast to ALL windows
│     │      └─ node-pty → shells → agent CLIs
│     │           └─ /proc poll (1.2 s): cwd changes + agent tree detect
│     │
│     ├─► mahasd (spawned, system Node ≥24)     packages/mahas-runtime
│     │      control-plane daemon: single writer of mahas.sqlite,
│     │      ordinary authenticated RPC socket + DEDICATED auth socket
│     │      (<configDir>/mahasd-auth.sock), collection scheduler,
│     │      hook-stream reader, Pack registry/runner
│     │      └─ Pack scripts (integrations/packs/*) invoked via runPack
│     │
│     └─► execution-host (spawned, system Node ≥24)
│            packages/mahas-execution-host — owns managed process/PTY
│            incarnations for the execution domain
└──────────────────────────────────────────────────────────────────────
   persists:   userData/mahas-state.json     (main window only, atomic replace)
   control DB: <configDir>/mahas.sqlite      (mahasd only; schema v3)
   hook log:   <configDir>/agent-events.log  (NDJSON tail → ingest → agent:event)
   icon cache: userData/agent-icons/
```

`userData` resolves to `~/.config/mahas` and `configDir` follows
`MAHAS_CONFIG_DIR`/`XDG_CONFIG_HOME` (`eventsFile.ts`). Dev runs isolate both
under `mahas-dev` paths — see [setup](../development/setup.md).

The desktop is a **client** of the daemons: closing the UI detaches the client
and leaves `mahasd` collecting; reconnecting reads stored data. Managed
executions (the `exec:*` surface) live on the daemon lifetime, while unmanaged
shell terminals stay on the app-owned pty-host and die with the app — the two
lifetimes are never mixed in one terminal.

## Electron main (`src/main/index.ts`)

A composition root and nothing else: profile/paths, the window registry, then
per-feature IPC registration. The bodies live in their own modules —

- `platform/` — window creation/registry (`windows.ts`), detached-window and
  window-control IPC (`windowIpc.ts`), file dialogs and fs listing IPC
  (`fileIpc.ts`), agent manifest/icon/config IPC (`agentIpc.ts`).
- `state/` — the state-file boundary (`store.ts`) and its writer
  (`persistence.ts`: serial atomic temp-file→rename writes, plus a synchronous
  shutdown write that fences every older queued snapshot so a stale async
  write can never replace the final one).
- `runtime/` — `serviceBootstrap.ts` (system Node ≥24 resolution, service
  entrypoints, detached spawn, logs under `<configDir>/logs/`), `domainIpc.ts`
  (the desktop's only domain read path), `authClient.ts` (the dedicated auth
  socket's only desktop client).

- `app.commandLine.appendSwitch('ozone-platform-hint', 'auto')` keeps the app
  on native Wayland — XWayland renders blurry text.
- `process.env.MAHAS_SESSION ??= randomUUID()` — per-run session tag inherited by
  pty-host → spawned shells → agent CLIs → hook scripts, which stamp it onto
  each event so the tailer can tell our terminals from foreign ones.
- `createWindow()` — frameless `BrowserWindow` (min 480×320, clamped to the
  work area under the cursor), `backgroundColor: '#0b0d10'`,
  `webPreferences: { sandbox: false, webviewTag: true }`. `webviewTag` enables
  the `<webview>` browser panes. `window.open` is denied and routed to
  `shell.openExternal`.

### IPC surface

| Channel | Purpose |
| --- | --- |
| `pty:spawn/attach/write/resize/kill` | forwarded to pty-host as NDJSON |
| `file:openDialog/read/write/stat` | file ops; `read` caps at 20 MiB and sniffs a kind (`image`/`video`/`audio`/`pdf`/`text`/`binary` by extension + NUL-byte probe); `write` returns post-write `mtimeMs` for the FileView save guard |
| `file:watch/unwatch` → `file:changed` | per-file watch for open editor tabs (`src/main/filewatch.ts`) |
| `fs:list`, `fs:resolve`, `dialog:pickDirectory` | dir listing (dirs first, cap 500), `~`/relative path resolution, project picker |
| `fs:create/rename/trash/copy/move/exists/reveal` | file-tree ops (`src/main/fsops.ts`) |
| `dir:watch/unwatch` → `dir:changed` | listing watch for expanded tree dirs (`src/main/dirwatch.ts`) |
| `git:info`, `git:worktreeAdd/Remove` | worktree support (`src/main/worktree.ts`) |
| `state:load`, `state:save`, `state:saveSync` | `userData/mahas-state.json`; **only the main window's webContents may save** (sender check) so detached renderers can't clobber it; writes are serial atomic replaces and `saveSync` is the beforeunload final write that fences stale queued ones |
| `notify:show` → `notify:clicked` | OS `Notification`; a click focuses the main window and forwards `{workspaceId, paneId, tabId}` |
| `agents:manifest/icon`, `agents:config` | `resources/agents/manifest.json` (a generated projection of the harness-runtime Pack); `icon` fetches the provider domain's favicon (google s2 → site `/favicon.ico`), mime-sniffs, disk-caches to `userData/agent-icons/<id>.img`, returns a data URL; `config` pushes match patterns into pty-host |
| `hooks:status/install/test/emit` → `agent:event` | per-harness hook management (`src/main/hooks.ts` + `hookInstallers.ts`, driven by the Pack's `installers.json`); `test`/`emit` write through the real event file |
| `win:minimize/maximize/close/alwaysOnTop` | sender-scoped window controls (main or detached) |
| `win:detach`, `pane:hello`, `win:reattach`, `win:closeDetached`, `win:focusDetached`, `pane:cmd`, `pane:syncUp` | detached-pane window coordination |
| `webview:preloadPath` | `file://` URL of `resources/webview-preload.cjs` for the `<webview preload>` attribute |
| `shell:openExternal` | `http(s)` URLs only |
| `runtime:status`, `exec:*` | daemon attachment state and the managed-execution route (`src/main/runtimeClient.ts`) — the only path managed executions may take |
| `domain:*` | stored domain reads (catalog/inventory/quota/ledger/summaries/statistics/sessions/collection) plus explicit mutations (`domain:collection.request`, `domain:auth.*`) — `src/main/runtime/domainIpc.ts` |
| `usage:fetch`, `usage:ledger`, `usageAuth:*` | legacy wire channels kept as compatibility projections over the stored domain — `src/main/usage.ts`, `src/main/ledger.ts`, `src/main/usageAuth.ts` |

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

## The daemons (`mahasd`, `execution-host`)

`src/main/runtime/serviceBootstrap.ts` resolves a system Node **≥ 24**
(`MAHAS_NODE`, `NODE_BINARY`, `PATH`, fixed prefixes, nvm/mise/fnm/asdf roots),
the service entrypoints (dev → `packages/*/src/main.ts` run with Node type
stripping; packaged → `<resources>/services/*.mjs` built by
`tools/build-services.mjs`), then spawns both daemons detached with stdout/stderr
under `<configDir>/logs/` and `MAHAS_BUILTIN_PACKS_DIR` pointing at the Pack
tree. A spawn is never treated as readiness — clients wait for the service's
own ready verdict.

`mahasd` composes the domain store at boot
(`packages/mahas-runtime/src/composition-domains.ts`): catalog seed, local
machine identity, the Pack registry (every manifest under the built-in packs
root, nested directories included), the collection scheduler, the hook-stream
reader, usage/quota/aggregate/statistic operations, and the auth domain. It is
the single writer of `mahas.sqlite`; its ordinary socket serves the
authenticated operation registry, and a **second socket**
(`<configDir>/mahasd-auth.sock`) serves the auth channel — provider secrets
never travel the receipt-persisting ordinary pipeline.

The desktop reaches the store through two clients only:

- `runtimeClient.ts` — the authenticated `mahas-client` session used for
  `runtime:status`, `exec:*`, and every `domain:*` call. A failed call drops
  the cached client so the next call retries the handshake.
- `runtime/authClient.ts` — the dedicated auth channel. A raw secret goes IN
  once (`auth.secret.deposit`) and only a single-use handle comes back; every
  other method is secret-free.

Queries are stored reads — nothing in the desktop scans a harness log, parses
a session file, or probes a provider. Collection is a separate mutation
(`domain:collection.request` queues durable per-source requests for the
scheduler). UI close detaches the client and leaves collection running;
`will-quit` calls `disconnectDesktopRuntime()`, which never drain-stops the
daemons.

## pty-host (`resources/pty-host.cjs` + `src/main/pty.ts`)

pty sessions run under a **separate system-Node process**, not Electron:
Electron 39 (ABI 140) can't load
`@homebridge/node-pty-prebuilt-multiarch`'s prebuilt native module, so
`startPtyHost()` spawns `<node> pty-host.cjs` and speaks newline-delimited
JSON over stdio (stderr inherited into the main process's console).

**Node binary resolution** (`nodeBinary()`): `MAHAS_NODE` env → `NODE_BINARY`
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

## Preload (`src/preload/index.ts` + `src/preload/domain.ts`)

`contextBridge` exposes `window.mahas` (plus `window.electron`):

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
- `usage`, `usageAuth`, `ledger` — the legacy channels backed by the compat
  projections
- `exec`, `runtime` — managed executions and daemon status
- `domain` — the canonical reads and mutations: `usage.sources`,
  `usage.ledger`, `usage.summaries`, `usage.statistics`, `sessions.list`,
  `sessions.detail`, `collection.sources`, `collection.request`,
  `usage.removeSource`, and the auth flow methods (`auth.start`,
  `auth.submitCode`, `auth.saveSecret`, `auth.poll`, `auth.status`,
  `auth.cancel`, `auth.refresh`)
- `openExternal`

Binary payloads cross the bridge as base64 (`pty.write` input, `data` events,
`file.read` results). The wire DTOs for `domain.*` live in
`src/preload/domain.ts` and extend `mahas-contracts` types — the renderer
imports contracts type-only.

## Renderer (`src/renderer/src`)

React 19 + a single zustand store (`store.ts`, `useStore`). The code is split
by responsibility:

- `shell/` — pure layout math (`layout.ts`), hydration/migration
  (`hydration.ts`), id helpers (`ids.ts`), and the IPC/PTY/window effect seam
  (`effects.ts`).
- `features/` — `terminal/` (codec, error scan, links, theme, transport,
  working pulse), `files/` (paths, operations, tree state), `usage/` (the
  domain read client plus UsageWidget/TokensWidget/AuthPanel/StatisticsPanel/
  MixBar and the view model), `sessions/` (stored-session list and detail).
- `workbench/` — project/run-scoped state, queues, contracts, and the
  control-plane views.
- `components/` — the shell widgets (SplitView, LeafPane, TabStrip, FileTree,
  TerminalPane, BrowserPane, FileView, menus, notifications).

### Persisted state

`PersistedState`: `projects`, `workspaces`, `activeWorkspaceId`, `settings`,
`sidebarOpen`, `bookmarks`, `agentSessions`. A `useStore.subscribe`
in `App.tsx` debounces 400 ms and calls `state:save`; `main.tsx` awaits
`state.load()` + the agent manifest **before first render** and runs
`hydrate()`, which migrates older saves (`normalizeWorkspace`/`normalizePane`
— v<3 typed panes become stacks of kind-tagged tabs; todo panes are dropped).

### Workspace + split-tree model

`Workspace = {id, name, projectId, root, panes, focusedPaneId}`. `root` is a
binary layout tree (`types.ts`):

```ts
type LayoutNode =
  | { kind: 'leaf'; id: string; paneId: string }
  | { kind: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode }
```

**A pane has no type** — `PaneState = {id, tabs: PaneTab[], activeTabId, …}`
is a stack of kind-tagged blocks (`PaneTab = TerminalTab | BrowserTab |
EditorTab | WidgetTab`, discriminated by `kind: 'term' | 'web' | 'file' | 'widget'`). The active
tab's kind picks the content rendered inside `LeafPane` and the block chrome
that floats over it (editor corner fab, browser omnibox header).

Placement invariant: **programmatic opens stack, never split** — `newBlock`,
`openFile`, and `openUrlInBrowser` resolve a target leaf via `stackTarget`
(explicit requester > focused visible leaf > last visible leaf) and append a
tab; `insertPane` (a new leaf) is reached only when nothing visible exists.
`splitPane` is the sole implicit-geometry op and is only reachable from user
gestures (shortcuts, `⋯` menu, drag-to-edge).

`ratio` is `a`'s share of the split (clamped 0.1–0.9 by `setRatio`).
`insertAt` splits a target leaf at a `DropEdge` (left/right → `row`, top/bottom
→ `col`; left/top inserts first), or wraps the root in a row split with ratio
`n/(n+1)` so existing panes keep their relative share when appending.
`removeLeaf` collapses a split back to its surviving child; `movePane` is a
strip+graft (or `swapPaneIds` for a center drop).

Pane presentation flags:

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
  in the title bar **and** by `LeafPane` as the leaf's block strip.
- `LeafPane.tsx` — the unified leaf renderer: shared `TabStrip` of the pane's
  blocks, per-kind content views (`TerminalTabView`, `BrowserTabView`,
  `FileView`, `WidgetTabView`), and the block chrome inside the content (file
  corner fab + tree overlay, web floating header).
- `Menu.tsx` — shared popup primitives, all portaled to `document.body`:
  `Popup` (`position:fixed`, viewport-clamped, closes on outside mousedown /
  Escape / scroll / resize / **focus theft** — a focused `<webview>` emits no
  keydown or click to the host, only a capture-phase focus event), `Dropdown`
  (trigger wrapper, click or hover mode), `Select` (themed `<select>`).

### Shortcuts

`applyShortcut` (`shortcuts.ts`) is the single dispatch for both the window
keydown listener and `mahas:key` ipc-messages relayed from
`resources/webview-preload.cjs` inside every `<webview>` guest — a focused
guest keeps its own keydowns, which would otherwise kill every app shortcut
while typing in a browser pane. User bindings live in `settings.bindings`
(`'ctrl+alt+shift+key'` combos); Alt+1…9 (workspace N) and Ctrl+Tab (cycle tabs
inside a pane) stay hardcoded but lose to an explicit user binding.

### Agent awareness

Agent signals land in `notifications[]` (+ optional OS notification; clicking
either jumps to workspace/pane/tab). There are two detection paths and one
durability gate:

1. **Process detection** — pty-host `{t:'agent'}` events; an agent→idle
   transition fires `agentFinished` (the completion proxy).
2. **Harness hooks** — installed per-provider hooks append NDJSON to
   `<configDir>/agent-events.log`. The main-process tailer stamps `ours`
   (`mahasSession === MAHAS_SESSION`) and hands every record to the durable
   ingest port first: when the control plane is attached, the daemon's
   `session.hook.ingest` operation must report the record committed before
   the renderer sees it as `agent:event` — an unavailable runtime queues the
   record (bounded, still durable in the file) rather than letting attention
   run ahead of storage. The daemon's own hook-stream reader also ingests the
   same file independently, so collection survives the desktop being closed.
   Renderer policy: `turn-complete`/`needs-input`/`error` notify, and only
   for `ours` events — foreign sessions (agents launched outside mahas; hooks
   are global) are dropped before they can notify.
