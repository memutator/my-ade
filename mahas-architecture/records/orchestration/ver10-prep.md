# VER-10 prep — codex harness real-execution readiness

**Date:** 2026-09-19 · **Host:** `pyosechang-MS-7D76`, Linux 7.0.0-31-generic, user `pyosechang`, node v24.20.0
**Scope:** everything for VER-10 *except* the paid codex invocation. No `codex` run that can
reach the model was executed — only `codex --version`, `--help`, `login status`, `features list`
(all verified local-only from `--help` output before running). No repo file modified outside
this record. Pinned source worktree created: `git worktree add --detach /tmp/mahas-ver-10/src 83a6d21`.

**Verdict:** **RUNNABLE pending (a) user cost approval and (b) a committed revision containing
the codex profile — see blocker B1.** DAG deps not all satisfied (VER-03 failed, VER-05/06
in progress) — status stays **pending**.

---

## 1. Environment (verified live, read-only)

### codex install identity

| Item | Value |
|---|---|
| PATH entry | `~/.nvm/versions/node/v24.20.0/bin/codex` → `…/lib/node_modules/@openai/codex/bin/codex.js` (8,790 B JS shim) |
| Native binary | `…/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex` — 269,339,072 B, musl ELF |
| sha256 (native) | `660e159a49e823ac8e5986cb238f73158ce4b957d40d9292f8de90862644b501` |
| Version | **codex-cli 0.155.0** — *changed since harness-inventory.md (0.154.0); package upgraded 09-19 02:58* |
| Auth | `codex login status` → **"Logged in using ChatGPT"**. `~/.codex/auth.json` keys: `auth_mode:str`, `tokens:dict`, `last_refresh:str` (values not read) |
| In-binary primitives | `developer_instructions` ×53 hits, `.agents/skills` path ×1 — both recipe primitives present in 0.155.0 |
| Feature flags (`features list`, local) | `skill_search`=true (stable), `skill_mcp_dependency_install`=true, **`multi_agent`=true (stable)**, `multi_agent_v2`=false — skills machinery live; **native multi-agent capability exists in this build** (matters for §4.5) |
| OS limits | `getconf ARG_MAX`=2,097,152 (2 MiB); MAX_ARG_STRLEN=131,072 — exactly matches `CODEX_ARG_LIMITS` (`codex/recipe.ts:67-70`: singleArg 131072, budget 2 MiB−64 KiB) |
| pty tooling | `/usr/bin/script` present (pty wrapper for TUI); `expect` absent; node v24 can `node-pty` via the repo's pty-host pattern |

### `~/.codex/` state (all inherited — disclosed on the receipt, never rewritten per policy)

