// mahas-execution-host — OS spawn backend (IMP-18).
//
// The single place OS process creation happens. Both stdio modes of the
// C-HOST ProcessSpec are real:
//   pipes — child_process.spawn(detached) so the child leads its own
//           process group and outlives a control-plane disconnect
//   pty   — @homebridge/node-pty-prebuilt-multiarch, the same prebuilt
//           binding resources/pty-host.cjs uses. It loads under system
//           Node 24 (verified: the Electron-ABI problem that forced the
//           pty-host split does not apply to this daemon).
// If the native binding cannot load, ptyAvailable() reports false and
// spawn() rejects 'pty' requests honestly — it never silently downgrades
// a requested terminal to pipes.

import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'

/** canonical SpawnSpec from packages/SHARED-APIS.md (IMP-17/18 seam) */
export interface SpawnSpec {
  /** argv[0] is the executable — an absolute path per C-HOST */
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  /** request a PTY-backed terminal at this initial size; absent = pipes */
  pty?: { cols: number; rows: number }
  /** bytes (utf8 string) written to stdin/master right after spawn */
  initialStdin?: string
}

/** minimal shape of the node-pty fork we use — typed locally so a binding
 *  change fails here, not in callers */
interface PtyBinding {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string>
      encoding?: string | null
    }
  ): PtyProcess
}
export interface PtyProcess {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

let ptyModule: PtyBinding | null | undefined

/** load the prebuilt binding once; undefined → not tried, null → failed */
function loadPty(): PtyBinding | null {
  if (ptyModule !== undefined) return ptyModule
  try {
    const require = createRequire(import.meta.url)
    ptyModule = require('@homebridge/node-pty-prebuilt-multiarch') as PtyBinding
  } catch {
    ptyModule = null
  }
  return ptyModule
}

/** is PTY spawn available on this host? honest capability probe */
export function ptyAvailable(): boolean {
  return loadPty() !== null
}

/**
 * Uniform handle over a spawned OS process. Output arrives as Buffers —
 * pipes emit stdout and stderr merged into one sequence (a pipes process
 * has no terminal; the merged tail is diagnostics, not a transcript).
 */
export interface SpawnedChild {
  readonly kind: 'pty' | 'pipes'
  readonly pid: number
  /** write input bytes; throws when the child is already gone */
  write(bytes: Uint8Array): void
  /** pty only — pipes children reject resize at the op layer */
  resize?(cols: number, rows: number): void
  /** deliver a signal to the child only (never the group) */
  signal(sig: NodeJS.Signals): void
  onData(cb: (chunk: Uint8Array) => void): void
  /** exitCode undefined when killed by signal */
  onExit(cb: (e: { exitCode?: number; signal?: string }) => void): void
  readonly exited: boolean
}

export class SpawnReject extends Error {
  readonly errno?: string

  constructor(message: string, errno?: string) {
    super(message)
    this.name = 'SpawnReject'
    this.errno = errno
  }
}

/**
 * Create the OS process. Resolves once the OS confirms the spawn
 * ('spawn' event for pipes, return of pty.spawn for pty); rejects with
 * SpawnReject carrying the OS errno on a definitive refusal. Anything
 * ambiguous surfaces to the caller so the effect journal can record
 * 'unknown' — never a guessed outcome.
 */
export function spawnProcess(spec: SpawnSpec): Promise<SpawnedChild> {
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv[0]) {
    return Promise.reject(new SpawnReject('SpawnSpec.argv must be a non-empty array'))
  }
  const [file, ...args] = spec.argv
  const env = buildEnv(spec)
  return spec.pty ? spawnPty(file, args, env, spec) : spawnPipes(file, args, env, spec)
}

/** env = the caller's allowlisted map only, plus what the medium needs */
function buildEnv(spec: SpawnSpec): Record<string, string> {
  const env: Record<string, string> = { ...(spec.env ?? {}) }
  if (spec.pty) {
    // a pty with no TERM is not a usable terminal
    env.TERM ??= 'xterm-256color'
    env.COLORTERM ??= 'truecolor'
  }
  // no PATH at all makes execvp fall back to a default, but be explicit
  env.PATH ??= process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'
  env.HOME ??= process.env.HOME ?? '/'
  return env
}

