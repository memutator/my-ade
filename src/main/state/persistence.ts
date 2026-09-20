import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/** Serial atomic replacement, with a synchronous shutdown write fencing every
 * older queued/in-flight snapshot. A stale async write can never replace it. */
export class StatePersistence {
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0

  private readonly file: () => string

  constructor(file: () => string) {
    this.file = file
  }

  save(state: unknown): Promise<boolean> {
    const generation = this.generation
    const data = JSON.stringify(state)
    const operation = this.queue.then(async () => {
      if (generation !== this.generation) return false
      const file = this.file()
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 })
        if (generation !== this.generation) return false
        // No await between the generation check and rename: saveSync can run
        // while async I/O waits, but cannot interleave this final replacement.
        renameSync(temp, file)
        return true
      } catch {
        return false
      } finally {
        await unlink(temp).catch(() => {})
      }
    })
    this.queue = operation
    return operation
  }

  saveSync(state: unknown): boolean {
    this.generation++
    const file = this.file()
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, file)
      return true
    } catch {
      return false
    } finally {
      try {
        unlinkSync(temp)
      } catch {
        /* renamed or not created */
      }
    }
  }
}

/** Main, at beforeunload, records which app run is about to close these PTYs.
 * This evidence distinguishes app-induced session-end from an earlier user exit.
 * Keep in sync with renderer `stampResumeShutdown` (main cannot import that module). */
export function withShutdownEvidence(state: unknown, runId: string, at = Date.now()): unknown {
  if (!state || typeof state !== 'object') return state
  const snapshot = state as Record<string, unknown>
  if (!snapshot.resumeSessions || typeof snapshot.resumeSessions !== 'object') return state
  return {
    ...snapshot,
    resumeSessions: Object.fromEntries(
      Object.entries(snapshot.resumeSessions).map(([id, row]) => [
        id,
        row && typeof row === 'object'
          ? { ...row, shutdown: (row as Record<string, unknown>).shutdown ?? { runId, at } }
          : row
      ])
    )
  }
}
