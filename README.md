# mahas

Personal Mahas (Agent Development Environment) — a minimal tiling shell in the spirit of
Wave Terminal, for Linux. Chrome-style workspace tabs live in the title bar; each
workspace is a splittable pane layout scoped to a project directory.

## Features

- **Tiling panes** — terminal / browser / editor panes in a binary split tree,
  flush edges, drag-to-resize dividers, press-hold the pane icon to drag panes
  (swap, split onto edges, or onto another workspace's tab)
- **Workspaces** — Chrome-curved tabs in the title bar; `+` picks a project,
  auto-named `workspace N`, double-click to rename, drag to reorder
- **Projects** — directories on disk; terminal cwd and the file tree follow the
  active workspace's project path
- **Editor pane** — editable files (CodeMirror), live-rendered markdown
  (Milkdown, Obsidian-style), dirty dots, image/video/audio/PDF preview
- **Todo pane** — project-scoped checklists with doing/done states, arbitrary
  nesting, dependencies; sidebar section + pane type (Alt+L)
- **Browser pane** — real tabs via header dropdown, bookmarks with global +
  project scopes
- **Agent awareness** — detects agent CLIs under each shell; per-harness hooks
  (codex/grok/devin/zcode/opencode) fire turn-complete / needs-input events →
  in-app + OS notifications
- **Terminal links** — URL/file paths in terminal output open in matching panes
- **File tree** — app icon hover → overlay, click → pinned sidebar
- **Persistence** — projects, workspaces, layouts, pane state, and settings are
  restored across restarts (`~/.config/mahas/mahas-state.json`)

## Development

```bash
npm install
npm run dev        # Electron + Vite dev (ELECTRON_DISABLE_SANDBOX=1 on this machine)
npm run typecheck
npm run lint
npm run build
npm run build:linux  # electron-builder package
```

Linux-first. On Wayland the app runs natively (`ozone-platform-hint=auto`) —
running under XWayland makes text render blurry.

## Shortcuts

| Key | Action |
| --- | --- |
| Alt+T / Alt+B / Alt+E / Alt+L | new terminal / browser / editor / todo pane |
| Alt+D / Alt+S | split focused pane right / down |
| Alt+W | close focused pane |
| Alt+] / Alt+[ | cycle focus |
| Alt+Arrow keys | move focus to the pane in that direction |
| Alt+M | toggle dark/light theme |
| Alt+1 … Alt+9 | activate workspace N (clamped to last) |
| Ctrl+Alt+→ / Ctrl+Alt+← | next / previous workspace (wraps) |
| Ctrl+Tab / Ctrl+Shift+Tab | next / previous tab inside the focused pane |

## Stack

Electron · React 19 · TypeScript · electron-vite · zustand · xterm.js ·
`@homebridge/node-pty-prebuilt-multiarch` (via a separate system-Node pty-host) ·
CodeMirror · Milkdown · material-icon-theme · lucide-react

## Docs

Full documentation lives in [`docs/`](docs/README.md) — user guide,
settings/shortcut reference, agent integration, architecture, development, and
packaging. See `AGENTS.md` for contributor-facing rules.
