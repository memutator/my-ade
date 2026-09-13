# Editor

The editor pane owns an internal **tab strip of files** in its titlebar. All
open tabs stay mounted, so unsaved buffers survive tab switches.

## Opening files

- Click a file in the **file tree** (app-icon hover overlay or the pinned
  sidebar) — it opens in the focused editor pane, else the first editor pane
  in the workspace, else a new editor pane is created
- The folder button in the pane titlebar opens a native file dialog
- File-path links in [terminal](terminal.md) output open here too

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

Detached editor windows get their own file-tree sidebar/overlay — see
[Panes](panes.md#detached-windows).
