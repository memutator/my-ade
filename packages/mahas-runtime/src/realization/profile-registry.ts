// realization/profile-registry.ts — HarnessProfile register/inspect/admit.
//
// role-realization.md §2: a HarnessProfile pins executableIdentity +
// recipeVersion + supportedComponents + injectionRoutes + resume/wake
// capabilities under an admissionState of draft|documented|verified|
// disabled — install version and OS range are FIXED per revision, and
// revisions are immutable (admit produces a NEW revision row, never edits).
//
// honesty rules (instruction §4.5, contract `harness.profile.admit`):
//  - a documentation-only profile is NEVER promoted to 'verified' — verified
//    requires SupportAttestation evidence from an actual verification run
//    (install observation / test launch / exercised recipe), not docs.
//  - inspect never fabricates an installation observation: it reports the
//    declared identity + attestation history, and only when an installation
//    probe is wired does it run one — recorded as an explicit diagnostic
//    record, never as "we ran the prompt" (contract: prompt 실행 안 함).
//  - inspect excludes secret/account settings from its response.

import type { DatabaseSync } from 'node:sqlite'
import type { SupportAttestation } from '../../../mahas-contracts/src/observation.ts'
import type { HarnessProfileInspectResult } from '../../../mahas-contracts/src/operations/inspector.ts'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import { authorize as defaultAuthorize, type TargetRef } from '../access/authorize.ts'
import type { TxnContext } from '../api/registry.ts'
import { appendDomainEvent } from '../storage/db.ts'
import { COMPONENT_KINDS, type ComponentKind } from './component-graph.ts'
import {
  asRecord,
  canonicalJson,
  digestOf,
  fail,
  mintId,
  optArray,
  optString,
  reqArray,
  reqInteger,
  reqString
} from './util.ts'

/* ------------------------------------------------------------------ *
 * profile storage shapes
 * ------------------------------------------------------------------ */

export type ProfileAdmissionState = 'draft' | 'documented' | 'verified' | 'disabled'

/** injection.md §4 — the three verified delivery routes, closed set */
export const INJECTION_ROUTES = [
  'instruction-file',
  'instruction-text',
  'confirmed-preload'
] as const
export type InjectionRoute = (typeof INJECTION_ROUTES)[number]

export interface ExecutableIdentity {
  locator: string
  versionRange: string
  osRange?: string
}

export interface ProfileRecipe {
  recipeVersion: number
  injection: unknown
  resume: unknown | null
  wake: unknown | null
  settingsPolicy: unknown | null
}

export interface ProfileCapabilities {
  supportedComponents: ComponentKind[]
  injectionRoutes: string[]
  resume: boolean
  wake: boolean
}

export interface StoredProfile {
  profileId: string
  revision: number
  admissionState: ProfileAdmissionState
  executableIdentity: ExecutableIdentity
  capabilities: ProfileCapabilities
  recipe: ProfileRecipe
}

interface ProfileRow {
  id: string
  revision: number
  state: string
  recipe_json: string
  capabilities_json: string
  executable_identity_json: string
}

function rowToProfile(row: ProfileRow): StoredProfile {
  return {
    profileId: row.id,
    revision: row.revision,
    admissionState: row.state as ProfileAdmissionState,
    executableIdentity: JSON.parse(row.executable_identity_json) as ExecutableIdentity,
    capabilities: JSON.parse(row.capabilities_json) as ProfileCapabilities,
    recipe: JSON.parse(row.recipe_json) as ProfileRecipe
  }
}

/** latest revision when revision is omitted */
export function loadProfile(
  db: DatabaseSync,
  profileId: string,
  revision?: number
): StoredProfile | undefined {
  const row = (revision === undefined
    ? db
        .prepare(
          'SELECT id, revision, state, recipe_json, capabilities_json, executable_identity_json ' +
            'FROM harness_profiles WHERE id = ? ORDER BY revision DESC LIMIT 1'
        )
        .get(profileId)
    : db
        .prepare(
          'SELECT id, revision, state, recipe_json, capabilities_json, executable_identity_json ' +
            'FROM harness_profiles WHERE id = ? AND revision = ?'
        )
        .get(profileId, revision)) as unknown as ProfileRow | undefined
  return row === undefined ? undefined : rowToProfile(row)
}