function spawnPipes(
  file: string,
  args: string[],
  env: Record<string, string>,
  spec: SpawnSpec
): Promise<SpawnedChild> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnChild(file, args, {
        cwd: spec.cwd,
        env,
        // detached: child leads a new process group (pgid == pid). This is
        // what makes group-stop addressable AND lets the child outlive a
        // control-plane restart for reattach.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (e) {
      reject(new SpawnReject(String(e), (e as NodeJS.ErrnoException).code))
      return
    }
    let settled = false
    let exited = false
    const exitCbs: Array<(e: { exitCode?: number; signal?: string }) => void> = []
    const dataCbs: Array<(chunk: Uint8Array) => void> = []

    child.once('error', (err) => {
      if (!settled) {
        settled = true
        reject(new SpawnReject(String(err.message ?? err), (err as NodeJS.ErrnoException).code))
      }
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      if (spec.initialStdin !== undefined) {
        try {
          child.stdin?.write(spec.initialStdin)
        } catch {
          /* child may already be gone — the exit path reports it */
        }
      }
      resolve(handle)
    })
    child.on('exit', (code, signal) => {
      exited = true
      const e = { exitCode: code ?? undefined, signal: signal ?? undefined }
      for (const cb of exitCbs) cb(e)
    })
    child.stdout?.on('data', (d: Buffer) => {
      for (const cb of dataCbs) cb(new Uint8Array(d))
    })
    child.stderr?.on('data', (d: Buffer) => {
      for (const cb of dataCbs) cb(new Uint8Array(d))
    })

    const handle: SpawnedChild = {
      kind: 'pipes',
      get pid() {
        return child.pid ?? -1
      },
      get exited() {
        return exited
      },
      write(bytes) {
        if (!child.stdin || child.stdin.destroyed) throw new SpawnReject('stdin closed')
        child.stdin.write(bytes)
      },
      signal(sig) {
        child.kill(sig)
      },
      onData(cb) {
        dataCbs.push(cb)
      },
      onExit(cb) {
        exitCbs.push(cb)
      }
    }
  })
}

function spawnPty(
  file: string,
  args: string[],
  env: Record<string, string>,
  spec: SpawnSpec
): Promise<SpawnedChild> {
  const pty = loadPty()
  if (!pty) {
    return Promise.reject(
      new SpawnReject(
        'PTY unavailable: @homebridge/node-pty-prebuilt-multiarch failed to load on this host'
      )
    )
  }
  return new Promise((resolve, reject) => {
    let proc: PtyProcess
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: spec.pty?.cols ?? 80,
        rows: spec.pty?.rows ?? 24,
        cwd: spec.cwd,
        env,
        // raw bytes — the terminal stream does its own sequencing/utf8 work
        encoding: null
      })
    } catch (e) {
      reject(new SpawnReject(String(e), (e as NodeJS.ErrnoException).code))
      return
    }
    let exited = false
    const exitCbs: Array<(e: { exitCode?: number; signal?: string }) => void> = []
    const dataCbs: Array<(chunk: Uint8Array) => void> = []
    proc.onData((d) => {
      const bytes = typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)
      for (const cb of dataCbs) cb(bytes)
    })
    proc.onExit((e) => {
      exited = true
      const ev = {
        exitCode: e.exitCode,
        signal: e.signal !== undefined ? `SIG${e.signal}` : undefined
      }
      for (const cb of exitCbs) cb(ev)
    })
    if (spec.initialStdin !== undefined) {
      try {
        proc.write(spec.initialStdin)
      } catch {
        /* reported via exit */
      }
    }
    resolve({
      kind: 'pty',
      get pid() {
        return proc.pid
      },
      get exited() {
        return exited
      },
      write(bytes) {
        if (exited) throw new SpawnReject('pty exited')
        proc.write(new TextDecoder().decode(bytes))
      },
      resize(cols, rows) {
        if (exited) throw new SpawnReject('pty exited')
        proc.resize(cols, rows)
      },
      signal(sig) {
        proc.kill(sig)
      },
      onData(cb) {
        dataCbs.push(cb)
      },
      onExit(cb) {
        exitCbs.push(cb)
      }
    })
  })
}
