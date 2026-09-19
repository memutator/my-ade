// recovery/harness-evidence.ts — production HarnessEvidence resolver.
//
// The legacy backfill (recovery/session-handles.ts) refuses to convert a legacy
// native handle unless the caller can name the canonical harness AND the
// installation whose namespace qualifies the native id. This module derives that
// evidence from what the system already recorded, in this order:
//
//   1. an explicit wiring override for the profile id (operator/deployment);
//   2. the REGISTERED harness profile's launcher evidence: the same
//      builtin.harness-runtime Pack lookup the launcher itself performs
//      (launch/recipe-adapter.ts lowers pack.profiles[profileId], and that
//      profile carries an explicit harnessId field). The harness id is read
//      from that field — it is never parsed out of the profile id string.
//   3. nothing else. An id that only shares a prefix/suffix with a harness id
//      stays unresolved, because a wrong namespace silently merges two native
//      sessions and a wrong harness attributes another tool's work.
//
// The installation is chosen with the same exactness rules as the bridge,
// folded in here so the reference row can record the resolved installation:
//   · candidates are the installations of that harness on the LOCAL machine
//     (machineId) — discovery may register installs on other machines later;
//   · exactly one candidate → that one;
//   · several candidates → the profile's recorded executable path
//     (harness_profiles.executable_identity_json.locator, an absolute path) must
//     match inventory_installations.executable_locator EXACTLY; otherwise the
//     evidence is returned without an installation and the bridge refuses it as
//     ambiguous rather than picking one.
//
// Nothing here writes: a resolver only decides what can be proven.

import type { DatabaseSync } from 'node:sqlite'
import {
  launchProfile,
  type HarnessRuntimePack
} from '../../../mahas-harness-config/src/runtime-pack.ts'
import type { HarnessEvidence, LegacyBackfillPointer } from './session-handles.ts'

export interface HarnessEvidenceOverride {
  harnessId: string
  installationId?: string
  namespace?: string
  /** why the override exists — recorded in the row evidence */
  basis?: string
}

export interface HarnessEvidenceOptions {
  /**
   * The Pack revision the launcher lowers profiles from
   * (builtin.harness-runtime). Omitted = only overrides can resolve.
   */
  pack?: HarnessRuntimePack | null
  /** local machine id; installations on other machines never qualify a session */
  machineId?: string | null
  /** explicit profileId → harness mapping; wins over Pack launcher evidence */
  overrides?: Readonly<Record<string, HarnessEvidenceOverride>>
  /** native namespace inside the installation (collector default: 'default') */
  namespace?: string
}

export interface RegisteredProfileEvidence {
  profileId: string
  revision: number
  state: string
  /** absolute executable path recorded at registration, when it is a path */
  executableLocator: string | null
}

export interface ProfileHarnessEvidence {
  harnessId: string
  basis: string
  profile: RegisteredProfileEvidence
  /** the harness id came from an explicit override rather than Pack data */
  fromOverride: boolean
}

