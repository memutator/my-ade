---
taskId: VER-02
codeRevision: 83a6d21
specRevision: 99eb5f5
verdict: failed
---

# VER-02 — SQLite transaction·receipt·content snapshot 내구성 검사

VerificationRecord for REQ-02, REQ-14, REQ-18, REQ-20, REQ-22, REQ-27.
Two real defects found (IMP-29: restore blob path, GC orphan enumeration); all
other expected observations reproduce on real execution evidence.

## environment

- repo `/home/pyosechang/projects/ade-wt-mahas-architecture`, branch `mahas-architecture`.
- **codeRevision `83a6d21`** — current HEAD is `8f69594`, a records-only commit;
  `git diff 83a6d21..HEAD -- packages/ src/` is empty, so the verified code is
  byte-identical to 83a6d21.
- **specRevision `99eb5f5`** — last commit touching `mahas-architecture/spec/`.
- Node `v24.20.0` (runs `.ts` directly; `node:sqlite` builtin `DatabaseSync`,
  SQLite bundled with Node — WAL/FULL verified live), OS `Linux 7.0.0-31-generic x86_64`.
- Contracts read: `spec/storage.md` (§3/§5/§7), `spec/common.md`,
  `spec/contracts/mail-artifacts.md`, `spec/contracts/recovery-operations.md`.
- All state under `/tmp/mahas-ver-02/` — no writes to `packages/`, `src/`,
  `spec/`, no npm install/build, no git writes. Spawned child processes killed.
- Harness: `/tmp/mahas-ver-02/harness/*.ts` importing the REAL implementation
  modules via absolute `file://` URLs (storage/db.ts, access/authorize.ts,
  api/registry.ts, mail/index.ts, model/ops.ts+publisher.ts,
  operations/{backup,restore,gc}.ts). Copies committed under
  `evidence/VER-02/harness/`; per-check JSON under `evidence/VER-02/results/`;
  original DBs/blob dirs remain under `/tmp/mahas-ver-02/s*/` for re-inspection.
- **Fault-injection method (no dedicated hook exists):** the code has no
  fault-injection hook. Injection used (a) the documented dependency seam —
  `registerMailOps(registry, deps)` accepts an `appendDomainEvent` override,
  the same seam the composition root uses; and (b) external OS-level faults —
  `chmod 444` files/`555` dirs, a rival `DatabaseSync` holding
  `BEGIN IMMEDIATE`, and `SIGKILL` on a spawned child mid-transaction. No
  implementation file was edited.

## results summary

| step | scope | checks | verdict |
|---|---|---|---|
| s0 smoke | seeded mail world, dispatch+replay+conflict | 8/8 | pass |
| 1 | write-boundary fault injection (REQ-02/14/18/22) | 35/36 + s1i 1/1 | pass* |
| 2 | receipt replay/conflict, store+dispatch level (REQ-14) | 24/24 | pass |
| 3 | interrupted blob publish durability (REQ-20/22) | 13/13 | pass |
| 4 | GC retention pins, real planGc/runGc (REQ-20) | 25/25 (incl. defect recorded) | pass w/ DEFECT-2 |
| 5 | consistent backup→restore + corrupted sets (REQ-27) | 41/42 | **fail** — DEFECT-1 |

\* the single s1 fail (`1i openControlDb fails on unwritable db`) is a harness
expectation stricter than the contract — see step-1 note; s1i documents the
real, safe behavior.

## step 1 — fault injection at DB write boundaries

**APIs exercised:** `openControlDb`, `withTx`, `commitUnitOfWork`,
`putContentBlob`/`getContentBlob`, `publishCandidate` (model publication),
`registry.dispatch` (`message.send`, `message.replyAndAck`, `task.report`),
direct `DatabaseSync` rival writer, child-process `SIGKILL`, `chmod`.

**Expected:** every atomic unit commits fully or rolls back fully; the failure
surfaces (throw or `rejected` receipt); no partial rows, no orphan events or
receipts.

**Observed (execution evidence — row counts queried on the real DBs):**

- `1a` throw inside `withTx` after `putContentBlob`+principal insert → error
  propagates; `content_blobs=0 principals=0`; `getContentBlob` → `null`.
- `1b` nested `withTx` → savepoint semantics: inner rolled back, outer
  committed (`A=true B=false`).
- `1c` `commitUnitOfWork` commits mutate+receipt+event+intent+outbox
  atomically (1/1/1/1/1); a write-stage failure (receipt missing `operation`
  → `insertReceipt` throws inside the same tx) rolls back the mutation too
  (`pc2/dgc/agg2/eff-2/op-c2` all `0`).
