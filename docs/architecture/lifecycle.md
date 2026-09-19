# Lifecycle

Mahas keeps three lifetimes apart, and most regressions come from merging
them: the **content** (a pty session, a webview guest, an editor buffer) that
must keep running in the background, the **view** (a mounted DOM subtree) that
renders it, and the **record** (a store entry) that owns both. Specs that name
these rules for users are [panes](../user/panes.md),
[terminal](../user/terminal.md), [editor](../user/editor.md), [browser](../user/browser.md),
and [notifications](../user/notifications.md).

Everything below is **current** — shipped and exercised by the app. See
[domains](domains/README.md) for ownership.

## Pane and tab views — current

- `PanePortals` ([SplitView.tsx](../../src/renderer/src/components/SplitView.tsx))
  renders each non-detached pane exactly once into a per-pane `.pane-mount`
  node it owns. That node is `appendChild`-ed into whichever registered slot
  hosts the pane: the leaf `.node.leaf` inside `SplitView`, `.float-inner`
  inside [FloatLayer.tsx](../../src/renderer/src/components/FloatLayer.tsx), or a
  hidden `.pane-stash` when no slot exists. Slots register through
  [paneSlots.ts](../../src/renderer/src/paneSlots.ts) with identity-guarded
  cleanups.
- The portal target is the stable mount node, never the slot: changing a
  `createPortal` container remounts the subtree.
- Inactive blocks inside a leaf stay mounted and hidden, so a background shell,
  a loaded page, and a dirty buffer all keep running.
- Minimized panes keep their leaf in the layout tree (`hidden` attr) plus a
  `.pane-dock` chip; minimized tabs leave the tab strip for title-bar chips but
  the block stays mounted. Restoring re-inserts the pane in its exact slot and
  un-tucks the tab.
- Closing the last tab of any leaf closes the leaf.

## Terminal and PTY — current

- A pty session id is `paneId:tabId:uuid`, unique per terminal tab mount, so a
  stale `exit` event (StrictMode remount, HMR, tab restart) cannot corrupt a
  newer session.
- **pty lifetime = tab record lifetime.** Unmount cleanup kills a session only
  when no workspace still holds a tab owning that exact session id — layout
  churn, detach handoff, cross-workspace moves, and StrictMode remounts
  re-`attach` to the live session. Closing a tab/pane/workspace removes the
  record, and then cleanup kills. `restartTab` kills its session explicitly
  before clearing `pty`.
- New tabs spawn in the workspace project directory (`project.path`);
  [pty-host.cjs](../../resources/pty-host.cjs) polls `/proc` for the shell cwd
  and for agent processes in the process tree.
- The pty-host is app-owned: it starts with the app and is killed at
  `will-quit` ([pty.ts](../../src/main/pty.ts)), so agent processes die with
  the desktop instead of orphaning.
- Resume records are observation data, not managed executions: the canonical
  session store owns sessions/handles/attachments, the desktop's persisted
  legacy map is imported once via `session.desktop.import`, and a candidate
  is replayed as a typed command into a freshly spawned shell
  ([resume.ts](../../src/renderer/src/resume.ts)). The main process stamps
  shutdown evidence (`ResumeSession.shutdown`) into the final save so the
  importer can tell an app-shutdown `session-end` from a real exit — a
  session killed by the app closing stays resumable, an explicit exit does
  not come back.

## Web blocks — current

A web tab keeps its `<webview>` mounted while inactive; `syncUrl` retries until
`dom-ready` because `loadURL` throws before that. While a pane/tab drag is
armed, `body.pane-dragging` disables pointer events on every webview so hit
testing and window pointer events stay alive
([paneDnd.ts](../../src/renderer/src/paneDnd.ts)).

## File buffers — current

File blocks use VS Code-style preview tabs: tree single-click opens an italic
preview replaced in place by the next preview; double-click, "Keep Open", or a
dirty buffer pins it. Every open tab stays mounted (unsaved edits survive tab
switches), `dirty` dots mark unsaved buffers, and `closeFilesUnder` closes the
tabs under a deleted path, closing the leaf when it empties.

## Detached windows — current

