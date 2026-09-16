# Terminal

Terminal **blocks** (`term` tab kind) are xterm.js shells backed by a separate
pty-host process (real `node-pty` under system Node — see
[Getting started](getting-started.md) for the Node.js requirement). They are
ordinary entries in a leaf's shared tab strip and can sit next to file and
web tabs in the same stack.

## Tabs

Every terminal tab keeps its own xterm and live pty in the background —
inactive tabs stay mounted, so shells keep running. The leaf's `+` menu
(`Alt+T`) stacks another terminal into the focused leaf;
`Ctrl+Tab` / `Ctrl+Shift+Tab` cycles tabs. Tabs can be double-clicked
to rename, dragged to reorder, and closed with `×` — closing the last tab
closes the leaf.

New terminals spawn in the **workspace's project directory**. The
shell's live cwd is tracked and shown as a sub-label on the tab. When a shell
exits, its tab gets a dot and a *process exited — click to restart* overlay
(a restart item also appears in the tab's context menu).

## Links in output

Terminal output is linkified — hold the pointer over it and click:

- **URLs** open in the same workspace — they navigate the leaf's active web
  tab if it has one, else stack a new web block into the link's leaf (never
  a split; a new leaf only appears when nothing is on screen)
- **file paths** stack a file tab into the link's own leaf, resolved against
  that tab's live cwd at click time — `src/foo.ts:12`, `./x`, `~/…`,
  `file://…` URIs, `key=path` args, and extensionless basenames like
  `Makefile` or `README` are all recognized

## Agent awareness

The pty host walks each shell's process tree and detects known **agent CLIs**
— claude, codex, gemini, grok, devin, cursor, copilot, aider, opencode, amp.
A detected agent shows on its tab with its vendor icon (falling back to a
brand-colored letter), replacing the shell name.

An agent→idle transition counts as a finished turn and fires an **in-app
notification plus an OS notification**; clicking either jumps straight to the
workspace/pane/tab that produced it. Per-provider toggles and the OS-
notification switch live in **Settings → agents & notifications**, which also
offers real per-harness hooks (turn-complete / needs-input / error) for supported
CLIs — process detection is the fallback.

Sessions survive minimize, float, and detach — remounts reattach to the same
pty and replay the scrollback tail. On app restart, shells respawn fresh.

Terminal font and size are configurable in **Settings → appearance**.