- `1d` model publication: planted `rdd_boundaries` PK conflict inside
  `publishCandidate`'s tx → `UNIQUE constraint` throw; CAS reverted
  (`active_model_version` still `mv_base`), no partial `mv_new` rows, base
  version still `published`, change still `prepared`, zero `ModelPublished`
  events.
- `1e` `message.send` with `appendDomainEvent` throwing after inserts →
  dispatch surfaces the failure; `messages=0 deliveries=0 domain_events=0
  operation_receipts=0`.
- `1f` `message.replyAndAck` with the fault armed at `delivery.acknowledged`
  → original delivery still `outstanding` rev 1, no reply message, no ack
  event, no ack receipt (only the original send receipt remains).
- `1g` rival writer holds `BEGIN IMMEDIATE` → dispatch waits `busy_timeout`
  (~5004 ms observed) then fails rejected/threw; `messages=0 deliveries=0`.
- `1h` child process `SIGKILL`ed after `UNCOMMITTED-READY` with `-wal` present
  → reopen via `openControlDb`: committed baseline survived
  (`pr_warm`/`pbase` present), uncommitted rows absent (`0`), DB writable
  after WAL recovery.
- `1i` explicit `readOnly` connection → write tx throws
  `attempt to write a readonly database`, no phantom write. See note below.
- `1j` `task.report`/`outcome.decide` are NOT registered (IMP-21 not wired —
  `registry.has` → false; dispatch → `rejected/UNAVAILABLE_OPERATION`).
  Storage-level proof stands in: `outcomes`+`settlements` inserts then throw
  → both roll back (`0/0`).

**Note — s1 `1i openControlDb on unwritable db` (expected open to throw,
observed success):** when `-shm`/`-wal` exist and are readable, SQLite's
read-only fallback lets `openControlDb` succeed on a chmod-444 DB in a 555
dir; the schema gate needs only reads, and every subsequent WRITE still
fails loudly (`1i read-only connection refuses write tx` passes). s1i shows
the complementary case: with `-shm`/`-wal` absent the open itself throws
`attempt to write a readonly database`. Either way no write lands silently —
the durability boundary holds; the harness's "open must fail" expectation was
stricter than the contract ("never degrade to *unverified writes*").

## step 2 — receipt idempotency / replay-conflict (REQ-14)

**APIs:** store level — `insertReceipt`, `findReceipt`,
`findConflictingReceipt`; dispatch level — `registry.dispatch`
(`message.send`, `inbox.check`, `surface.describe`) via the real admission
pipeline (`api/admission.ts`).

**Expected:** identical `(principalScope, operation, operationId)` + identical
payload fingerprint → stored receipt replayed, zero duplicate effects;
different payload under the same operationId → `OPERATION_CONFLICT`, never a
silent accept.

**Observed (24/24):**

- store level: `findReceipt` returns the stored row; same-fingerprint
  re-insert is a dedup no-op (fingerprint unchanged `fp-aaa`);
  different fingerprint insert → `OPERATION_CONFLICT` and the original row
  is not overwritten; `findConflictingReceipt` returns the stored receipt on
  fingerprint mismatch, `null` on match/absent; the key is exactly
  (scope, operation, operationId) — same opId under another scope stores
  independently; a receipt lacking `operation` is refused at insert.
- dispatch level: `message.send` replay → `committed`, identical fingerprint
  `667c7ce8…`, identical stored `result` (`msg_0d9aad26…`), still
  `1 message / 2 deliveries / 1 receipt` — no duplicate effects; key-order
  variant of the same payload replays (canonical fingerprint); conflicting
  payload → `rejected/OPERATION_CONFLICT` with `messages=1 deliveries=2`
  unchanged and the original fingerprint preserved.
- rejected verdicts replay their verdict (`rejected/SCOPE_DENIED`) but are
  NOT persisted as receipt rows (`operation_receipts=0`) — matching the
  documented admission design (a `same-operation` retry may re-execute);
  verified live: a corrected retry under the same operationId `committed`,
  and a different principal scope is unaffected.

## step 3 — interrupted blob publish durability (REQ-20/22)

**APIs:** `putExternalContentBlob`, `getContentBlob`, `planGc`, real
`artifact.publish`/`artifact.read` dispatch.

**Expected:** a partial file without a manifest row is never served; corrupt
bytes are caught at read; publish is atomic (file+row+pin).

**Observed (13/13):**

