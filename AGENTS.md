# mahas

Personal Mahas (Agent Development Environment) — a minimal tiling shell in the
spirit of Wave Terminal. Chrome-style workspace tabs sit in the title bar; each
workspace is a splittable pane layout scoped to a project directory.

The desktop is a **client** of two daemons (`mahasd` control plane,
`execution-host` process owner) spawned under system Node ≥24. Deep architecture,
domain, and user docs live under `docs/` — this file keeps only the working
rules and the invariants every change must preserve.

## Core invariants (do not break)

- **A pane (leaf) has no type** — `PaneState` is a stack of kind-tagged blocks
  (`term` | `web` | `file` | `widget`); inactive blocks stay mounted (hidden) so
  shells, web pages and dirty buffers keep running.
- **Programmatic opens stack, never split** — `newBlock`/`openFile`/
  `openUrlInBrowser` resolve a leaf via `stackTarget` and append a tab. The
  focused leaf is never implicitly split; `splitPane` runs only on explicit user
  gestures. Sole exception (`soleLeafSplit`): appending a NEW tab to a workspace
  with a single visible leaf splits it right — stacking would hide the only
  thing on screen.
- **Pane content never remounts on layout changes** — `PanePortals` renders each
  pane once into a stable per-pane `.pane-mount` node that is `appendChild`-ed
  into whichever slot hosts it. The portal target is the mount node, never the
  slot.
- **pty lifetime = tab record lifetime**, not view lifetime — cleanup kills a
  session iff no workspace still holds a tab owning that exact session id.
  Layout churn, detach handoff, cross-workspace moves and StrictMode remounts
  re-attach to the live session.
- **Closing the last tab of a leaf closes the leaf.**
- **Minimized panes/tabs stay mounted** — a minimized leaf keeps its slot in the
  layout tree (hidden, still running); a minimized tab keeps its block mounted
  and shows a ghost dock chip.
- **File blocks use preview tabs** — single-click opens an italic preview
  replaced in place; double-click/Keep-Open/dirty pins it.
- **Unmanaged shells stay on `pty:*`; managed executions use `exec:*` and the
  daemon lifetime — never mixed in one terminal.** UI close = detach, never
  drain-stop.
- **Desktop state writes are serial + atomic** (`src/main/state/persistence.ts`);
  `state:saveSync` is the beforeunload final write that fences stale queued
  snapshots. Only the main window may save.
- **Agent hook events reach the renderer only after durable ingest**
  (`session.hook.ingest` all-record ack via `src/main/agentEventIngest.ts`); the
  daemon hook-stream reader ingests the same file independently.
- **Unknown is not zero** — stored usage/quota data reports unobserved values as
  unknown/null, never fabricated zeros; coverage travels with every number.

Details: [docs/architecture/overview.md](docs/architecture/overview.md),
[lifecycle.md](docs/architecture/lifecycle.md),
[domains/README.md](docs/architecture/domains/README.md).

## Commands

- `npm run dev` — start dev (sets `ELECTRON_DISABLE_SANDBOX=1`; required because
  `chrome-sandbox` lacks setuid root on this machine). Dev runs an isolated
  profile: `userData` → `appData/mahas-dev` and `MAHAS_CONFIG_DIR` →
  `~/.config/mahas-dev` — it never touches the installed app's live data, and
  spawned agents inherit `MAHAS_CONFIG_DIR` so hook events route into the dev
  channel. Hook installers still target real harness configs because hooks are
  global. `MAHAS_TEST` (e2e) opts out — it isolates via `XDG_CONFIG_HOME`.
