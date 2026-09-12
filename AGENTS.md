# ade

Personal ADE (Agent Development Environment) — a minimal tiling shell in the spirit of
Wave Terminal. Chrome-style workspace tabs sit in the title bar; each workspace is a
splittable pane layout scoped to a project directory.

## Domain model

- **project** = a directory (`{id, name, path}`), global registry.
- **workspace** = a tab = one split-pane layout, belongs to a project (`project:workspace = 1:N`).
  All workspaces across projects share the single `WorkspaceStrip` in the title bar.
  Switching happens only via workspace tabs; project is chosen when creating a workspace.
- Terminal cwd and the file-tree root come from the workspace's `project.path`.
- **editor pane** owns an internal `TabStrip` of file tabs; tree clicks open files there.

## Commands

- `npm run dev` — start dev (sets `ELECTRON_DISABLE_SANDBOX=1`; required because
  `chrome-sandbox` lacks setuid root on this machine)
- `npm run typecheck` / `npm run lint` / `npm run build`
- `npm run build:linux` — package via electron-builder

## Architecture

- **Electron main** (`src/main/index.ts`): frameless `BrowserWindow`; IPC for files,
  dir listing/picker, JSON state (`userData/ade-state.json`), OS `Notification`
  (click forwards `notify:clicked` with workspace/pane meta), agent manifest/icons.
  `webPreferences.webviewTag: true` enables `<webview>` browser panes.
- **pty-host** (`resources/pty-host.cjs`): separate *system Node* child process that owns
  `node-pty` sessions (Electron 39 ABI 140 can't load the prebuilt native module).
  Newline-delimited JSON over stdio. Polls `/proc` for shell cwd **and walks the
  process tree to detect agent CLIs** (claude/codex/gemini/…), emitting
  `{t:'agent',agent}` events. Patterns come from `resources/agents/manifest.json`,
  filtered by the provider toggles in settings (`agents:config` IPC).
- **Preload** (`src/preload/index.ts`): `window.ade` — `pty`, `file`, `fs`, `state`,
  `notify`, `agents`, `win`, `openExternal`.
- **Renderer** (`src/renderer/src`): React 19 + zustand. Store holds `projects`,
  `workspaces[]` (each with `root`/`panes`/`focusedPaneId`), `settings`,
  `notifications`. `TabStrip.tsx` is the shared Chrome-curved-tab component used by
  `WorkspaceStrip` (title bar) and `EditorPane` (pane title bar). `FileTree` backs both
  the app-icon hover overlay and the pinned `Sidebar`. Persisted state is saved
  debounced via `state:save` and hydrated before first render in `main.tsx`.
- PTY session ids are `paneId:uuid` — unique per mount so stale `exit` events from a
  killed session (StrictMode remount, HMR) can't corrupt a new one.
- Agent "completion" = detected agent → idle transition → in-app notification +
  OS notification; clicking either jumps to the workspace/pane. (Process-exit proxy —
  interactive agents ending their turn may not be captured.)

## Shortcuts

| Key | Action |
| --- | --- |
| Alt+T / Alt+B / Alt+E | new terminal / browser / editor pane |
| Alt+D / Alt+S | split focused pane right / down |
| Alt+W | close focused pane |
| Alt+] / Alt+[ | cycle focus |
| Alt+M | toggle dark/light theme |

## Gotchas

- `webview.loadURL` throws before `dom-ready`; `BrowserPane` retries via a ready flag.
- shiki needs `'wasm-unsafe-eval'` in `index.html` CSP.
- No build tools (make/gcc) on this machine — never add deps that require node-gyp
  builds; prefer prebuilt binaries.
- Preload changes are NOT hot-reloaded — restart `npm run dev` after editing
  `src/preload/*` or `src/main/*`.
- This machine's inotify instances are limited (128); stray `electron-vite dev`
  processes exhaust them (`inotify_init failed: too many open files`) — kill stale
  dev processes before restarting.