- `3a` positive control: file lands at `<store>/<digest[0:2]>/<digest>`,
  manifest row `verified=1 external_ref=<shard path>`, read-back exact.
- `3b` simulated crash mid-publish (abandoned `.<digest>.<pid>.deadbeef.tmp`,
  no row): `getContentBlob` → `null`, `content_blobs` row count `0`, and GC
  does not offer the `.tmp` as a collectable candidate.
- `3c` crash after rename before manifest (partial bytes AT the final
  content-addressed name, no row): `getContentBlob` → `null`. A forged
  manifest row over the corrupt file is still refused at read with
  `ARTIFACT_MISMATCH` — `getContentBlob` re-hashes on every read.
- `3d` real `artifact.publish` → `committed`; artifact row + `verified=1`
  blob + exactly 1 `retention_pins` row (`content-blob` held by `artifact`)
  landed atomically; `artifact.read` returns bytes; a publish whose file
  digest no longer matches `expectedDigest` → `rejected/ARTIFACT_MISMATCH`
  with `artifacts=1` (no partial row).

## step 4 — GC retention pins (REQ-20)

**APIs:** `pinTarget`, `isTargetPinned`, `isBlobReferenced`,
`resolvePinTarget`, `planGc`, `runGc` — the real GC op, dry-run then run.

**Expected:** content pinned by pending/unknown executions and outstanding
deliveries, and any referenced content, is never collectable; truly orphan
content is; domain rows are never GC candidates.

**Observed (25/25):**

- pin resolution: a `delivery`-kind pin resolves to `deliveries.id`
  (resolvable+exists); an unknown `target_kind` is conservatively
  unresolvable; `isBlobReferenced` sees `work_envelopes.body_digest`.
- plan: free inline + free external blobs collectable; pinned inline,
  pinned external (holder `execution` incl. the `unverifiable`-state e3),
  and the referenced envelope body all skipped; candidates are content-only
  kinds; `protectedCounts` reports `live_or_unknown_executions=3,
  outstanding_deliveries=1, retention_pins=3`.
- run: unreferenced inline row deleted; pinned inline + referenced body +
  pinned external file+row all survive; free external row deleted and file
  unlinked; the outstanding delivery stays `outstanding`; the
  `unverifiable` execution is untouched; second `runGc` is idempotent
  (`collected=0`).
- **DEFECT-2 recorded here** (see below): shard-dir enumeration misclassifies
  directories as orphan files → EISDIR unlink failures persisted as retryable
  residues + `effect_intents` rows, and the real orphan file under `aa/` was
  never discovered (`fileExists=true` after run).

## step 5 — consistent backup → restore (REQ-27)

**APIs:** `backup.create`/`backup.restore` via real registry dispatch;
`readBackupManifest`, `createBackupSetStandalone`,
`restoreBackupSetStandalone`; fresh-target open via `openControlDb`.

**Expected:** consistent snapshot (never a raw WAL-main-file copy) + manifest
binding digests + content pins; restore resurrects data but marks every past
execution unconfirmed; missing/corrupt manifest, snapshot, content file,
live-writer or unattested target → rejected with nothing written.

**Observed (41/42):**

- `5a` `backup.create` → `committed`, state `complete`; set dir holds
  `control.sqlite` + `manifest.json` + `hosts/host-0-host.sqlite` +
  `blobs/<digest>`; `consistencyPoint.method='sqlite3_serialize'`; manifest
  self-digest verifies on `readBackupManifest`; `imageDigest ==
  control.sha256` and equals the `backup_sets.manifest_digest`; artifact
  recorded `ref-recorded` (inline bytes ride inside the image); 5
  `backup_set`-holder retention pins incl. `content_blob`+`artifact`;
  `backup.created` event appended. Snapshot `PRAGMA integrity_check` = `ok`
  and **contains the WAL-resident committed row** (`pr_walonly` + sent
  message) while a raw main-file copy of the same live DB drops it entirely
  (`no such table: principals` — the whole schema was WAL-resident at
  1.17 MB `-wal`). Same-opId replay returns the stored receipt, `backup_sets`
  stays `1` — no second set.
- `5b` `backup.restore` → `committed`, `runtimeState='restored-unconfirmed'`,
  `unconfirmedExecutions=3` (all previously-live), `restoredBlobs=1`,
  `restoredHosts=1`, manifest digest echoes the set. Restored DB: WAL-resident
  row present; message/delivery/principal counts equal live DB
  (`1/1, 1/1, 6/6`); `executions` `0 live / 3 unverifiable` — **no past PID
  authority resurrected**; `schema_meta.restored_from_backup=<setId>`;
  `backup.restored` event; artifact inline bytes present; accepts new
  writes; host snapshot lands only at the explicitly mapped path; live DB
  marks the set `restored` + `backup.restore-recorded` event.
  **FAIL — DEFECT-1:** the restored external blob file is written to
  `<blobTargetDir>/<digest>` (flat) but the row's `external_ref` is
  `<shard>/<digest>` → `getContentBlob` throws ENOENT; bytes exist and are
  digest-correct but unreachable through the content API.