/** every attestation recorded against a profile id, oldest first */
export function listAttestations(db: DatabaseSync, profileId: string): SupportAttestation[] {
  const rows = db
    .prepare(
      'SELECT id, profile_id, profile_revision, decision, installation_json, evidence_json ' +
        'FROM support_attestations WHERE profile_id = ? ORDER BY rowid'
    )
    .all(profileId) as unknown as Array<{
    id: string
    profile_id: string
    profile_revision: number
    decision: string
    installation_json: string
    evidence_json: string
  }>
  return rows.map(
    (r) =>
      ({
        id: r.id,
        profileId: r.profile_id,
        profileRevision: r.profile_revision,
        decision: r.decision,
        installation: JSON.parse(r.installation_json),
        evidence: JSON.parse(r.evidence_json)
      }) as unknown as SupportAttestation
  )
}

/* ------------------------------------------------------------------ *
 * harness.profile.register  (operator 또는 profile-maintainer)
 * ------------------------------------------------------------------ */

export interface HarnessProfileRegisterInput {
  /** optional caller-chosen id; minted when absent */
  profileId?: string
  executableLocator: string
  versionRange: string
  osRange?: string
  supportedComponents: string[]
  injectionRecipe: { routes: string[]; [k: string]: unknown }
  resumeRecipe?: unknown
  wakeRecipe?: unknown
  settingsPolicy?: unknown
}

export interface HarnessProfileRegisterResult {
  profileId: string
  revision: number
  admissionState: 'draft'
}

function validateRoutes(routes: string[]): void {
  for (const r of routes) {
    if (!(INJECTION_ROUTES as readonly string[]).includes(r)) {
      fail('MODEL_INVALID', `unknown injection route '${r}'`, {
        details: { allowedRoutes: INJECTION_ROUTES }
      })
    }
  }
}

/**
 * Register a new profile revision 1 in 'draft' state. Storage only — no
 * executable is run, no admission claimed. Arbitrary-executable approval is
 * an operator/maintainer grant question for authorize(); a plain worker
 * principal never reaches this handler with a passing grant.
 */
export function harnessProfileRegister(
  txn: TxnContext,
  payload: unknown,
  deps: RealizationDeps = {}
): HarnessProfileRegisterResult {
  const p = asRecord(payload, 'harness.profile.register payload')
  const requestedId = optString(p, 'profileId')
  const executableLocator = reqString(p, 'executableLocator')
  const versionRange = reqString(p, 'versionRange')
  const osRange = optString(p, 'osRange')

  const supportedRaw = reqArray(p, 'supportedComponents').map((k, i) => {
    if (typeof k !== 'string' || !(COMPONENT_KINDS as readonly string[]).includes(k)) {
      fail('MODEL_INVALID', `supportedComponents[${i}] must be one of ${COMPONENT_KINDS.join('|')}`)
    }
    return k as ComponentKind
  })
  const injectionRecipe = asRecord(p['injectionRecipe'], 'injectionRecipe')
  const routes = reqArray(injectionRecipe, 'routes').map((r, i) => {
    if (typeof r !== 'string')
      fail('MODEL_INVALID', `injectionRecipe.routes[${i}] must be a string`)
    return r
  })
  if (routes.length === 0) {
    fail('MODEL_INVALID', 'injectionRecipe.routes must declare at least one route')
  }
  validateRoutes(routes)

  const profileId = requestedId ?? mintId('hp')
  allow(deps)(txn.ctx, 'harness.profile.register', [{ kind: 'harnessProfile', id: profileId }])

  if (loadProfile(txn.db, profileId) !== undefined) {
    fail(
      'OPERATION_CONFLICT',
      `harness profile ${profileId} already exists — admit creates revisions`
    )
  }

  const executableIdentity: ExecutableIdentity = { locator: executableLocator, versionRange }
  if (osRange !== undefined) executableIdentity.osRange = osRange
  const capabilities: ProfileCapabilities = {
    supportedComponents: supportedRaw,
    injectionRoutes: routes,
    resume: p['resumeRecipe'] !== undefined && p['resumeRecipe'] !== null,
    wake: p['wakeRecipe'] !== undefined && p['wakeRecipe'] !== null
  }
  const recipe: ProfileRecipe = {
    recipeVersion: 1,
    injection: injectionRecipe,
    resume: p['resumeRecipe'] ?? null,
    wake: p['wakeRecipe'] ?? null,
    settingsPolicy: p['settingsPolicy'] ?? null
  }

  txn.db
    .prepare(
      'INSERT INTO harness_profiles (id, revision, state, recipe_json, capabilities_json, ' +
        'executable_identity_json) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      profileId,
      1,
      'draft',
      canonicalJson(recipe),
      canonicalJson(capabilities),
      canonicalJson(executableIdentity)
    )

  appendDomainEvent(
    txn.db,
    profileId,
    1,
    'harness.profile.registered',
    { profileId },
    { executableIdentity, supportedComponents: supportedRaw }
  )

  return { profileId, revision: 1, admissionState: 'draft' }
}

