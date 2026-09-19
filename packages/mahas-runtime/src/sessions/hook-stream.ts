// sessions/hook-stream.ts — the daemon-side reader for the normalized hook
// NDJSON stream (spec: the `hook-stream` collection source).
//
// The transport (builtin.harness-runtime → hooks/mahas-hook.cjs) appends one
// normalized AgentHookEvent per line to a plain file. The desktop tails the
// same file and pushes batches through `session.hook.ingest`; this reader is
// the daemon-lifetime alternative, for the case where no desktop is attached.
// It is deliberately independent of the desktop and of any harness: it parses
// NOTHING provider-specific, it only moves complete lines into the same atomic
// commit path (`commitHookRecords`) that desktop delivery uses.
//
// The properties this module owns:
//
//   · BOUNDED — one pass reads at most `maxBytes` plus a 4 KiB prefix and emits at most
//     `maxRecords`, so a huge or hot log cannot stall the daemon or blow the
//     ingest request contract (512 records / 2 MiB).
//   · DURABLE CURSOR — the position lives in the collection cursor
//     (`getCollectionCursor`), written in the SAME transaction as the events.
//     A crash re-reads uncommitted lines instead of losing them, and only this
//     reader ever advances the position (desktop requests omit the checkpoint).
//   · COMPLETE NEWLINES ONLY — a record exists only once its terminating
//     newline is present. A partial trailing line stays uncommitted and is
//     re-read (whole) on the next pass; nothing is buffered across passes, so
//     the offset after a normal commit is the START byte of the next unread
//     line. Oversized lines advance with a durable skipUntilNewline flag;
//     continuation bytes are discarded even across restarts.
//   · ROTATION/TRUNCATION — the position carries the file identity
//     (dev:ino:birthtimeMs), a bounded prefix fingerprint and a record generation.
//     Changed prefix bytes detect same-inode rewrites even after they grow
//     beyond the old offset. A reset clears the offset and discard flag.
//   · MALFORMED COMPLETE LINES ARE A GAP, NOT A STALL — a line that is not a
//     normalized event is skipped with an error diagnostic; the commit is a
//     partial batch with explicit gap coverage. The same holds for a single
//     line larger than `maxBytes` (bounded scan, warning diagnostic).
//   · A MISSING FILE PRESERVES HISTORY — no cursor is written, nothing is
//     deleted; when the file reappears the reader resumes from the stored
//     position and reads whatever was appended meanwhile.
//
// File IO never runs inside a database callback: the pass reads the cursor
// through the injected `database()` admission queue, does its file work
// outside it, and only then re-enters the queue to commit events + cursor
// atomically. The commit proves the position it read is still current with
// `expectedRevision` (CAS), so a concurrent writer can never be overwritten.

import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, type Stats } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CollectionDiagnostic } from '../../../mahas-contracts/src/metering/index.ts'
import type {
  AgentHookEvent,
  AgentHookIngestRecord,
  AgentHookIngestRequest,
  AgentHookIngestResult
} from '../../../mahas-contracts/src/operations/hooks.ts'
import {
  CollectionCheckpointConflict,
  getCollectionCursor
} from '../observation/collection/commit.ts'
import { commitHookRecords, hookCollectionSourceId, type HookCheckpoint } from './hook-ingest.ts'

const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_RECORDS = 256
/** the ingest request contract rejects batches beyond these bounds */
const REQUEST_MAX_BYTES = 2 * 1024 * 1024
const REQUEST_MAX_RECORDS = 512
/** Fixed overhead for detecting in-place rewrites; independent of log size. */
const PREFIX_MAX_BYTES = 4096
const NEWLINE = 0x0a

/** Stable file identity — a rotated or replaced file gets a new one. */
export type HookStreamFileIdentity = {
  dev: string
  ino: string
  birthtimeMs: number | null
}

/** Durable position; an offset inside an oversized line always carries the discard flag. */
export type HookStreamPosition = {
  offset: number
  /** increments on rotation/truncation so equal offsets cannot collide */
  generation: number
  dev?: string
  ino?: string
  birthtimeMs?: number | null
  /** Hash only this many bytes on the next pass, even if an append grew the prefix. */
  prefixLength?: number
  prefixHash?: string
  skipUntilNewline?: boolean
}

