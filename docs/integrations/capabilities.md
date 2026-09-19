# Current harness and provider capabilities

This is an implementation inventory of the code that exists in the current
app. It is not a live compatibility report: the table marks a capability when
an executable path or an existing source contract provides evidence for it.
Synthetic-fixture runs exercise these paths without a real vendor login — see
[../development/verification.md](../development/verification.md) for what has
actually been observed.

Status terms used below:

- **Observed** means that the current source contains the implementation.
- **Conditional** means that the implementation depends on a provider binary,
  a user-installed hook, a local credential, or another runtime condition.
- **Documented** means that a package contract or recipe describes the
  behavior, but no current renderer/main call path was found that performs
  it.
- **Absent** means that no implementation was found in the current source
  inventory.
- **Unclear** means that a value is carried through a generic field, but its
  provider or harness semantics are not established.

## Identity, events, hook installation, and resume

The stable current roster comes from `resources/agents/manifest.json`. The
renderer loads those descriptors through `src/renderer/src/agents.ts`, and
`resources/pty-host.cjs` also has a process-tree detector. The detector's
fallback list includes `crush` and `goose`, but they have no manifest
descriptor; they are therefore not part of the stable roster below.

The mechanics behind the event and resume columns now live in the
harness-runtime Pack (`integrations/packs/harness-runtime/`), which declares
implemented identify, launch, resume, wake, events, and maintenance
capabilities for the twelve manifest harnesses. The desktop hook installers
(`src/main/hookInstallers.ts`) and the event bridge
(`integrations/packs/harness-runtime/hooks/mahas-hook.cjs`) are driven by
those declarations.

| Harness | Identify | Events | Hook install | Resume command | Evidence and limit |
| --- | --- | --- | --- | --- | --- |
| `claude` | Observed, manifest/process match | Conditional, hook or pty idle | Conditional, `~/.claude/settings.json` | Observed, `claude --resume <id>` | Hook installer and normalizer exist; installation is offered only when the CLI is found. |
| `codex` | Observed, manifest/process match | Conditional, hook or pty idle | Conditional, `~/.codex/config.toml` | Observed, `codex resume <id>` | Existing `notify` is forwarded and legacy `ade-hook` pointers are rewritten. |
| `gemini` | Observed, manifest/process match | Conditional, pty idle only | Absent | Observed, `gemini --resume <id>` | No Gemini hook installer was found. |
| `grok` | Observed, manifest/process match | Conditional, hook or pty idle | Conditional, `~/.grok/hooks/mahas.json` | Observed, `grok --resume <id>` | Grok event reasons are normalized by the shared bridge. |
| `devin` | Observed, hook or pty idle | Conditional, hook or pty idle | Conditional, Devin config | Observed, `devin --resume <id>` | Devin has Stop/permission/session hooks and a separate lock sweep. |
| `zcode` | Observed, manifest/process match | Conditional, hook or pty idle | Conditional, `~/.zcode/cli/config.json` | Observed, `zcode --resume <id>` | Zcode hooks are under `hooks.events`. |
| `cursor` | Observed, manifest/process match | Conditional, pty idle only | Absent | Absent | The descriptor has no resume recipe. |
| `copilot` | Observed, manifest/process match | Conditional, pty idle only | Absent | Absent | `copilot` and `gh copilot` are process patterns only. |
| `aider` | Observed, manifest/process match | Conditional, pty idle only | Absent | Absent | No provider-specific event, resume, usage, or quota path was found. |
| `opencode` | Observed, manifest/process match | Conditional, plugin or pty idle | Conditional, owned plugin | Observed, `opencode --session <id>` | The plugin maps OpenCode session events and delays permission notifications. |
| `amp` | Observed, manifest/process match | Conditional, pty idle only | Absent | Absent | Process identification is the only current provider path. |
| `cline` | Observed, manifest/process match | Conditional, event files or pty idle | Conditional, event files in `~/.cline/hooks` | Observed, `cline --id <id>` | The installer preserves displaced user event files as `.mahas-bak`. |
| `fake` | Observed, test manifest/process match | Conditional, test harness path | Absent | Observed, test command | This is used by the e2e fake harness, not a production provider. |

