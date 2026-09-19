---
taskId: VER-10
codeRevision: "wip-tree@4d3a11c+120-dirty (IMP-25 codex profile exists only as ignored WIP — F-033; no clean revision contains it)"
specRevision: 99eb5f5
verdict: passed
scope: "codex profile real-execution legs R1–R5 on the WIP tree via direct-argv launch (approved). Managed worker.start path NOT exercised — its defects are VER-05/06 findings (F-046~F-055)."
cost: "4 paid codex turns approved by user — 60,190 tokens total (r1 15,926 + r2 8,932 + r4a 16,138 + r4b 19,194), gpt-6-astra/xhigh via user's ChatGPT login"
---

# VER-10 — codex harness profile real-execution verification

**Date:** 2026-09-19 · host `pyosechang-MS-7D76`, node v24.20.0, codex-cli 0.155.0 (native sha `660e159a…`)
**World:** isolated `MAHAS_CONFIG_DIR=/tmp/mahas-ver-10/config` — real execution-host + real mahasd from the WIP copy at `/tmp/mahas-ver-10/wip` (rsync of the dirty worktree; `git` metadata absent — revision labeled by source `git rev-parse HEAD` + dirty count).
**Authorization:** provisioning grant `grt_ef804c80` minted through the real `access.grant` op (`scope.provisioning.profileAdmission='documented-in-verification-run'`, `allowedRoleIds=['r-codex']`) — the purpose=verification grant required by the run.
**Worker fixture (SCAFFOLD, honestly labeled):** member/exec/credential chain seeded directly (`seed.mjs`) because the managed launch path is separately under test and documented broken at `83a6d21`. Seeded rows: run/member/assignment/launch-plan chain/execution/`execution_credentials` (mode `bootstrap`) + `grant-ver10-worker`. The seeded principal follows the `principal-<executionId>` convention `memberPrincipalBound` enforces — a mismatched principal produced an empty surface, which is itself F-018-fix evidence.
**`~/.codex/config.toml` untouched** — `approval_policy=never`, `danger-full-access`, model `gpt-6-astra` governed the legs as-is (disclosed, per prep §1).

## checks: 21/21 exercised paths pass · 0 product defects in VER-10 scope · 2 observations

| # | check | result | evidence |
|---|---|---|---|
| s0 | `access.grant` op (WIP socket) commits verification provisioning grant | **pass** | `seed-results.json` — `grt_ef804c80` committed |
| s0 | `memberPrincipalBound` convention `principal-<execId>` enforced — wrong principal → empty surface | **pass (F-018 fix live)** | first seed used `pri-ver10-worker` → every op `UNAVAILABLE_OPERATION`; renamed to `principal-exec-ver10-1` → surface resolves |
| s1 | worker socket `mahasd-worker.sock` bound + authenticates `{kind,credentialId,secret}` | **pass (F-001/F-023 fix live)** | `hello-ok principal=principal-exec-ver10-1` |
| s1 | bootstrap (unjoined) ctx surface = 4 ops only; operator ops refused | **pass** | probe: `surface.describe`/`assignment.show` committed; `inbox.check`/`run.get`/`access.grant`/`project.create` → `UNAVAILABLE_OPERATION` |
| s1 | scoped CLI `bin/mahas` → dev CLI → worker socket: `mahas help` lists only bootstrap surface; `mahas access grant` → `not in your surface`; `mahas surface describe` commits | **pass (§4.4)** | live CLI output |
| s2 | `buildCodexLaunchSpec` (real recipe) on instruction+skill+tool-config+launch-config components → processSpec argv `[-c, developer_instructions=<TOML>, <initialText>]`, env `MAHAS_CLI`, envPrepend `PATH=[bin]`, skill materialize `.agents/skills/ver10-probe/SKILL.md`, 0 plan errors | **pass** | `out/launch-spec.json` |
| s2 | refusals live: empty mandatory → `MANDATORY_COMPONENT_MISSING`; `subagent` → `INJECTION_UNSUPPORTED`; 200KB arg → `INJECTION_UNSUPPORTED` single-arg limit | **pass** | recipe calls (free legs) |
| R1 | `codex exec` + recipe argv → session `01a0b874`, reply `VER10-R1-OK`, 15,926 tok | **pass** | `r1-result.json`, rollout |
| R1 | injection reaches model as developer-role `response_item` with **verbatim text incl. 한글+개행** (TOML basic-string round-trip) | **pass (§4.2)** | rollout `r1-r4-rollout.jsonl` — `HAS-KOREAN` |
| R2 | agent shell `command -v mahas` → scoped launcher via PATH prepend (no `/usr/bin/mahas` shadow leak) | **pass** | r2 stdout + rollout `exec` tool call |
| R2 | agent shell `mahas surface describe` → real committed receipt through worker socket | **pass (§4.4, inside agent turn)** | r2 stdout shows receipt |
| R2 | skill catalog: `.agents/skills/ver10-probe/SKILL.md` delivered at canonical path; model `cat`s it and reports probe token `VER10-SKILL-TOKEN-7f3a` | **pass — convention-based discovery** | rollout tool call `cat .agents/skills/ver10-probe/SKILL.md` |
| R4a | `codex exec resume <sid>` — same session continues, `VER10-R4-RESUMED` | **pass** | `r4a-result.json` |
| R4b | changed-role resume (`resume <sid> -c developer_instructions="<auditor>"`) — **override silently dropped**: session continues under ORIGINAL instructions, auditor text appears nowhere in rollout (0 refs), no refusal/warning | **pass-with-note** | `r4b-changed.json`, rollout developer items [0..2] only |
| R5 | rollout proves real execution: `token_usage_record.response_id` = 5 real `resp_…` ids (unforgeable), `cwd` = allocated checkout, `cli_version=0.155.0`, `session_id` in index | **pass** | `out/rollouts/` |
| R5 | hook channel: `turn-complete` event for session `01a0b874` reached `~/.config/mahas/agent-events.log` with correct sessionId+cwd; `mahasSession`=`4a04e741` + paneId/tabId = the desktop app session hosting this verification (inherited env on the r4b inline leg — consistent, not a defect) | **pass** | agent-events.log line |
| s1 | bootstrap surface comes from execution join-state in `decide()` (`BOOTSTRAP_OPERATIONS` = join/show/describe/get), NOT credential `mode` | **pass — but see O-1** | probe + `authorize.ts:378-395` |

