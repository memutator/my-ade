// Hook stream reader fixtures — daemon-lifetime ingest of the normalized
// NDJSON hook stream, against a REAL migrated control DB (applyMigrations over
// CONTROL_MIGRATIONS) and throwaway temp-dir stream files. Nothing here reads
// the user's config, credentials or session logs.
//
// Covered acceptance cases:
//   · bounded pass, durable cursor written in the same commit as the events
//   · a partial trailing line is not committed and is re-read whole next pass
//   · rotation/truncation (same inode truncate, replaced file) resets the offset
//   · a malformed complete line becomes a gap diagnostic, not a stall
//   · a missing file preserves history and the stored position
//   · oversized single line: bounded scan, explicit gap
//   · stop() awaits the in-flight pass; conflict leaves the cursor alone
//   · the canonical key dedups the same line across producers/generations, and
//     the committed event is readable through the stored session queries
//   · session.hook.ingest without a checkpoint (desktop path) does not advance
//     the stream cursor
import assert from 'node:assert/strict'
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations, CONTROL_MIGRATIONS } from '../storage/migrations.ts'
import { getCollectionCursor } from '../observation/collection/commit.ts'
import { getSessionDetail, queryHarnessSessions, querySessionEvents } from './query.ts'
import { commitHookRecords, hookCollectionSourceId } from './hook-ingest.ts'
import {
  HookStreamReader,
  canonicalHookRecordKey,
  hookStreamGeneration,
  type HookStreamPosition
} from './hook-stream.ts'

const MACHINE = 'machine-hook-stream'
const root = mkdtempSync(join(tmpdir(), 'mahas-hook-stream-'))
const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys=ON')
applyMigrations(db, CONTROL_MIGRATIONS, 'control')

// The same admission serialization the composition root injects. A plain FIFO
// is enough here: the fixture never dispatches nested operations.
let queue: Promise<unknown> = Promise.resolve()
function database<T>(work: () => T | Promise<T>): Promise<T> {
  const run = queue.then(() => work())
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

const event = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 2,
    provider: 'claude',
    event: 'turn-complete',
    ts: 1_700_000_000_000,
    ...over
  })

let clock = 1_700_000_000_000
const now = (): number => ++clock

const stream = (name: string): string => join(root, name)

function reader(
  path: string,
  over: Partial<ConstructorParameters<typeof HookStreamReader>[0]> = {}
): HookStreamReader {
  return new HookStreamReader({
    db,
    machineId: MACHINE,
    path,
    database,
    now,
    log: () => {},
    ...over
  })
}

const cursor = (path: string): ReturnType<typeof getCollectionCursor> =>
  getCollectionCursor(db, hookCollectionSourceId(MACHINE, path))

const positionOf = (path: string): HookStreamPosition => {
  const value = cursor(path)?.position
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'cursor position must be stored'
  )
  return value as HookStreamPosition
}

const batches = (): number =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM collection_batches').get() as { n: number }).n)
const facets = (): number =>
  Number(
    (db.prepare('SELECT COUNT(*) AS n FROM observation_collection_facets').get() as { n: number }).n
  )
const coverageRows = (): Array<{ completeness: string; gap_reason: string | null }> =>
  db
    .prepare('SELECT completeness,gap_reason FROM collection_coverage ORDER BY rowid')
    .all() as Array<{
    completeness: string
    gap_reason: string | null
  }>

