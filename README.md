# ade

Personal ADE (Agent Development Environment) — a minimal tiling shell in the spirit of
Wave Terminal, for Linux. Chrome-style workspace tabs live in the title bar; each
workspace is a splittable pane layout scoped to a project directory.

## Features

- **Tiling panes** — terminal / browser / editor panes in a binary split tree,
  flush edges, drag-to-resize dividers
- **Workspaces** — Chrome-curved tabs in the title bar; `+` picks a project,
  auto-named `workspace N`, double-click to rename, drag to reorder
- **Projects** — directories on disk; terminal cwd and the file tree follow the
  active workspace's project path
- **Editor pane** — internal file tabs; file-tree clicks open files there
- **Agent awareness** — the PTY host detects agent CLIs (claude, codex, gemini, …)
  under each shell and fires in-app + OS notifications when an agent goes idle
- **File tree** — app icon hover → overlay, click → pinned sidebar
- **Persistence** — projects, workspaces, layouts, pane state, and settings are
  restored across restarts (`~/.config/ade/ade-state.json`)

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
| Alt+T / Alt+B / Alt+E | new terminal / browser / editor pane |
| Alt+D / Alt+S | split focused pane right / down |
| Alt+W | close focused pane |
| Alt+] / Alt+[ | cycle focus |
| Alt+M | toggle dark/light theme |

## Stack

Electron · React 19 · TypeScript · electron-vite · zustand · xterm.js ·
`@homebridge/node-pty-prebuilt-multiarch` (via a separate system-Node pty-host) ·
lucide-react

See `AGENTS.md` for architecture and contributor-facing details.
