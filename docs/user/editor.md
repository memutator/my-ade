# Editor

An editor **block** (`file` tab kind) lives in a leaf's shared tab strip —
it can sit next to terminals and web pages in the same stack. All open file
tabs stay mounted, so unsaved buffers survive tab switches.

When the active tab is a file block, a small **corner fab** floats at the
content's top-left — hovering it (~350 ms dwell) pops the directory-tree
overlay, whose root is the pane's own `treeRoot` (default: the project path,
re-pickable via the header's root menu).

## Opening files

- Click a file in the **file tree** (app-icon hover overlay, pinned
  sidebar, or a file block's corner-fab overlay) — it stacks as a file tab
  into the leaf that asked, else the focused leaf; a new leaf only appears
  when nothing is on screen
- The folder button in the pane titlebar opens a native file dialog (shown
  while a file block is active)
- File-path links in [terminal](terminal.md) output stack a file tab into
  the link's own leaf

Reopening an already-open path just activates its tab. Renames and deletes
done through the file tree keep tabs honest — moved paths remap, deleted files
close.

## Editing

- **CodeMirror** with syntax highlighting resolved from the file name; theme
  follows the app theme
- unsaved tabs show a **dirty dot**; `Ctrl+S` saves
- unsaved buffers are kept as session drafts — they survive pane drags,
  minimize/float/detach, and even closing and reopening the tab (hot-exit
  style), until you reload or save

## Markdown

`.md` / `.markdown` files open in **Milkdown**, a live-rendered WYSIWYG
surface (CommonMark + GFM). The **Rendered / Raw** chip toggle in the corner
switches to raw CodeMirror and back; unsaved edits carry across both
directions.

## Media and other files

Images (`png`, `jpg`, `gif`, `webp`, `svg`, `ico`, `bmp`, `avif`), video
(`mp4`, `webm`, `mov`, …), audio (`mp3`, `wav`, `flac`, `ogg`, …), and PDFs
preview in place. Binary files show a *binary file* notice. A footer shows
`name · size` plus an *unsaved changes* marker.

## External changes

Open files are watched on disk:

- a clean buffer auto-reloads and flashes *reloaded from disk*
- a dirty buffer gets a banner instead — *reload* or *keep mine*
- saving after the file changed on disk asks first (*overwrite*); if it was
  deleted, saving offers to recreate it

## Settings

The editor font is configurable separately from the terminal font in
**Settings → appearance → editor font** (blank falls back to a monospace
stack).

Detached panes get the same corner-fab tree overlay — see
[Panes](panes.md#detached-windows).