The event column describes available observation paths, not guaranteed
delivery. `hookStatuses` checks `command -v` before reporting an installer,
and the user must install the hook. When no hook is installed, the process
detector can only provide a generic agent-to-idle fallback.

Every hook event is durably ingested before the renderer sees it: the desktop
forwards records through `session.hook.ingest`
(`src/main/agentEventIngest.ts`) and the daemon's own hook-stream reader
ingests the same event file independently with stream checkpoints, so events
become stored session history rather than tail-only signals.

## Sessions, local usage history, quota, and authentication

Session evidence is now persisted. Hook events ingest into the canonical
session store (`packages/mahas-runtime/src/sessions/`), and the desktop's
legacy resume records are imported once through `session.desktop.import`.
Local provider history is read by per-harness collector Packs
(`integrations/packs/<harness>/collector.mjs`), each declaring identify,
sessions, and usage against the observation contracts — the daemon scheduler
runs them and commits batches into the stored ledger.

| Harness/provider | Live session observation | Local history collector | Quota probe | Auth/credential path |
| --- | --- | --- | --- | --- |
| `grok` / XAI | Conditional, hook or pty observation | Observed, `integrations/packs/grok/` (`~/.grok` sessions) | Conditional, builtin-offerings `xai/grok` | Conditional, managed pkce flow or `~/.grok/auth.json` |
| `claude` / Anthropic | Conditional, hook or pty observation | Observed, `integrations/packs/claude/` (project JSONL) | Conditional, builtin-offerings `anthropic/claude` | Conditional, managed manual-code flow or `~/.claude/.credentials.json` |
| `codex` / OpenAI ChatGPT | Conditional, hook or pty observation | Observed, `integrations/packs/codex/` (rollout JSONL) | Conditional, builtin-offerings `openai/chatgpt` | Conditional, managed pkce flow (`localhost:1455` callback) or `~/.codex/auth.json` |
| `gemini` / Google Cloud Code | Conditional, pty observation | Absent — no gemini collector Pack | Conditional, builtin-offerings `google/cloud-code` | Conditional, managed pkce-dynamic flow or `~/.gemini/oauth_creds.json` |
| `copilot` / GitHub | Conditional, pty observation | Absent | Conditional, builtin-offerings `github/copilot` | Conditional, managed device flow or `$config/github-copilot/apps.json` |
| `zcode` / Z.AI | Conditional, hook or pty observation | Observed, `integrations/packs/zcode/` (CLI SQLite) | Conditional, builtin-offerings `zai/coding-plan` | Conditional, api-key via `~/.zcode/{v2,cli}/config.json` |
| `opencode` / Zen | Conditional, plugin or pty observation | Observed, `integrations/packs/opencode/` (session SQLite) | Conditional, builtin-offerings `opencode/go` | Conditional, api-key via opencode `auth.json` |
| `devin` / Codeium/Windsurf | Conditional, hook or pty observation | Observed, `integrations/packs/devin/` (sessions DB, transcript fallback) | Conditional, builtin-offerings `windsurf/account` | Conditional, api-key via devin `credentials.toml` |
| `cline` | Conditional, hook or pty observation | Observed, `integrations/packs/cline/` (message JSON metrics) | Conditional, builtin-offerings `cline/account` | Conditional, managed cline-device flow or `~/.cline/data/settings/providers.json` |
| `cursor` | Conditional, pty observation | Absent | Absent | Absent |
| `aider` | Conditional, pty observation | Absent | Absent | Absent |
| `amp` | Conditional, pty observation | Absent | Absent | Absent |
| `fake` | Conditional, test pty observation | Absent | Absent | Absent |

A collector or probe being present means source support exists; it does not
prove that the current account, token, endpoint, or plan is valid. Real
vendor sign-in and quota responses have not been exercised — the conformance
fixtures and synthetic smokes are what verification covers today.

## Quota and authentication source inventory

