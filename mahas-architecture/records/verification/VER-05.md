---
taskId: VER-05
codeRevision: 83a6d21
specRevision: 99eb5f5
verdict: failed
evidence: VER-05
---

# VER-05 — 역할 구현의 실제 구성품·초기 입력 검사 (role-implementation materialization · initial-input injection)

VerificationRecord for the injection, realization, and launch contracts
(`spec/injection.md`, `spec/contracts/realization.md`,
`spec/contracts/launch.md`), requirements REQ-05/06/07/08/22. Prerequisites
VER-01 (`a9dcd65`, failed) and VER-03 (`83a6d21`, failed) are recorded. This
run was executed against a clean detached copy of `83a6d21`
(`83a6d21204ab6f164f2ff519a12ba6043188be14`) in `/tmp/mahas-ver-05/` — the
main worktree's unrelated WIP was never touched and the pinned
implementation was not modified.

## environment

| 항목 | 값 |
|---|---|
| code revision | `83a6d21` (coordinator handoff, all 32 IMPs landed) |
| spec revision | `99eb5f5` |
| runtime | node v24.20.0 (`--experimental-strip-types`), `node:sqlite` (SQLite 3.53.4) |
| OS | Linux 7.0.0-31-generic x86_64 |
| world | in-process `composeRuntime` + real `mahas-execution-host` over `config/execution-host.sock` (`host-pyosechang-MS-7D76`); control DB `db/mahas.sqlite`; the socket authenticator cannot mint member/execution-bound contexts, so authenticated ctxs were constructed in-process against the same real registry/admission path |
| cooperative executable | `/tmp/mahas-ver-05/coop/recorder.mjs` — records exact child argv, cwd, `MAHAS_*`/`VER05_*` env, stdin byte length + sha256 (+text), and per-`--file` path sha256; spawned by the real host, never a mock |
| fixture | `state.json` + `probe/fixture.ts` — project + mv1 + run, roles r-lead/r-asm/r-tool, authored role implementations + interface snapshots, shared source `src/shared/ver05-source.md` + root charter `src/charter/root-charter.md`, provisioning grants, plan rev1, `hp-main@2` |

## probe inventory

