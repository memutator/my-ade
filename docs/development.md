# Development

## Setup

```bash
npm install
```

`postinstall` runs `electron-builder install-app-deps`, which attempts a
node-gyp rebuild of the pty native module and **fails when `make` isn't
installed** — dependencies still install fine, so the error is safe to ignore
(or use `npm install --ignore-scripts`). The app doesn't need the rebuilt
module anyway: pty runs in the system-Node pty-host against the shipped
prebuilt.

## Commands

| Command                | What it does                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`          | `electron-vite dev` — sets `ELECTRON_DISABLE_SANDBOX=1` (required on this machine: `chrome-sandbox` lacks setuid root)                        |
| `npm run typecheck`    | `tsc --noEmit` for both projects: `typecheck:node` (main + preload, `tsconfig.node.json`) and `typecheck:web` (renderer, `tsconfig.web.json`) |
| `npm run lint`         | `eslint --cache .`                                                                                                                            |
| `npm run format`       | `prettier --write .`                                                                                                                          |
| `npm run build`        | typecheck + `electron-vite build` → `out/`                                                                                                    |
| `npm run start`        | `electron-vite preview` of the built app                                                                                                      |
| `npm run build:unpack` | build + `electron-builder --dir` → `dist/linux-unpacked`                                                                                      |
| `npm run build:linux`  | `electron-vite build` + `electron-builder --linux` → `dist/`                                                                                  |

## Hot-reload boundary

- `src/renderer/**` — Vite HMR, instant.
- `src/main/**` and `src/preload/**` — **not** hot-reloaded; restart
  `npm run dev` after editing.
- `resources/*.cjs` (`pty-host.cjs`, `webview-preload.cjs`, hook scripts) —
  loaded at runtime, not bundled; need an app restart (a running pty-host or a
  mounted `<webview>` keeps the old copy).
- Vite occasionally caches a stale transform across rapid consecutive edits
  (CSS and tsx) — `touch` the file and reload when live behavior doesn't match
  the source.
- inotify: dev watches many directories. If watchers silently die, kill stale
  `electron-vite dev` processes and check `fs.inotify.max_user_instances` /
  `max_user_watches`.

## Debugging

Renderer via CDP:

```bash
npm run dev -- --remote-debugging-port=9222
```

Talk CDP against `http://localhost:9222/json` — `Page.captureScreenshot`
(screenshots are physical pixels; `devicePixelRatio` is 1 on this machine) and
`Runtime.evaluate`. The zustand store is exposed as `window.__ade` for
inspection and poking (`__ade.getState()`,
`__ade.getState().newPane('terminal')`, …). VS Code has matching launch
configs (`Debug Main Process` / attach on 9222).

Main-process logs go to the terminal that ran `npm run dev`; pty-host stderr is
inherited (`stdio: 'inherit'` in `src/main/pty.ts`), so `[pty-host]` spawn/exit
errors land there too.

## Tests

None. Verification = `npm run typecheck` + `npm run lint` + live checks via
CDP (evaluate store state, screenshot panes, simulate flows).

## Conventions

- **TypeScript strict** — `@electron-toolkit/tsconfig` bases (`strict: true`),
  split into `tsconfig.node.json` (main + preload) and `tsconfig.web.json`
  (renderer + `@renderer/*` alias).
- **Formatting** — prettier (`singleQuote`, no semicolons, `printWidth: 100`,
  `trailingComma: 'none'`) + eslint flat config; `resources/**` is
  eslint-ignored.
- **Zustand store is the single source of truth** — all layout/pane/workspace
  state lives in `useStore` (`src/renderer/src/store.ts`); mutate only through
  store actions. Detached windows run their own store and push pane edits up
  via `pane:syncUp` / `pane:cmd` rather than writing shared state.
- **Settings autosave** — the debounced `state:save` subscriber in `App.tsx`
  persists every store change; no explicit save calls.
- **i18n** — every user-visible string goes through `useT()`/`t()`
  (`src/renderer/src/i18n.ts`) and needs an entry in **both** `en` and `ko`
  tables — `ko` is typed `Record<TKey, string>`, so a missing key fails
  typecheck. Interpolation uses `{var}` placeholders. `settings.language`
  is `ko`/`en`/`system` (navigator-language resolution).
- **Pane drag & drop is pointer-event based** (`paneDnd.ts`) — HTML5 DnD can't
  cross a `<webview>` (it swallows mouse events). An armed drag sets
  `body.pane-dragging` which forces `pointer-events: none` on every webview so
  `elementFromPoint` hit-testing and window pointermove/up keep working.
- **Menus are portaled to `document.body`** (`Menu.tsx`: `Popup`/`Dropdown`/
  `Select`) — never place a `position: absolute` dropdown inside `.tstrip`:
  its `overflow-y: clip` would hide it. `Popup` is `position:fixed` and
  clamps into the viewport.
- **`<webview>` quirks** — `loadURL` throws before `dom-ready` (BrowserPane
  retries via a ready flag); guest keydowns for app shortcuts arrive as
  `ade:key` ipc-messages → `applyShortcut`, not window keydown.
- **No node-gyp dependencies** — build tools aren't guaranteed on target
  machines; prefer prebuilt binaries (node-pty itself runs in the system-Node
  pty-host for this reason).
