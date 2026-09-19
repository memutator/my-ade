# mahas documentation

Use this index to find the current explanation for a responsibility. The
Electron app and its user-facing behavior are documented separately from the
control-plane (daemon) architecture that now serves it.

## User

The guides under [`user/`](user/) describe behavior available in the current
desktop app:

- [Getting started](user/getting-started.md) — install, requirements, and first run
- [Workspaces](user/workspaces.md) — workspace tabs, projects, and strip interactions
- [Panes](user/panes.md) — stacked blocks, splits, floating, detached windows, and drag/drop
- [Terminal](user/terminal.md) — shells, terminal links, and agent observation
- [Editor](user/editor.md) — file tabs, CodeMirror, live Markdown, and previews
- [Browser](user/browser.md) — webview blocks, bookmarks, and the floating header
- [Settings](user/settings.md) — settings, autosave, and the state file
- [Shortcuts](user/shortcuts.md) — default bindings and rebinding
- [Agents](user/agents.md) — detection, hooks, notifications, and resume
- [Usage](user/usage.md) — quota, token usage, statistics, sign-in, and stored sessions
- [Notifications](user/notifications.md) — attention levels and status indicators
- [Troubleshooting](user/troubleshooting.md) — sandbox, Wayland, Node, and watchers

## Architecture

- [Overview](architecture/overview.md) — current Electron process topology, IPC, and state
- [Lifecycle](architecture/lifecycle.md) — pane, tab, PTY, service, and view lifetimes
- [Storage and migrations](architecture/migration.md) — the control DB schema chain and upgrade paths
- [Domain index](architecture/domains/README.md) — current domain ownership and migration status
- [Contract index](architecture/contracts/README.md) — machine contract sources and compatibility boundaries

The normative execution architecture and its historical review/evidence remain
under [`mahas-architecture/`](../mahas-architecture/). The current app
overview is the entry point for behavior that already ships.

## Integrations

- [Authoring](integrations/authoring.md) — how an integration Pack is shaped and registered
- [Capabilities](integrations/capabilities.md) — evidence-backed current harness/provider inventory

The capability inventory records executable source evidence. A documented
contract, a present package module, or a manifest row does not by itself mean
that the desktop path is wired, installed, authenticated, or network-tested.

## Development

- [Setup and conventions](development/setup.md) — install, commands, hot reload, debugging, and code rules
- [Source map](development/code-map.md) — responsibility to source and documentation owner
- [Verification](development/verification.md) — available checks, scopes, and known limits
- [Packaging](development/packaging.md) — electron-builder, deb/AppImage, and native PTY shipping

## Decisions and plans

- [Decisions index](decisions/README.md) — accepted boundaries and decisions still proposed
- [Plans index](plans/README.md) — ongoing domain/integration work and migration ownership
- [Integration migration map](plans/integration-migration-map.md) — source-to-destination handoff map
- [Integration status](plans/integration-status.md) — implementation status owned by the integration coordinator
- [Root domain design](../domain-model-design.md) and [root milestone plan](../milestone-plan.md) — domain design and the active milestone plan; see HANDOFF and the stage audit for remaining work

## Compatibility paths

The former flat paths under `docs/` remain as short links to the new locations
so bookmarks and older references continue to resolve. New links should use
the sections above.
