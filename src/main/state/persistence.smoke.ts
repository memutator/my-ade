import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StatePersistence, withShutdownEvidence } from './persistence.ts'

const directory = await mkdtemp(join(tmpdir(), 'mahas-state-'))
try {
  const file = join(directory, 'state.json')
  const writer = new StatePersistence(() => file)
  const pending = [writer.save({ version: 1 }), writer.save({ version: 2 })]
  assert.equal(writer.saveSync({ version: 3 }), true)
  await Promise.all(pending)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 3)

  // Let the async write begin before the final synchronous write fences it.
  const inFlight = writer.save({ version: 4, data: 'x'.repeat(2_000_000) })
  await new Promise((resolve) => setImmediate(resolve))
  writer.saveSync({ version: 5 })
  await inFlight
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 5)
  await Promise.all([writer.save({ version: 6 }), writer.save({ version: 7 })])
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 7)
  assert.deepEqual(await readdir(directory), ['state.json'])
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  const state = { resumeSessions: { a: { sessionId: 'a' } } }
  const stamped = withShutdownEvidence(state, 'run-1', 1000) as typeof state & {
    resumeSessions: { a: { shutdown: { runId: string; at: number } } }
  }
  assert.deepEqual(stamped.resumeSessions.a.shutdown, { runId: 'run-1', at: 1000 })
  assert.equal('shutdown' in state.resumeSessions.a, false)
  assert.deepEqual(withShutdownEvidence(stamped, 'run-2', 2000), stamped)
  console.log(
    'state persistence smoke: ordered/atomic writes, shutdown fence and exact run evidence pass'
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
