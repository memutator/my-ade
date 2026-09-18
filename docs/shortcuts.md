# Shortcuts

Every bindable action has an id and a default combo in `DEFAULT_BINDINGS`
(`src/renderer/src/shortcuts.ts`). Combos are stored as
`ctrl+alt+shift+key` — modifiers in that fixed order, key lowercased
(` ` → `space`). Your overrides live in `settings.bindings`
(action id → combo, `''` = explicitly unbound) and persist with the rest of the
settings.

## Default bindings

### Panes

| Action id         | Combo      | Description                                                              |
| ----------------- | ---------- | ------------------------------------------------------------------------ |
| `pane.newTerminal` | `alt+t`   | New terminal block (stacks into the focused leaf)                        |
| `pane.newBrowser`  | `alt+b`   | New browser block                                                        |
| `pane.newEditor`   | `alt+e`   | New editor block                                                         |
| `pane.splitRight`  | `alt+d`   | Split focused pane right (new terminal; no focus → plain new terminal)   |
| `pane.splitDown`   | `alt+s`   | Split focused pane down (same fallback)                                  |
| `pane.close`       | `alt+w`   | Close focused pane                                                       |
| `pane.minimize`    | `alt+h`   | Minimize focused pane to the dock                                        |
| `pane.float`       | `alt+f`   | Float focused pane / dock a floating pane                                |
| `focus.next`       | `alt+]`   | Focus next pane                                                          |
| `focus.prev`       | `alt+[`   | Focus previous pane                                                      |
| `focus.left`       | `alt+←`   | Focus the pane geometrically left of the focused one                     |
| `focus.right`      | `alt+→`   | Focus pane right                                                         |
| `focus.up`         | `alt+↑`   | Focus pane up                                                            |
| `focus.down`       | `alt+↓`   | Focus pane down                                                          |

Directional focus picks the pane whose center lies in that direction from the
focused pane's center, scored by axial + orthogonal distance; minimized panes
are excluded.

### Tabs

| Action id | Combo                 | Description                                |
| --------- | --------------------- | ------------------------------------------ |
| `ws.next` | `ctrl+alt+→`          | Next workspace (wraps)                     |
| `ws.prev` | `ctrl+alt+←`          | Previous workspace (wraps)                 |
| — fixed   | `Alt+1` … `Alt+9`     | Activate workspace N (clamped to the last) |
| — fixed   | `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab inside the focused pane |

### Windows & panels

| Action id        | Combo   | Description              |
| ---------------- | ------- | ------------------------ |
| `sidebar.toggle` | `alt+x` | Toggle sidebar           |
| `tree.toggle`    | `alt+o` | Toggle file tree overlay |

### Misc

| Action id      | Combo   | Description                                  |
| -------------- | ------- | -------------------------------------------- |
| `theme.toggle` | `alt+m` | Toggle dark/light                            |
| — fixed        | `Ctrl+S` | Save file (the file block's own handler; `Cmd+S` also accepted) |
| — fixed        | `Esc`   | Close overlay/menu/settings — per-component  |

## Rebinding

Settings → **shortcuts** (`scClickToBind` hint: click a binding to reassign).

- **Click a row's binding** to enter capture — the next modified key combo
  becomes the binding. `Esc` cancels; bare `Backspace`/`Delete` unbinds the
  action. Modifier-only presses are ignored while capturing.
- **Conflicts steal**: a combo is single-owner — recording a combo already used
  by another action sets that action's override to `''` (explicitly unbound,
  shadowing its default).
- **Reset all** clears `settings.bindings` — everything returns to defaults.
- While capture is active the dispatcher is suspended (`setKeyCapture`), so the
  keys you type are recorded, not executed. The same flag keeps `Esc` from
  closing the settings page underneath you.

Rules of the combo format:

- Combos need a real modifier — a bare key is never bindable (every typed
  letter would fire the action) and the dispatcher only consults the binding
  table when `Alt` or `Ctrl` is held.
- `Meta`/`Super` is ignored end to end: the dispatcher and the webview relay
  both drop `meta` events, so a recorded Super combo never fires. Stick to
  Ctrl/Alt combos.
- User bindings are checked **before** the fixed families — binding an action
  to `ctrl+tab` or `alt+3` takes that key away from tab-cycling/workspace-N.

## Keys that can't be rebound

These are hardcoded outside the binding table (fixed rows in the settings
table):

- `Alt+1` … `Alt+9` — activate workspace N, clamped to the last existing one.
- `Ctrl+Tab` / `Ctrl+Shift+Tab` — cycle tabs inside the focused pane
  (deliberately window-level so inputs, CodeMirror, and xterm can't keep it).
- `Ctrl+S` — save in a file block (`FileView`'s own keydown; `Cmd+S` works
  too).
- `Esc` — close overlays/menus, handled per component (settings page, menus,
  tree overlay, pane drag cancel, …).

## Inside web tabs

A focused `<webview>` keeps its keydowns — the host document never sees them.
`resources/webview-preload.cjs` runs inside every guest and forwards `Alt+*`,
`Ctrl+Tab`, and every combo in the effective binding table (pushed via
`mahas:bindings` whenever bindings change or a guest loads) as an `ipc-message`
`mahas:key` → `applyShortcut` — the same dispatch the window keydown listener
uses. So custom combos work while typing in a web block; all other keys go
to the page untouched.
