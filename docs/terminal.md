# Terminal

Terminal panes are xterm.js shells backed by a separate pty-host process (real
`node-pty` under system Node — see [Getting started](getting-started.md) for
the Node.js requirement).

## Tabs

Each pane owns an internal **tab strip of shell tabs** — every tab keeps its
own xterm and live pty in the background. The `+` button in the titlebar adds
a tab; `Ctrl+Tab` / `Ctrl+Shift+Tab` cycles them. Tabs can be double-clicked
to rename, dragged to reorder, and closed with `×` — closing the last tab
closes the pane.

New panes and new tabs spawn in the **workspace's project directory**. The
shell's live cwd is tracked and shown as a sub-label on the tab. When a shell
exits, its tab gets a dot and the pane shows a *process exited — click to
restart* overlay (a restart button also appears in the titlebar).

## Links in output

Terminal output is linkified — hold the pointer over it and click:

- **URLs** open in a browser pane of the same workspace — the focused browser
  pane navigates, else the first browser pane, else a new one is created
- **file paths** open in an [editor](editor.md) pane, resolved against that
  tab's live cwd at click time — `src/foo.ts:12`, `./x`, `~/…`, `file://…`
  URIs, `key=path` args, and extensionless basenames like `Makefile` or
  `README` are all recognized

## Agent awareness

The pty host walks each shell's process tree and detects known **agent CLIs**
— claude, codex, gemini, grok, devin, cursor, copilot, aider, opencode, amp.
A detected agent shows in the pane titlebar/tab with its vendor icon (falling
back to a brand-colored letter), replacing the shell name.

An agent→idle transition counts as a finished turn and fires an **in-app
notification plus an OS notification**; clicking either jumps straight to the
workspace/pane/tab that produced it. Per-provider toggles and the OS-
notification switch live in **Settings → agents & notifications**, which also
offers real per-harness hooks (turn-complete / needs-input) for supported
CLIs — process detection is the fallback.

Sessions survive minimize, float, and detach — remounts reattach to the same
pty and replay the scrollback tail. On app restart, shells respawn fresh.

Terminal font and size are configurable in **Settings → appearance**.