A detached pane window runs its own renderer and store and syncs through
`pane:hello` / `pane:cmd` / `pane:syncUp` / `pane:reattach`
([DetachedApp.tsx](../../src/renderer/src/components/DetachedApp.tsx),
[windowState.ts](../../src/main/windowState.ts)). Closing its last tab routes
through `pane:cmd` to the main store `closePane`, which kills the detached pty
and tears the window down. Detached windows also relay agent-idle signals into
the main window attention policy.

## Desktop state — current

Projects, workspaces, layouts, pane/tab state, bookmarks, resume records, and
settings live in the main window store and are hydrated before the first render
([main.tsx](../../src/renderer/src/main.tsx)), then saved debounced through
`state:save` into `userData/mahas-state.json`. Writes go through
[state/persistence.ts](../../src/main/state/persistence.ts): a serial queue of
atomic temp-file→rename replaces, and a synchronous `state:saveSync` on
beforeunload that fences every older queued snapshot — the final shutdown
write can never be overwritten by a stale async one. Dev runs use the
isolated `mahas-dev` profile, so layout churn in development never rewrites
live data.

## Control-plane services — current

The desktop is a client of `mahasd` — the control plane — and
`execution-host`, the process/PTY owner:

- [serviceBootstrap.ts](../../src/main/runtime/serviceBootstrap.ts) locates a
  system Node 24 binary (`MAHAS_NODE`, `PATH`, common prefixes, nvm), resolves
  service entrypoints, and spawns both daemons detached, with stdout/stderr
  under `<configDir>/logs/` and `MAHAS_BUILTIN_PACKS_DIR` pointing at the Pack
  directory. A spawn is never treated as readiness.
- Dev resolves the `packages/*/src/main.ts` sources (system Node runs them with
  type stripping); a packaged app resolves the ESM bundles
  `<resources>/services/{mahasd,execution-host}.mjs` produced by
  [build-services.mjs](../../tools/build-services.mjs) and shipped by
  [electron-builder.yml](../../electron-builder.yml) as extraResources.
- [runtimeClient.ts](../../src/main/runtimeClient.ts) owns the app runtime
  attachment: `runtime:status`, the `exec:*` managed-execution IPC, and the
  generic `exec:op` command route. A failed call drops the cached client so the
  next call retries the handshake.
- **UI close = detach.** `disconnectDesktopRuntime()` on `will-quit` drops the
  client and deliberately leaves the daemons running; only an explicit operator
  `ShutdownRequest` (`drain-and-stop` / `leave-executions`) stops executions.
  Managed executions stay outside the app-owned pty-host lifetime.
- Collection runs on the daemon's own lifetime, not the UI's: `mahasd` composes
  the integration domains at boot, schedules bounded Pack collection, and
  commits batches into the stored ledger. Closing the UI detaches the client and
  leaves collection running; reconnecting reads stored data rather than
  re-scanning sources. The control-plane schema arrives through the central
  migration chain (schema v3) — see [migration.md](migration.md).
- Agent hook events reach the renderer only through a durable-ingest gate:
  [agentEventIngest.ts](../../src/main/agentEventIngest.ts) forwards every
  received record to the daemon (`session.hook.ingest`) and waits for the
  all-record acknowledgement before the renderer sees the event, with chunk
  merging and overflow protection. The daemon's own hook-stream reader ingests
  the same events independently, so records survive even when no UI is
  attached.
- The desktop's former usage/quota/auth/ledger code paths are now
  compatibility projections over the domain reads — see
  [domains/README.md](domains/README.md) for the adapter table.

## Invariants the migration must preserve

- Stable pane mounts: no remount of pane content on layout changes.
- Background tabs (shells, webviews, dirty buffers) keep running while hidden.
- Session survival across detach, pane move, and minimize.
- The shared `TabStrip`, preview file tabs, and the explicit split/stack rules
  (focused leaf is never implicitly split).
- Pointer-based drag and drop with webview input relay.
- Unmanaged shells stay on `pty:*` with the tab-record lifetime; managed
  executions use `exec:*` and the daemon lifetime. The two are never mixed in
  one terminal.
