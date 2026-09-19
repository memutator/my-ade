// Deterministic worker used by launch-host-integration.smoke.ts.
// It is a real child of mahas-execution-host, but never invokes a model.

import assert from 'node:assert/strict'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { watch } from 'node:fs'
import { connectRpc, readWorkerConnectionFile } from '../rpc/index.ts'

function requiredEnv(name: string): string {
  const value = process.env[name]
  assert.ok(value, `${name} is required`)
  return value
}

function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  if (existsSync(path)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${path}`)), timeoutMs)
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) finish()
    })
    // Close the existsSync -> watch registration race.
    if (existsSync(path)) finish()
    function finish(error?: Error): void {
      clearTimeout(timer)
      watcher.close()
      error ? reject(error) : resolve()
    }
  })
}

function readInitialStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let settled = false
    const timer = setTimeout(
      () => finish(new Error('timed out waiting for complete initial stdin JSON')),
      10_000
    )
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The host intentionally keeps the pipe open for later terminal input;
      // this one-shot fake owns no interactive loop, so release its read
      // handle once the complete initial JSON frame has arrived.
      process.stdin.destroy()
      error ? reject(error) : resolve(body)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      body += chunk
      // Pipes need not preserve write boundaries. The injected task input is
      // one JSON document, so syntax completion is the deterministic frame.
      try {
        JSON.parse(body)
        finish()
      } catch {
        /* wait for the remainder of the document */
      }
    })
    process.stdin.on('end', () => {
      try {
        JSON.parse(body)
        finish()
      } catch (error) {
        finish(error as Error)
      }
    })
    process.stdin.on('error', (error) => finish(error))
  })
}

async function main(): Promise<void> {
  const connectionPath = requiredEnv('MAHAS_CONNECTION_FILE')
  const barrierPath = requiredEnv('MAHAS_TEST_BARRIER')
  const resultPath = requiredEnv('MAHAS_TEST_RESULT')
  const initialStdin = await readInitialStdin()
  await waitForFile(barrierPath)

  const injected = JSON.parse(initialStdin) as {
    bootstrap: {
      join: { operation: string; payload: unknown }
      accept: {
        operation: string
        payload: { dispatchId: string; taskRevision: number; envelopeDigest: string }
      }
    }
  }
  assert.equal(injected.bootstrap.join.operation, 'execution.join')
  assert.equal(injected.bootstrap.accept.operation, 'task.accept')
  const connection = await readWorkerConnectionFile(connectionPath)
  const client = await connectRpc(connection.endpoint, connection.credential)
  try {
    const join = await client.call(
      injected.bootstrap.join.operation,
      injected.bootstrap.join.payload,
      { operationId: 'launch-host-worker-join' }
    )
    assert.equal(join.status, 'committed', JSON.stringify(join))

    const accept = await client.call(
      injected.bootstrap.accept.operation,
      injected.bootstrap.accept.payload,
      { operationId: 'launch-host-task-accept' }
    )
    assert.equal(accept.status, 'committed', JSON.stringify(accept))

    const replay = await client.call(
      injected.bootstrap.accept.operation,
      injected.bootstrap.accept.payload,
      { operationId: 'launch-host-task-accept' }
    )
    assert.equal(replay.status, 'committed')
    assert.deepEqual(replay.result, accept.result)
    assert.equal(replay.eventCursor, accept.eventCursor)

    // A bounded real task, not just a protocol acknowledgement: derive the
    // operands from the delivered requirement, compute, and report the result.
    const operands = initialStdin.match(/Compute (\d+) \+ (\d+)/)
    assert.ok(operands, 'initial input must carry the computation requirement')
    const answer = Number(operands[1]) + Number(operands[2])
    const reportPayload = {
      ...injected.bootstrap.accept.payload,
      result: 'succeeded',
      rationale: `Computed result: ${answer}`,
      outputs: []
    }
    const report = await client.call('task.report', reportPayload, {
      operationId: 'launch-host-report'
    })
    assert.equal(report.status, 'committed', JSON.stringify(report))
    const reportReplay = await client.call('task.report', reportPayload, {
      operationId: 'launch-host-report'
    })
    assert.equal(reportReplay.status, 'committed', JSON.stringify(reportReplay))
    assert.deepEqual(reportReplay.result, report.result)
    assert.equal(reportReplay.eventCursor, report.eventCursor)

    const tmp = `${resultPath}.tmp-${process.pid}`
    writeFileSync(
      tmp,
      JSON.stringify({ initialStdin, join, accept, replay, answer, report, reportReplay }, null, 2)
    )
    renameSync(tmp, resultPath)
  } finally {
    client.close()
  }
}

main().catch((error: unknown) => {
  const resultPath = process.env.MAHAS_TEST_RESULT
  if (resultPath)
    writeFileSync(
      resultPath,
      JSON.stringify({ error: String(error), stack: (error as Error)?.stack })
    )
  process.exitCode = 1
})
