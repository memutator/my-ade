// inventory/auth/callback.ts — the loopback callback adapter.
//
// Providers in the PKCE family redirect the browser back to a loopback address
// that is either registered with the provider (codex 1455, grok 56121) or
// allocated per flow (gemini). The adapter owns exactly that platform capability:
// bind a loopback listener, hand back the redirect it advertises, resolve once
// with the authorization code, and close. The code is never echoed into the
// response page, never appended to a log, and never stored here.
//
// A daemon has no browser, so this adapter never opens one: the browser effect
// stays on the desktop side and the completion travels back through the
// 'effect' field of the flow view (see coordinator.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AuthTransportError } from './transport.ts'

export interface AuthCallbackResult {
  code: string
  state: string | null
}

export type AuthCallbackErrorCode =
  | 'UNAVAILABLE'
  | 'NOT_LOOPBACK'
  | 'BIND_FAILED'
  | 'TIMEOUT'
  | 'CLOSED'
  | 'PROVIDER_ERROR'
  | 'KEY_MISSING'

export class AuthCallbackError extends Error {
  readonly code: AuthCallbackErrorCode

  constructor(code: AuthCallbackErrorCode, message: string) {
    super(message)
    this.name = 'AuthCallbackError'
    this.code = code
  }
}

export interface AuthCallbackHandle {
  readonly redirect: string
  readonly closed: boolean
  awaitResult(signal?: AbortSignal): Promise<AuthCallbackResult>
  close(): void
}

export interface AuthCallbackOpenInput {
  host?: string
  /** 0 allocates a free loopback port; provider-registered ports pass the fixed value. */
  port?: number
  path?: string
  timeoutMs?: number
}

export interface AuthCallbackPort {
  open(input?: AuthCallbackOpenInput): Promise<AuthCallbackHandle>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function assertLoopbackRedirect(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new AuthCallbackError(
      'NOT_LOOPBACK',
      'callback host ' + host + ' is not a loopback address'
    )
  }
}

const COMPLETION_PAGE = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<title>mahas sign-in</title></head><body>',
  '<h1>Sign-in received</h1><p>You can close this window and return to mahas.</p>',
  '</body></html>'
].join('')

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'",
    'x-content-type-options': 'nosniff',
    connection: 'close'
  })
  response.end(body)
}

function callbackTarget(request: IncomingMessage, path: string): URL | null {
  const raw = request.url ?? '/'
  let url: URL
  try {
    url = new URL(raw, 'http://127.0.0.1')
  } catch {
    return null
  }
  return url.pathname === path ? url : null
}

/**
 * Loopback HTTP listener. The first matching request resolves the wait; every
 * other request (favicon probes, mismatched paths) is answered with 404.
 */
export class LoopbackAuthCallback implements AuthCallbackPort {
  async open(input: AuthCallbackOpenInput = {}): Promise<AuthCallbackHandle> {
    const host = input.host ?? '127.0.0.1'
    assertLoopbackRedirect(host)
    const path = input.path ?? '/callback'
    const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000
    const server: Server = createServer()
    let settle: ((result: AuthCallbackResult) => void) | null = null
    let fail: ((error: Error) => void) | null = null
    const pending = new Promise<AuthCallbackResult>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    let finished = false
    let closeRequested = false
    // A holder rather than a bare mutable binding: the timer is created after the request
    // handler is installed, but finish() can be called by that handler first.
    const state: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined }

    const finish = (action: () => void): void => {
      if (finished) return
      finished = true
      if (state.timer) clearTimeout(state.timer)
      action()
    }

