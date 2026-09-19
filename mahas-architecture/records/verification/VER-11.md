---
taskId: VER-11
codeRevision: "wip-tree@6384399-dirty (rsync of dirty worktree; fix-session WIP — no clean revision contains it)"
specRevision: 99eb5f5
verdict: failed
scope: "cross-harness collaboration E2E — grok lead (user-directed substitute for claude; VER-09 remains blocked) + codex member (VER-10-qualified) over real worker-socket ops in a seeded two-member world. Managed worker.start launch NOT exercised — its defects are F-046~F-055."
cost: "2 paid grok turns approved implicitly via user direction — ACP session 01a0b892 (236 tool calls) + probe session 01a0b883; codex not re-billed (qualified at VER-10)"
---

# VER-11 — 서로 다른 하네스의 역할·해상도·협업 종단 수락 (grok lead + codex member)

**Date:** 2026-09-19 · host `pyosechang-MS-7D76`, node v24.20.0, grok-cli 1.0.34 stable (xAI OIDC), codex 0.155.0
**World:** isolated `MAHAS_CONFIG_DIR=/tmp/mahas-ver-11/config` — real mahasd (92 ops composed) + execution-host + worker socket, all from the WIP copy at `/tmp/mahas-ver-11/wip`.
**Lead substitution:** VER-09 is blocked (claude `loggedIn:false`). Per user direction the team-lead harness is **grok** — no VER-09 claim is made; the second verified harness is codex via VER-10.
**Member fixture (SCAFFOLD, honestly labeled):** both members seeded post-join (`worker_joins` + `executions.state='ready'` + `mode='full'` credentials) because managed launch is separately broken at this revision. Principals follow the enforced `principal-<executionId>` convention.
**Grok recipe (data-only onboarding):** profile stored as an explicit `process` recipe — `recipe-adapter.ts:71-77` passes complete `{executable,argv,routes}` through unchanged, so no `src/grok/` provider code was required. Launch surface observed: `--system-prompt-override`, `--rules`, `--agent/--agents`, `--allow/--deny`, `--sandbox`, `--resume/--fork-session`, `grok agent stdio` (ACP/JSON-RPC: `initialize`/`session.new`/`session.prompt`/`session.update`, `loadSession`, x.ai blocking hooks). TUI requires a real tty — ACP is the deterministic scripted path.

## checks: 14 legs · 11 pass · 2 blocked-by-defect (F-058/F-059) · 1 pass-with-scope-note

| # | check | result | evidence |
|---|---|---|---|
| g0 | grok ACP round-trip — `--always-approve --system-prompt-override … agent stdio` → `sessionId`, `grok-4.6/xhigh`, `stopReason=end_turn` | **pass** | probe `01a0b883-7d89-7361-b97b-eff70cf8f819`; `out/g1-token.frames.jsonl` |
| g1 | injection reaches model — system-prompt-override content echoed verbatim | **pass** | g1 frames — probe token returned |
| L1 | lead autonomous leg — seeded role prompt → 236 tool calls of real mahas CLI ops, ended `end_turn` with work summary; directly `message.send`→worker (`dlv_c169506b`) | **pass** | `out/l1-lead.frames.jsonl`, lead session `01a0b892-32a2-7172-aa7b-c81c6a55aaff` |
| s1 | worker-socket auth + post-join full surface on both members; operator ops surface-filtered | **pass** | `hello-ok` ×2; `surface.describe` |
| s2 | `responsibility.search` → candidate + matchReasons + memberAvailability + HMAC `selectionToken` | **pass** | `out/search-result*.json` — `r-worker` on `mv_49821eb4` |
| s3 | `assignment.preview` → proposedMember + requiredActions(34) + grantCoverage{grant-ver11-lead-prov, missing:[]} | **pass** | preview receipt `bd616225…` chain |
| s4 | `team.assign` commits new member + assignment grant | **FAIL → F-058** — child grant scope carries `memberId` of a member row inserted *after* `issueGrant` → `assertChildWithinParent` can never cover it → `SCOPE_DENIED` for every non-`*` parent. Committed only after prov-grant scope→`{kind:'*'}` workaround: `mem_def33498`, `grt_fb059024` | `member.ts:642` issueGrant vs `:653` INSERT; in-process `scopeCoversTargets` probe `uncovered:[member:<newid>]` |
| m1 | direct messaging — lead `message.send` → worker `inbox.check` outstanding → worker `replyAndAck` (atomic reply+ack, rev2) → lead inbox outstanding | **pass — no lead relay** | `dlv_6f5df75d` ack'd, `dlv_ba35b9e9` |
| a1 | exact artifact handoff — worker `artifact.publish` (digest-pinned, `expectedDigest` verified at publish) → `message.send` artifactRefs → lead `artifact.read` returns identical digest + bytes | **pass** | `art_9f9aca48` sha256 `f87aa899…` byte-equal |
| w1 | safe-wake semantics — `execution.wake` is member-self/continuation-grant-mediated: lead→other `SCOPE_DENIED` (correct), worker surface excludes it (grant-gated), no continuation grant → **manual resume required**; deliveries stay durable (3 outstanding rows survive) | **pass — manual-resume scope, not automated wake** | wake rejects + `deliveries` rows |
| c1 | stale candidate — after `role.revise`/`boundary.revise` model change, old `selectionToken` → `INVALID_TRANSITION` retry=`replan`; fresh `responsibility.search` returns new `mv_e4a76579` (projection rebuilt on publish) | **pass** | assign re-run + search |
| c2 | maintenance task path — `model.change.prepare`→`commit` (operator surface) publishes `mv_e4a76579` + writes `impact_candidates` (`r-worker`, `b-quality`, reason `parent-responsibility`, state `open`) | **pass at DB layer — but see F-059** | `impact_candidates` rows, `model_changes` committed |
| c3 | `model.impact.list` surfaces those candidates | **FAIL → F-059** — op filters `reason_json.scope.projectId`; `computeModelImpact` writes `{kind,details}` with no scope envelope → 2 real candidates invisible through the query surface | `impact-service.ts:177` vs publisher writer |
| e1 | rejection receipts carry actionable reason | **FAIL → F-060** — SCOPE_DENIED arrives as `{code,retry,name}` with **no message/details** on the wire; operator cannot tell which axis denied | raw `result` frame vs `fail(code,message,…,details)` |

