import type { ControlError, ControlResult } from '../../../packages/mahas-contracts/src/index.ts'
import type { AuthChannelMethod, AuthChannelResponse } from './authClient.ts'

export const AUTH_CHANNEL_PROTOCOL = 'mahas.auth.channel/v1'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** interpret the receipt: an auth channel response, or a flow/result the server
 *  already unwrapped. Anything else is a protocol violation, not an empty answer. */
export function responseFrom(
  method: AuthChannelMethod,
  receipt: Record<string, unknown>
): ControlResult<AuthChannelResponse> {
  const status = receipt['status']
  if (status !== 'committed') {
    const error = isRecord(receipt['error']) ? receipt['error'] : {}
    const pending = status === 'pending' || status === 'unknown'
    return {
      ok: false,
      error: {
        code: (typeof error['code'] === 'string'
          ? error['code']
          : 'UNKNOWN') as ControlError['code'],
        message:
          typeof error['message'] === 'string'
            ? error['message']
            : `auth channel call was ${String(status)}`,
        retryable: pending || error['retry'] === 'same-operation'
      }
    }
  }
  const result = receipt['result']
  if (isRecord(result) && 'protocolVersion' in result) {
    if (
      result['protocolVersion'] !== AUTH_CHANNEL_PROTOCOL ||
      result['method'] !== method ||
      (result['status'] !== 'ok' && result['status'] !== 'failed')
    ) {
      return {
        ok: false,
        error: { code: 'UNKNOWN', message: 'invalid auth channel response', retryable: false }
      }
    }
    if (result['status'] === 'failed') {
      const error = isRecord(result['error']) ? result['error'] : {}
      return {
        ok: false,
        error: {
          code: (typeof error['code'] === 'string'
            ? error['code']
            : 'UNKNOWN') as ControlError['code'],
          message:
            typeof error['message'] === 'string'
              ? error['message']
              : 'auth channel rejected the request',
          retryable: false
        }
      }
    }
    return { ok: true, value: result as unknown as AuthChannelResponse }
  }
  if (result === undefined) {
    return {
      ok: false,
      error: { code: 'UNKNOWN', message: 'auth channel returned no result', retryable: false }
    }
  }
  return {
    ok: true,
    value: { protocolVersion: AUTH_CHANNEL_PROTOCOL, method, status: 'ok', result }
  }
}
