# Harness inventory — real CLI recon for VER-09 / VER-10 / VER-11

**Date:** 2026-09-19 · **Host:** `pyosechang-MS-7D76`, Linux 7.0.0-31-generic, user `pyosechang`
**Scope:** READ-ONLY inventory. No agent was run interactively; only `--version` / `--help` /
`codex login status` / `claude config list` (all local, no requests). No credential file
contents were read — existence only. No repo files modified.

Per the verification README (`verification-plan/README.md` §수행 지시), real harness runs
require user-approved install·account·cost·isolation — this document only reports what is
on the machine so VER-09/10/11 can plan.

## Summary table

| provider | CLI present? | version | config present? | profile implemented? | runnable for VER-09/10/11? | blockers |
|---|---|---|---|---|---|---|
| **claude** | ✅ `~/.nvm/versions/node/v24.20.0/bin/claude` → `…/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (ELF x86-64, sha256 `4ae40dd1784e8575…`) | **2.1.261** — satisfies profile constraint `>=2.0.0` | ⚠️ `~/.claude/` (settings.json with mahas hooks: Stop/Notification/UserPromptSubmit; skills/opentui), `~/.claude.json` (343 B, telemetry keys only) — **NO `.credentials.json`, NOT logged in** | ✅ IMP-24 file-based (`claude-code` rev 1, state `documented`) | ❌ **VER-09 blocked on auth** | interactive `claude /login` or `setup-token` (user action); user cost approval; isolated worktree; provisioning grant |
| **codex** | ✅ `~/.nvm/.../bin/codex` → `…/@openai/codex/bin/codex.js` → native `codex-linux-x64` musl binary (sha256 `61b0194f3bb65344…`) | **0.154.0** | ✅ `~/.codex/` — `auth.json`, `config.toml` (user's own `approval_policy` etc.), `hooks.json` (mahas notify hook), `session_index.jsonl`, `sessions/…` **222 rollout files**. `codex login status` → **"Logged in using ChatGPT"** | ✅ IMP-25 config-body (`codex-cli` rev 1, state `documented`) | ✅ **VER-10 runnable pending approval** | user cost approval; isolated checkout; pty for TUI; provisioning grant; app-server must NOT be started (per instruction) |
| devin | ✅ `~/.local/bin/devin` → `~/.local/share/devin/cli/_versions/3000.10.31/bin/devin` | 3000.10.31 | ✅ `~/.local/share/devin/credentials.toml`, `sessions.db`; ⚠️ 4 stale `session_locks/*.lock` | ❌ none | n/a — no profile | not a VER target |
| opencode | ✅ `~/.nvm/.../bin/opencode` → `…/opencode-ai/bin/opencode.exe` | 1.18.31 | ✅ `~/.local/share/opencode/auth.json`, `opencode.db`; `~/.config/opencode/` (plugin slot holds only `ade-events.js.ade-bak` — no live mahas plugin) | ❌ none | n/a | not a VER target |
| grok | ✅ `~/.local/bin/grok` → `~/.grok/downloads/grok-1.0.34-linux-x86_64` | 1.0.34 | ✅ `~/.grok/auth.json`, `config.toml`, `active_sessions.json`; hooks dir has only `ade.json.ade-bak` (no live mahas hook) | ❌ none | n/a | not a VER target |
| zcode | ✅ `~/.nvm/.../bin/zcode` → `…/zcode-app-cli/bin/zcode.js` | 3.11.2-22 (runtime 0.16.5) | ✅ `~/.zcode/v2/credentials.json`, `cli/config.json` | ❌ none | n/a | not a VER target |
| gemini | ❌ not on PATH | — | absent | ❌ none | n/a | not installed |
| cursor / cursor-agent | ❌ | — | — | ❌ | n/a | not installed |
| copilot | ❌ | — | — | ❌ | n/a | not installed |
| aider | ❌ | — | — | ❌ | n/a | not installed |
| amp | ❌ | — | — | ❌ | n/a | not installed |
| fake (mahas-fake) | no bin; script at `tools/mahas-fake.mjs` (node, present) | — | — | ❌ (test double, not a real harness) | n/a | cannot substitute for real runs — VER rules forbid mock-as-real |

**Only two harness profiles exist** in `packages/mahas-harness-config/src/`: `claude/`
(IMP-24, file-based — spec/injection.md §5) and `codex/` (IMP-25, config-body — §6 path B).
Every other manifest provider is detection-only (`resources/agents/manifest.json`):
match/label/icon/resume strings, no injection recipe. VER-09 can therefore only target
`claude`; VER-10 only `codex`; VER-11's "different verified harnesses" can only mean
those two.

## Per-provider detail

### claude — VER-09 target (IMP-24 file-based profile)

**Recipe expectation** (`src/claude/recipe.ts`, `profile.ts`, `settings-policy.ts`):
- executable: `claude` on PATH, env override `MAHAS_CLAUDE_EXECUTABLE` (**not set**),
  version flag `--version`. ✅ resolved at `…/claude` → ELF binary; 2.1.261 ≥ 2.0.0.
- argv: `--append-system-prompt-file <mandatory.md>` [`--plugin-dir`] [`--mcp-config`
  `+--strict-mcp-config`] [`--settings`] [`--agent`] [`--session-id`] [`--model`]
  [`--permission-mode`] [`--add-dir`] [`--allowedTools`/`--disallowedTools`]
  `<initialText body>` (trailing positional). cwd = allocated checkout, stdio = pty.
- **Flag support on installed 2.1.261**: `--append-system-prompt-file` confirmed in the
  binary strings (11 hits); help lists `--append-system-prompt` (inline-text primary form)
  plus `--plugin-dir`, `--mcp-config`, `--strict-mcp-config`, `--settings`, `--agent`,
  `--session-id`, `--model`, `--permission-mode`, `--add-dir`, `--allowedTools`,
  `--disallowedTools`, `--resume` — all recipe flags exist.
- env exports: `MAHAS_EXECUTION_ROOT`, `MAHAS_BIN_DIR`, `MAHAS_HARNESS_PROFILE`,
  `MAHAS_{BUNDLE,SURFACE,ENVELOPE}_DIGEST`; PATH prepend `<execution-root>/bin`.
- inherited-load probe (recorded on EffectiveContextReceipt, never written):
  `~/.claude/{settings.json,CLAUDE.md,skills,agents,commands,plugins}`,
  `<cwd>/{CLAUDE.md,.claude/settings.json,.claude/agents,.claude/commands,.claude/skills,
  .claude/settings.local.json}`, managed settings paths.
- resume: `claude --resume <sessionId>` — native transcripts live at
  `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` (same-cwd constraint).

**On disk**: binary and all recipe flags present; `~/.claude/settings.json` already carries
mahas hooks. **But `claude config list` → "Not logged in · Please run /login"**; no
`.credentials.json`; `~/.claude.json` holds only telemetry keys; no real session history.

**What a real VER-09 run needs**:
1. User performs interactive OAuth `/login` (browser flow) or `claude setup-token` —
   cannot be done non-interactively by an agent; no API-key env exists either
   (`ANTHROPIC_API_KEY` unset).
2. User-approved cost scope + isolated worktree + purpose=verification provisioning grant
   (VER-09 §3).
3. Materialized execution root: `role/mandatory.md`, `task/initial.txt`, `bin/mahas`
   scoped launcher, optional `role/components/` files — produced by IMP-09/IMP-19 flow.
4. A pty (profile baseline stdio=pty — interactive TUI).
5. For the resume leg: a session must first be created in the verification cwd so a
   `~/.claude/projects/<cwd-slug>/*.jsonl` exists — none do today.

### codex — VER-10 target (IMP-25 config-body profile)

**Recipe expectation** (`src/codex/recipe.ts`, `settings-policy.ts`):
- executable: `codex` on PATH (`executableLocator {kind:PATH, name:"codex"}`). ✅ 0.154.0.
- argv: `-c developer_instructions=<TOML basic string of mandatory.md>` + `<initialText>`
  positional; cwd = allocated checkout; stdio = pty baseline.
- **Support on installed 0.154.0**: `-c, --config <key=value>` in help; the native binary
  contains `developer_instructions` (58 hits) and `.agents/skills` — both recipe
  primitives exist. `codex resume [SESSION_ID]` matches `CODEX_RESUME_RECIPE`.
- skills: optional-only, installed to `<checkout>/.agents/skills/<name>/SKILL.md`
  (conditional component; required skills are refused).
- policy: CODEX_HOME never relocated; `~/.codex/{config.toml,auth.json,AGENTS.md}` never
  written; inherited settings disclosed on the receipt.
- env: `MAHAS_CLI` pointer + PATH prepend of scoped `binDir`; denylist blocks
  `CODEX_HOME`/`HOME`/secret-shaped keys.

**On disk**: fully authenticated ("Logged in using ChatGPT"), 222 prior rollouts +
`session_index.jsonl` for the resume leg; `hooks.json` (mahas notify hook) already
installed; user's `config.toml` sets `approval_policy` and other keys — these apply to a
VER run and must be disclosed as inherited, not removed.

**What a real VER-10 run needs**:
1. User cost approval + isolated checkout + purpose=verification provisioning grant.
2. Materialized checkout + scoped `bin/mahas` launcher + `MAHAS_CLI` pointer
   (IMP-09/IMP-19 flow); `-c developer_instructions=…` argv per recipe.
3. A pty for the interactive TUI; **`app-server` must NOT be started** (VER-10 §3).
4. The user's configured `approval_policy` governs tool approvals inside the TUI — plan
   for interactive approval handling (no bypass flags are permitted by the policy).
5. Record install identity: codex-cli 0.154.0, sha256 of the vendor binary, OS.

### VER-11 — cross-harness end-to-end

Requires 팀장 and tool/prompt-assemble 담당 on **different verified harnesses**
(VER-11 §3). The only two profiles are claude-code + codex-cli → transitively requires
VER-09 **and** VER-10 both passed. Blocked today behind the claude login blocker.

## Sandbox / permission implications

- **claude auth is the hard gate**: interactive OAuth (`/login`) or `setup-token` needs
  the user; there is no headless path and no API-key env on this machine.
- **Real money / real accounts**: both runs hit the user's real ChatGPT (codex) and —
  post-login — Anthropic (claude) accounts. The README's user-approval gate applies to
  every launch.
- **Hooks are global**: `~/.claude/settings.json` and `~/.codex/hooks.json` already carry
  mahas hooks, so a VER run inside an allocated checkout emits into the real event
  channel (`~/.config/mahas/agent-events.log` or `MAHAS_CONFIG_DIR` dev channel).
- **System `mahas` exists**: `/usr/bin/mahas` → `/opt/Mahas/mahas` (installed ADE). The
  execution-root `bin/mahas` must shadow it via PATH prepend — a misordered PATH would
  silently invoke the installed app instead of the scoped CLI.
- **pty required**: both profiles' baseline is `stdio: pty`; a headless shell must wrap
  the spawn (the ADE pty-host, `script`, expect, …).
- **Side-effect disclosure**: this recon's `claude --version/--help/config list` probes
  caused the CLI to scaffold `~/.claude/projects/` (two cwd-slug dirs) and one ~13.5 KB
  stub session `.jsonl`, and to touch `~/.claude.json` — created by the probes, not prior
  usage. Harmless, but noted for honesty (no auth/session history existed before).
- **Stale devin locks** (4 in `~/.local/share/devin/cli/session_locks/`): irrelevant to
  these VERs (devin has no profile) — noted as machine context only.
- `MAHAS_CLAUDE_EXECUTABLE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTHROPIC_*`,
  `OPENAI_*` env vars: all unset.

## Bottom line

| VER | status today | what it needs to run |
|---|---|---|
| **VER-09** (file-based → claude) | **BLOCKED — not authenticated** | user runs interactive `claude /login` (or `setup-token`); then: isolated worktree, purpose=verification grant, materialized execution root (`role/mandatory.md` + `task/initial.txt` + `bin/mahas`), pty spawn; resume leg needs a session created first (none exist). Binary/version/flags all verified present. |
| **VER-10** (config-body → codex) | **RUNNABLE pending user approval** | authenticated install already present; needs isolated checkout, provisioning grant, materialized `.agents/skills` + scoped `bin/mahas`/`MAHAS_CLI`, pty TUI, no app-server, disclosure of inherited `~/.codex/config.toml` settings (incl. `approval_policy`). Record: codex-cli 0.154.0, native binary sha256, `developer_instructions`/`.agents/skills` confirmed in-binary. |
| **VER-11** (cross-harness e2e) | **BLOCKED — chained on VER-09** | only claude+codex profiles exist, so it needs both verified; inherits the claude login blocker plus VER-09/VER-10 pass requirements. |
