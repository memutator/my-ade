# Todos

ade has a built-in checklist — items are **project-scoped**: each project owns
one list, shared by every workspace under it.

The list surfaces in two places:

- a collapsible **todos section** at the bottom of the pinned sidebar (shows a
  `done/total` count)
- a dedicated **todo pane** (`Alt+L` or the topbar button) — see
  [Panes](panes.md)

## Working with items

- **add** — type in the input at the bottom and hit Enter
- **status** — click the circle to cycle `todo → doing → done`
- **edit text** — click the text; Enter or clicking away commits, Esc cancels,
  and emptying the text deletes the item
- **reorder** — drag a row and drop it before/after another row (the item
  joins the target's level)

## Nesting

Items nest to arbitrary depth:

- the **indent** button makes an item a child of the sibling above it;
  **outdent** lifts it back up a level
- while editing text, `Tab` indents and `Shift+Tab` outdents

Deleting an item removes its whole subtree.

## Dependencies

The **link** button on a row opens a picker of the project's other items —
selecting one marks it as a blocker (`dependsOn`). A item with unfinished
blockers shows a **blocked** badge, and hovering it lists what it's waiting
on. An item can't depend on itself or its own descendants.

Items, states, nesting, and dependencies all persist in
`~/.config/ade/ade-state.json` — see [Getting started](getting-started.md).
