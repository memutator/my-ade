// inventory/auth/locators.ts — existing credential files, imported by reference.
//
// mahas never copies a user's credential file into its own storage to make quota or
// sign-in work. An existing file becomes a 'locator://file/<abs path>' ref in
// ProviderCredential.materialRef, with the ownership that says who may rewrite it:
//
//   user      — a harness- or CLI-owned file. Read only.
//   external  — a file another application manages. Read only.
//
// Which file an offering has and how to parse it are VENDOR facts: the provider Pack
// owns them (see integrations/packs/providers/builtin-offerings/providers.json and
// locators.mjs). This module owns only the vendor-neutral machinery — refs, probes,
// the read-only material port — and takes the catalog through ProviderLocatorCatalog.

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import type { EpochMillis } from '../../../../mahas-contracts/src/ids.ts'
import type {
  CredentialOwnership,
  ProviderCredential
} from '../../../../mahas-contracts/src/inventory/index.ts'

export const LOCATOR_REF_PREFIX = 'locator://file/'

/** Opaque to the runtime: the Pack decides which formats it can read. */
export type CredentialMaterialFormat = string

export type LocatorOwnership = Extract<CredentialOwnership, 'user' | 'external'>

export interface LocatorCandidate {
  offeringId: string
  format: CredentialMaterialFormat
  ownership: LocatorOwnership
  /** absolute path of the existing file */
  path?: string
  /** human label used in diagnostics and by the settings UI */
  label: string
  /**
   * A directory of per-account subdirectories (the desktop usage-accounts layout). The Pack
   * has no filesystem port, so it declares the shape and the runtime expands it.
   */
  directory?: string
  fileName?: string
  fanout?: boolean
}

export interface LocatorRoots {
  home: string
  configHome: string
  dataHome: string
  /**
   * The desktop's own per-account credential directory, when composition supplies it
   * (MAHAS_LEGACY_USAGE_ACCOUNTS_ROOT). Absent means those copies are simply not offered:
   * the runtime never guesses a desktop path.
   */
  usageAccountsRoot?: string
}

/**
 * The Pack's half of credential discovery: where the files are and how to read them.
 * Implemented by the provider Pack adapter (auth/driver.ts); the runtime never
 * contains a vendor path or a provider JSON shape.
 */
export interface ProviderLocatorCatalog {
  candidates(roots: LocatorRoots): readonly LocatorCandidate[]
  /** Parse file CONTENT (never a path) into the shared credential material shape. */
  parseMaterial(format: CredentialMaterialFormat, content: string): Record<string, unknown>
}

export function locatorRefFor(path: string): string {
  if (!path || !path.startsWith('/')) throw new Error('locator paths must be absolute')
  return LOCATOR_REF_PREFIX + path
}

export function locatorPathFrom(ref: string): string | null {
  if (!ref.startsWith(LOCATOR_REF_PREFIX)) return null
  const path = ref.slice(LOCATOR_REF_PREFIX.length)
  return path.startsWith('/') ? path : null
}

export const isLocatorRef = (ref: string): boolean => ref.startsWith(LOCATOR_REF_PREFIX)

/** Deterministic id so re-importing the same file never creates a second row. */
export function locatorCredentialId(machineId: string, offeringId: string, ref: string): string {
  const digest = createHash('sha256')
    .update([machineId, offeringId, ref].join('\u0000'))
    .digest('hex')
  return 'credential_locator_' + digest.slice(0, 32)
}

export function locatorConnectionId(credentialId: string): string {
  const digest = createHash('sha256').update(credentialId).digest('hex')
  return 'connection_' + digest.slice(0, 32)
}

export interface LocatorFileIo {
  read(path: string): Promise<string>
  stat(path: string): Promise<{ exists: boolean; size: number; mtimeMs: number }>
  listDirectories(path: string): Promise<readonly string[]>
}