try {
  /* --------------------------------------------------- bounded pass + cursor */
  const basic = stream('basic.log')
  writeFileSync(
    basic,
    event({ sessionId: 's-basic' }) +
      '\n' +
      event({ sessionId: 's-basic', event: 'needs-input' }) +
      '\n'
  )
  const first = await reader(basic).tick()
  assert.equal(first.outcome, 'committed')
  assert.equal(first.records, 2)
  assert.equal(first.diagnostics, 0)
  assert.equal(first.result?.committed, true)
  assert.equal(
    first.offset,
    Buffer.byteLength(event({ sessionId: 's-basic' })) +
      1 +
      Buffer.byteLength(event({ sessionId: 's-basic', event: 'needs-input' })) +
      1
  )
  assert.equal(positionOf(basic).offset, first.offset)
  assert.equal(cursor(basic)?.checkpointRevision, 1)
  assert.equal(
    cursor(basic)?.sourceGeneration,
    hookStreamGeneration({
      dev: positionOf(basic).dev!,
      ino: positionOf(basic).ino!,
      birthtimeMs: (positionOf(basic) as { birthtimeMs?: number | null }).birthtimeMs ?? null
    })
  )
  assert.equal(cursor(basic)?.collectorRevision, 'mahas.hook-stream/v2')
  const afterFirst = batches()

  // nothing new — the cursor is not rewritten, no empty batch is stored
  const idle = await reader(basic).tick()
  assert.equal(idle.outcome, 'idle')
  assert.equal(idle.offset, first.offset)
  assert.equal(batches(), afterFirst)
  assert.equal(cursor(basic)?.checkpointRevision, 1)

  // maxRecords bounds one pass; the next pass continues at the committed cursor
  const idleLine = event({ sessionId: 's-basic', event: 'idle' })
  const errorLine = event({ sessionId: 's-basic', event: 'error' })
  appendFileSync(basic, idleLine + '\n' + errorLine + '\n')
  const bounded = await reader(basic, { maxRecords: 1 }).tick()
  assert.equal(bounded.outcome, 'committed')
  assert.equal(bounded.records, 1)
  assert.equal(bounded.offset, first.offset + Buffer.byteLength(idleLine) + 1)
  assert.equal(positionOf(basic).offset, bounded.offset)
  const drain = await reader(basic).tick()
  assert.equal(drain.records, 1)
  assert.equal(drain.outcome, 'committed')
  assert.equal(drain.offset, bounded.offset + Buffer.byteLength(errorLine) + 1)
  assert.equal(cursor(basic)?.checkpointRevision, 3)

  /* ------------------------------------------- partial trailing line re-read */
  const partial = stream('partial.log')
  const line = event({ sessionId: 's-partial' })
  writeFileSync(partial, line.slice(0, 20))
  const incomplete = await reader(partial).tick()
  assert.equal(incomplete.outcome, 'idle')
  assert.equal(incomplete.offset, 0)
  assert.equal(cursor(partial), null, 'an incomplete line must not create a cursor')
  appendFileSync(partial, line.slice(20) + '\n')
  const completed = await reader(partial).tick()
  assert.equal(completed.outcome, 'committed')
  assert.equal(completed.records, 1)
  assert.equal(completed.offset, Buffer.byteLength(line) + 1)
  assert.equal(positionOf(partial).generation, 1)

  /* ------------------------------------------------------- malformed complete */
  const malformed = stream('malformed.log')
  const good = event({ sessionId: 's-malformed' })
  writeFileSync(malformed, 'not json at all\n' + good + '\n' + '{"provider":"claude"}\n')
  const gap = await reader(malformed).tick()
  assert.equal(gap.outcome, 'committed')
  assert.equal(gap.records, 1)
  assert.equal(gap.diagnostics, 2)
  assert.equal(gap.partial, true)
  assert.equal(
    gap.offset,
    Buffer.byteLength('not json at all') +
      1 +
      Buffer.byteLength(good) +
      1 +
      Buffer.byteLength('{"provider":"claude"}') +
      1
  )
  assert.equal(cursor(malformed)?.checkpointRevision, 1)
  const malformedCoverage = coverageRows().at(-1)
  assert.equal(malformedCoverage?.completeness, 'gap')
  assert.equal(malformedCoverage?.gap_reason, 'malformed-or-truncated-hook-stream')
  const malformedDiagnostics = db
    .prepare('SELECT diagnostics_json FROM collection_batches ORDER BY rowid DESC LIMIT 1')
    .get() as { diagnostics_json: string }
  const parsedDiagnostics = JSON.parse(malformedDiagnostics.diagnostics_json) as Array<{
    code: string
  }>
  assert.deepEqual(
    parsedDiagnostics.map((d) => d.code),
    ['hook.invalid-record', 'hook.invalid-record']
  )

  /* -------------------------------------------------- truncation, same inode */
  const truncated = stream('truncated.log')
  writeFileSync(truncated, event({ sessionId: 's-truncate' }) + '\n')
  await reader(truncated).tick()
  const beforeTruncate = positionOf(truncated)
  truncateSync(truncated, 0)
  const replaced = event({ sessionId: 's-truncate', event: 'session-end' }) + '\n'
  writeFileSync(truncated, replaced)
  const afterTruncate = await reader(truncated).tick()
  assert.equal(afterTruncate.outcome, 'committed')
  assert.equal(afterTruncate.records, 1)
  assert.equal(afterTruncate.generation, beforeTruncate.generation + 1)
  assert.equal(positionOf(truncated).generation, beforeTruncate.generation + 1)
  assert.equal(
    positionOf(truncated).ino,
    beforeTruncate.ino,
    'truncate keeps the inode; the generation moves'
  )
  assert.equal(afterTruncate.offset, Buffer.byteLength(replaced))

  // A rewrite can overtake the old cursor before the next poll without ever
  // exposing a smaller size. Its changed prefix must still reset the reader.
  for (const extraBytes of [0, 5000]) {
    const rewritten = stream(`rewritten-${extraBytes}.log`)
    const original =
      event({ sessionId: `old-a-${extraBytes}` }) +
      '\n' +
      event({ sessionId: `old-b-${extraBytes}` }) +
      '\n'
    const replacement =
      event({ sessionId: `new-a-${extraBytes}` }) +
      '\n' +
      ' '.repeat(extraBytes) +
      event({ sessionId: `new-b-${extraBytes}` }) +
      '\n'
    writeFileSync(rewritten, original)
    await reader(rewritten).tick()
    const before = positionOf(rewritten)
    const sourceId = hookCollectionSourceId(MACHINE, rewritten)
    const oldIds = db
      .prepare('SELECT observation_id FROM observation_collection_facets WHERE source_id=?')
      .all(sourceId)
      .map((row) => String(row.observation_id))
    assert.equal(oldIds.length, 2)
    assert.equal(before.prefixLength, Math.min(4096, Buffer.byteLength(original)))
    assert.match(before.prefixHash!, /^[a-f0-9]{64}$/)
    writeFileSync(rewritten, replacement)
    assert.equal(String(statSync(rewritten).ino), before.ino)
    assert.ok(statSync(rewritten).size >= before.offset)
    const reset = await reader(rewritten).tick()
    assert.equal(reset.outcome, 'committed')
    assert.equal(
      reset.records,
      2,
      'a rewrite starts at byte zero even after growing past the old cursor'
    )
    assert.equal(reset.generation, before.generation + 1)
    assert.equal(reset.offset, Buffer.byteLength(replacement))
    const retainedIds = db
      .prepare('SELECT observation_id FROM observation_collection_facets WHERE source_id=?')
      .all(sourceId)
      .map((row) => String(row.observation_id))
    assert.equal(retainedIds.length, 4)
    assert.ok(
      oldIds.every((id) => retainedIds.includes(id)),
      'rewriting never erases the prior events'
    )
    const firstPayload = db
      .prepare(
        `SELECT o.payload_json FROM observations o
      JOIN observation_collection_facets f ON f.observation_id=o.id
      WHERE f.source_id=? AND json_extract(o.payload_json,'$.sessionId')=?`
      )
      .get(sourceId, `new-a-${extraBytes}`)
    assert.ok(firstPayload, 'the new beginning is ingested')
  }

  // Only compare the number of prefix bytes saved with the old checkpoint:
  // appending to a one-byte stream must not look like a rewrite.
  const shortPrefix = stream('short-prefix.log')
  writeFileSync(shortPrefix, '\n')
  await reader(shortPrefix).tick()
  assert.equal(positionOf(shortPrefix).prefixLength, 1)
  appendFileSync(
    shortPrefix,
    event({ sessionId: 'prefix-growth', message: 'x'.repeat(5000) }) + '\n'
  )
  const extendedPrefix = await reader(shortPrefix).tick()
  assert.equal(extendedPrefix.records, 1)
  assert.equal(extendedPrefix.generation, 1)
  assert.equal(positionOf(shortPrefix).prefixLength, 4096, 'the stored fingerprint remains bounded')

  /* ------------------------------------------------------------- rotation */
  const rotated = stream('rotated.log')
  writeFileSync(rotated, event({ sessionId: 's-rotate' }) + '\n')
  const beforeRotate = await reader(rotated).tick()
  const rotatedIno = positionOf(rotated).ino
  renameSync(rotated, rotated + '.1')
  writeFileSync(rotated, event({ sessionId: 's-rotate', event: 'error' }) + '\n')
  const afterRotate = await reader(rotated).tick()
  assert.equal(afterRotate.outcome, 'committed')
  assert.equal(afterRotate.records, 1, 'the new file is read from byte 0')
  assert.notEqual(positionOf(rotated).ino, rotatedIno)
  assert.equal(
    afterRotate.offset,
    Buffer.byteLength(event({ sessionId: 's-rotate', event: 'error' }) + '\n')
  )
  assert.ok(afterRotate.generation > beforeRotate.generation)

  /* ---------------------------------------------------------------- missing */
  const missing = stream('missing.log')
  writeFileSync(missing, event({ sessionId: 's-missing' }) + '\n')
  await reader(missing).tick()
  const missingRevision = cursor(missing)?.checkpointRevision
  rmSync(missing)
  const absent = await reader(missing).tick()
  assert.equal(absent.outcome, 'missing')
  assert.equal(
    cursor(missing)?.checkpointRevision,
    missingRevision,
    'a missing file preserves history'
  )
  appendFileSync(missing, event({ sessionId: 's-missing', event: 'idle' }) + '\n')
  const reappeared = await reader(missing).tick()
  assert.equal(reappeared.outcome, 'committed')
  assert.equal(reappeared.records, 1)

  const missingTransitions = stream('missing-transitions.log')
  const transitionLogs: Record<string, unknown>[] = []
  const missingReader = reader(missingTransitions, {
    log: (entry) => {
      transitionLogs.push(entry)
    }
  })
  for (let poll = 0; poll < 5; poll++) assert.equal((await missingReader.tick()).outcome, 'missing')
  assert.deepEqual(
    transitionLogs.map((entry) => entry.t),
    ['hook-stream.missing']
  )
  writeFileSync(missingTransitions, event({ sessionId: 'recovered' }) + '\n')
  assert.equal((await missingReader.tick()).records, 1)
  for (let poll = 0; poll < 5; poll++) await missingReader.tick()
  assert.equal(transitionLogs.filter((entry) => entry.t === 'hook-stream.recovered').length, 1)
  const beforeMissingAgain = cursor(missingTransitions)
  rmSync(missingTransitions)
  for (let poll = 0; poll < 5; poll++) await missingReader.tick()
  assert.equal(transitionLogs.filter((entry) => entry.t === 'hook-stream.missing').length, 2)
  assert.deepEqual(cursor(missingTransitions), beforeMissingAgain)

  /* ------------------------------------------------------------- oversized */
  const oversized = stream('oversized.log')
  const huge = '{"provider":"claude","event":"other","message":"' + 'x'.repeat(4096) + '"}'
  writeFileSync(oversized, huge + '\n' + event({ sessionId: 's-oversized' }) + '\n')
  let skipped = await reader(oversized, { maxBytes: 512 }).tick()
  assert.equal(skipped.outcome, 'committed')
  assert.equal(skipped.records, 0)
  assert.equal(skipped.diagnostics, 1)
  let skipOffset = 0
  while (positionOf(oversized).skipUntilNewline) {
    assert.ok(skipped.offset > skipOffset && skipped.offset - skipOffset <= 512)
    skipOffset = skipped.offset
    skipped = await reader(oversized, { maxBytes: 512 }).tick()
    assert.equal(skipped.outcome, 'committed')
    assert.equal(skipped.records, 0)
    assert.equal(skipped.diagnostics, 1)
  }
  assert.equal(skipped.offset, Buffer.byteLength(huge) + 1)
  const oversizedTail = await reader(oversized, { maxBytes: 512 }).tick()
  assert.equal(oversizedTail.records, 1, 'the pass after the gap reads the next line')
  assert.equal(skipped.generation, 1)

  // Cross the former 64 MiB scan cap, reach EOF inside a line, restart the
  // reader, then append a suffix that would parse as a standalone event.
  // That suffix belongs to the oversized line and must never become a record.
  const incompleteHuge = stream('incomplete-huge.log')
  writeFileSync(incompleteHuge, '')
  const chunkBytes = 1024 * 1024
  const fill = Buffer.alloc(chunkBytes, 'x')
  for (let chunk = 0; chunk < 65; chunk++) appendFileSync(incompleteHuge, fill)
  const hugeSize = statSync(incompleteHuge).size
  const beforeHuge = facets()
  let hugeOffset = 0
  for (let chunk = 0; chunk < 65; chunk++) {
    const step = await reader(incompleteHuge, { maxBytes: chunkBytes }).tick()
    assert.equal(step.outcome, 'committed')
    assert.equal(step.records, 0)
    assert.equal(step.diagnostics, 1)
    assert.equal(
      step.offset,
      hugeOffset + chunkBytes,
      'one pass reads only one bounded data window'
    )
    assert.equal(
      positionOf(incompleteHuge).skipUntilNewline,
      true,
      'discard mode survives reader restarts'
    )
    assert.equal(coverageRows().at(-1)?.completeness, 'gap')
    hugeOffset = step.offset
  }
  assert.equal(hugeOffset, hugeSize)
  const eofRevision = cursor(incompleteHuge)?.checkpointRevision
  assert.equal((await reader(incompleteHuge).tick()).outcome, 'idle')
  assert.equal(
    cursor(incompleteHuge)?.checkpointRevision,
    eofRevision,
    'waiting at EOF does not rescan or rewrite the gap'
  )
  const impostor = event({ sessionId: 'must-not-ingest' })
  const afterHuge = event({ sessionId: 'after-huge' })
  appendFileSync(incompleteHuge, impostor + '\n' + afterHuge + '\n')
  const discardSuffix = await reader(incompleteHuge).tick()
  assert.equal(discardSuffix.records, 0)
  assert.equal(discardSuffix.offset, hugeSize + Buffer.byteLength(impostor) + 1)
  assert.equal(positionOf(incompleteHuge).skipUntilNewline, false)
  assert.equal(facets(), beforeHuge, 'the JSON-looking continuation was never parsed')
  const completeAfterHuge = await reader(incompleteHuge).tick()
  assert.equal(completeAfterHuge.records, 1)
  assert.equal(completeAfterHuge.offset, statSync(incompleteHuge).size)
  assert.equal(facets(), beforeHuge + 1)

  // A pass that finds only blank lines still moves the position: consuming
  // them is real progress, so the next pass never re-scans them.
  const blank = stream('blank.log')
  writeFileSync(blank, '\n\n')
  const blanked = await reader(blank).tick()
  assert.equal(blanked.outcome, 'committed')
  assert.equal(blanked.records, 0)
  assert.equal(blanked.diagnostics, 0)
  assert.equal(blanked.offset, 2)
  assert.equal(positionOf(blank).offset, 2)

  /* --------------------------------------------------------------- conflict */
  const conflicting = stream('conflict.log')
  const conflictFirst = event({ sessionId: 's-conflict' })
  const conflictSecond = event({ sessionId: 's-conflict', event: 'error' })
  writeFileSync(conflicting, conflictFirst + '\n')
  await reader(conflicting).tick()
  // A foreign writer (desktop delivery) commits between the reader's cursor
  // read and its commit. The reader must not overwrite that position.
  const foreign = event({ sessionId: 's-conflict', event: 'idle' })
  let racingCalls = 0
  const racing = <T>(work: () => T | Promise<T>): Promise<T> => {
    racingCalls += 1
    if (racingCalls !== 2) return database(work)
    return database(async () => {
      await commitHookRecords(db, {
        machineId: MACHINE,
        request: {
          source: {
            sourceKey: 'hook:' + conflicting,
            kind: 'hook-stream',
            locator: { path: conflicting },
            generation: 'foreign'
          },
          records: [
            {
              sourceRecordKey: canonicalHookRecordKey(conflicting, 0, foreign),
              offset: 0,
              generation: 9,
              raw: foreign,
              event: JSON.parse(foreign) as never
            }
          ]
        },
        now: now(),
        checkpoint: {
          generation: 'foreign',
          position: { offset: 0, generation: 9 },
          expectedRevision: cursor(conflicting)?.checkpointRevision ?? null
        }
      })
      return await work()
    })
  }
  appendFileSync(conflicting, conflictSecond + '\n')
  const conflicted = await new HookStreamReader({
    db,
    machineId: MACHINE,
    path: conflicting,
    database: racing,
    now,
    log: () => {}
  }).tick()
  assert.equal(conflicted.outcome, 'conflict')
  assert.equal(positionOf(conflicting).offset, 0, 'the foreign position is not overwritten')
  assert.equal(positionOf(conflicting).generation, 9)
  const facetsAfterConflict = facets()
  const recovered = await reader(conflicting).tick()
  assert.equal(recovered.outcome, 'committed', 'the next pass re-reads the moved cursor')
  // The re-read line is the same content at the same offset, so it commits the
  // cursor without a second facet — only the new error line adds one.
  assert.equal(facets(), facetsAfterConflict + 1)
  assert.equal(
    positionOf(conflicting).offset,
    Buffer.byteLength(conflictFirst) + 1 + Buffer.byteLength(conflictSecond) + 1
  )

  /* ------------------------------------------------- dedup across producers */
  const dedup = stream('dedup.log')
  const shared = event({ sessionId: 's-dedup', message: 'same line, two producers' })
  writeFileSync(dedup, shared + '\n')
  const committedByReader = await reader(dedup).tick()
  assert.equal(committedByReader.records, 1)
  const facetsBefore = facets()
  // the desktop tail sends the identical line under its own generation counter
  await database(() =>
    commitHookRecords(db, {
      machineId: MACHINE,
      request: {
        source: {
          sourceKey: 'hook:' + dedup,
          kind: 'hook-stream',
          locator: { path: dedup },
          generation: 'ndjson-v2'
        },
        records: [
          {
            sourceRecordKey: canonicalHookRecordKey(dedup, 0, shared),
            offset: 0,
            generation: 1,
            raw: shared,
            event: JSON.parse(shared) as never
          }
        ]
      },
      now: now()
    })
  )
  assert.equal(
    facets(),
    facetsBefore,
    'the same content at the same offset dedups regardless of generation'
  )

  /* ------------------------------------------------- desktop path keeps cursor */
  const desktopOnly = stream('desktop-only.log')
  const desktopLine = event({ sessionId: 's-desktop', event: 'needs-input' })
  writeFileSync(desktopOnly, desktopLine + '\n')
  const desktopResult = await database(() =>
    commitHookRecords(db, {
      machineId: MACHINE,
      request: {
        source: {
          sourceKey: 'hook:' + desktopOnly,
          kind: 'hook-stream',
          locator: { path: desktopOnly },
          generation: 'ndjson-v2'
        },
        records: [
          {
            sourceRecordKey: canonicalHookRecordKey(desktopOnly, 0, desktopLine),
            offset: 0,
            generation: 1,
            raw: desktopLine,
            event: JSON.parse(desktopLine) as never
          }
        ]
      },
      now: now()
    })
  )
  assert.equal(desktopResult.committed, true)
  assert.equal(
    cursor(desktopOnly),
    null,
    'a desktop request without a checkpoint never advances the stream cursor'
  )
  const readerTakesOver = await reader(desktopOnly).tick()
  assert.equal(readerTakesOver.outcome, 'committed')
  assert.equal(readerTakesOver.records, 1)
  assert.equal(positionOf(desktopOnly).offset, Buffer.byteLength(desktopLine) + 1)

  /* -------------------------------------------- stored reads + no tasks/exec */
  const stored = queryHarnessSessions(db, { harnessId: 'claude', limit: 100 })
  const session = stored.items.find((s) => s.nativeSessionKey === 's-basic')
  assert.ok(session, 'the committed session is readable through the stored query')
  const detail = getSessionDetail(db, session.id)
  assert.ok(detail)
  const storedEvents = querySessionEvents(db, session.id).items
  assert.ok(
    storedEvents.some((e) => e.kind === 'turn-complete'),
    'the committed event is stored'
  )
  assert.ok(detail.handles.length > 0, 'the canonical hook handle is stored')
  assert.equal(
    detail.handles[0]?.resumeSupport,
    'unknown',
    'without a Pack declaration support stays unknown'
  )
  assert.equal(
    Number((db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }).n),
    0,
    'hook ingestion never creates an Execution'
  )
  assert.equal(
    Number((db.prepare('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n),
    0,
    'hook ingestion never creates a Dispatch/Task'
  )

  /* --------------------------------------------------------- child identity */
  const childStream = stream('child.log')
  const childLine = event({
    sessionId: 's-child',
    parentSessionId: 's-parent',
    child: true,
    internalRun: true
  })
  writeFileSync(childStream, childLine + '\n')
  await reader(childStream).tick()
  const child = queryHarnessSessions(db, { harnessId: 'claude', limit: 100 }).items.find(
    (s) => s.nativeSessionKey === 's-child'
  )
  const parent = queryHarnessSessions(db, { harnessId: 'claude', limit: 100 }).items.find(
    (s) => s.nativeSessionKey === 's-parent'
  )
  assert.ok(child && parent, 'child and parent rows both exist')
  assert.equal(child.parentSessionId, parent.id, 'the parent link is retained')
  const childDetail = getSessionDetail(db, child.id)
  assert.equal(
    childDetail?.handles[0]?.resumeSupport,
    'unsupported',
    'a child run never claims a resume handle'
  )
  const childPayload = querySessionEvents(db, child.id).items[0]?.payload as
    { child?: boolean; internalRun?: boolean } | undefined
  assert.equal(
    childPayload?.child,
    true,
    'child identity is preserved in the stored event, not stripped'
  )
  assert.equal(childPayload?.internalRun, true)

  /* --------------------------------------------------- lifecycle: start/stop */
  const live = stream('live.log')
  const liveReader = reader(live, { intervalMs: 25 })
  liveReader.start()
  appendFileSync(live, event({ sessionId: 's-live' }) + '\n')
  await new Promise((resolve) => setTimeout(resolve, 120))
  await liveReader.stop()
  assert.equal(
    cursor(live)?.checkpointRevision,
    1,
    'start() drains appended lines; stop() awaits the pass'
  )
  appendFileSync(live, event({ sessionId: 's-live', event: 'idle' }) + '\n')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(cursor(live)?.checkpointRevision, 1, 'a stopped reader commits nothing more')

  /* ------------------------------------------- adapter pack pin is recorded */
  const pinned = stream('pinned.log')
  writeFileSync(pinned, event({ sessionId: 's-pinned' }) + '\n')
  const resumeLookups: string[] = []
  await reader(pinned, {
    adapterPack: { id: 'builtin.harness-runtime', revision: 2 },
    harnessResume: {
      hasResumeRecipe: (harnessId) => {
        resumeLookups.push(harnessId)
        return harnessId === 'claude'
      }
    }
  }).tick()
  const pinnedBatch = db
    .prepare(
      'SELECT adapter_pack_id,adapter_pack_revision FROM collection_batches ORDER BY rowid DESC LIMIT 1'
    )
    .get() as { adapter_pack_id: string; adapter_pack_revision: number }
  assert.equal(pinnedBatch.adapter_pack_id, 'builtin.harness-runtime')
  assert.equal(pinnedBatch.adapter_pack_revision, 2)
  assert.deepEqual(resumeLookups, ['claude'])
  const supportedSession = queryHarnessSessions(db, { harnessId: 'claude', limit: 100 }).items.find(
    (s) => s.nativeSessionKey === 's-pinned'
  )
  assert.ok(supportedSession)
  assert.equal(
    getSessionDetail(db, supportedSession.id)?.handles[0]?.resumeSupport,
    'supported',
    'daemon-first ingestion persists Pack-declared resume support without a raw resumeSupport field'
  )

  console.log(
    'hook stream smoke: bounded pass, durable cursor, partial line, malformed gap, same-inode rewrites, prefix growth, rotation, missing transitions, oversized restart/continuation, conflict, dedup, desktop cursor, stored reads, lifecycle and Pack resume support passed'
  )
} finally {
  db.close()
  rmSync(root, { recursive: true, force: true })
}