export type HookStreamTickOutcome =
  /** complete lines were committed (possibly with gap diagnostics) */
  | 'committed'
  /** nothing new (or only an incomplete trailing line) — the cursor stays put */
  | 'idle'
  /** the stream file is absent; stored history and cursor are untouched */
  | 'missing'
  /** another writer advanced the cursor first — the next pass re-reads it */
  | 'conflict'
  /** an unexpected failure; the cursor was not advanced */
  | 'error'

export interface HookStreamTickResult {
  outcome: HookStreamTickOutcome
  /** committed cursor offset after this pass (the previous offset when idle) */
  offset: number
  generation: number
  /** normalized records handed to the daemon */
  records: number
  /** gap diagnostics committed with this batch (malformed / oversized lines) */
  diagnostics: number
  /** verdict of `session.hook.ingest` when a commit ran */
  result?: AgentHookIngestResult
  /** the commit was a partial batch with explicit gap coverage */
  partial?: boolean
  error?: string
}

export interface HookStreamReaderOptions {
  db: DatabaseSync
  machineId: string
  /** the NDJSON stream (`<configDir>/agent-events.log`) */
  path: string
  /** admission's per-connection queue (serializeDatabase) — the same seam the scheduler uses */
  database<T>(work: () => T | Promise<T>): Promise<T>
  /**
   * The registered Pack revision that decodes this stream, pinned on every
   * batch. Omitted, the commit records the generic normalized-hook-stream
   * decoder (`mahas.normalized-hook-stream@2`); production composition passes
   * the resolved revision (e.g. `builtin.harness-runtime@2`).
   */
  adapterPack?: { id: string; revision: number }
  /** Pack-declared resume support shared with desktop ingestion. */
  harnessResume?: { hasResumeRecipe(harnessId: string): boolean }
  log?(line: Record<string, unknown>): void
  intervalMs?: number
  maxBytes?: number
  maxRecords?: number
  now?(): number
}

export function hookStreamFileIdentity(stat: Stats): HookStreamFileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeMs: Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : null
  }
}

/** Source generation string: file identity, not a counter that can be reset. */
export function hookStreamGeneration(identity: HookStreamFileIdentity): string {
  return `file:${identity.dev}:${identity.ino}:${identity.birthtimeMs ?? 0}`
}

/**
 * Canonical record key: path + START byte offset + sha256(raw) — the same
 * derivation `commitHookRecords` uses for its stored record identity, so the
 * key this reader sends, the key the daemon echoes back and the key on the
 * stored facet are one value.
 *
 * Generation counters are deliberately absent. The desktop tail and this
 * reader compute the same key for the same line, so the same event cannot be
 * committed twice no matter which producer got there first; and because the
 * key pins the content digest, a generation counter that restarts after a
 * rotation cannot make old content look new. Identical content at the same
 * offset IS the same record — replay dedups on purpose. (The commit re-derives
 * this id from `path`/`offset`/`raw`, so a producer that formats its key
 * differently still cannot double-commit a line.)
 */
export function canonicalHookRecordKey(path: string, offset: number, raw: string): string {
  return createHash('sha256')
    .update(JSON.stringify([resolve(path), offset, raw]))
    .digest('hex')
}

/** A line is ingestable only when it is a normalized event the contract accepts. */
function parseHookEvent(raw: string): AgentHookEvent | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  if (typeof event['provider'] !== 'string' || !event['provider']) return null
  if (typeof event['event'] !== 'string') return null
  return value as AgentHookEvent
}

interface ReadPosition {
  offset: number
  generation: number
  identity: HookStreamFileIdentity | null
  prefix: { length: number; hash: string } | null
  skipUntilNewline: boolean
}