| artifact | checks | result |
|---|---|---|
| `out/s0-fixture.json` | 11 | fixture seeded via real ops (model/role/interface/impl publish, member assign, envelope pin, snapshot digests). 1 expectation artifact — `env.src-revision` compared short `83a6d21` to full `83a6d21204…be14` with strict equality; the observed full SHA **confirms** the target revision (harness artifact, not a product failure) |
| `out/s1-build.json` | 37 | **all pass** — same source re-expressed into per-role mandatory bytes for all 3 roles; byte-identical mandatory text across roles; **no parent-charter auto-injection**; 16 compiler negatives (conditional-only skill, removed component file, stale source pin/interface, out-of-scope action, verbatim-original leak into re-expressed text, conflicting pins, unpinned source, duplicate installPath, secret in binding, exec key in launch config, catalog on initial, missing preload route, unsupported kind, missing surface, pins-as-object); `worker.prepare` handler semantics under 6 revision/stale/host/grant/profile negatives |
| `out/s2-materialize.json` | 24 | **all pass** — real compiled bundle **rejected** by materializer (schema break, F-051); consumer-shape bundle → published execution root with mandatory `role/mandatory.md`, `task/initial.txt`, `envelope.json`, `commands.md`, private `connection/worker` (0600, hash-only), executable `bin/mahas`; route evidence + `materialized` receipt; replay + drift detection; pin-cannot-move; checkout-scoped skill install; second-writer `RESOURCE_BUSY`; reserved `AGENTS.md`/`CLAUDE.md`/`docs/AGENTS.md`; existing-target refusal; no-claim denial |
| `out/s3-start.json` | 28 | **all pass** — shipped `worker.start` ceiling = `resources_claimed` (F-046); corrected-glue run: all 8 driven stages confirmed, real host spawn, recorder observed mandatory bytes via `--file` argv route, cwd = claimed checkout, `MAHAS_*` env delivered, `materialized`+`initial-attachment` receipts; join negatives + commit-reauth rollback (F-049) + corrected-glue join + `worker_joined` receipt; accept negatives + phase-stuck (F-050) + corrected-glue accept + replay; stdin route drop pinned (F-047) |
| `out/s3b-spawn-record.json` | — | cooperative recorder dump: argv/cwd/env/stdin/file-sha256 for the corrected-glue spawn |
| `out/s3e-stdin-{spec,payload}.json` | — | direct host probes: `spec.initialStdin` delivers bytes (sha `98581e…` = sha of sent text); payload-level `initialStdin` silently ignored (child got 0 bytes) |
| `out/s4-collision.json` | 16 | **all pass** — two roles converging on one canonical checkout: same-path second writer `OPERATION_CONFLICT` (A's bytes intact), no-claim `SCOPE_DENIED`, in-bundle duplicate path `OPERATION_CONFLICT`, pre-existing shared `AGENTS.md`/`CLAUDE.md` untouched while components install, reserved basenames refused at any depth + case-insensitive, `../`/`.`/absolute/backslash escapes `MODEL_INVALID`, symlinked ancestor `MODEL_INVALID`, disjoint path under same claim publishes |
| `out/s5-stages.json` | 12 | **all pass** — `materialized`/`initial-attachment`/`worker_joined`/task-accepted are four distinct records; attached-but-unjoined executions have no join receipt/row and dispatches never reach `running`; refused stages leave no receipt; ordering attach→join→ack; full digest chain closed |

Raw probe sources: `/tmp/mahas-ver-05/probe/{common,fixture,s0..s5}.ts`
(preserved copy: `records/verification/evidence/VER-05/`).
No secrets in evidence; the `connection/worker` credential was validated by
file mode/hash/identity only — its bytes never appear in argv, env, receipts,
or artifacts.

### evidence digests (sha256, `/tmp/mahas-ver-05/out/`)

```
bcc87fa0b69c501c8d4d9353e39d08e0ac65db6b360eb15a9e927f3772269d40  s0-fixture.json
b6e1e68f4180c73342df9900f588a44a6067c1da0b9c95e2e1dfd2509190f937  s1-build.json
15fcea559e8f9fb73a68080c9a63d40d8212abccf91ba2cf18a9047586b41edd  s2-materialize.json
7e1674dba5e8b377309e5e9a66f5812d86e772ea4e2eb29671a3d6f1e0f4f502  s3-start.json
e12b461da9ac8360ae4b139d03e83305f687c948eab1272072e2a61db598370c  s3b-spawn-record.json
4fafb2f2c73e848ef0d4dec3095d03264d9ceb670a4009292615b7b510ab8574  s3e-stdin-payload.json
49d6df145ccc34b0520ebf12a9693a81a5d00a2224e48529aed318b57c320b8d  s3e-stdin-spec.json
ccdc3cff03c375ac00f9d7746236ecf889c291118ec2334689c424f5ee13cb07  s4-collision.json
284d0e3e069b018d7159cf77af015bd73d63d7aa6c5858eacedbe1ffc12d3acb  s5-stages.json
```

## evidence chain (s5 digest table)

`source snapshot → component manifest → actual argv/config/stdin → join digest`

| link | digest / value |
|---|---|
| shared source snapshot | `88d7f180…22b56a` (`src/shared/ver05-source.md`), `1a94742a…b4272` (charter) |
| component manifest | bundle `887f6861…b2d7576`, requiredText `df3693c0…1391e01`, surface `c06d66a8…37fca36` |
| actual argv | `--file` → `role/mandatory.md`, child-observed sha256 `df3693c0…1391e01` = manifest requiredText ✓ |
| cwd / env | cwd = claimed canonical checkout `…/co-s3b-e28`; `MAHAS_EXECUTION_ID/MEMBER_ID/GENERATION/CONNECTION_FILE/ENDPOINT` delivered |
| stdin | coordinator sent digest `a9b31d2a…c98d4`; child received `e3b0c442…b855` (empty) — **route break, F-047**; spec-field route delivers `98581ee7…ee9e4` |
| join digest | `worker_joins` echoes bundle/surface/envelope = verified pins; receipt `evidenceLevel: "pins-declared-not-comprehension"` |
| acceptance | dispatch `running`, delivery `acknowledged` @1789797217397 |

## findings confirmed at this revision

### critical — shipped path cannot deliver the contract

**F-046 (new) — coordinator `workspace.prepare` payload mismatches the op
contract, and the failure degrades to `unknown`.** `stageResourcesClaimed`
(`launch/start-coordinator.ts:739-746`) sends
`{reservationId, placementIntent, owner, memberId, runId, purpose, mode}` —
the op requires `projectId` + `ownerReservation` (`INPUT_NOT_READY`). The
`OperationCallError` wrapper surfaces it as `INTERNAL`/unknown (reconcile)
rather than the definitive validation rejection. **The shipped
`worker.start` therefore always dies at `resources_claimed`** — no spawn, no
attachment, no join at `83a6d21`. Everything below this stage was exercised
through corrected glue (translating only this payload and the
materialize-input shape; all stage handlers, admission, host spawn, and
receipts are the shipped code). Owner: IMP-19/IMP-16.

**F-047 (new) — initial stdin is silently dropped on the shipped route.**
`stageProcessAttempting` puts the bytes at payload level
(`spawnPayload.initialStdin = {digest, mediaType, sizeBytes, bytesB64}`,
`start-coordinator.ts:1009-1016`), but the host consumes
`spec.initialStdin` (`packages/mahas-execution-host/src/pty-manager.ts:27,
170-172, 261-263`). Cooperative-executable proof: coordinator-route spawn →
child received **0 bytes** (sha `e3b0c4…` = empty) although the
`initial-attachment` receipt records route `stdin` digest `a9b31d…`; direct
host probe with `spec.initialStdin` → child received the exact bytes (sha
`98581e…` = sha of sent). The receipt records attach **intent**, not
delivery — a silent loss of mandatory initial input. Owner: IMP-19/IMP-18.

**F-050 (new) — dispatch phase `assigned` is unreachable by join
advancement, so `task.accept` can never fire after a real join.**
`admitDispatch` inserts phase `'assigned'` (`start-coordinator.ts:605`);
join's advancement only rewrites `('reserved','starting','awaiting_join')`
(`launch/join.ts:259-261`). A committed join leaves the dispatch at
`assigned` — never `awaiting_accept` — so the acceptance path the spec
defines (join → awaiting_accept → task.accept) cannot complete without
manual phase correction. Owner: IMP-19/IMP-14.

### authorization / lifecycle gaps

**F-048 (new) — `worker.start` never issues the worker's post-join grant.**
The coordinator mints a worker principal + bootstrap credential but no
grant; post-join operations (`execution.join`, `task.accept`) are
`UNAVAILABLE_OPERATION` for the worker principal — the agent literally
cannot perform the operations the launch protocol assigns to it. Verified:
pre-join `task.accept` hidden (correct), and post-join still hidden. Only a
probe-supplied wildcard grant (corrected glue) allowed exercising the
handlers. Owner: IMP-19/IMP-10.

**F-049 (new) — join rolls back at commit-time reauthorization.**
`execution.join`'s handler inserts `worker_joins` mid-transaction; the
admission post-handler reauthorization then sees the execution as already
joined, the bootstrap-credential join bypass no longer applies, and with no
worker grant (F-048) the final authorize denies `SCOPE_DENIED` → the join
commits nothing. Even a perfectly-formed join cannot land at this revision.
Owner: IMP-19 + IMP-10/IMP-11 (reauth ordering).

**F-051 (new) — compiler→materializer manifest schema break.** `context.build`
emits components `{blobDigest, installPath, activation}`; `parseBundleManifest`
(`realization/component-store.ts:159-167`) requires `{digest, path, scope,
loadPhase}` → real compiled bundles are rejected `MODEL_INVALID 'missing
digest'`. The verification's materialized runs used a consumer-shape bundle
carrying identical bytes/pins (the translation drops fields —
`s2c.adapterDropsFields` records exactly which). The shipped pipeline's own
compiler output is not consumable by its own materializer. Owner: IMP-07/IMP-08
↔ IMP-14.

## verified-correct behavior

- **Mandatory bytes on the initial path**: identical source → byte-identical mandatory text across all three roles; delivered to a real spawned process through the `argv-file` route (child-hashed sha256 = manifest-pinned digest); **not** dependent on optional discovery — `missingRequiredRoutes: []`.
- **No auto-injection of parent charter**: charter content absent from mandatory bytes unless the interface clause requires it (s1b.mandatory.noCharterAuto ×3).
- **Pre-launch rejection**: conditional-only skill, removed component file, stale source pin, stale interface, out-of-scope action, verbatim-original leak, conflicting/unpinned pins, duplicate installPath, secret-in-binding, exec-key launch config, catalog-on-initial, missing preload route, unsupported kind, missing surface — all refused at compile/plan, before any launch.
- **Materialization**: execution root published with mandatory file, initial task text, envelope, commands, private `connection/worker` (0600, never in model-facing manifest), executable launcher; replay returns the same root; byte drift is detected; pins cannot be moved.
- **Same-cwd collision protection**: second writer refused at claim level (`RESOURCE_BUSY` at prepare, `SCOPE_DENIED` without held claim); same-path second materialization refused at file level (`OPERATION_CONFLICT`, foreign bytes intact); duplicate paths in one bundle refused at plan; checkout-scoped `AGENTS.md`/`CLAUDE.md` refused at **any depth, any case**; `..`/`.`/absolute/backslash paths `MODEL_INVALID`; symlinked ancestors `MODEL_INVALID`; pre-existing shared instruction files coexist untouched.
- **Join/accept fencing**: wrong execution binding, stale generation, digest mismatch, wrong member, wrong dispatch, stale task revision, wrong envelope digest — all rejected with definitive codes; join replay is honest; acceptance replay returns `alreadyAccepted`; pre-join worker operations are non-exposed.
- **Stage distinctness**: `materialized`, `initial-attachment`, `worker_joined`, and task-accepted are four separate durable records with correct ordering; attached-but-unjoined executions provably lack join receipts and running dispatches; refused stages leave no receipt at all.

## blocked / not-run (honest)

| item | status | reason |
|---|---|---|
| shipped `worker.start` past `resources_claimed` | blocked | F-046 — coordinator payload mismatches the op contract at this revision; downstream stages exercised via corrected glue, labeled as such |
| shipped stdin delivery to the child | blocked | F-047 — payload-level field is not consumed by the host; delivery proven only on the `spec.initialStdin` route (direct host probe) |
| shipped `execution.join` / `task.accept` commit | blocked | F-048 + F-049 — no worker grant exists to satisfy commit-time reauthorization; handler semantics exercised under a probe-supplied grant (corrected glue) |
| shipped dispatch reaching `awaiting_accept` | blocked | F-050 — `assigned` is not in join's advancement set; acceptance exercised after manual phase correction (corrected glue) |
| real compiled bundle through `materializeBundle` | blocked | F-051 — compiler emits a manifest shape the materializer rejects; consumer-shape bundle (same bytes/pins) used instead |
| native hidden prompt bytes | not-observable | receipt honestly records `nativeHiddenPrompt: "unknown"` — not directly observable at this revision |
| real harness CLIs (claude/codex/gemini) | not-run | cooperative recorder was the contract-observing executable; vendor CLI argv parsing is IMP-25/harness-adapter territory |
| comprehension | out-of-scope | per instruction §3 — model understanding is REV-03/VER-11; join digest equality proves pin receipt only |

## verdict

**failed.** The mechanisms are largely correct: mandatory role bytes reach a
real process through the initial-input path (observed, digest-verified),
invalid and conflicting setups are rejected before launch, shared-checkout
collision protection is thorough, and the four receipt stages are genuinely
distinct. But at `83a6d21` the **shipped** end-to-end path cannot satisfy the
contract: `worker.start` dies at `resources_claimed` on a payload schema
mismatch (F-046); initial stdin is silently dropped between coordinator and
host (F-047); the worker can never join because no grant is issued (F-048)
and join self-rolls-back at commit reauthorization (F-049); the dispatch can
never reach `awaiting_accept` (F-050); and the compiler's own bundle output
is unreadable by the materializer (F-051). Finding candidates F-046…F-051 are
named here for routing to IMP-07/08/10/11/14/16/18/19 —
`records/orchestration/findings.md` and `STATUS.md` were intentionally not
modified in this run; repeat s3–s5 after the owning IMPs land fixes.
