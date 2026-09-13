# Workspaces

A **workspace** is one tab in the title bar — a single split-pane layout. Every
workspace belongs to exactly one **project** (a directory on disk);
`project : workspace = 1 : N`.

## The workspace strip

All workspaces across all projects share the single strip in the title bar,
Chrome-style curved tabs. Each tab shows the workspace name with its project
name underneath. The strip scrolls horizontally with the wheel when it
overflows, and the active tab is always scrolled back into view.

## Creating workspaces

The **`+`** button at the end of the strip opens a menu listing every
registered project — picking one creates a new workspace scoped to it
(auto-named `workspace N`, numbered per project). The menu's
**+ add project…** item opens a directory picker: the chosen directory becomes
a project and a workspace is created for it in one step.

For projects that are git repositories, each row gets a worktree button
(<kbd>⎇</kbd>-style branch icon) that opens the worktree modal — create a new
git worktree, or open a workspace rooted at an existing one.

## Tab interactions

| Gesture | Effect |
| --- | --- |
| Click | Activate the workspace |
| Double-click | Rename (Enter commits, Esc cancels; empty keeps the old name) |
| Drag | Reorder tabs |
| × | Close the workspace — its layout and panes go with it |

Closing the active workspace activates the neighboring tab. Panes can also be
moved between workspaces by dragging — see [Panes](panes.md#moving-panes).

## Keyboard

| Key | Action |
| --- | --- |
| `Alt+1 … Alt+9` | Activate workspace N (clamped to the last one when fewer exist) |
| `Ctrl+Alt+→` / `Ctrl+Alt+←` | Next / previous workspace (wraps around) |

## Project scoping

The workspace's project path follows it everywhere:

- terminal panes spawn shells (and new terminal tabs) with `cwd` set to the
  project path — see [Terminal](terminal.md)
- the file tree (app-icon hover overlay, pinned sidebar, and the detached
  editor sidebar) is rooted at the project path — see [Panes](panes.md)
- todos and project-scoped bookmarks key off the project — see
  [Todos](todos.md) and [Browser](browser.md)

A project is registered once; creating another workspace for the same project
just adds a second tab for it.
