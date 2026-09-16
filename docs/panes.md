# Panes

A workspace is a binary split tree of **leaves** (panes). A pane has no type
of its own — it's a **stack of blocks** shown as tabs in its titlebar. Three
block kinds exist, and they mix freely inside one stack:

| Kind | Keys | Contents |
| --- | --- | --- |
| Terminal (`term`) | `Alt+T` | xterm.js shells — see [Terminal](terminal.md) |
| Browser (`web`) | `Alt+B` | webview pages — see [Browser](browser.md) |
| Editor (`file`) | `Alt+E` | file buffers — see [Editor](editor.md) |

**Opening content never splits the layout.** `Alt+T/B/E`, tree clicks,
terminal file links, and `openUrlInBrowser` all stack a block into a leaf —
the leaf that asked, else the focused one, else the last visible one. A new
leaf only appears when nothing visible exists. Splits are created exclusively
by explicit gestures: `Alt+D`/`Alt+S`, the `⋯` menu's split items, or dragging
a pane to another pane's edge. Invariant: *the focused leaf is never
implicitly split.*

Closing a block's last tab closes the leaf.

## Titlebar

Every pane has a titlebar:

- **pane icon** (left) — shows the active block's kind glyph; press-and-hold
  then drag to move the pane
- **tab strip** — the shared `TabStrip` lists every block in the stack with a
  kind icon, label, and status dot (exited shell, unsaved buffer, unread
  notification). The `+` at the end of the strip stacks a new block of any
  kind into this leaf. Double-click renames terminal blocks; file previews
  pin on double-click. Right-click opens per-kind actions (rename / copy cwd
  / restart shell for terminals, copy path / reveal for files, copy URL for
  web) plus the shared close ops (close, close others, close to the right,
  close all)
- **block-specific buttons** — e.g. restart-shell on an exited terminal,
  open-file on an editor block
- **`⋯` actions menu** — opens on hover:

  | Item | Effect |
  | --- | --- |
  | Float pane / Dock pane | Toggle floating overlay (`Alt+F`); floating panes show *dock* instead |
  | Detach to window | Pop the pane into its own OS window |
  | Split right / Split down | Split this leaf with a new terminal block (hidden while floating) |
  | Minimize | Collapse to a dock chip (`Alt+H`) |
  | Close | Close the pane (`Alt+W`) |

Inside a detached window the menu collapses to a single close button — the
split/float/minimize ops live in the main window.

The **focused pane** gets a 2px accent bar on the left of its titlebar. Click
anywhere in a pane to focus it; `Alt+]` / `Alt+[` cycle focus, `Alt+←↑→↓`
moves focus to the pane in that direction.

Block-specific chrome lives *inside* the content, not the titlebar: a web
block floats a translucent navigation header at the top of the page, and a
file block gets a small corner fab that pops the directory-tree overlay on
hover (~350 ms dwell). See [Browser](browser.md) and [Editor](editor.md).

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

## Moving tabs

The same press-and-hold gesture works on any tab in a leaf's strip — the drag
arms after ~0.2s and a ghost chip follows the pointer:

- **inside the strip** — reorder; a thin accent line marks the insertion gap
- **center of another pane (or anywhere on its tab strip)** — stack the tab
  into that leaf and raise it
- **edge of a pane** — split that pane; the tab lands in a fresh leaf on the
  new half (works on the source pane itself — splitting a tab off)
- **workspace tab / empty workspace background** — move the tab to a new leaf
  in that workspace; hovering a workspace tab ~0.4s mid-drag activates it
- **Esc** — cancel

A pane emptied by the move closes (its own last-tab-closes rule). Terminal
tabs keep their live shells through any move — the pty belongs to the tab
record, not the pane. In a detached window tab drags are reorder-only — the
window shows a single pane, so there's nothing else to drop on.

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
real. A chip shows the active block's icon and label — for a terminal block
that's the running agent's icon or an exited dot plus `shell · cwd`.