function tablePresent(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { name?: unknown } | undefined
  return row !== undefined
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** the registered profile row, newest revision first — null when unregistered */
export function registeredProfileEvidence(
  db: DatabaseSync,
  profileId: string
): RegisteredProfileEvidence | null {
  if (!tablePresent(db, 'harness_profiles')) return null
  const row = db
    .prepare(
      'SELECT id, revision, state, executable_identity_json FROM harness_profiles' +
        ' WHERE id=? ORDER BY revision DESC LIMIT 1'
    )
    .get(profileId) as
    { id: string; revision: number; state: string; executable_identity_json: string } | undefined
  if (!row) return null
  let locator: string | null = null
  try {
    const identity = objectOf(JSON.parse(row.executable_identity_json))
    const raw = identity ? identity.locator : null
    // only an absolute-path string is usable as exact installation evidence; a
    // { commands: [...] } locator names commands, not paths, and is ignored
    locator = typeof raw === 'string' && raw.startsWith('/') ? raw : null
  } catch {
    locator = null
  }
  return { profileId: row.id, revision: row.revision, state: row.state, executableLocator: locator }
}

/**
 * harness id for one registered profile, from stored launcher evidence.
 * Returns null when neither an override nor Pack data establishes it — the
 * execution then keeps its legacy handle instead of being converted on a guess.
 */
export function profileHarnessEvidence(
  db: DatabaseSync,
  profileId: string,
  options: HarnessEvidenceOptions
): ProfileHarnessEvidence | null {
  const profile = registeredProfileEvidence(db, profileId)
  if (!profile) return null
  const override = options.overrides ? options.overrides[profileId] : undefined
  if (override && typeof override.harnessId === 'string' && override.harnessId.length > 0) {
    return {
      harnessId: override.harnessId,
      basis: override.basis ?? 'explicit harness override for profile ' + profileId,
      profile,
      fromOverride: true
    }
  }
  const pack = options.pack
  if (!pack) return null
  const lowered = launchProfile(pack, profileId)
  const harnessId = lowered && typeof lowered.harnessId === 'string' ? lowered.harnessId : ''
  if (harnessId.length === 0) return null
  return {
    harnessId,
    basis:
      'registered profile ' +
      profileId +
      ' (revision ' +
      profile.revision +
      ', ' +
      profile.state +
      ') is launched from Pack profile ' +
      profileId +
      ' which declares harnessId ' +
      harnessId,
    profile,
    fromOverride: false
  }
}

interface InstallationCandidate {
  id: string
  machine_id: string
  executable_locator: string | null
}

/**
 * The resolver handed to the backfill plan:
 *   resolveHarness: harnessEvidenceResolver(db, options)
 *
 * Returning null is a normal answer — the execution then stays legacy and is
 * retried on a later pass, which is what makes the pass runner safe to call on
 * every discovery refresh.
 */
export function harnessEvidenceResolver(
  db: DatabaseSync,
  options: HarnessEvidenceOptions
): (pointer: LegacyBackfillPointer) => HarnessEvidence | null {
  return (pointer) => {
    const profileId = pointer.harnessProfileId
    if (!profileId) return null
    const resolved = profileHarnessEvidence(db, profileId, options)
    if (!resolved) return null
    const harnessId = resolved.harnessId

    const override = options.overrides ? options.overrides[profileId] : undefined
    const namespace = (override && override.namespace) || options.namespace || 'default'
    const machineId = options.machineId ?? null
    const base: HarnessEvidence = {
      harnessId,
      ...(machineId ? { machineId } : {}),
      namespace,
      basis: resolved.basis
    }
    if (override && override.installationId) {
      return { ...base, installationId: override.installationId }
    }
    if (!tablePresent(db, 'inventory_installations')) return base

    const machineFilter = machineId ? ' AND machine_id=?' : ''
    const candidates = db
      .prepare(
        'SELECT id, machine_id, executable_locator FROM inventory_installations' +
          ' WHERE harness_id=?' +
          machineFilter +
          ' ORDER BY id'
      )
      .all(
        ...(machineId ? [harnessId, machineId] : [harnessId])
      ) as unknown as InstallationCandidate[]
    if (candidates.length === 1) {
      return { ...base, installationId: candidates[0]!.id }
    }
    const locator = resolved.profile.executableLocator
    if (candidates.length > 1 && locator) {
      const exact = candidates.filter((row) => row.executable_locator === locator)
      if (exact.length === 1) {
        return {
          ...base,
          installationId: exact[0]!.id,
          installationLocator: locator,
          basis: base.basis + '; installation matched by exact executable path ' + locator
        }
      }
    }
    // zero or several candidates: hand the exactness question to the bridge,
    // which refuses instead of choosing (unknown-installation / ambiguous)
    return { ...base, ...(locator ? { installationLocator: locator } : {}) }
  }
}
