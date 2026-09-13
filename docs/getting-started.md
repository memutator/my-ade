# Getting started

ade is a Linux-first Electron app — a tiling shell where Chrome-style workspace
tabs live in the title bar and each workspace is a split-pane layout scoped to a
project directory.

## Requirements

- **Linux.** Wayland is preferred — the app runs natively under it
  (`ozone-platform-hint=auto`); running under XWayland makes text render blurry.
- **Node.js**, installed somewhere reachable. Terminal panes are driven by a
  separate pty-host process that runs under system Node (not Electron), so a
  `node` binary must exist. ade probes, in order:
  - `ADE_NODE` / `NODE_BINARY` env vars (explicit override)
  - `node` on `PATH`
  - `/usr/bin/node`, `/usr/local/bin/node`, `/snap/bin/node`,
    `/home/linuxbrew/.linuxbrew/bin/node`
  - `~/.volta/bin/node`, `~/.local/bin/node`, `~/.asdf/shims/node`
  - the newest version under `~/.nvm/versions/node`,
    `~/.local/share/mise/installs/node`, `~/.local/share/fnm/node-versions`,
    `~/.asdf/installs/nodejs`

  nvm / volta / fnm / mise / asdf / system / snap installs all resolve — no
  symlink into a fixed location is needed. If terminals stay dead, set
  `ADE_NODE=/path/to/node` before launching.

## Install

### deb (recommended)

```bash
sudo dpkg -i dist/ade_0.1.0_amd64.deb
```

Installs to `/opt/ade`, links `ade` into `/usr/bin`, and drops a
`ade.desktop` entry for the app launcher. The postinst also:

- sets `chrome-sandbox` setuid root on kernels without working user namespaces
- installs the bundled AppArmor profile on Ubuntu 24+ (skipped cleanly on
  AppArmor versions that can't parse it)
- refreshes the mime/desktop databases

Then run `ade` from a shell or your launcher.

### AppImage

```bash
chmod +x dist/ade-0.1.0.AppImage
./dist/ade-0.1.0.AppImage
```

On Ubuntu 24+ AppArmor blocks user-namespace creation for unconfined apps, so
the sandbox must be disabled:

```bash
ELECTRON_DISABLE_SANDBOX=1 ./dist/ade-0.1.0.AppImage
```

## First run

1. With no workspaces yet, the empty state offers **add project — choose
   dir…** (plus one-click entries for any projects already on file). Picking a
   directory registers it as a project and creates a workspace for it.
2. Add more workspaces with the **`+`** button at the end of the tab strip —
   its menu lists every project. See [Workspaces](workspaces.md).
3. Add panes with the topbar buttons or `Alt+T` (terminal), `Alt+B` (browser),
   `Alt+E` (editor), `Alt+L` (todos). See [Panes](panes.md).

## Persistence

Projects, workspaces, layouts, pane state, bookmarks, todos, and settings are
saved (debounced) to `~/.config/ade/ade-state.json` and restored on the next
launch. Terminal scrollback and running shells are not persisted — sessions
respawn on restart.

## Building from source

```bash
npm install
npm run dev          # Electron + Vite dev (needs ELECTRON_DISABLE_SANDBOX=1 on some machines)
npm run build:linux  # electron-builder → dist/*.deb + *.AppImage
```

See `AGENTS.md` for architecture and contributor-facing details.