/* ------------------------------------------------------------------ *
 * harness.profile.inspect  (해당 profile 사용 권한)
 * ------------------------------------------------------------------ */

/** fresh observation of the installed executable — produced only by a real probe */
export interface InstallationObservation {
  executablePath?: string
  resolvedVersion?: string
  matchesDeclaredIdentity: boolean
  detail?: unknown
  observedAt: number
}

/**
 * The ONLY source of a live installation observation — injected by the
 * composition root (a host-backed prober, IMP-17/19 territory). When absent,
 * inspect honestly reports "not probed" instead of inventing version data.
 */
export type InstallationProbe = (
  profile: Pick<StoredProfile, 'profileId' | 'revision' | 'executableIdentity'>,
  hostId: string
) => InstallationObservation | Promise<InstallationObservation>

export interface RealizationDeps {
  probeInstallation?: InstallationProbe
  authorize?: (ctx: AuthenticatedContext, operation: string, targets: TargetRef[]) => void
}

function allow(
  deps: RealizationDeps
): (ctx: AuthenticatedContext, operation: string, targets: TargetRef[]) => void {
  return deps.authorize ?? defaultAuthorize
}

const SECRETISH = /secret|token|credential|password|api[-_]?key|private[-_]?key/i

/** strip secret/account material from echoed settings — contract: secret 설정 제외 */
function scrubSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubSecrets)
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = SECRETISH.test(k) ? '[redacted]' : scrubSecrets(val)
    }
    return out
  }
  return v
}

export interface HarnessProfileInspectInput {
  profileId: string
  revision?: number
  hostId?: string
}

export type { HarnessProfileInspectResult }

export async function harnessProfileInspect(
  txn: TxnContext,
  payload: unknown,
  deps: RealizationDeps = {}
): Promise<HarnessProfileInspectResult> {
  const p = asRecord(payload, 'harness.profile.inspect payload')
  const profileId = reqString(p, 'profileId')
  const revision = p['revision'] === undefined ? undefined : reqInteger(p, 'revision')
  const hostId = optString(p, 'hostId')

  allow(deps)(txn.ctx, 'harness.profile.inspect', [{ kind: 'harnessProfile', id: profileId }])

  const profile = loadProfile(txn.db, profileId, revision)
  if (profile === undefined) {
    fail('MODEL_INVALID', `unknown harness profile ${profileId}${revision ? `@${revision}` : ''}`)
  }

  // Probe I/O must not run inside the write transaction. Reads are done;
  // the observation is returned to the caller and not persisted here.
  let observation: InstallationObservation | null = null
  if (deps.probeInstallation !== undefined && hostId !== undefined) {
    observation = await deps.probeInstallation(
      {
        profileId: profile.profileId,
        revision: profile.revision,
        executableIdentity: profile.executableIdentity
      },
      hostId
    )
  }

  return {
    profileId: profile.profileId,
    revision: profile.revision,
    admissionState: profile.admissionState,
    executableIdentity: profile.executableIdentity,
    capabilities: profile.capabilities,
    recipeSummary: {
      recipeVersion: profile.recipe.recipeVersion,
      injectionRoutes: profile.capabilities.injectionRoutes,
      hasResumeRecipe: profile.capabilities.resume,
      hasWakeRecipe: profile.capabilities.wake,
      settingsPolicy: scrubSecrets(profile.recipe.settingsPolicy)
    },
    attestations: listAttestations(txn.db, profileId),
    installationObservation: observation
  }
}

/* ------------------------------------------------------------------ *
 * harness.profile.admit  (operator/profile 검증 책임자)
 * ------------------------------------------------------------------ */

/** evidence classes — 'documentation' alone can never carry 'verified' */
export type AttestationEvidenceKind =
  'install-observation' | 'test-launch' | 'recipe-exercise' | 'documentation' | 'other'

export interface AttestationEvidence {
  kind: AttestationEvidenceKind
  ref?: string
  summary?: string
  observedAt?: number
}

export type ProfileAdmissionDecision = 'verified' | 'documented' | 'disabled'

export interface HarnessProfileAdmitInput {
  profileId: string
  profileRevision: number
  attestation: {
    decision: ProfileAdmissionDecision
    installation?: unknown
    evidence?: AttestationEvidence[]
  }
  expectedExecutableIdentity: ExecutableIdentity
}

export interface HarnessProfileAdmitResult {
  profileId: string
  revision: number
  admissionState: ProfileAdmissionState
  attestationId: string
}

export const EVIDENCE_KINDS: readonly string[] = [
  'install-observation',
  'test-launch',
  'recipe-exercise',
  'documentation',
  'other'
]

