# Settings

The gear icon in the title bar opens Settings — a full-page overlay that slides
over the workspace area (panes, terminals, and webviews stay mounted
underneath). A left nav switches sections; **Esc** or **Back to app** closes the
page. Esc is also the cancel key while recording a keybinding — see
[shortcuts](shortcuts.md).

There is no save button. Every change lands in the store immediately and is
persisted debounced (~400 ms) with the rest of the app state to
`~/.config/ade/ade-state.json` (`$XDG_CONFIG_HOME/ade/ade-state.json` when
`XDG_CONFIG_HOME` is set). The file holds projects, workspaces, layouts,
bookmarks, todos, and settings — deleting it factory-resets everything.

## Appearance

| Setting            | Key              | Default                                                 | Notes                                                                                  |
| ------------------ | ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Theme              | `theme`          | `dark`                                                  | `dark` / `light` / `system`; `system` follows `prefers-color-scheme` live               |
| Language           | `language`       | `system`                                                | `system` / `English` / `한국어`; `system` resolves via `navigator.language` (ko → Korean, else English) |
| Accent             | `accent`         | `#7aa2f7`                                               | One of 7 swatches; sets the `--accent` CSS var app-wide                                 |
| UI font            | `uiFont`         | `'Inter', system-ui, sans-serif`                        | Free-text CSS `font-family`; sets `--font-ui`                                           |
| Terminal font      | `termFont`       | `'JetBrains Mono', 'Fira Code', ui-monospace, monospace` | Free-text; applied to xterm `fontFamily`                                                |
| Terminal font size | `termFontSize`   | `12.5`                                                  | Number input, 8–24 in 0.5 steps; empty/invalid resets to 12.5                           |
| Editor font        | `editorFont`     | `'JetBrains Mono', 'Fira Code', ui-monospace, monospace` | Free-text; CodeMirror + Milkdown. Blank falls back to the default monospace stack       |

## Browser

- **Home page** (`homeUrl`, default empty) — start URL applied to newly created
  browser panes and new tabs inside them. Existing tabs are untouched; empty
  means a blank address bar.
- **Bookmarks** — a manager, not an editor. Bookmarks are saved from a browser
  pane's star button (project or global scope); here they're listed grouped by
  scope — **Global** first, then each project in registry order, then groups
  whose project no longer exists (labeled by raw scope id). Each row shows
  title, URL, scope badge, and a delete button. Saving the same URL to the same
  scope replaces the older entry.

## Agents & notifications

- **OS notifications** (`osNotifications`, default on) — gates desktop
  `Notification`s only; the in-app notification list (bell) always records
  events.
- **Agent providers** — one toggle per provider in
  `resources/agents/manifest.json` (claude, codex, gemini, grok, devin, cursor,
  copilot, aider, opencode, amp). All default on (`providers[id] !== false`).
  Turning one off drops its notifications and removes its `match` patterns
  from the set pushed to the pty host (`agents:config`). Edge case: with every
  provider off, nothing is pushed and the host keeps its last pattern set —
  detection labels still appear, but notifications stay off.
- **Agent hooks** — per-harness lifecycle hooks, listed only for providers
  whose CLI binary is found on `PATH`. Each row shows the mechanism and state
  (`installed` / `not installed`), an **Install** button while uninstalled, and
  a **Test** button once installed (writes a synthetic `turn-complete` through
  the real event channel — end-to-end, expect a notification). Installers are
  additive, idempotent, and back up any file they mutate (`<file>.ade-bak`).
  See [agents](agents.md) for what each hook does.

## Shortcuts

The full binding table lives here — click a row's binding to reassign it,
Backspace/Delete unbinds, Esc cancels, and **Reset all** restores defaults.
Details and the default table: [shortcuts](shortcuts.md).