## findings

- **F-058 (major) — `team.assign` unreachable for every non-wildcard caller.** The issued member grant's scope includes `memberId` (`member.ts:632-641`), but `issueGrant`→`assertChildWithinParent` runs *before* `INSERT INTO members` (`:642` vs `:653`). `expandOne('member')` finds no row → target unresolvable → uncovered → `SCOPE_DENIED`. Only a `{kind:'*'}` parent scope covers it. Member-led coordination assignment (the architecture's core delegation) cannot commit. Same ordering at pinned `83a6d21`. Owner: IMP-04/IMP-12 — insert member before issueGrant, or drop `memberId` from child scope (targets already pin run/role/boundary), or define coverage semantics for not-yet-persisted identities.
- **F-059 (major) — `model.impact.list` blind to real candidates.** Writer (`computeModelImpact`, `model/impact-candidates.ts`) stores `reason_json={kind,details}`; reader (`impact-service.ts:177`) requires `$.scope.projectId`. `NULL=projectId` → every publisher-generated candidate is permanently invisible — the "separate maintenance task path" exists in the DB but unreachable through the op. Owner: IMP-27 (reader) + IMP-05 (writer) — unify the reason envelope.
- **F-060 (minor) — rejection receipts strip error message/details.** `fail(code,message,retry,details)` serializes to `{code,retry,name:AccessError}` — the reason ("provisioning coverage failed", "child grant targets exceed…") never reaches the wire. VER-11 needed in-process probing to diagnose F-058. Owner: IMP-11/IMP-12 — include message+details in receipt error.
- **F-061 (minor/design) — `callerGrantsOfKind` is attestation-scoped only.** With `ctx.grantRevisions` populated it scans *only* attested ids; a member's legitimately-owned provisioning grant is invisible to `checkProvisioning` unless the assignment binding attests it (`internal.ts:555-566`). Whether intended (attestation = capability claim) or an ownership-scan omission needs a contract ruling — today a member must be bound via a provisioning-grant-keyed assignment to provision at all. Owner: IMP-12.

## observations

- **O-1 — `message.replyAndAck` absent from `surface.describe` yet callable+committed.** Surface listing ≠ enforcement set on this path (decision layer still authorizes). Consistent with earlier surface≠gate notes.
- **O-2 — model-change ops are operator-surface only.** Member credential → `not in your surface: model.change.prepare` — architecturally consistent (members can't mutate the model they work under); the VER-11 change was driven through the real operator connection.
- **O-3 — CLI drops empty-object payloads** (`main.ts:231`: `{}` → `undefined` → "payload must be an object"). Workaround: any non-empty field. Minor UX wart.
- **O-4 — L1 lead autonomy is real but unguided.** 236 tool calls happened because `surface.describe` returns `inputSchema:null` — the lead could discover op names but not payload shapes and guessed (`projectId` omitted, wrong field names). Discovery legibility gap, not a denial: `operation.get` returns receipts, not schemas.

## legs consumed

| leg | argv/channel | cost | result |
|---|---|---|---|
| g0 probe | `grok --always-approve --system-prompt-override … agent stdio` ACP | 1 turn | session `01a0b883`, token echo |
| L1 lead | same, seeded role prompt, `MAHAS_CLI=bin-lead/mahas` | 236 tool calls / 1 turn | session `01a0b892`; direct `message.send`, `surface.describe`, `run.get` committed; realization ops blocked (fixture model then-unpublished) |
| CLI legs | scoped `bin-lead`/`bin-worker`/`bin-op` → worker socket / operator socket | free | all receipts in `out/*.json` |

## blocked / not-run (honest)

- **Managed `worker.start`→host spawn of grok/codex** — not exercised (launch path defects F-046~F-055 open at this revision). Members seeded post-join; VER-11 verifies the collaboration contract, not spawn.
- **Codex paid re-execution** — not re-run; worker role exercised through its qualified worker-surface CLI (VER-10 already proved real codex exec/injection/resume).
- **Grok TUI member residency** — requires a real pty; ACP stdio was the deterministic path. Resume via `session/loadSession` capability observed in ACP metadata, not driven.
- **VER-09 claude** — remains `blocked` (no account); VER-11 does not claim its coverage.