The vendor knowledge that used to live in `src/main/usage.ts` and
`src/main/usageAuth.ts` now lives in the built-in provider Pack
(`integrations/packs/providers/builtin-offerings/`): `providers.json` is the
per-offering catalog (credential file locations, formats, flow kind, loopback
callback shape), `auth.mjs` runs the flows, `quota.mjs` runs the probes, and
`locators.mjs` finds the credential files. The runtime never names a vendor —
it asks this catalog through the Pack.

| Offering | Flow kind | Credential source observed in code |
| --- | --- | --- |
| `anthropic/claude` | manual-code | `~/.claude/.credentials.json` |
| `openai/chatgpt` | pkce, provider-registered callback `localhost:1455/auth/callback` | `~/.codex/auth.json` |
| `xai/grok` | pkce, provider-registered callback `127.0.0.1:56121/callback` | `~/.grok/auth.json` |
| `google/cloud-code` | pkce-dynamic, loopback `/oauth2callback` | `~/.gemini/oauth_creds.json` |
| `github/copilot` | device | `$config/github-copilot/apps.json` |
| `cline/account` | cline-device | `~/.cline/data/settings/providers.json` |
| `opencode/go` | api-key | opencode `auth.json` |
| `zai/coding-plan` | api-key | `~/.zcode/v2` or `~/.zcode/cli` `config.json` |
| `windsurf/account` | api-key | devin `credentials.toml` |

Auth flows run on the daemon's dedicated auth channel
(`mahasd-auth.sock`), reached from the desktop through
`src/main/runtime/authClient.ts`. A submitted secret becomes a single-use
handle (`auth.secret.deposit`); completing a flow commits the resulting
credential, connection, identity claims, and auth intent before it returns,
including callback flows that never show UI — sign-in itself never creates a
Binding. The old `usage:fetch`/`usage:auth` IPC
channels survive only as compatibility projections — see
[../architecture/domains/README.md](../architecture/domains/README.md).

## Launch, wake, bindings, and maintenance

| Capability | Current source evidence | Status |
| --- | --- | --- |
| Launch a harness | `src/main/pty.ts` starts/attaches a shell and writes commands; the harness-runtime Pack declares an implemented launch capability (`runtime.mjs`) | **Conditional**; shell launch is generic, Pack launch is declared for the manifest harnesses |
| Resume a harness | `src/renderer/src/resume.ts` builds the manifest command and types it into the terminal; the Pack declares resume implemented | **Conditional**; this is shell command replay, not a native session service |
| Managed launch recipes | Claude and Codex recipes exist under `packages/mahas-harness-config/src/claude/` and `.../codex/` | **Documented**; the profiles are not admitted/verified runtime support |
| Automatic wake | The Pack declares wake implemented; the package wake service treats Claude as manual and Codex as having no route (`packages/mahas-runtime/src/mail/wake-service.ts`) | **Conditional**, harness-dependent |
| Harness/provider binding | Installation–Connection Bindings are stored inventory (`packages/mahas-runtime/src/inventory/`); boot import creates unbound connections, and the usage UI lists them in a separate group with no inferred binding | **Observed** as stored records; binding is explicit, never guessed |
| Harness maintenance | Devin stale lock sweep in `src/main/devinLocks.ts`, called on startup, Devin session end, pty exit, and quit; the Pack declares maintenance implemented | **Conditional**, Devin only in practice |
| Installer maintenance | Hook refresh, backup, and legacy pointer rewrite in `src/main/hookInstallers.ts` | **Observed**, but this maintains hook files rather than a general harness installation |

## Current limits

- Hook install is still a per-harness user action: `hookStatuses` reports an
  installer only when the CLI is found, and the user must install it.
- The process detector's fallback patterns do not include every manifest
  entry, and process-name matching alone does not establish installation,
  version, authentication, or usage support.
- Quota provenance is per-connection polling through the provider Pack; a
  failed poll preserves the last success and never fabricates coverage — see
  the metering/quota row of
  [../architecture/domains/README.md](../architecture/domains/README.md).