- `config.toml` (user's own, governs any VER run): `approval_policy="never"`,
  `sandbox_mode="danger-full-access"`, `approvals_reviewer="user"`, `model="gpt-6-astra"`,
  `model_reasoning_effort="xhigh"`, `notify=["node","/home/pyosechang/.config/mahas/mahas-hook.cjs","codex"]`,
  ~30 `[projects.*] trust_level="trusted"` entries, `[plugins.*]`/`[marketplaces.*]` tables.
  `approval_policy="never"` ⇒ **no interactive approval prompts inside a VER TUI** — but also no
  guardrail; the run's own sandboxing must come from the isolation, not codex approvals.
- `config.toml.mahas-bak` diff proves the mahas installer rewrote `ade-hook.cjs`→`mahas-hook.cjs`;
  `~/.config/mahas/notify-forward.json` chains the displaced `session-tap.js` notify.
- `hooks.json` is **NOT mahas** — it belongs to `.orca/agent-hooks/codex-hook.sh` (a different
  tool; the inventory's "mahas notify hook" label was imprecise — mahas uses the `notify` key,
  not hooks.json). Leave untouched; it will fire during a VER run too (global by nature).
- `AGENTS.md` = 0 bytes (empty user-level instructions).
- `sessions/2026/MM/DD/rollout-*.jsonl` — **223 rollout files** + `session_index.jsonl`
  (`{id, thread_name, updated_at}`). Latest: 09-19, cwd `~/projects/growph`.

### mahas-side

- `/usr/bin/mahas` → `/etc/alternatives/mahas` → `/opt/Mahas/mahas` — **199,949,528 B stripped
  ELF = the Electron desktop app, not a CLI.** Any unscoped `mahas` lookup launches a GUI.
- Dev CLI entry: `packages/mahas-cli/src/main.ts` (shebang `#!/usr/bin/env node`, mode 0644 —
  invoke as `node <path>` or via generated shim); `npm run mahas` = `node packages/mahas-cli/src/main.ts`.
- Event channel live: `~/.config/mahas/{agent-events.log,hook-raw.log,notify-decisions.log,mahas-hook.cjs}`
  — real codex `turn-complete` events with `mahasSession`/`paneId`/`tabId`/`sessionId`/`cwd`
  already flow from installed-app usage (verified tail of agent-events.log).
- Control-plane recipe (proven): `ver-infra.md` — `node packages/mahas-execution-host/src/main.ts`
  then `node packages/mahas-runtime/src/main.ts` with `MAHAS_CONFIG_DIR=<isolated>`; no build
  needed (node runs .ts directly).

---

## 2. mahas↔codex integration surface (pinned `83a6d21` unless noted)

| Surface | Location | Shape |
|---|---|---|
| Process detection | `resources/agents/manifest.json` `"codex"` | `match:["codex"]`, label Codex, domain openai.com, `resume:{cmd:"codex",args:["resume"]}` |
| Hook install | `src/main/hookInstallers.ts:164-232` | id `codex`; edits `~/.codex/config.toml` top-level `notify=[node, <hook>, codex]`; preserves/chains a prior notify via `notify-forward.json` (`codex` table) |
| Event normalization | `resources/mahas-hook.cjs:11,185-190,267-271,285-337` | `codex` notify payload = last argv; emits `{v:1,provider:"codex",event,cwd,sessionId,message,mahasSession,paneId,tabId,ts}`; codex-internal catch-up threads demoted; `mahas:!!MAHAS_SESSION` marks channel |
| Env stamping | `src/main/index.ts:69` `MAHAS_SESSION ??= randomUUID()`; `resources/pty-host.cjs:118-119` `MAHAS_PANE`/`MAHAS_TAB` from pty id `paneId:tabId:uuid` | survives shell→agent→hook chain |
| `ours` attribution | `src/main/eventsFile.ts:187` | `ev.ours = ev.mahasSession === process.env.MAHAS_SESSION` — a *manual* VER run has no app session ⇒ set `MAHAS_SESSION` explicitly or attribute by `sessionId` |
| Resume record | `src/renderer/src/resume.ts` | `resumeSessions:{sessionId,provider,cwd,wsId,paneId,tabId}`; accept types `cd '<cwd>' && codex resume '<sid>'` into the tab |
| Resume recipe | WIP `codex/recipe.ts:310-323` | `CODEX_RESUME_RECIPE={cmd:'codex',args:['resume'],sessionIdPosition:'trailing'}`; `buildCodexResumeArgv` NUL-guards |
| Launch recipe | WIP `codex/recipe.ts:181-300` | `argv=["-c","developer_instructions=<TOML-basic-string>",initialText]`, cwd=checkout, `env.MAHAS_CLI=cliPath`, `envPrepend.PATH=[binDir]`, stdio `pty` baseline |
| TOML encoding | WIP `codex/components.ts:175-224` | basic string; escapes C0/DEL/`"`/`\`; **한글/astral pass through raw UTF-8** (legal TOML); NUL + lone surrogates → `INJECTION_UNSUPPORTED` |
| Skills | WIP `codex/components.ts:232-275,356-417` | optional-only → `<checkout>/.agents/skills/<name>/SKILL.md`, fail-on-conflict; `required` skill refused; name from `binding.skillName`→frontmatter `name:`→slug(componentId) |
| Refusals | WIP `codex/components.ts:473-484` | `subagent` → `INJECTION_UNSUPPORTED` (no silent fallback by construction) |
| Policy | WIP `codex/settings-policy.ts` | `-c` whitelist=`['developer_instructions']` only; forbidden: `model_instructions_file`,`api_key`,`model_provider`,…; env denylist `CODEX_HOME,HOME,PATH,LD_*,NODE_OPTIONS` + secret-pattern; `configHome:'preserve-existing'`; `persistentMutation:'none'`; `admissionState:'documented'` |
| Managed-path glue | WIP `launch/recipe-adapter.ts:84-118` | `profileId.includes('codex')` → routes `role/mandatory.md`→`argv-config-text`/`developer_instructions`/`toml-basic-string`, `task/initial.txt`→`argv-text` |

### Rollout record = the real-vs-replay proof (from a live 0.155.0 rollout)

`~/.codex/sessions/2026/09/19/rollout-…-01a0b5ab-….jsonl` line types:
`session_meta`(1) `event_msg`(261) `response_item`(188) `turn_context`(15) `token_usage_record`(52)
`world_state`(2) `compacted`(1).

- `session_meta`: `session_id`, `cwd`, `runtime_workspace_roots`, `originator:"codex-tui"`,
  `cli_version:"0.155.0"`, `source:"cli"`, `thread_source:"user"`, `model_provider:"openai"`,
  `base_instructions:{text, provenance:{type:"model",model:"gpt-6-astra"}}`, `history_mode:"paginated"`.
- `turn_context` per turn: `approval_policy`, `sandbox_policy`, `model`, `cwd`,
  `collaboration_mode.settings.developer_instructions` (codex-internal mode text).
- `token_usage_record`: **`response_id:"resp_…"` + token counts — the unforgeable proof of real
  model calls.** A replay/fixture cannot mint response_ids.
- `response_item` `role:"developer"` entries carry codex-injected instructions
  (`<skills_instructions>`, `<multi_agent_role>`, `<multi_agent_mode>`). A `-c
  developer_instructions=` injection is expected to surface as an additional developer-role item
  — verify by digest/content match against the emitted `-c` value.
- Discriminators for VER-10: `cli_version`==installed, `cwd`==allocated checkout, session_id in
  `session_index.jsonl`, hook events in `agent-events.log`, token_usage_records present.

---

## 3. `/usr/bin/mahas` shadowing — what a VER-10 run must do

The installed app is a GUI binary; the dev CLI is a .ts entrypoint. The scoped launcher is a
generated `<execRoot>/bin/mahas` (0755) that exports the connection env and `exec`s the real CLI.

Two launcher implementations exist:

1. `launch/worker-connection.ts:96-129` `scopedCliLauncherSource` —
   `export MAHAS_CONNECTION_FILE='<conn path>'` then `exec <binaryArgv> "$@"` where binaryArgv is
   the pinned `mahasBinary` **or bare `mahas`** (PATH lookup). ⚠️ If `mahasBinary` is omitted and
   `<execRoot>/bin` is on PATH, `exec mahas` re-resolves the shim → self-recursion. **A VER run
   must pin `mahasBinary` to an absolute path.**
2. `realization/component-store.ts:466-478` `renderCliLauncher` — always absolute:
   `export MAHASD_ENDPOINT='<endpoint>'` + `exec '<cli.executablePath>' "$@"` (VER-05's
   `exec-s2b/bin/mahas` exec'd a *test recorder* — VER-10 must point at the real CLI).

**Requirements for the run:**

- `PATH` inside the harness shell: `<execRoot>/bin` **first** (recipe `envPrepend.PATH`).
  `command -v mahas` must resolve to `<execRoot>/bin/mahas`, never `/usr/bin/mahas`.
- The launcher must exec the **dev CLI**, e.g. `executablePath` = a generated wrapper
  `#!/bin/sh\nexec node <repo>/packages/mahas-cli/src/main.ts "$@"` (mode 0755) — or
  `mahasBinary`=`/usr/bin/env node …` equivalent. Do **not** point it at `/usr/bin/mahas`.
- `MAHAS_CLI` env (codex tool-config route) = `<execRoot>/bin/mahas`.
- `MAHAS_CONFIG_DIR` must be exported into the agent env so the scoped CLI dials the *isolated*
  mahasd (`/tmp/mahas-ver-10/config`), not the live `~/.config/mahas` daemons.
- No app-server: do not start `codex app-server` (shared daemon behind `codex agents`) and do
  not launch the desktop app; bare mahasd + execution-host + CLI only (ver-infra recipe).

---

## 4. Instruction §4 step classification

Legend: **[I]** done-by-inspection (complete, evidence above) · **[R]** needs real invocation
(paid) · **[B]** blocked.

| §4 step | Class | Detail |
|---|---|---|
| 4.1 pass mandatory string + initial task body via direct argv/config; run join/accept·collab CLI | **[R]** | The codex launch itself is paid. The join/accept leg needs mahasd + materialized exec root + scoped CLI (free to set up). |
| 4.2 quoting/한글/개행 correctness | partly **[I]** + **[R]** | [I]: encoder escapes C0/DEL/quote/backslash, 한글/astral pass through — legal TOML basic string (components.ts:175-217). [R]: confirm installed 0.155.0's TOML parser accepts a multi-KB 한글+개행 value — real run required. |
| 4.2 physical argv limits | **[I]** + free probe | Recipe gate matches host limits (verified above). The execve E2BIG boundary probe is **free** (kernel refuses before any model call). |
| 4.2 missing mandatory instruction | **[I]** | `MANDATORY_COMPONENT_MISSING` paths verified in source (recipe.ts:196-211, components.ts:500-507). A managed-path replay through worker.prepare is optional [R]-free (no model call — refusal happens pre-spawn). |
| 4.3 optional skill ≠ mandatory meaning; no cross-checkout leak | partly **[I]** + **[R]** | [I]: required skills refused at plan; install root = checkout `.agents/skills`, fail-on-conflict; `skill_search`=true. [R]: confirm 0.155.0 actually discovers the checkout catalog (expect `<skills_instructions>`/skill refs in rollout) and that generated files stay inside the checkout (filesystem + rollout `cwd`/`workspace_roots`). |
| 4.4 harness shell: connection+CLI reachable, no operator secret/action | **[R]** + revision-dependent | [I]: launcher carries endpoint/conn-file pointer only; credential file 0600 outside model input. [R]: exercise `mahas status`/`surface describe`/`inbox check`/`task accept` via scoped launcher → worker/member surface; operator ops must reject. ⚠️ At `83a6d21` worker-auth **leaks operator authority** (cli-surface.md); WIP binds `mahasd-worker.sock` with strict `workerAuth` (main.ts:478-487,527-540). **Expected result differs by pinned revision.** |
| 4.5 unsupported native subagent / changed-role resume — no silent fallback | **[I]** + **[R]** | [I]: `subagent` component refused `INJECTION_UNSUPPORTED`; resume recipe is same-shape only; `wakeRecipe:null`. [R]: (a) changed-role resume must not silently continue — needs a real session + `codex resume`; (b) observe no quiet multi_agent fan-out substituting for the refused component — codex 0.155.0 HAS `multi_agent`=true, so this leg is meaningful; hook demotes sub-agent events to `other` (mahas-hook.cjs:185-190). |

---

## 5. Steps that consume the user's ChatGPT quota — the approval ask

All commands assume: `MAHAS_CONFIG_DIR=/tmp/mahas-ver-10/config`, isolated exec root
`/tmp/mahas-ver-10/exec/<execId>/` materialized (mandatory text, `task/initial.txt`,
`connection/worker`, `bin/mahas` → dev-CLI wrapper), host+mahasd booted per ver-infra.

| # | Leg | Exact command shape | Cost | Covers |
|---|---|---|---|---|
| R1 | **Baseline TUI launch** — real recipe argv under pty | `cd <checkout> && script -qec "codex -c 'developer_instructions=\"<TOML(mandatory)>\"' '<initialText>'" /tmp/mahas-ver-10/out/r1.tty` — or non-interactive: `codex exec -c 'developer_instructions="<TOML>"' '<initialText>'` | paid (≥1 turn) | §4.1, §4.2 quoting/한글/개행 |
| R2 | **Skill catalog leg** — same launch with `.agents/skills/<name>/SKILL.md` present | as R1 + prompt exercising the optional skill | paid | §4.3 |
| R3 | **CLI-access leg** — inside the R1/R2 TUI shell (or a `codex exec` shell tool call): `command -v mahas`, `mahas status`, `mahas surface describe`, `mahas inbox check`, `mahas task accept …`, and a forbidden probe (`mahas access grant …` → expect rejection) | driven via the harness's own shell tool | paid (runs inside agent turns) | §4.4 |
| R4 | **Resume leg** — after R1 creates a session in the checkout: `codex resume <sessionId>` (and changed-role attempt) | `cd <checkout> && codex resume <sid>` / `codex resume --last` | paid | §4.5-resume |
| R5 | **No-silent-fallback observation** — during R1–R4 watch rollout + `agent-events.log` for `developer` items, `token_usage_record.response_id`, sub-session demotion | analysis of R1–R4 artifacts | free (post-hoc) | §4.5, receipts |

Free legs already done or runnable without the model: install/version/auth record; TOML
encoder analysis; argv-limit execve boundary probe; `MANDATORY_COMPONENT_MISSING` source
verification; hook/config disclosure; feature flags; rollout-shape documentation (§2 above);
`/usr/bin/mahas` shadow audit; control-plane boot (ver-infra).

**Estimated paid surface:** 3–5 short turns (R1–R4 can share sessions: R3 runs inside R1's
shell; R4 reuses R1's session id). User's `approval_policy="never"` means no in-TUI approval
prompts — codex runs tools directly under `danger-full-access`, inside the isolated checkout.

---

## 6. Blocked / pending items

- **B1 — codex profile source is absent from every committed revision.** `.gitignore:7`
  (`codex`) ignores `packages/mahas-harness-config/src/codex/` entirely;
  `codex/{components,recipe,settings-policy}.ts` (1,064 lines) exist **only** as ignored files
  in the dirty worktree (mtime 09-18 20:37); `git ls-files`/`git log --all` show they were
  **never committed**. Yet `src/index.ts:137-139` at `83a6d21` *and* HEAD exports them →
  `tsc` fails **TS2307 ×3** (proven this session). `launch/recipe-adapter.ts` is likewise
  untracked WIP. STATUS.md's "IMP-25 landed" covered the exports, not the implementation.
  **VER-10 cannot cite a clean pinned revision until IMP-25 lands the files** (unignore the
  path — the bare `codex` pattern is over-broad — and commit). Interim option: run against the
  WIP tree honestly labeled `codeRevision=<wip-tree>@<describe>` — VER rules prefer a fixed
  revision; flag for the record.
- **B2 — DAG deps unsatisfied.** `delivery-dag.json:564-573`: VER-10 ← VER-03, VER-05, VER-06,
  IMP-25, IMP-30. Today: VER-03 recorded `failed`; **VER-05 in progress** (`/tmp/mahas-ver-05`,
  fixture complete through members/grants); **VER-06 in progress** (`/tmp/mahas-ver-06`,
  epoch 41/42); IMP-25 blocked per B1; IMP-30 landed (`a0f6562`). Status: **pending**, honestly.
- **B3 — managed pty-spawn path broken at `83a6d21`** (ver-infra bug #3: `host_terminals`
  INSERT before `host_processes` → FK failure). Fixed in WIP (`process-manager.ts:349-393`
  reordered, comment "F-007"). If VER-10 drives codex through `worker.start`→host pty (the
  managed path), it needs the post-fix revision. Direct-argv legs (R1–R4) don't need it —
  `script`/pty wrapper suffices.
- **B4 — worker-auth leak at `83a6d21`** (cli-surface.md: forged/absent worker creds →
  `operator-local`, 72 ops; worker socket never bound). §4.4's "no operator action" check
  would **fail by design** on the pinned rev; WIP adds `mahasd-worker.sock` + strict
  `authenticateWorker` (main.ts:466-540). Same revision dependency as B3.
- **Not blocked, noted:** `~/.codex/hooks.json` (`.orca` hooks) and the live
  `agent-events.log` channel fire during a VER run — inherited-environment disclosure, per
  settings-policy `autoLoadDisclosure`. `MAHAS_SESSION` must be set (or attribute by
  `sessionId`) for `ours` filtering in a manual run.

## 7. What VER-10 still needs from the user

1. **Cost approval** for legs R1–R4 (ChatGPT subscription quota; ~3–5 short turns).
2. **Provisioning grant** `purpose=verification` on the isolated run + profile revision (§3).
3. **Revision decision** — wait for the IMP-25/WIP landing (recommended: gives worker-auth +
   pty fixes + the codex profile in-tree), or approve running against the labeled WIP tree.
4. Confirmation that `~/.codex/config.toml` (approval never / danger-full-access) may govern
   the run — disclosed, not modified; `CODEX_HOME` untouched.