- `5c` rejections — every one `rejected` with the right code and **zero
  bytes written to the target**:
  `c1` missing `manifest.json` → `INPUT_NOT_READY`;
  `c2` tampered manifest (stale self-digest) → `ARTIFACT_MISMATCH`;
  `c3` missing control snapshot → `ARTIFACT_MISMATCH`;
  `c4` corrupted snapshot bytes → `ARTIFACT_MISMATCH`;
  `c5` missing captured content file → `ARTIFACT_MISMATCH`;
  `c6` `backup_sets` row digest ≠ manifest → `ARTIFACT_MISMATCH`, and after
  fixing the row the SAME operationId re-executes and commits (rejected
  receipts are never persisted — consistent with step 2);
  `c7` `expectedRuntimeStopped:false` → `INVALID_TRANSITION`;
  `c8` target == live control DB path → `INVALID_TRANSITION`, live DB
  untouched;
  `c9` live writer on target → `STOP_UNKNOWN`, target content untouched;
  `c10` operator liveness probe `isTargetStopped()=false` → `STOP_UNKNOWN`.

## supportedScope

Execution evidence (real `node:sqlite` DBs, real implementation modules end
to end — no mocks) supports, at this code revision:

- WAL+FULL atomicity: throw-in-tx, nested savepoints, unit-of-work
  (mutation+receipt+event+effect intent+outbox) all-or-nothing; SQLITE_BUSY
  contention fails cleanly; SIGKILL mid-tx → WAL recovery preserves only
  committed data.
- Receipt idempotency: `(scope, operation, operationId)` key; canonical
  fingerprint replay; `OPERATION_CONFLICT` on payload drift; no duplicate
  effects at store and registry-dispatch levels; rejected receipts
  intentionally not persisted (retry may re-execute) — documented design.
- Content snapshot durability: tmp-residue and orphan final-path files are
  never served; every read re-verifies SHA-256; `artifact.publish` is atomic
  (file+blob+pin) and rejects digest drift.
- GC: pending/unknown executions' pins, outstanding deliveries, referenced
  content are protected; unreferenced content is collected; re-run is
  idempotent; failed deletions become `unknown`-state `effect_intents`
  residues, never silent.
- Backup/restore: `sqlite3_serialize` consistent image incl. WAL-resident
  data; self-verifying manifest binding every file's digest; restore marks
  all executions `unverifiable` and stamps provenance; all ten corrupted/
  unsafe cases (c1–c10) rejected pre-write.

## notExecuted / blocked

- `task.report`, `outcome.decide`, `execution.wake`, `task.dispatch` are not
  registered in this composition (IMP-21 not landed) → the report+settlement
  dispatch boundary could not be driven end-to-end; covered at storage level
  instead (`1j` — outcome+settlement roll back together).
- No product fault-injection hook exists by design; injection used the deps
  seam + OS faults as described — no code was edited.
- `runtime.status/reconcile/shutdown`, schema-mismatch migrations beyond
  `assertReadableSchema`, and multi-host restore fan-out were out of this
  task's listed steps (VER-08 territory).

## defects — for the IMP owner (IMP-29)

### DEFECT-1 — `backup.restore` writes external blobs to the wrong path; restored external content is unreadable

- **Where:** `packages/mahas-runtime/src/operations/restore.ts` —
  `restoreContent`/`copyVerified` (lines ~378-402): `destName = c.digest` →
  `atomicWriteBytes(join(blobTargetDir, destName), bytes)` places the file at
  `<root>/<digest>` (flat). But `content_blobs.external_ref` (written by
  `putExternalContentBlob`, `storage/blob-store.ts:133`) is the sharded path
  `<digest[0:2]>/<digest>`, and `getContentBlob` resolves
  `join(storeRoot, external_ref)` — so the restored row points at
  `<root>/<shard>/<digest>` while the bytes sit at `<root>/<digest>`.
- **Observed:** `getContentBlob(restoredDb, digest)` →
  `ENOENT …/restored/blobs/bf/bfd74a…` while
  `…/restored/blobs/bfd74a…` exists. `restoredBlobs=1`, `warnings=[]` — the
  op reports success while the content is unreachable.