    server.on('request', (request, response) => {
      const url = callbackTarget(request, path)
      if (!url) {
        respond(response, 404, '<!doctype html><title>mahas</title>')
        return
      }
      const providerError = url.searchParams.get('error')
      if (providerError) {
        respond(response, 200, COMPLETION_PAGE)
        finish(() =>
          fail?.(
            new AuthCallbackError(
              'PROVIDER_ERROR',
              'provider rejected the sign-in: ' + providerError
            )
          )
        )
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        respond(response, 200, COMPLETION_PAGE)
        finish(() =>
          fail?.(new AuthCallbackError('KEY_MISSING', 'callback carried no authorization code'))
        )
        return
      }
      const state = url.searchParams.get('state')
      respond(response, 200, COMPLETION_PAGE)
      finish(() => settle?.({ code, state }))
    })
    server.on('error', (error) => {
      finish(() =>
        fail?.(new AuthCallbackError('BIND_FAILED', 'callback listener failed: ' + error.message))
      )
    })

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(input.port ?? 0, host, () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new AuthCallbackError('BIND_FAILED', 'callback listener has no port'))
          return
        }
        resolve(address.port)
      })
    }).catch((error: unknown) => {
      server.close()
      throw error instanceof AuthCallbackError
        ? error
        : new AuthCallbackError(
            'BIND_FAILED',
            error instanceof Error ? error.message : 'callback listener failed'
          )
    })

    state.timer = setTimeout(() => {
      finish(() => fail?.(new AuthCallbackError('TIMEOUT', 'sign-in callback timed out')))
    }, timeoutMs)

    const displayHost = host === '::1' || host === '[::1]' ? '[::1]' : host
    const redirect = 'http://' + displayHost + ':' + port + path

    return {
      redirect,
      get closed(): boolean {
        return closeRequested || finished
      },
      awaitResult(signal?: AbortSignal): Promise<AuthCallbackResult> {
        if (signal) {
          if (signal.aborted) {
            finish(() => fail?.(new AuthCallbackError('CLOSED', 'callback wait was aborted')))
          } else {
            signal.addEventListener(
              'abort',
              () =>
                finish(() => fail?.(new AuthCallbackError('CLOSED', 'callback wait was aborted'))),
              { once: true }
            )
          }
        }
        return pending
      },
      close(): void {
        closeRequested = true
        finish(() =>
          fail?.(
            new AuthCallbackError('CLOSED', 'callback listener closed before the sign-in completed')
          )
        )
        server.close()
      }
    }
  }
}

export interface SyntheticCallbackHandle {
  redirect: string
  closed: boolean
  deliver(result: AuthCallbackResult): void
  fail(error: Error): void
}

/** Test double: no socket, explicit delivery. */
export class SyntheticAuthCallback implements AuthCallbackPort {
  readonly handles: SyntheticCallbackHandle[] = []

  open(input: AuthCallbackOpenInput = {}): Promise<AuthCallbackHandle> {
    const path = input.path ?? '/callback'
    const port = input.port && input.port > 0 ? input.port : 1024 + this.handles.length
    let resolve: ((result: AuthCallbackResult) => void) | null = null
    let reject: ((error: Error) => void) | null = null
    const pending = new Promise<AuthCallbackResult>((ok, no) => {
      resolve = ok
      reject = no
    })
    const record: SyntheticCallbackHandle = {
      redirect: 'http://127.0.0.1:' + port + path,
      closed: false,
      deliver(result: AuthCallbackResult): void {
        record.closed = true
        resolve?.(result)
      },
      fail(error: Error): void {
        record.closed = true
        reject?.(error)
      }
    }
    this.handles.push(record)
    return Promise.resolve({
      redirect: record.redirect,
      get closed(): boolean {
        return record.closed
      },
      awaitResult: () => pending,
      close(): void {
        if (record.closed) return
        record.closed = true
        reject?.(
          new AuthCallbackError('CLOSED', 'callback listener closed before the sign-in completed')
        )
      }
    })
  }
}

/** Headless composition: only manual-code and device flows can complete. */
export class UnavailableAuthCallback implements AuthCallbackPort {
  open(input?: AuthCallbackOpenInput): Promise<AuthCallbackHandle> {
    void input
    return Promise.reject(
      new AuthCallbackError('UNAVAILABLE', 'no loopback callback listener is available')
    )
  }
}

/** Surface a callback failure through the transport error taxonomy. */
export function callbackTransportFailure(error: unknown): AuthTransportError {
  if (error instanceof AuthTransportError) return error
  if (error instanceof AuthCallbackError) {
    return new AuthTransportError(
      'DRIVER_FAILED',
      'callback ' + error.code.toLowerCase() + ': ' + error.message
    )
  }
  return new AuthTransportError(
    'DRIVER_FAILED',
    error instanceof Error ? error.message : 'callback failed'
  )
}