/** Positions written by this reader carry identity; a foreign shape is trusted by offset only. */
function readPosition(value: unknown): ReadPosition | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const offset = row['offset']
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null
  const generation = row['generation']
  const dev = row['dev']
  const ino = row['ino']
  const birthtimeMs = row['birthtimeMs']
  const prefixLength = row['prefixLength']
  const prefixHash = row['prefixHash']
  const identity =
    typeof dev === 'string' && typeof ino === 'string'
      ? { dev, ino, birthtimeMs: typeof birthtimeMs === 'number' ? birthtimeMs : null }
      : null
  return {
    offset,
    generation:
      typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 1
        ? generation
        : 1,
    identity,
    prefix:
      typeof prefixLength === 'number' &&
      Number.isSafeInteger(prefixLength) &&
      prefixLength >= 0 &&
      prefixLength <= PREFIX_MAX_BYTES &&
      typeof prefixHash === 'string'
        ? { length: prefixLength, hash: prefixHash }
        : null,
    skipUntilNewline: row['skipUntilNewline'] === true
  }
}

function sameIdentity(left: HookStreamFileIdentity, right: HookStreamFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
}

/**
 * Daemon-lifetime hook stream reader. One instance owns one stream path; the
 * composition root starts it with the daemon and stops it with the daemon.
 */
export class HookStreamReader {
  private readonly db: DatabaseSync
  private readonly machineId: string
  private readonly path: string
  private readonly database: <T>(work: () => T | Promise<T>) => Promise<T>
  private readonly adapterPack: { id: string; revision: number } | undefined
  private readonly harnessResume: HookStreamReaderOptions['harnessResume']
  private readonly log: (line: Record<string, unknown>) => void
  private readonly intervalMs: number
  private readonly maxBytes: number
  private readonly maxRecords: number
  private readonly now: () => number
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<HookStreamTickResult> | undefined
  private stopped = true
  private fileMissing = false

