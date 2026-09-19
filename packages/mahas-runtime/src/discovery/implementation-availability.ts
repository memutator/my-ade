// mahas-runtime/src/discovery/implementation-availability.ts —
// implementation support assembly, shared by CandidateCard and the
// role.implementations operation.
//
// Returns publication metadata only: implementation revision, interface
// digest, profile identity, support state, blockers. Component bodies,
// binding_json internals and secret launch data never leave the store
// (C-DISCOVERY: "implementation의 내부 파일 본문은 없다", "secret launch
// data 제외"). Support state distinguishes documented vs verified
// (harness_profiles.state / support_attestations.decision); nothing here
// is a promise a future launch succeeds — observedAt stamps the read.
//
// IMPLEMENTATION_MISSING is a result state, never an exception and never
// a fallback harness pick.

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { DiscoveryDeps } from './deps.ts'
import { asTargetRefs } from './deps.ts'
import {
  componentKindsForImpl,
  eventHighWater,
  getProfile,
  getRole,
  implementationsForDigests,
  interfaceDigestsForRole,
  latestAttestation,
  resolveModelVersion,
  sha256Hex
} from './model-read.ts'
import { discoveryError, target } from './types.ts'
import type {
  AvailabilityBlocker,
  ImplementationAvailability,
  ImplementationsRequest,
  ImplementationsResult
} from './types.ts'

export interface AvailabilityQuery {
  hostId?: string
  componentNeeds?: string[]
  observedAt: number
}

function profileSupportedComponents(capabilitiesJson: string): string[] {
  try {
    const parsed = JSON.parse(capabilitiesJson) as { supportedComponents?: unknown }
    if (Array.isArray(parsed?.supportedComponents))
      return parsed.supportedComponents.filter((c): c is string => typeof c === 'string')
  } catch {
    // malformed capabilities are a data defect — treat as no declared support
  }
  return []
}

/**
 * Host identity in installation evidence — exact field match, never a
 * substring (empty hostId must not vacuously pass).
 */
export function attestationMentionsHost(installationJson: string, hostId: string): boolean {
  if (typeof hostId !== 'string' || hostId.length === 0) return false
  try {
    const parsed = JSON.parse(installationJson) as unknown
    return jsonMentionsHost(parsed, hostId)
  } catch {
    return false
  }
}

function jsonMentionsHost(v: unknown, hostId: string): boolean {
  if (v === hostId) return true
  if (Array.isArray(v)) return v.some((x) => jsonMentionsHost(x, hostId))
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of ['hostId', 'host_id', 'host']) {
      if (o[key] === hostId) return true
    }
    if (Array.isArray(o.hostIds) && o.hostIds.includes(hostId)) return true
    return Object.values(o).some((x) => jsonMentionsHost(x, hostId))
  }
  return false
}

/** digest of one shown implementation — assign re-checks this pin */
export function implementationPinDigest(impl: {
  id: string
  revision: number
  interfaceDigest?: string
  interface_digest?: string
  profileId?: string
  profile_id?: string
  profileRevision?: number
  profile_revision?: number
  status?: string
}): string {
  const body = JSON.stringify({
    id: impl.id,
    interfaceDigest: impl.interfaceDigest ?? impl.interface_digest ?? '',
    profileId: impl.profileId ?? impl.profile_id ?? '',
    profileRevision: impl.profileRevision ?? impl.profile_revision ?? 0,
    revision: impl.revision,
    status: impl.status ?? 'published'
  })
  return sha256Hex(body)
}