- `npm install` fails at the `electron-builder install-app-deps` postinstall
  (node-gyp rebuild needs make, which isn't installed) — deps still install
  fine; ignore it or use `--ignore-scripts`.
- `npm run typecheck` / `npm run lint` / `npm run build` — `typecheck` covers
  node, web, **and every `packages/*` source file**.
- `npm run check:boundaries` / `npm run test:boundaries` — resolve every import
  and apply the package direction policy (`tools/boundary-policy.mjs`).
- `npm run check:docs` — every repo-relative Markdown link resolves.
- `npm run test:domain` — synthetic domain smokes (throwaway `/tmp` databases
  and Pack snapshots — never a real credential, provider API, or user session
  log). `--include-runtime` adds the launch/access suite.
- `npm run build:services` — bundles `mahasd`, `execution-host`, and the `mahas`
  CLI into `out/services/*.mjs` and boot-tests each artifact in an isolated
  scratch environment. Never point a probe at the real config dir or packs
  root: the collection scheduler resolves discovery roots from `homedir()`.
- `node tools/e2e.mjs [scenario]` — CDP-driven e2e against `out/` (needs
  `npm run build` first); `tools/mahas-fake.mjs` is the fake harness.
- `npm run build:linux` — package via electron-builder.

Current results of all of the above, including what is failing and why, are
recorded in `docs/development/verification.md`. **Do not claim a check passes
without re-running it.**

## Releases

Packaging is versioned — before every `npm run build:linux`, do all three
without being asked:

1. **Bump `version` in `package.json`** (patch by default; minor for
   milestones). Never repackage an unchanged version.
2. **Write `requirements/<version>.md`** from `requirements/_template.md` — one
   `- [ ]` item (+ a `비고:` line) per user-facing behavior change in that
   release, grouped by area. Files for older versions stay untouched.
3. After packaging, report the artifacts and the reinstall command
   (`sudo apt install --reinstall ./dist/mahas_<version>_amd64.deb`).

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

## Visual system

Hierarchy: **app shell → workspace surface → pane content**, one step darker
each level: `--chrome` strips → `--tab-active`/`.pane` card → `--bg-pane`
content islands. Active tab = fill + curved wings driven by a shared
`--tab-fill` var. Panes carry `border: 1px solid var(--border-strong)` and are
flush; the divider is a transparent 9px hit area with `margin: 0 -5px` so
adjacent borders collapse into one line. Focused pane: `z-index` raise + 2px
accent bar on the titlebar's left edge. Dark theme is neutral gray (no blue
tint): `#101011 / #1a1a1c / #262629 / #151516`.

## Gotchas

- `webview.loadURL` throws before `dom-ready`; `BrowserPane`'s `syncUrl` retries
  on a bounded timer.
- Pane/tab drag & drop (`paneDnd.ts`) is pointer-event based, not HTML5 DnD — a
  `<webview>` swallows all mouse events, so an armed drag sets
  `body.pane-dragging` which forces `pointer-events: none` on every webview.
- A focused `<webview>` also keeps its keydowns —
  `resources/webview-preload.cjs` relays Alt+\* / Ctrl+Tab via `ipc-message` →
  `mahas:key` to `applyShortcut`.
- No build tools (make/gcc) on this machine — never add deps that require
  node-gyp builds; prefer prebuilt binaries.
- Use the root typecheck or `tsc --noEmit`; emitting `tsc -b` beside source
  files can leave JavaScript that shadows the TypeScript during bundling.
- Preload changes are NOT hot-reloaded — restart `npm run dev` after editing
  `src/preload/*` or `src/main/*`.
- Vite may cache a stale transform across rapid consecutive edits (CSS AND tsx
  modules) — `touch` the file + reload when live behavior doesn't match the
  source.
- inotify limits were raised to `fs.inotify.max_user_instances=512` /
  `max_user_watches=524288` (`/etc/sysctl.d/99-inotify.conf`); stray dev
  processes still waste instances — kill stale `electron-vite dev` before
  restarting.
- Debug renderer via CDP: start dev with `-- --remote-debugging-port=9222`,
  then `Page.captureScreenshot` / `Runtime.evaluate` against
  `localhost:9222/json`. Screenshots are physical pixels — `devicePixelRatio`
  is 1 here.
