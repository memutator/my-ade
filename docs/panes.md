# Panes

A workspace is a binary split tree of **panes**. Four pane types exist:

| Type | Keys | Contents |
| --- | --- | --- |
| Terminal | `Alt+T` | xterm.js shells — see [Terminal](terminal.md) |
| Browser | `Alt+B` | webview tabs — see [Browser](browser.md) |
| Editor | `Alt+E` | file tabs — see [Editor](editor.md) |
| Todo | `Alt+L` | project checklist — see [Todos](todos.md) |

Add panes with the topbar buttons or the shortcuts. A new pane splits the
focused pane to the right (or fills the workspace when it's empty).

## Titlebar

Every pane has a titlebar:

- **pane icon** (left) — press-and-hold then drag to move the pane
- **title area** — terminal and editor panes show an internal tab strip here;
  browser panes show their header controls (tab dropdown, bookmarks, nav,
  omnibox); todo panes show a plain title
- **type-specific buttons** — e.g. `+` new tab on terminals, open-file on
  editors
- **`⋯` actions menu** — opens on hover:

  | Item | Effect |
  | --- | --- |
  | Float pane / Dock pane | Toggle floating overlay (`Alt+F`); floating panes show *dock* instead |
  | Detach to window | Pop the pane into its own OS window |
  | Split right / Split down | Split this pane with a new terminal (hidden while floating) |
  | Minimize | Collapse to a dock chip (`Alt+H`) |
  | Close | Close the pane (`Alt+W`) |

Inside a detached window the menu collapses to a single close button — the
split/float/minimize ops live in the main window.

The **focused pane** gets a 2px accent bar on the left of its titlebar. Click
anywhere in a pane to focus it; `Alt+]` / `Alt+[` cycle focus, `Alt+←↑→↓`
moves focus to the pane in that direction.

## Resizing

Dividers between panes are flush — a transparent 9px hit area sits over the
shared edge. Drag to resize; hovering or dragging shows an accent line. Ratios
clamp to 10–90%.

## Moving panes

Press-and-hold the pane icon (~0.2s) until the drag arms, then drag. A ghost
chip follows the pointer and a highlight shows the drop target:

- **center of a pane** — swap the two panes
- **outer quarter (edge) of a pane** — split that pane and drop onto that side
- **workspace tab** — move the pane to that workspace; hovering a tab ~0.4s
  mid-drag activates it so you can drop into a specific spot inside
- **empty workspace background** — append to that layout
- **Esc** — cancel

Drops work across workspaces: dropping onto (or hovering through) another
workspace's tab moves the pane there.

## Floating panes

`⋯` → *Float pane* or `Alt+F` lifts the pane out of the tree into a free-moving
card over the layout — its slot is reclaimed by the siblings.

- Move by dragging the titlebar (including the empty tab-strip area; buttons,
  tabs, and the pane icon keep their own gestures)
- Resize with the edge/corner handles just outside the card
- Focusing a float raises it above the others
- Dock it back with `⋯` → *Dock pane*, `Alt+F`, or drag it into the tree with
  the normal pane drag (grip icon)

## Detached windows

`⋯` → *Detach to window* moves the pane into its own frameless OS window. The
pane keeps its slot in the workspace — reattaching returns it exactly there —
and terminal sessions keep running through the move.

The detached window's top bar (draggable anywhere) has:

- **file-tree button** (editor panes only) — hover to peek the project tree as
  an overlay, click to pin it as a sidebar; `Alt+X` / `Alt+O` work here too
- **always-on-top pin** toggle
- **reattach** — sends the pane back to its workspace slot
- minimize / maximize / close — closing the window reattaches the pane rather
  than closing it; to close the pane for real use its inner titlebar's close

Detached panes show a chip in the main window's [pane dock](#minimized-panes);
clicking it brings the window forward.

## Minimized panes

`Alt+H` or `⋯` → *Minimize* collapses the pane. Minimized panes stay mounted
— terminals keep running, webviews stay loaded — and show up as **dock chips
on the right side of the title bar**, scoped to the active workspace. Clicking
a chip restores the pane to its exact slot; the chip's `×` closes the pane for
real. A terminal chip shows the running agent's icon or an exited dot, and its
`shell · cwd` label.
