// mahas-runtime rpc — wire framing for the local collaboration transport.
//
// spec/contracts/access-cli.md §1: the local transport targets POSIX Unix
// domain sockets / Windows named pipes and defines a version handshake, a
// requestId, and length-delimited JSON framing. The length delimiter here is
// the NDJSON newline: every frame is exactly one JSON object on one line,
// capped at MAX_FRAME_BYTES so a hostile or broken peer cannot grow memory
// without bound. Terminal transcripts never share this channel — the frames
// below are the only shapes on the wire (spec/common.md §2 output rules).

import type {
  AuthenticatedContext,
  CommandReceipt,
  CommandRequest,
  ErrorCode,
  ErrorRetry,
  MahasError
} from '../../../mahas-contracts/src/index.ts'

/**
 * Wire protocol revision for serveRpc/connectRpc. Bumped when frame shapes or
 * handshake semantics change; peers negotiate the max common version during
 * hello. Distinct from MAHAS_RUNTIME_PROTOCOL_VERSION in bootstrap.ts, which
 * tracks the desktop RuntimeClient seam.
 */
export const MAHAS_RPC_PROTOCOL_VERSION = 1

/** hard cap on a single NDJSON frame — generous for payloads, fatal beyond */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** opaque credential material — the server-side `authenticate` gives it meaning */
export type RpcCredential = unknown

/** first client→server frame: version offer + credential proof */
export interface ClientHelloFrame {
  kind: 'hello'
  protocolVersion: number
  credential: RpcCredential
}

/** server→client handshake acceptance — carries the verified identity echo */
export interface ServerHelloOkFrame {
  kind: 'hello-ok'
  protocolVersion: number
  transportSessionId: string
  principalId: string
}

/** server→client handshake refusal — socket is closed right after this frame */
export interface ServerHelloErrorFrame {
  kind: 'hello-error'
  error: MahasError
}

export type ServerHelloFrame = ServerHelloOkFrame | ServerHelloErrorFrame

/** an authenticated call: requestId correlates the response on this socket */
export interface CallFrame {
  kind: 'call'
  requestId: number
  request: CommandRequest
}

/** server→client answer: the CommandReceipt IS the response body (§2) */
export interface ResultFrame {
  kind: 'result'
  requestId: number
  receipt: CommandReceipt
}

/**
 * transport-level fault that never reached dispatch (malformed frame, bad
 * envelope shape). Request-scope errors still answer as `result` receipts —
 * this frame is only for frames that could not produce a receipt at all.
 */
export interface ErrorFrame {
  kind: 'error'
  requestId: number | null
  error: MahasError
}

export type ClientFrame = ClientHelloFrame | CallFrame
export type ServerFrame = ServerHelloFrame | ResultFrame | ErrorFrame

export function mahasError(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): MahasError {
  return details === undefined ? { code, message, retry } : { code, message, retry, details }
}

/**
 * Structural MahasError check — same rule IMP-11's handler-ports uses
 * (code + message; a missing retry is normalized to 'none' by callers who
 * re-emit the error on the wire).
 */
export function isMahasError(v: unknown): v is MahasError {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return typeof e.code === 'string' && typeof e.message === 'string'
}

/** ensure a wire-bound error carries a retry verdict */
export function normalizeError(v: unknown, fallback: MahasError): MahasError {
  if (!isMahasError(v)) return fallback
  return v.retry === undefined ? { ...v, retry: 'none' } : v
}

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame) + '\n'
}

export type FrameParseResult =
  { ok: true; frame: Record<string, unknown> } | { ok: false; error: MahasError }

/**
 * Structural check shared by both ends: a frame must be a JSON object whose
 * `kind` is one both sides understand. Field-level validation is the
 * receiver's job — this only proves the envelope parses.
 */
export function parseFrame(line: string): FrameParseResult {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return { ok: false, error: mahasError('MODEL_INVALID', 'unparseable NDJSON frame') }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: mahasError('MODEL_INVALID', 'frame is not a JSON object') }
  }
  const kind = (v as Record<string, unknown>).kind
  if (typeof kind !== 'string') {
    return { ok: false, error: mahasError('MODEL_INVALID', 'frame has no kind') }
  }
  return { ok: true, frame: v as Record<string, unknown> }
}

/**
 * Incremental NDJSON decoder over a socket. Bytes accumulate until a
 * newline; each completed line is handed to onLine. Exceeding
 * MAX_FRAME_BYTES before a newline is a protocol fault (onOverflow) — the
 * caller should error the peer and close.
 */
export class NdjsonDecoder {
  private buf = ''
  private readonly onLine: (line: string) => void
  private readonly onOverflow: () => void
  constructor(onLine: (line: string) => void, onOverflow: () => void) {
    this.onLine = onLine
    this.onOverflow = onOverflow
  }

  feed(chunk: string | Uint8Array): void {
    this.buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (;;) {
      const nl = this.buf.indexOf('\n')
      if (nl < 0) {
        if (Buffer.byteLength(this.buf, 'utf8') > MAX_FRAME_BYTES) {
          this.buf = ''
          this.onOverflow()
        }
        return
      }
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (line.length > 0) this.onLine(line)
    }
  }

  /** bytes buffered without a terminating newline — nonzero at EOF is a torn frame */
  get pendingBytes(): number {
    return Buffer.byteLength(this.buf, 'utf8')
  }
}

/**
 * Server-side view of a verified connection. `transportSessionId` is minted
 * by the server per accepted socket — the authenticator may fold it into the
 * context it returns, and serveRpc force-assigns it either way so the field
 * is always the real session, never a payload/client claim (§2: context is
 * built from the credential, not the request).
 */
export interface RpcSessionInfo {
  transportSessionId: string
  endpoint: string
}

/**
 * The authenticator serveRpc calls once per connection during hello.
 * SHARED-APIS fixes `(credential: unknown) => AuthenticatedContext`; the
 * extra optional `session` parameter is signature-compatible (a 1-arg
 * implementation is assignable here) and lets the authenticator embed the
 * real session id. Throw (or return a rejected promise) to refuse the
 * connection — a thrown MahasError-shaped object keeps its code; anything
 * else maps to UNAUTHENTICATED.
 */
export type RpcAuthenticate = (
  credential: RpcCredential,
  session: RpcSessionInfo
) => AuthenticatedContext | Promise<AuthenticatedContext>

/** validate a CommandRequest's envelope fields; payload stays opaque */
export function requestFromWire(v: unknown): CommandRequest | MahasError {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return mahasError('MODEL_INVALID', 'request is not an object')
  }
  const r = v as Record<string, unknown>
  if (typeof r.operation !== 'string' || r.operation.length === 0) {
    return mahasError('MODEL_INVALID', 'request.operation must be a non-empty string')
  }
  if (typeof r.operationId !== 'string' || r.operationId.length === 0) {
    return mahasError('MODEL_INVALID', 'request.operationId must be a non-empty string')
  }
  if (r.expectedRevisions !== undefined) {
    if (typeof r.expectedRevisions !== 'object' || r.expectedRevisions === null) {
      return mahasError('MODEL_INVALID', 'request.expectedRevisions must be an object')
    }
    for (const [k, rev] of Object.entries(r.expectedRevisions)) {
      if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
        return mahasError('MODEL_INVALID', `expectedRevisions[${k}] must be an integer ≥ 1`)
      }
    }
  }
  return {
    protocolVersion: typeof r.protocolVersion === 'string' ? r.protocolVersion : '',
    operation: r.operation,
    operationId: r.operationId,
    expectedRevisions: r.expectedRevisions as Record<string, number> | undefined,
    payload: r.payload
  }
}