/**
 * Record the SupportAttestation and mint the next profile revision with the
 * resulting admissionState. 'verified' demands real verification evidence —
 * a run that exercised install/recipe/test-launch; 'documentation' entries
 * describe a documented-in-verification-run profile, which lands as
 * 'documented', never as verified (instruction §4.5).
 */
export function harnessProfileAdmit(
  txn: TxnContext,
  payload: unknown,
  deps: RealizationDeps = {}
): HarnessProfileAdmitResult {
  const p = asRecord(payload, 'harness.profile.admit payload')
  const profileId = reqString(p, 'profileId')
  const profileRevision = reqInteger(p, 'profileRevision')
  const attestationRaw = asRecord(p['attestation'], 'attestation')
  const decision = reqString(attestationRaw, 'decision') as ProfileAdmissionDecision
  if (decision !== 'verified' && decision !== 'documented' && decision !== 'disabled') {
    fail('MODEL_INVALID', `attestation.decision must be verified|documented|disabled`)
  }
  const expectedIdentity = asRecord(p['expectedExecutableIdentity'], 'expectedExecutableIdentity')

  allow(deps)(txn.ctx, 'harness.profile.admit', [{ kind: 'harnessProfile', id: profileId }])

  const source = loadProfile(txn.db, profileId, profileRevision)
  if (source === undefined) {
    fail('STALE_REVISION', `unknown harness profile ${profileId}@${profileRevision}`, {
      retry: 'replan'
    })
  }

  // the attested executable must be the one this revision pins — verifying
  // a different binary and admitting this revision is a stale pin.
  if (digestOf(source.executableIdentity) !== digestOf(expectedIdentity)) {
    fail(
      'STALE_REVISION',
      `expectedExecutableIdentity does not match profile ${profileId}@${profileRevision} — ` +
        'the attestation covers a different executable',
      { retry: 'reconcile', details: { pinned: source.executableIdentity } }
    )
  }

  const evidence: AttestationEvidence[] = optArray(attestationRaw, 'evidence').map((e, i) => {
    const r = asRecord(e, `attestation.evidence[${i}]`)
    const kind = reqString(r, 'kind')
    if (!EVIDENCE_KINDS.includes(kind)) {
      fail('MODEL_INVALID', `attestation.evidence[${i}].kind unknown: ${kind}`)
    }
    const entry: AttestationEvidence = { kind: kind as AttestationEvidenceKind }
    const ref = optString(r, 'ref')
    const summary = optString(r, 'summary')
    if (ref !== undefined) entry.ref = ref
    if (summary !== undefined) entry.summary = summary
    if (typeof r['observedAt'] === 'number') entry.observedAt = r['observedAt']
    return entry
  })

  if (decision === 'verified') {
    const hasRunEvidence = evidence.some((e) => e.kind !== 'documentation')
    if (!hasRunEvidence) {
      fail(
        'MODEL_INVALID',
        'verified admission requires evidence from an actual verification run ' +
          '(install-observation / test-launch / recipe-exercise) — documentation-only ' +
          'profiles admit as documented, never verified',
        { details: { evidenceKinds: evidence.map((e) => e.kind) } }
      )
    }
  }

  const attestationId = mintId('att')
  txn.db
    .prepare(
      'INSERT INTO support_attestations (id, profile_id, profile_revision, decision, ' +
        'installation_json, evidence_json) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      attestationId,
      profileId,
      profileRevision,
      decision,
      canonicalJson(attestationRaw['installation'] ?? null),
      canonicalJson(evidence)
    )

  // revisions are immutable: admission mints a new revision carrying the
  // decided state; the attested source revision is untouched.
  const maxRow = txn.db
    .prepare('SELECT MAX(revision) AS m FROM harness_profiles WHERE id = ?')
    .get(profileId) as unknown as { m: number | null }
  const newRevision = (maxRow.m ?? profileRevision) + 1
  txn.db
    .prepare(
      'INSERT INTO harness_profiles (id, revision, state, recipe_json, capabilities_json, ' +
        'executable_identity_json) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      profileId,
      newRevision,
      decision,
      canonicalJson(source.recipe),
      canonicalJson(source.capabilities),
      canonicalJson(source.executableIdentity)
    )

  appendDomainEvent(
    txn.db,
    profileId,
    newRevision,
    'harness.profile.admitted',
    { profileId, attestedRevision: profileRevision },
    { decision, attestationId, evidenceKinds: evidence.map((e) => e.kind) }
  )

  return { profileId, revision: newRevision, admissionState: decision, attestationId }
}