export const nodeLocatorFileIo: LocatorFileIo = {
  read: (path) => readFile(path, 'utf8'),
  async stat(path) {
    try {
      const info = await stat(path)
      return { exists: info.isFile(), size: info.size, mtimeMs: Math.floor(info.mtimeMs) }
    } catch {
      return { exists: false, size: 0, mtimeMs: 0 }
    }
  },
  async listDirectories(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }
}

export interface LocatorProbe {
  candidate: LocatorCandidate
  ref: string
  available: boolean
  size: number
  mtimeMs: number
}

/** Probe without reading material: existence and file shape only. */
export async function probeLocators(
  candidates: readonly LocatorCandidate[],
  io: LocatorFileIo = nodeLocatorFileIo
): Promise<LocatorProbe[]> {
  const probes: LocatorProbe[] = []
  for (const candidate of candidates) {
    if (candidate.fanout) {
      if (!candidate.directory || !candidate.fileName) {
        throw new Error('a fanout locator candidate must declare directory and fileName')
      }
      for (const account of await io.listDirectories(candidate.directory)) {
        const path = (candidate.directory + '/' + account + '/' + candidate.fileName).replace(
          /\/+/g,
          '/'
        )
        const info = await io.stat(path)
        probes.push({
          candidate: { ...candidate, path, label: candidate.label + ' / ' + account },
          ref: locatorRefFor(path),
          available: info.exists,
          size: info.size,
          mtimeMs: info.mtimeMs
        })
      }
      continue
    }
    if (!candidate.path) throw new Error('a locator candidate must declare path or directory')
    const info = await io.stat(candidate.path)
    probes.push({
      candidate,
      ref: locatorRefFor(candidate.path),
      available: info.exists,
      size: info.size,
      mtimeMs: info.mtimeMs
    })
  }
  return probes
}

export interface ImportedLocator {
  candidate: LocatorCandidate
  ref: string
  credential: ProviderCredential
  evidence: Record<string, unknown>
}

/**
 * Registration input for an available locator. The row points at the file; the
 * material stays where the user put it.
 */
export function importedLocatorCredential(input: {
  machineId: string
  probe: LocatorProbe
  now: EpochMillis
}): ImportedLocator {
  const ref = input.probe.ref
  return {
    candidate: input.probe.candidate,
    ref,
    credential: {
      id: locatorCredentialId(input.machineId, input.probe.candidate.offeringId, ref),
      machineId: input.machineId,
      materialRef: ref,
      materialRevision: 1,
      ownership: input.probe.candidate.ownership,
      availability: input.probe.available ? 'available' : 'unavailable',
      firstSeenAt: input.now,
      lastSeenAt: input.now
    },
    evidence: {
      format: input.probe.candidate.format,
      label: input.probe.candidate.label,
      ownership: input.probe.candidate.ownership,
      size: input.probe.size,
      mtimeMs: input.probe.mtimeMs
    }
  }
}

/**
 * Read-only material access for a locator ref: the runtime reads the bytes and the
 * Pack parses them. There is no write path at all.
 */
export class LocatorMaterialReader {
  readonly #catalog: ProviderLocatorCatalog
  readonly #io: LocatorFileIo

  constructor(catalog: ProviderLocatorCatalog, io: LocatorFileIo = nodeLocatorFileIo) {
    this.#catalog = catalog
    this.#io = io
  }

  async read(format: CredentialMaterialFormat, ref: string): Promise<Record<string, unknown>> {
    const path = locatorPathFrom(ref)
    if (!path) throw new Error('ref is not a locator ref')
    try {
      return this.#catalog.parseMaterial(format, await this.#io.read(path))
    } catch {
      // Native parser messages may quote credential bytes. This error can cross
      // the ordinary receipt boundary during adoption; keep it secret-free.
      throw new Error('credential locator could not be read with the declared format')
    }
  }
}

/** Locator paths never travel out of the daemon as absolute strings. */
export function redactLocatorRef(ref: string): string {
  const path = locatorPathFrom(ref)
  if (!path) return ref
  const parts = path.split('/')
  return locatorRefFor('/**/' + parts.slice(-2).join('/'))
}
