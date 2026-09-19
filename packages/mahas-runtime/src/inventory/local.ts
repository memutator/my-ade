import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject } from '../../../mahas-contracts/src/common.ts'
import type { HarnessInstallation, Machine } from '../../../mahas-contracts/src/inventory/index.ts'
import { mahasError } from '../api/handler-ports.ts'
import type { Versioned } from '../catalog/repository.ts'
import { putInstallation, putMachine } from './repository.ts'

export const LOCAL_MACHINE_ID_FILENAME = 'machine-id'

export interface LocalMachineIo {
  readText(path: string): string
  writeNewText(path: string, value: string): void
  ensureDir(path: string): void
  randomId(): string
  hostname(): string
}

const REAL_LOCAL_MACHINE_IO: LocalMachineIo = {
  readText: (path) => readFileSync(path, 'utf8'),
  writeNewText: (path, value) => writeFileSync(path, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
  ensureDir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  randomId: randomUUID,
  hostname
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function readMachineId(path: string, io: LocalMachineIo): string | undefined {
  try {
    const value = io.readText(path).trim()
    if (!value) throw mahasError('CONTROL_UNAVAILABLE', `${path} contains an empty machine id`, 'reconcile')
    return value
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Materialize the one local-machine identity for a runtime config directory.
 * Tests can inject an in-memory LocalMachineIo and never inspect host files.
 */
export function ensureLocalMachine(
  db: DatabaseSync,
  input: {
    configDir: string
    observedAt: number
    label?: string
    metadata?: JsonObject
    io?: LocalMachineIo
  }
): Versioned<Machine> {
  const io = input.io ?? REAL_LOCAL_MACHINE_IO
  const configDir = resolve(input.configDir)
  const identityPath = join(configDir, LOCAL_MACHINE_ID_FILENAME)
  let id = readMachineId(identityPath, io)
  if (!id) {
    io.ensureDir(configDir)
    const candidate = `machine.${io.randomId()}`
    try {
      io.writeNewText(identityPath, `${candidate}\n`)
      id = candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      id = readMachineId(identityPath, io)
    }
  }
  if (!id) {
    throw mahasError('CONTROL_UNAVAILABLE', 'local machine identity was not persisted', 'same-operation')
  }

  return putMachine(db, {
    id,
    label: input.label ?? io.hostname(),
    firstSeenAt: input.observedAt,
    lastSeenAt: input.observedAt,
    metadata: {
      ...input.metadata,
      provenance: 'mahas-config-directory',
      configDir
    }
  })
}

export interface EnsureHarnessInstallationInput {
  machineId: string
  harnessId: string
  configNamespace: string
  dataNamespace: string
  observedAt: number
  executableLocator?: string | null
  presence?: HarnessInstallation['presence']
  origin: HarnessInstallation['origin']
}

/** Register explicit discovery output; this function never probes executables or config files. */
export function ensureHarnessInstallation(
  db: DatabaseSync,
  input: EnsureHarnessInstallationInput
): Versioned<HarnessInstallation> {
  const identity = JSON.stringify([
    input.machineId,
    input.harnessId,
    input.configNamespace,
    input.dataNamespace
  ])
  const id = `installation.${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
  return putInstallation(db, {
    id,
    machineId: input.machineId,
    harnessId: input.harnessId,
    executableLocator: input.executableLocator ?? null,
    configNamespace: input.configNamespace,
    dataNamespace: input.dataNamespace,
    firstSeenAt: input.observedAt,
    lastSeenAt: input.observedAt,
    presence: input.presence ?? 'present',
    origin: input.origin
  })
}