- **Contract:** `spec/contracts/recovery-operations.md` `backup.restore`
  "DB/content 복원" — restored content must be usable; currently it is not
  for any `external_ref` blob.
- **Repro:** `node /tmp/mahas-ver-02/harness/s5.ts` → check
  `5b restored external blob readable via row external_ref` (fails);
  `evidence/VER-02/results/s5-backup-restore.json`, artifact paths recorded
  in the check's `extra`. Live state at `/tmp/mahas-ver-02/s5/restored/blobs/`.
- **Suggested direction:** restore through the same shard layout as
  `putExternalContentBlob` (`<digest[0:2]>/<digest>`), or republish via that
  helper.

### DEFECT-2 — GC `planOrphanBlobFiles` enumerates shard directories, not blob files

- **Where:** `packages/mahas-runtime/src/operations/gc.ts` —
  `planOrphanBlobFiles` (lines ~386-425): `readdirSync(externalBlobDir)`
  lists only the top level, which contains shard *directories* (`aa`, `b5`,
  `d5`, `11`…), never the blob files under them. `collectOne` then
  `unlinkSync(join(externalBlobDir, id))` (line ~478) on a directory →
  `EISDIR`.
- **Observed:** plan candidates included `orphan_external_blob_files:11 /
  :aa / :d5` (directory names); every deletion failed EISDIR and was
  persisted as a retryable residue + `effect_intents` row (3 rows, re-created
  on every run → permanent residue churn). Meanwhile a real orphan file at
  `aa/aaaa…` was never discovered and survived the run
  (`fileExists=true`) — orphan external blobs are never actually collected.
- **Contract:** `spec/storage.md` §7 — policy retention cleanup must actually
  collect orphans; bogus candidates + perpetual residues are neither
  collection nor honest protection.
- **Repro:** `node /tmp/mahas-ver-02/harness/s4.ts` → checks
  `4d orphan enumeration behavior on shard dirs`,
  `4r GC residue recorded for failed deletions`,
  `4r orphan file under shard dir`; `evidence/VER-02/results/s4-gc-retention.json`.
- **Suggested direction:** recurse into the two-level shard layout
  (`<shard>/<digest>`), skip dotfiles/`.tmp`, and compare file *names* to the
  `external_ref` basenames (or the stored digests).

## observations (recorded, not defects)

- `openControlDb` on a chmod-protected DB with readable `-shm`/`-wal` opens
  via SQLite's read-only fallback (s1 `1i`); without `-shm` it throws
  (s1i). All writes still fail loudly — no unverified-write path.
- `validateSnapshot`'s read-only open creates `-shm`/`-wal` auxiliary files
  inside the backup set dir when the dir is writable (image bytes
  unaffected; only `control.sqlite` is digest-bound). Minor hygiene note —
  verification-side file creation inside "immutable" evidence.
- `makeCaller`-internal ops mint fresh operationIds — client idempotency is
  intentionally per outer request (registry.ts:267 note).
- GC correctly collects a *referenced-then-unreferenced* external blob via
  the manifest-row path (`collectOne` unlinks `join(dir, external_ref)`) —
  only the orphan-discovery path (DEFECT-2) is broken.

## evidenceRefs

- `evidence/VER-02/harness/` — all harness sources (`common.ts`,
  `s0-smoke.ts`, `s1.ts`, `s1-child.ts`, `s1i.ts`, `s2.ts`, `s3.ts`, `s4.ts`,
  `s5.ts`); run as `node <file>.ts` from that dir.
- `evidence/VER-02/results/` — per-check JSON:
  `s0-smoke.json` (8/8), `s1-fault-injection.json` (35/36),
  `s1i-readonly.json` (1/1), `s2-idempotency.json` (24/24),
  `s3-blob-durability.json` (13/13), `s4-gc-retention.json` (25/25),
  `s5-backup-restore.json` (41/42).
- `evidence/VER-02/manifest-sample.json` — a real `backup.create` manifest
  (consistency point, content/artifact/host entries, self-digest).
- Live state (large/binary, kept out of the repo): `/tmp/mahas-ver-02/`
  — `s1/`…`s5/` DBs incl. crash-recovery `s1/h.sqlite`, read-only `s1i/`,
  GC store `s4/gc.sqlite`+`s4/blobs/`, backup sets `s5/backups/`, restored
  target `s5/restored/`, interrupted blob `s3/blobs/1d/.*.deadbeef.tmp`,
  and `results/*.json` originals.