## observations (not numbered findings)

- **O-1 — `isBootstrapOperationAllowed` is dead code with misleading comments.** Defined in `launch/bootstrap-credential.ts:49-59`, referenced by comments in `main.ts`/`join.ts` claiming transport-layer enforcement — **never called** (`bindingToContextFields` drops `mode`). Harmless today: `decide()` enforces the identical 4-op set via execution join-state (`authorize.ts:386-393`), so bootstrap authority is correctly restricted pre-join. Risk: future readers trust the comment; a 'bootstrap'-mode credential on a joined execution gets full surface (mode isn't consulted — arguably intended since the credential is still valid). Owner: IMP-12/IMP-19 — either call it or delete it + fix comments.
- **O-2 — codex 0.155.0 does not inject `<skills_instructions>` for `.agents/skills/` catalogs.** No skills block in session_meta/turn_context/developer items; discovery is convention-based (model knew `.agents/skills/<name>/SKILL.md`). Spec §4.3 expected catalog injection — delivery route verified, advertisement mechanism is lazy/conventional on this version. Recorded as environment fact, not a mahas defect.
- **O-3 — codex injects its own `<multi_agent_role>`/`<multi_agent_mode>` developer items** (`multi_agent=true` stable feature) and a `<recommended_plugins>` user item — native multi-agent machinery active in this build. No mahas `subagent` component was requested or delivered; codex's own defaults did this. §4.5's no-silent-fallback concern is about mahas substituting components — none observed.
- **O-4 — changed-role resume (R4b) drops the new `-c developer_instructions` silently.** From mahas's side the resume recipe emits no `-c`, so the managed path can't express a role swap — fail-closed by construction. Codex's raw behavior (silent drop, original instructions retained) additionally prevents role escape. Honest-signaling gap is codex-side.

## legs consumed (approved)

| leg | argv shape | cost | result |
|---|---|---|---|
| R1 | `codex exec --skip-git-repo-check -c developer_instructions=<TOML> <initialText>` | 15,926 tok | VER10-R1-OK |
| R2 | same + materialized skill + CLI prompt | 8,932 tok | token + receipts + VER10-R2-OK |
| R4a | `codex exec resume 01a0b874 <prompt>` | 16,138 tok | VER10-R4-RESUMED |
| R4b | `codex exec resume 01a0b874 -c developer_instructions=<auditor> <prompt>` | 19,194 tok | VER10-R4-CHANGED, override dropped |

`--skip-git-repo-check` is a leg-level flag, not recipe argv — the isolated `/tmp` checkout isn't a trusted project in the user's config and the config was not modified.

## blocked / not-run (honest)

- **Managed `worker.start`→host-pty launch of codex** — not exercised; the launch path's own defects are F-046~F-055 (VER-05/06). VER-10's legs are direct-argv per prep §5.
- **`codex` interactive TUI under pty** — `codex exec` used instead (same argv/injection path, deterministic). TUI-vs-exec delta is terminal chrome, not injection.
- **execve E2BIG boundary** — recipe arg accounting verified (498B total); kernel boundary probe not run (recipe's own gate already verified live: 200KB arg refused).

## evidence

`records/verification/evidence/VER-10/` — `launch-spec.json`, leg result JSONs, stdout/stderr captures, rollout copies (`r1-r4-rollout.jsonl`, `r2-rollout.jsonl`), `seed.mjs`/`gen-launch.mjs`/`run-leg.mjs`, `digests.txt` (sha256 ×20), worker-connection scaffold (secret-bearing file excluded — mode 0600 stays under /tmp).
