import assert from 'node:assert/strict'
import { AUTH_CHANNEL_PROTOCOL, responseFrom } from './authResponse.ts'

const method = 'auth.flow.status'
const wrapped = {
  protocolVersion: AUTH_CHANNEL_PROTOCOL,
  method,
  status: 'ok',
  result: { state: 'unknown' }
}
assert.equal(responseFrom(method, { status: 'committed', result: wrapped }).ok, true)
assert.equal(responseFrom(method, { status: 'committed', result: { state: 'unknown' } }).ok, true)
const failure = responseFrom(method, {
  status: 'committed',
  result: {
    ...wrapped,
    status: 'failed',
    error: { code: 'HANDLE_INVALID', message: 'expired handle' }
  }
})
assert.equal(failure.ok, false)
if (!failure.ok) assert.equal(failure.error.message, 'expired handle')
for (const receipt of [
  { status: 'committed' },
  { status: 'committed', result: { ...wrapped, protocolVersion: 'future/unknown' } },
  { status: 'committed', result: { ...wrapped, method: 'auth.flow.start' } },
  { status: 'committed', result: { ...wrapped, status: 'pending' } },
  { status: 'rejected', result: wrapped },
  { status: 'unknown', result: wrapped }
])
  assert.equal(responseFrom(method, receipt).ok, false)
const pending = responseFrom(method, { status: 'pending' })
assert.equal(pending.ok, false)
if (!pending.ok) assert.equal(pending.error.retryable, true)
console.log('auth response smoke: wrapped failures, malformed envelopes and pending receipts pass')