  constructor(options: HookStreamReaderOptions) {
    this.db = options.db
    this.machineId = options.machineId
    this.path = resolve(options.path)
    this.database = options.database
    this.adapterPack = options.adapterPack
    this.harnessResume = options.harnessResume
    this.log = options.log ?? (() => {})
    this.intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.maxBytes = Math.max(1, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, REQUEST_MAX_BYTES))
    this.maxRecords = Math.max(
      1,
      Math.min(options.maxRecords ?? DEFAULT_MAX_RECORDS, REQUEST_MAX_RECORDS)
    )
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  /** Resolves after the in-flight pass (including its commit) has finished. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.running?.catch(() => {})
  }

  /** One bounded pass. Concurrent callers share the pass already in flight. */
  tick(): Promise<HookStreamTickResult> {
    if (this.running) return this.running
    const running = this.pass().catch((error: unknown): HookStreamTickResult => ({
      outcome: 'error',
      offset: 0,
      generation: 0,
      records: 0,
      diagnostics: 0,
      error: error instanceof Error ? error.message : String(error)
    }))
    this.running = running.finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().finally(() => {
        if (!this.stopped) this.schedule(this.intervalMs)
      })
    }, delay)
    this.timer.unref?.()
  }

  private async pass(): Promise<HookStreamTickResult> {
    const sourceId = hookCollectionSourceId(this.machineId, this.path)
    // Read the cursor BEFORE any file work: the commit below proves this
    // revision is still current (CAS) instead of overwriting a newer position.
    const cursor = await this.database(() => getCollectionCursor(this.db, sourceId))
    const expectedRevision = cursor?.checkpointRevision ?? null
    const position = readPosition(cursor?.position)
    let fd: number
    try {
      fd = openSync(this.path, 'r')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      if (!this.fileMissing) this.log({ t: 'hook-stream.missing', path: this.path })
      this.fileMissing = true
      return {
        outcome: 'missing',
        offset: position?.offset ?? 0,
        generation: position?.generation ?? 0,
        records: 0,
        diagnostics: 0
      }
    }
    try {
      if (this.fileMissing) this.log({ t: 'hook-stream.recovered', path: this.path })
      this.fileMissing = false
      // Identity, prefix and data come from one descriptor, so a path rotation
      // cannot mix two files. All reads finish synchronously in readPass;
      // returning its promise closes the descriptor before the queued commit.
      return this.readPass(fd, position, expectedRevision)
    } finally {
      closeSync(fd)
    }
  }

  private async readPass(
    fd: number,
    position: ReadPosition | null,
    expectedRevision: number | null
  ): Promise<HookStreamTickResult> {
    const stat = fstatSync(fd)
    const identity = hookStreamFileIdentity(stat)
    const generation = hookStreamGeneration(identity)
    const prefix = this.read(fd, 0, Math.min(stat.size, PREFIX_MAX_BYTES))
    const prefixChanged =
      position?.prefix != null &&
      createHash('sha256').update(prefix.subarray(0, position.prefix.length)).digest('hex') !==
        position.prefix.hash
    const rotated =
      position !== null &&
      ((position.identity !== null && !sameIdentity(position.identity, identity)) ||
        stat.size < position.offset ||
        prefixChanged)
    const start = rotated ? 0 : Math.min(position?.offset ?? 0, stat.size)
    const recordGeneration = Math.max(1, (position?.generation ?? 0) + (rotated ? 1 : 0))
    if (rotated) {
      this.log({
        t: 'hook-stream.rotated',
        path: this.path,
        generation: recordGeneration,
        reason:
          position.identity !== null && !sameIdentity(position.identity, identity)
            ? 'replaced'
            : prefixChanged
              ? 'rewritten'
              : 'truncated'
      })
    }
    if (stat.size <= start) {
      return {
        outcome: 'idle',
        offset: start,
        generation: recordGeneration,
        records: 0,
        diagnostics: 0
      }
    }

    const length = Math.min(stat.size - start, this.maxBytes)
    const window = this.read(fd, start, length)
    if (!window.length) {
      return {
        outcome: 'idle',
        offset: start,
        generation: recordGeneration,
        records: 0,
        diagnostics: 0
      }
    }
    const skipping = !rotated && position?.skipUntilNewline === true
    if (skipping) {
      const newline = window.indexOf(NEWLINE)
      return this.commitOversized({
        start,
        identity,
        generation,
        prefix,
        expectedRevision,
        recordGeneration,
        nextOffset: start + (newline === -1 ? window.length : newline + 1),
        skipUntilNewline: newline === -1
      })
    }
    const lastNewline = window.lastIndexOf(NEWLINE)
    if (lastNewline === -1) {
      if (window.length < this.maxBytes) {
        // A record exists only once its newline is present. The trailing bytes
        // are NOT buffered: the next pass re-reads them from `start`.
        return {
          outcome: 'idle',
          offset: start,
          generation: recordGeneration,
          records: 0,
          diagnostics: 0
        }
      }
      return this.commitOversized({
        start,
        identity,
        generation,
        prefix,
        expectedRevision,
        recordGeneration,
        nextOffset: start + window.length,
        skipUntilNewline: true
      })
    }

    const diagnostics: CollectionDiagnostic[] = []
    const records: AgentHookIngestRecord[] = []
    let consumed = 0
    while (consumed <= lastNewline) {
      const newline = window.indexOf(NEWLINE, consumed)
      const raw = window.toString('utf8', consumed, newline).trim()
      if (raw) {
        if (records.length >= this.maxRecords) break
        const offset = start + consumed
        const event = parseHookEvent(raw)
        if (event) {
          records.push({
            sourceRecordKey: canonicalHookRecordKey(this.path, offset, raw),
            offset,
            generation: recordGeneration,
            raw,
            event
          })
        } else {
          // A malformed COMPLETE line is consumed with an explicit gap: the
          // stream must not stall behind one bad line, and the raw bytes stay
          // in the file for a human to inspect.
          diagnostics.push({
            code: 'hook.invalid-record',
            severity: 'error',
            message: 'A complete hook line is not a normalized event and was skipped.',
            sourceRecordKey: canonicalHookRecordKey(this.path, offset, raw),
            position: { offset, generation: recordGeneration }
          })
        }
      }
      consumed = newline + 1
    }
    const nextOffset = start + consumed
    return await this.commit({
      start,
      nextOffset,
      identity,
      generation,
      prefix,
      skipUntilNewline: false,
      expectedRevision,
      recordGeneration,
      records,
      diagnostics
    })
  }

  /** Discard one bounded chunk and persist whether its terminating newline was seen. */
  private async commitOversized(args: {
    start: number
    nextOffset: number
    identity: HookStreamFileIdentity
    generation: string
    prefix: Buffer
    expectedRevision: number | null
    recordGeneration: number
    skipUntilNewline: boolean
  }): Promise<HookStreamTickResult> {
    const skipped = args.nextOffset - args.start
    const diagnostics: CollectionDiagnostic[] = [
      {
        code: 'hook.oversized-line',
        severity: 'warning',
        message: `Discarded ${skipped} bytes of an oversized hook line; ${args.skipUntilNewline ? 'still waiting for its newline' : 'newline reached'}.`,
        position: {
          offset: args.start,
          bytes: skipped,
          generation: args.recordGeneration,
          skipUntilNewline: args.skipUntilNewline
        }
      }
    ]
    this.log({
      t: 'hook-stream.oversized-line',
      path: this.path,
      offset: args.start,
      bytes: skipped
    })
    return await this.commit({
      ...args,
      records: [],
      diagnostics
    })
  }

  private async commit(args: {
    start: number
    nextOffset: number
    identity: HookStreamFileIdentity
    generation: string
    prefix: Buffer
    skipUntilNewline: boolean
    expectedRevision: number | null
    recordGeneration: number
    records: AgentHookIngestRecord[]
    diagnostics: CollectionDiagnostic[]
  }): Promise<HookStreamTickResult> {
    // Fingerprint committed bytes only. A short prefix can grow next time;
    // comparing its old length avoids treating an ordinary append as a reset.
    const prefix = args.prefix.subarray(0, args.nextOffset)
    const position: HookStreamPosition = {
      offset: args.nextOffset,
      generation: args.recordGeneration,
      dev: args.identity.dev,
      ino: args.identity.ino,
      birthtimeMs: args.identity.birthtimeMs,
      prefixLength: prefix.length,
      prefixHash: createHash('sha256').update(prefix).digest('hex'),
      skipUntilNewline: args.skipUntilNewline
    }
    const checkpoint: HookCheckpoint = {
      generation: args.generation,
      position,
      expectedRevision: args.expectedRevision,
      ...(args.diagnostics.length ? { diagnostics: args.diagnostics } : {})
    }
    const request: AgentHookIngestRequest = {
      source: {
        sourceKey: 'hook:' + this.path,
        kind: 'hook-stream',
        locator: { path: this.path },
        generation: args.generation
      },
      records: args.records
    }
    let result: AgentHookIngestResult
    try {
      result = await this.database(() =>
        commitHookRecords(this.db, {
          machineId: this.machineId,
          ...(this.adapterPack ? { adapterPack: this.adapterPack } : {}),
          ...(this.harnessResume ? { harnessResume: this.harnessResume } : {}),
          request,
          now: this.now(),
          checkpoint
        })
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof CollectionCheckpointConflict) {
        this.log({ t: 'hook-stream.conflict', path: this.path, error: message })
        return {
          outcome: 'conflict',
          offset: args.start,
          generation: args.recordGeneration,
          records: 0,
          diagnostics: 0,
          error: message
        }
      }
      this.log({ t: 'hook-stream.commit-failed', path: this.path, error: message })
      return {
        outcome: 'error',
        offset: args.start,
        generation: args.recordGeneration,
        records: 0,
        diagnostics: 0,
        error: message
      }
    }
    const partial = args.diagnostics.length > 0
    this.log({
      t: 'hook-stream.committed',
      path: this.path,
      offset: args.nextOffset,
      generation: args.recordGeneration,
      records: args.records.length,
      diagnostics: args.diagnostics.length,
      revision: args.expectedRevision === null ? 1 : args.expectedRevision + 1
    })
    return {
      outcome: 'committed',
      offset: args.nextOffset,
      generation: args.recordGeneration,
      records: args.records.length,
      diagnostics: args.diagnostics.length,
      result,
      ...(partial ? { partial: true } : {})
    }
  }

  /** One bounded read using the descriptor whose identity was checked. */
  private read(fd: number, offset: number, length: number): Buffer {
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, read)
  }
}
