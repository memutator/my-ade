# Troubleshooting

## Install & launch

**`chrome-sandbox` errors / app won't start.** The dev script already sets
`ELECTRON_DISABLE_SANDBOX=1` (`npm run dev`) because `chrome-sandbox` lacks
setuid on a source checkout. The packaged **deb** handles it in postinst:
`chmod 4755 chrome-sandbox` when kernel user namespaces are unavailable, plus
an AppArmor profile on Ubuntu 24+. The **AppImage** can't run a postinst — on
Ubuntu 24+ launch it with `--no-sandbox` or `ELECTRON_DISABLE_SANDBOX=1`.

**`spawn node ENOENT`, or terminals dead when launched from a desktop entry.**
GUI launches don't inherit an interactive-shell `PATH`, so version-manager
Nodes (nvm/mise/fnm/asdf) used to vanish and the pty host failed to spawn.
Since `f0ce8c3` the main process probes `PATH` first, then scans
`/usr/bin`, `/usr/local/bin`, `/snap/bin`, linuxbrew, `~/.volta/bin`,
`~/.local/bin`, `~/.asdf/shims`, and the newest install under
`~/.nvm`, `~/.local/share/mise`, `~/.local/share/fnm`, `~/.asdf/installs`.
Point it explicitly with `ADE_NODE=/path/to/node` (`NODE_BINARY` also works).
If no Node is found at all the app stays up but terminals stay dead — check
the `[pty-host]` errors on stderr.

**Icon shows `?` in the dock/panel after installing the deb.** The package
ships `hicolor/512x512/apps/ade.png` and `ade.desktop`, but the desktop's
icon cache may be stale — run `kbuildsycoca6 --noincremental` (KDE) or just
log out and back in.

**Factory reset.** Everything persisted lives in
`~/.config/ade/ade-state.json` (`$XDG_CONFIG_HOME/ade/` when set) — projects,
workspaces, layouts, settings, bookmarks, todos. Quit and delete the file to
start clean. Agent event log and icons sit alongside it
(`agent-events.log`, `agent-icons/`, `ade-hook.cjs`, `notify-forward.json`).

## Display

**Blurry/fuzzy text.** The app sets `ozone-platform-hint=auto` and runs
natively on Wayland — under XWayland text renders blurry. Make sure the
session is Wayland and no override forces X11.

## Runtime

**Shortcuts do nothing inside a browser pane.** By design: a focused
`<webview>` keeps its keys, and only `Alt+*`, `Ctrl+Tab`, and your custom
combos are relayed to the app. Everything else reaches the page. See
[shortcuts](shortcuts.md).

**No OS notifications.** Check Settings → agents & notifications → **os
notifications**; `Notification.isSupported()` also needs a running desktop
notification daemon. In-app notifications (bell) are recorded regardless.

**Agent finished events missing.** Process detection only fires on an
agent → idle *transition* — an interactive agent that stays running between
turns is invisible to it. Install the harness hook (Settings → agent hooks)
for real `turn-complete` events. Also check the provider toggle isn't off, and
that the agent ran inside a registered project (foreign hook events outside
projects stay silent). `ADE_HOOK_DEBUG=1` makes hook scripts log to
`~/.config/ade/hook-debug.log`.

## Development

**File tree/agent events stopped; `inotify` errors.** ade watches
directories, open files, and the agent event log. Raise the limits:

```
fs.inotify.max_user_instances=512
fs.inotify.max_user_watches=524288
```

(`/etc/sysctl.d/99-inotify.conf`). Stray `electron-vite dev` processes keep
wasting instances — kill them before restarting. The event tailer and the
per-file watch fall back to 1 s stat polling when `fs.watch` dies; the
directory watch only reports one final change and goes stale, so a tree that
stopped refreshing is usually this.

**`webview.loadURL` throws.** Calling it before `dom-ready` throws —
`BrowserPane` funnels every load through a bounded retry (`syncUrl`, 60 ×
100 ms) plus an initial probe for the StrictMode-remount case. If you write
webview code, gate imperative calls on `dom-ready`.

**Live behavior doesn't match the source after rapid edits.** Vite can serve
a stale transform (CSS _and_ tsx — once a mid-edit `t0 is not defined` build
for minutes). `touch` the file and reload the window.

**Preload/main changes not picked up.** Not hot-reloaded — restart
`npm run dev` after editing `src/preload/*` or `src/main/*`.

**Detached pane windows misbehave.** Each detached window is a separate
renderer with its own store — a view onto the pane, not the source of truth.
pty events are broadcast to _every_ window; `state:save` is ignored from
non-main senders; `agent:event` hook events go to the main window only; the
detached renderer pushes local pane edits up via `pane:syncUp` and closes via
`pane:cmd`.

**`npm install` fails at `install-app-deps`.** electron-builder's postinstall
runs node-gyp and this machine has no `make` — deps still install fine;
ignore it or use `--ignore-scripts`. Don't add dependencies that need native
builds; prefer prebuilt binaries.

**Debug the renderer via CDP.** Start dev with
`npm run dev -- --remote-debugging-port=9222`, then drive
`Page.captureScreenshot` / `Runtime.evaluate` against `localhost:9222/json`.
Screenshots are physical pixels (`devicePixelRatio` is 1).

### Environment variables

| Variable                     | Effect                                                        |
| ---------------------------- | ------------------------------------------------------------- |
| `ELECTRON_DISABLE_SANDBOX=1` | Required for dev / AppImage without a usable chrome-sandbox    |
| `ADE_NODE`, `NODE_BINARY`    | Node binary used to spawn pty-host                             |
| `ADE_CONFIG_DIR`             | Relocate `~/.config/ade` (event log, hook copy, icon cache)    |
| `ADE_EVENTS_FILE`            | Relocate the NDJSON agent-event file                           |
| `ADE_HOOK_DEBUG=1`           | Hook scripts log to `~/.config/ade/hook-debug.log`             |
| `ADE_SESSION`                | Per-run UUID set by main — don't set it yourself               |