/** digest of the published candidate set shown on a card (sorted id@rev) */
export function implementationSetDigest(
  items: readonly { implementationId: string; revision: number }[]
): string {
  const rows = items
    .map((i) => ({ id: i.implementationId, revision: i.revision }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision)
  return sha256Hex(JSON.stringify(rows))
}

/**
 * Published implementations satisfying a role's stored interface digests,
 * each with support state + blockers. Candidate/draft/retired revisions
 * are excluded from new selection.
 */
export function availabilityForRole(
  db: DatabaseSync,
  modelVersion: string,
  roleId: string,
  query: AvailabilityQuery
): { interfaceDigests: string[]; items: ImplementationAvailability[] } {
  const interfaceDigests = interfaceDigestsForRole(db, modelVersion, roleId)
  const impls = implementationsForDigests(db, interfaceDigests).filter(
    (i) => i.status === 'published'
  )
  const items: ImplementationAvailability[] = []
  for (const impl of impls) {
    const blockers: AvailabilityBlocker[] = []
    const profile = getProfile(db, impl.profile_id, impl.profile_revision)
    const profileState = profile?.state ?? 'unknown'
    const attestation = latestAttestation(db, impl.profile_id, impl.profile_revision)

    // effective support: the latest attestation decision wins over the
    // stored profile admission state (an admitted verified profile may be
    // disabled later, and vice versa is NOT allowed — disabled wins)
    let support: ImplementationAvailability['support'] = 'unknown'
    const effective =
      attestation?.decision === 'disabled' || profileState === 'disabled'
        ? 'disabled'
        : (attestation?.decision ?? profileState)
    if (effective === 'verified' || effective === 'documented' || effective === 'draft')
      support = effective
    else if (effective === 'disabled') support = 'disabled'

    if (profile === undefined)
      blockers.push({
        kind: 'profile-admission',
        detail: `harness profile ${impl.profile_id}@${impl.profile_revision} not found`
      })
    else if (profileState !== 'verified')
      blockers.push({
        kind: 'profile-admission',
        detail: `harness profile state '${profileState}' (not verified)`
      })

    if (query.hostId !== undefined) {
      const ok =
        attestation !== undefined &&
        attestation.decision === 'verified' &&
        attestationMentionsHost(attestation.installation_json, query.hostId)
      if (!ok)
        blockers.push({
          kind: 'host-unverified',
          detail: `no verified support attestation ties this profile to host ${query.hostId}`
        })
    }

    if (interfaceDigests.length > 1 && impl.interface_digest !== interfaceDigests[0])
      blockers.push({
        kind: 'interface-ambiguous',
        detail: 'role has multiple stored interface digests; team.assign must re-verify'
      })

    if (query.componentNeeds !== undefined && query.componentNeeds.length > 0) {
      const implKinds = new Set(componentKindsForImpl(db, impl.id, impl.revision))
      const profileKinds = new Set(
        profile === undefined ? [] : profileSupportedComponents(profile.capabilities_json)
      )
      const missing = query.componentNeeds.filter((n) => !implKinds.has(n) || !profileKinds.has(n))
      if (missing.length > 0)
        blockers.push({
          kind: 'component-unsupported',
          detail: `component needs not covered: ${missing.join(', ')}`
        })
    }

    items.push({
      implementationId: impl.id,
      revision: impl.revision,
      interfaceDigest: impl.interface_digest,
      profileId: impl.profile_id,
      profileRevision: impl.profile_revision,
      status: impl.status,
      profileState,
      support,
      blockers,
      observedAt: query.observedAt
    })
  }
  return { interfaceDigests, items }
}

// ---------------------------------------------------------------------------
// role.implementations — role 읽기와 discovery 권한
// ---------------------------------------------------------------------------

export function validateImplementationsRequest(payload: unknown): ImplementationsRequest {
  const p = payload as Partial<ImplementationsRequest>
  if (typeof p?.modelVersion !== 'string' || p.modelVersion.length === 0)
    throw discoveryError('MODEL_INVALID', 'role.implementations requires modelVersion')
  if (typeof p?.roleId !== 'string' || p.roleId.length === 0)
    throw discoveryError('MODEL_INVALID', 'role.implementations requires roleId')
  if (p.hostId !== undefined && typeof p.hostId !== 'string')
    throw discoveryError('MODEL_INVALID', 'hostId must be a string')
  if (p.componentNeeds !== undefined) {
    if (!Array.isArray(p.componentNeeds) || p.componentNeeds.some((c) => typeof c !== 'string'))
      throw discoveryError('MODEL_INVALID', 'componentNeeds must be a string array')
  }
  return {
    modelVersion: p.modelVersion,
    roleId: p.roleId,
    ...(p.hostId !== undefined ? { hostId: p.hostId } : {}),
    ...(p.componentNeeds !== undefined ? { componentNeeds: p.componentNeeds } : {})
  }
}

export function roleImplementations(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  deps: DiscoveryDeps,
  payload: unknown
): ImplementationsResult {
  const req = validateImplementationsRequest(payload)

  // the op pins an explicit snapshot; it must exist (project membership is
  // enforced through the role's model, not a caller claim)
  const mv = resolveModelVersion(db, projectOf(db, req.modelVersion), req.modelVersion)

  const role = getRole(db, mv.id, req.roleId)
  if (role === undefined)
    throw discoveryError('NO_RESPONSIBLE_ROLE', 'role not found in model snapshot', {
      modelVersion: mv.id,
      roleId: req.roleId
    })

  deps.authorize(
    ctx,
    'role.implementations',
    asTargetRefs([
      target('modelVersion', mv.id),
      target('role', req.roleId),
      target('boundary', role.boundary_id)
    ])
  )

  const observedAt = deps.now !== undefined ? deps.now() : Date.now()
  const { interfaceDigests, items } = availabilityForRole(db, mv.id, req.roleId, {
    ...(req.hostId !== undefined ? { hostId: req.hostId } : {}),
    ...(req.componentNeeds !== undefined ? { componentNeeds: req.componentNeeds } : {}),
    observedAt
  })

  // componentNeeds is a filter: unmet impls are reported separately, never
  // silently dropped and never silently kept
  const needs = req.componentNeeds ?? []
  const kept: ImplementationAvailability[] = []
  const excluded: ImplementationsResult['excluded'] = []
  for (const item of items) {
    const unmet = item.blockers.find((b) => b.kind === 'component-unsupported')
    if (needs.length > 0 && unmet !== undefined) {
      const implKinds = new Set(componentKindsForImpl(db, item.implementationId, item.revision))
      excluded.push({
        implementationId: item.implementationId,
        revision: item.revision,
        missingNeeds: needs.filter((n) => !implKinds.has(n))
      })
    } else kept.push(item)
  }

  return {
    modelVersion: mv.id,
    roleId: req.roleId,
    snapshotRevision: eventHighWater(db),
    interfaceDigests,
    status: kept.length > 0 ? 'ok' : 'implementation-missing',
    implementations: kept,
    excluded
  }
}

function projectOf(db: DatabaseSync, modelVersion: string): string {
  const r = db.prepare('SELECT project_id FROM model_versions WHERE id = ?').get(modelVersion) as
    { project_id: string } | undefined
  if (r === undefined)
    throw discoveryError('MODEL_INVALID', 'unknown modelVersion', { modelVersion })
  return r.project_id
}
