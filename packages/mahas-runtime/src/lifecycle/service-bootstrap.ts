// mahas-runtime / lifecycle — mahasd service-entrypoint bootstrap.
//
// spec/execution-lifecycle.md §5 is the normative source:
//   * the endpoint file carries {protocolVersion, serviceId, pid, birth
//     evidence, bootId when available, launchNonce, endpointIncarnation};
//   * it is published by exclusive create → temp file → atomic rename, and
//     removed ONLY when the file's identity still equals ours;
//   * a stale PID file never justifies a kill, and missing platform birth
//     evidence is 'unverifiable', never silently 'dead';
//   * a live same-service endpoint with a different protocolVersion is a
//     diagnostic requiring explicit upgrade — never a reason to spawn a
//     second daemon next to it;
//   * crash-loop admission throttles on RECENT BOOT FAILURES — operational
//     protection, not a work retry policy.
//
// The single-writer guarantee comes from an exclusive-create lock file held
// open for the process lifetime — NOT from the endpoint file (that file is
// how clients find us; the lock is how writers exclude each other).

import { open, readFile, rename, unlink, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { createReadStream, readFileSync } from 'node:fs'
import { hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { ProcessIdentity, ServiceEndpointFile } from './types.ts'

export const MAHASD_PROTOCOL_VERSION = 0
export const SERVICE_ID = 'mahasd'

// ---------------------------------------------------------------------------
// process identity + death evidence
// ---------------------------------------------------------------------------

/** Linux boot id — absent on other platforms (unverifiable, not fatal) */
export function readBootId(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** Linux /proc/<pid>/stat field 22 (starttime ticks) — birth evidence for this pid */
export function readProcessBirthEvidence(pid: number): string | undefined {
  if (platform() !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return undefined
    const fields = stat.slice(close + 2).split(' ')
    // fields[0] is field 3 (state); field 22 → index 19
    return fields[19] || undefined
  } catch {
    return undefined
  }
}

export function collectProcessIdentity(pid = process.pid, startedAt = Date.now()): ProcessIdentity {
  return {
    pid,
    birthEvidence: readProcessBirthEvidence(pid),
    bootId: readBootId(),
    hostname: hostname(),
    startedAt
  }
}

export type ProcessVerdict = 'alive' | 'dead' | 'unverifiable'

/**
 * Is the recorded identity's process alive NOW? pid-alive is checked with
 * signal 0; when birth evidence exists for both sides it must also match —
 * a reused pid is NOT the same process. No evidence → 'unverifiable'
 * (spec: missing platform birth evidence is unverifiable, never assumed).
 */
export function verdictForProcess(identity: ProcessIdentity): ProcessVerdict {
  let pidAlive: boolean
  try {
    process.kill(identity.pid, 0)
    pidAlive = true
  } catch (err) {
    pidAlive = (err as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (!pidAlive) return 'dead'
  const currentBirth = readProcessBirthEvidence(identity.pid)
  if (identity.birthEvidence && currentBirth) {
    return identity.birthEvidence === currentBirth ? 'alive' : 'dead' // same pid, different birth = reuse
  }
  if (identity.bootId) {
    const boot = readBootId()
    if (boot && boot !== identity.bootId) return 'dead' // recorded process predates this boot
  }
  return 'unverifiable' // pid answers but we cannot prove it is the same birth
}

// ---------------------------------------------------------------------------
// single-writer lock
// ---------------------------------------------------------------------------

export interface ServiceLock {
  path: string
  identity: ProcessIdentity
  release: () => Promise<void>
}

export class BootstrapError extends Error {
  readonly code:
    'LOCK_HELD' | 'LOCK_UNVERIFIABLE' | 'VERSION_MISMATCH' | 'ALREADY_RUNNING' | 'CRASH_LOOP' | 'IO'
  readonly detail?: unknown
  constructor(code: BootstrapError['code'], message: string, detail?: unknown) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

interface LockFileBody {
  service: string
  protocolVersion: number
  pid: number
  processIdentity: ProcessIdentity
  acquiredAt: number
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Acquire the single-writer lock. Existence = held; we keep the fd open so
 * the lock dies with the process even if unlink never runs.
 * A prior lock whose owner is provably dead is STALE — removed, never
 * signalled. A lock whose owner is alive is a hard refusal; unverifiable is
 * also a refusal (we do not take over on a guess).
 */
export async function acquireServiceLock(
  lockPath: string,
  protocolVersion: number,
  identity = collectProcessIdentity()
): Promise<ServiceLock> {
  await mkdir(dirname(lockPath), { recursive: true })
  const body: LockFileBody = {
    service: SERVICE_ID,
    protocolVersion,
    pid: identity.pid,
    processIdentity: identity,
    acquiredAt: Date.now()
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath, 'wx')
      await fh.writeFile(JSON.stringify(body, null, 2))
      let released = false
      return {
        path: lockPath,
        identity,
        release: async () => {
          if (released) return
          released = true
          await fh.close().catch(() => {})
          // remove only while it is still OUR file — never unlink a
          // successor's lock (spec §5 cleanup identity check)
          const current = await readJsonFile<LockFileBody>(lockPath)
          if (
            current?.pid === identity.pid &&
            current.processIdentity?.startedAt === identity.startedAt
          ) {
            await unlink(lockPath).catch(() => {})
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new BootstrapError('IO', `cannot create lock ${lockPath}: ${String(err)}`)
      }
    }
    const existing = await readJsonFile<LockFileBody>(lockPath)
    if (!existing?.processIdentity) {
      // unreadable/garbage lock — not proof of a live writer; treat as stale
      await unlink(lockPath).catch(() => {})
      continue
    }
    if (existing.protocolVersion !== protocolVersion) {
      const v = verdictForProcess(existing.processIdentity)
      if (v === 'alive' || v === 'unverifiable') {
        throw new BootstrapError(
          'VERSION_MISMATCH',
          `existing mahasd at ${lockPath} runs protocolVersion ${existing.protocolVersion} ` +
            `(ours ${protocolVersion}); explicit upgrade/diagnosis required — refusing to ` +
            `start a second daemon beside it`,
          { existing }
        )
      }
      // dead prior lock of a different version — stale, removable
      await unlink(lockPath).catch(() => {})
      continue
    }
    const v = verdictForProcess(existing.processIdentity)
    if (v === 'alive') {
      throw new BootstrapError(
        'ALREADY_RUNNING',
        `mahasd already running (pid ${existing.pid}, lock ${lockPath})`,
        { existing }
      )
    }
    if (v === 'unverifiable') {
      throw new BootstrapError(
        'LOCK_UNVERIFIABLE',
        `lock holder pid ${existing.pid} answers but birth evidence cannot be ` +
          `verified — refusing to take over on a guess`,
        { existing }
      )
    }
    await unlink(lockPath).catch(() => {}) // provably dead → stale lock
  }
  throw new BootstrapError('IO', `could not acquire service lock ${lockPath}`)
}

// ---------------------------------------------------------------------------
// endpoint file publication (tmp + atomic rename; cleanup only if still ours)
// ---------------------------------------------------------------------------

export function buildEndpointFile(
  endpoint: string,
  protocolVersion: number,
  identity: ProcessIdentity,
  launchNonce: string
): ServiceEndpointFile {
  return {
    service: SERVICE_ID,
    protocolVersion,
    serviceId: `${SERVICE_ID}-${identity.pid}`,
    pid: identity.pid,
    processIdentity: identity,
    launchNonce,
    endpointIncarnation: randomUUID(),
    endpoint,
    publishedAt: Date.now()
  }
}

/**
 * Publish the endpoint document ATOMICALLY at `path` (the service's
 * `<configDir>/<service>.endpoint.json` convention — never the socket path:
 * renaming a JSON document over the socket would replace the listener's
 * inode with a regular file).
 */
export async function publishEndpointFile(path: string, file: ServiceEndpointFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  // exclusive create on the temp, then atomic rename onto the public name
  const fh = await open(tmp, 'wx')
  try {
    await fh.writeFile(JSON.stringify(file, null, 2))
  } finally {
    await fh.close()
  }
  await rename(tmp, path)
}

export function readEndpointFile(path: string): Promise<ServiceEndpointFile | null> {
  return readJsonFile<ServiceEndpointFile>(path)
}

/** unlink only when the file on disk still carries OUR incarnation */
export async function removeEndpointFile(
  path: string,
  endpointIncarnation: string
): Promise<boolean> {
  const current = await readEndpointFile(path)
  if (!current) return false
  if (current.endpointIncarnation !== endpointIncarnation) return false
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

/**
 * What does an existing endpoint file mean for a new start?
 * 'live-service' → someone is there (same protocol); 'version-mismatch' →
 * someone is there on another protocol; 'stale' → recorded owner is dead
 * and the file may be replaced; 'unverifiable' → refuse to decide blindly.
 */
export function assessExistingService(
  file: ServiceEndpointFile | null,
  ownProtocolVersion: number
): 'absent' | 'live-service' | 'version-mismatch' | 'stale' | 'unverifiable' {
  if (!file) return 'absent'
  const v = verdictForProcess(file.processIdentity)
  if (v === 'dead') return 'stale'
  if (v === 'unverifiable') return 'unverifiable'
  return file.protocolVersion === ownProtocolVersion ? 'live-service' : 'version-mismatch'
}

// ---------------------------------------------------------------------------
// crash-loop admission (operational protection, NOT a work retry policy)
// ---------------------------------------------------------------------------

export interface CrashLoopPolicy {
  windowMs: number
  maxFailures: number
}

export const DEFAULT_CRASH_LOOP: CrashLoopPolicy = { windowMs: 120_000, maxFailures: 5 }

interface BootJournalEntry {
  t: 'boot' | 'ready' | 'stopped'
  bootId: string
  pid: number
  at: number
}

async function readJournal(path: string): Promise<BootJournalEntry[]> {
  const out: BootJournalEntry[] = []
  try {
    const rl = createInterface({ input: createReadStream(path), terminal: false })
    for await (const line of rl) {
      try {
        const e = JSON.parse(line) as BootJournalEntry
        if (e && typeof e.at === 'number') out.push(e)
      } catch {
        /* torn last line is normal after a crash — ignore */
      }
    }
  } catch {
    /* no journal yet */
  }
  return out
}

export async function recordBootMarker(
  journalPath: string,
  t: BootJournalEntry['t'],
  bootId: string
): Promise<void> {
  await mkdir(dirname(journalPath), { recursive: true })
  const entry: BootJournalEntry = { t, bootId, pid: process.pid, at: Date.now() }
  await appendFile(journalPath, JSON.stringify(entry) + '\n')
}

/**
 * Admit or refuse this start based on recent boot failures. A 'boot' marker
 * with no following 'ready'/'stopped' inside the window counts as a failed
 * boot — the process died before publishing readiness.
 */
export async function checkCrashLoop(
  journalPath: string,
  policy: CrashLoopPolicy = DEFAULT_CRASH_LOOP,
  now = Date.now()
): Promise<{ admit: boolean; recentFailures: number }> {
  const entries = await readJournal(journalPath)
  const since = now - policy.windowMs
  const settled = new Set<string>()
  const boots: BootJournalEntry[] = []
  for (const e of entries) {
    if (e.t === 'boot' && e.at >= since) boots.push(e)
    if ((e.t === 'ready' || e.t === 'stopped') && e.at >= since) settled.add(e.bootId)
  }
  const failures = boots.filter((b) => !settled.has(b.bootId)).length
  // journal hygiene: keep the file bounded so a long-lived host does not grow it
  if (entries.length > 200) {
    const keep = entries.slice(-100)
    await writeFile(journalPath, keep.map((e) => JSON.stringify(e) + '\n').join('')).catch(() => {})
  }
  return { admit: failures < policy.maxFailures, recentFailures: failures }
}

// ---------------------------------------------------------------------------
// conventional paths
// ---------------------------------------------------------------------------

export function lifecyclePaths(configDir: string): {
  lock: string
  endpointFile: string
  socket: string
  bootJournal: string
  db: string
} {
  return {
    lock: join(configDir, 'mahasd.lock'),
    endpointFile: join(configDir, 'mahasd.endpoint.json'),
    socket: join(configDir, 'mahasd.sock'),
    bootJournal: join(configDir, 'mahasd-boots.log'),
    db: join(configDir, 'mahas.sqlite')
  }
}

export { randomUUID }
