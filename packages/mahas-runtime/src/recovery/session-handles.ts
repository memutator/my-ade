// recovery/session-handles.ts — canonical HarnessSession/SessionHandle bridge.
//
// D-EXEC §1 / milestone stage A: executions.native_conversation_json is a
// LEGACY migration-compatibility field. The persistent identity of a native
// conversation is HarnessSession (harness + namespace + native session key)
// plus SessionHandle (installation, native id, resume support, locator), and a
// managed execution references that identity instead of owning a private copy.
//
// This module is the one place recovery code crosses that seam. It does three
// things and nothing else:
//
//   1. RESOLVE   an execution to its canonical session/handle using only exact
//                evidence: an explicit execution reference, an attachment row
//                for that execution, or session_handles.native_id equality.
//                A native id that matches nothing stays unresolved — no
//                suffix/prefix/title matching, no "closest" candidate.
//   2. BACKFILL  an explicit, idempotent conversion of a legacy handle into
//                canonical rows. It requires harness/installation evidence the
//                caller can name, and it never invents one. Re-running it
//                converges: session ids follow the collector's deterministic
//                identity, handle/attachment ids derive from the evidence, and
//                existing rows are left in place.
//   3. REFUSE    honestly. Anything not established exactly returns a typed
//                unresolved verdict with a reason, so the caller — and the
//                operator reading the report — sees "unknown", not a guess.
//
// Invariants this file must not break:
//   · discovering or converting a session NEVER creates a Task or an Execution
//     (milestone stage A: session discovery alone is not a Task/Execution).
//   · a session is never authoritative in two places: nothing here writes a
//     richer session state back into native_conversation_json.
//   · resumeSupport 'unknown' is not resumable. Only 'supported' is a positive
//     recipe; the legacy vocabulary's 'verified' maps to it with the raw string
//     preserved in the handle evidence.

import { createHash } from 'node:crypto'
import type { JsonObject } from '../../../mahas-contracts/src/common.ts'
import type {
  HarnessSession,
  SessionAttachment,
  SessionEvidenceRef,
  SessionHandle,
  SessionResumeSupport
} from '../../../mahas-contracts/src/sessions/index.ts'
import {
  findHarnessSession,
  getHarnessSession,
  listSessionHandles,
  putSessionAttachment,
  putSessionHandle,
  upsertHarnessSession
} from '../sessions/store.ts'
import {
  failure,
  loadExecution,
  tableExists,
  type DatabaseSync,
  type ExecutionRow,
  type NativeConversation,
  type RecoveryDeps
} from './ports.ts'
import { EXECUTION_SESSION_REF_TABLE } from './session-reference-migration.ts'
import {
  EXECUTION_SESSION_BACKFILL_STATE_TABLE,
  LEGACY_NATIVE_CONVERSATION_BACKFILL_ID
} from './session-reference-migration.ts'

/* ------------------------------------------------------------------ *
 * evidence vocabulary
 * ------------------------------------------------------------------ */

/** how a canonical session reference was established — never a guess */
export type SessionRefEvidence =
  'execution-reference' | 'execution-attachment' | 'native-id-handle' | 'explicit-selection'

export type SessionUnresolvedReason =
  | 'session-store-absent'
  | 'no-legacy-handle'
  | 'malformed-legacy-handle'
  | 'dangling-execution-reference'
  | 'ambiguous-execution-attachment'
  | 'ambiguous-native-id'
  | 'no-harness-evidence'
  | 'unknown-harness'
  | 'unknown-installation'
  | 'ambiguous-installation'
  | 'harness-conflict'
  /** the conversion itself failed — reported, never swallowed, never retried as a guess */
  | 'conversion-failed'

export interface CanonicalSessionRef {
  sessionId: string
  /** the handle carrying the resume recipe, when one is stored */
  handleId: string | null
  harnessId: string
  namespace: string
  nativeSessionKey: string
  nativeId: string | null
  installationId: string | null
  resumeSupport: SessionResumeSupport
  /** explicitly recorded harness profile evidence, when any exists */
  harnessProfileId: string | null
}

/** the honest negative: what could not be established, and why */
export interface SessionUnresolved {
  kind: 'unresolved'
  reason: SessionUnresolvedReason
  detail: string
}

export type SessionResolution =
  { kind: 'resolved'; ref: CanonicalSessionRef; evidence: SessionRefEvidence } | SessionUnresolved

function unresolved(reason: SessionUnresolvedReason, detail: string): SessionUnresolved {
  return { kind: 'unresolved', reason, detail }
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Legacy resume vocabulary → canonical SessionResumeSupport.
 *
 * 'verified' was the strongest legacy class and is admission-positive, so it
 * maps to 'supported'; the raw string stays in nativeResumeSupport and in the
 * handle evidence, which is where the collapsed distinction is still readable.
 * A missing or unrecognized state maps to 'unknown' and is never resumable.
 */
export function normalizeResumeSupport(value: unknown): SessionResumeSupport {
  if (value === 'supported' || value === 'verified') return 'supported'
  if (value === 'unsupported') return 'unsupported'
  return 'unknown'
}

export interface LegacyHandleFacts {
  harnessProfileId: string | null
  nativeId: string | null
  capturedBy: string | null
  capturedAt: number | null
  /** the raw recorded string, before normalization */
  nativeResumeSupport: string | null
  resumeSupport: SessionResumeSupport
  raw: NativeConversation
}

/** parse the legacy JSON column into facts; null when it holds no object */
export function legacyHandleFacts(handle: unknown): LegacyHandleFacts | null {
  if (typeof handle !== 'object' || handle === null || Array.isArray(handle)) return null
  const raw = handle as NativeConversation
  const recorded = raw.resumeSupport
  return {
    harnessProfileId: textOrNull(raw.harnessProfileId),
    nativeId: textOrNull(raw.nativeId),
    capturedBy: textOrNull(raw.capturedBy),
    capturedAt:
      typeof raw.capturedAt === 'number' && Number.isFinite(raw.capturedAt) ? raw.capturedAt : null,
    nativeResumeSupport: typeof recorded === 'string' ? recorded : null,
    resumeSupport: normalizeResumeSupport(recorded),
    raw
  }
}

/* ------------------------------------------------------------------ *
 * canonical store presence + identity derivation
 * ------------------------------------------------------------------ */

const SESSION_STORE_TABLES = ['harness_sessions', 'session_handles', 'session_attachments']

/** the canonical session fragment arrives with schema v2 (SESSION_SCHEMA_SQL) */
export function canonicalSessionStorePresent(db: DatabaseSync): boolean {
  return SESSION_STORE_TABLES.every((table) => tableExists(db, table))
}

function sha256OfParts(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/**
 * Deterministic session id for one native identity.
 *
 * This reproduces the collector's stableId('session', harnessId, namespace,
 * nativeSessionKey) formula (observation/collection/commit.ts) byte-for-byte:
 * the collector and the backfill must derive the SAME id for the same identity,
 * or upsertHarnessSession rejects the second writer as an identity conflict.
 * Requirement handed to the parent: move this into sessions/ and let both
 * callers import the one definition instead of holding two copies of it.
 */
export function stableSessionId(
  harnessId: string,
  namespace: string,
  nativeSessionKey: string
): string {
  return sha256OfParts(['session', harnessId, namespace, nativeSessionKey])
}

/** backfill handle id — derived from the evidence it was minted from */
export function stableSessionHandleId(sessionId: string, nativeId: string): string {
  return sha256OfParts(['session-handle-backfill', sessionId, nativeId])
}

/** backfill attachment id — one link per (execution, session) pair */
export function stableSessionAttachmentId(executionId: string, sessionId: string): string {
  return sha256OfParts(['session-attachment-backfill', executionId, sessionId])
}

function newestHandle(handles: readonly SessionHandle[]): SessionHandle | null {
  const sorted = [...handles].sort(
    (a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id)
  )
  return sorted[0] ?? null
}

function preferNativeId(
  handles: readonly SessionHandle[],
  nativeId: string | null
): SessionHandle | null {
  if (nativeId) {
    const exact = handles.filter((handle) => handle.nativeId === nativeId)
    if (exact.length > 0) return newestHandle(exact)
  }
  return newestHandle(handles)
}

/** explicit profile evidence: session metadata first, then the handle locator */
export function handleProfileEvidence(
  session: HarnessSession,
  handle: SessionHandle | null
): string | null {
  const fromMetadata = textOrNull((session.metadata ?? {})['harnessProfileId'])
  if (fromMetadata) return fromMetadata
  const locator = handle ? handle.locator : null
  if (!locator) return null
  return textOrNull(locator['harnessProfileId'])
}

function refOf(
  session: HarnessSession,
  handle: SessionHandle | null,
  facts: LegacyHandleFacts | null
): CanonicalSessionRef {
  return {
    sessionId: session.id,
    handleId: handle ? handle.id : null,
    harnessId: session.harnessId,
    namespace: session.namespace,
    nativeSessionKey: session.nativeSessionKey,
    nativeId: handle ? handle.nativeId : facts ? facts.nativeId : session.nativeSessionKey,
    installationId: handle ? (handle.installationId ?? null) : null,
    resumeSupport: handle ? handle.resumeSupport : 'unknown',
    harnessProfileId:
      handleProfileEvidence(session, handle) ?? (facts ? facts.harnessProfileId : null)
  }
}

interface AttachmentRow {
  id: string
  session_id: string
  installation_id: string | null
}

function attachmentsFor(db: DatabaseSync, executionId: string): AttachmentRow[] {
  return db
    .prepare(
      'SELECT id, session_id, installation_id FROM session_attachments' +
        ' WHERE execution_id=? ORDER BY observed_from DESC, id'
    )
    .all(executionId) as unknown as AttachmentRow[]
}

/* ------------------------------------------------------------------ *
 * 1. resolve — read-only, exact evidence only
 * ------------------------------------------------------------------ */

/**
 * Resolve one execution to its canonical session/handle.
 *
 * Order of evidence (first hit wins, each step exact):
 *   1. executions.session_id — an explicit canonical reference;
 *   2. a session_attachments row naming this execution;
 *   3. session_handles.native_id = <legacy nativeId> (exact equality).
 * Anything else is unresolved, with the reason the caller can report.
 */
export function resolveExecutionSession(
  db: DatabaseSync,
  execution: ExecutionRow
): SessionResolution {
  if (!canonicalSessionStorePresent(db)) {
    return unresolved(
      'session-store-absent',
      'harness_sessions/session_handles/session_attachments are not in this database — ' +
        'the canonical session store arrives with the session schema fragment'
    )
  }
  const facts = legacyHandleFacts(execution.nativeConversation)
  const nativeId = facts ? facts.nativeId : null

  if (execution.sessionId) {
    const session = getHarnessSession(db, execution.sessionId)
    if (!session) {
      return unresolved(
        'dangling-execution-reference',
        'executions.' +
          execution.id +
          '.session_id=' +
          execution.sessionId +
          ' has no harness_sessions row'
      )
    }
    const handles = listSessionHandles(db, session.id)
    const recorded = execution.sessionHandleId
      ? (handles.find((handle) => handle.id === execution.sessionHandleId) ?? null)
      : null
    return {
      kind: 'resolved',
      evidence: 'execution-reference',
      ref: refOf(session, recorded ?? preferNativeId(handles, nativeId), facts)
    }
  }

  const attachments = attachmentsFor(db, execution.id)
  const attachedSessions = [...new Set(attachments.map((row) => row.session_id))]
  if (attachedSessions.length > 1) {
    return unresolved(
      'ambiguous-execution-attachment',
      'execution ' +
        execution.id +
        ' is attached to ' +
        attachedSessions.length +
        ' canonical sessions (' +
        attachedSessions.join(', ') +
        ') — one must be chosen explicitly'
    )
  }
  if (attachedSessions.length === 1) {
    const session = getHarnessSession(db, attachedSessions[0] as string)
    if (!session) {
      return unresolved(
        'dangling-execution-reference',
        'session_attachments.' +
          attachments[0]!.id +
          ' names unknown session ' +
          attachedSessions[0]
      )
    }
    return {
      kind: 'resolved',
      evidence: 'execution-attachment',
      ref: refOf(session, preferNativeId(listSessionHandles(db, session.id), nativeId), facts)
    }
  }

  if (!facts) {
    return unresolved(
      'no-legacy-handle',
      'executions.' + execution.id + '.native_conversation_json holds no handle object'
    )
  }
  if (!facts.nativeId) {
    return unresolved(
      'malformed-legacy-handle',
      'executions.' +
        execution.id +
        '.native_conversation_json has no nativeId — no canonical key can be established'
    )
  }

  const rows = db
    .prepare('SELECT DISTINCT session_id FROM session_handles WHERE native_id=?')
    .all(facts.nativeId) as unknown as Array<{ session_id: string }>
  const sessionIds = [...new Set(rows.map((row) => row.session_id))]
  if (sessionIds.length > 1) {
    return unresolved(
      'ambiguous-native-id',
      'native id ' +
        facts.nativeId +
        ' belongs to ' +
        sessionIds.length +
        ' canonical sessions (' +
        sessionIds.join(', ') +
        ') — exact equality alone cannot pick one'
    )
  }
  if (sessionIds.length === 1) {
    const session = getHarnessSession(db, sessionIds[0] as string)
    if (!session) {
      return unresolved(
        'dangling-execution-reference',
        'session_handles.native_id=' + facts.nativeId + ' names unknown session ' + sessionIds[0]
      )
    }
    return {
      kind: 'resolved',
      evidence: 'native-id-handle',
      ref: refOf(session, preferNativeId(listSessionHandles(db, session.id), facts.nativeId), facts)
    }
  }

  return unresolved(
    'no-harness-evidence',
    'native id ' +
      facts.nativeId +
      ' matches no stored session handle and the legacy JSON ' +
      'carries no installation-qualified namespace — converting it needs explicit harness evidence'
  )
}

/* ------------------------------------------------------------------ *
 * 2. resume recipe selection — the canonical side of worker.resume
 * ------------------------------------------------------------------ */

export interface SessionRecipeSelection {
  sessionId?: string
  sessionHandleId?: string
  nativeId?: string
}

export type SessionRecipeResolution =
  | { kind: 'recipe'; ref: CanonicalSessionRef; evidence: SessionRefEvidence }
  | {
      kind: 'no-recipe'
      reason: 'session-not-found' | 'unsupported' | 'profile-not-evidenced'
      detail: string
    }
  | { kind: 'unresolved'; reason: SessionUnresolvedReason; detail: string }

/**
 * Pick the resume recipe for one execution from the CANONICAL store.
 *
 * A recipe is a SessionHandle with resumeSupport 'supported' on the session the
 * execution resolves to. When the launch plan pins a harness profile, the
 * handle (or its session metadata) must name that SAME profile: a changed role
 * still may not inherit a past conversation, and absent profile evidence is a
 * refusal rather than an implicit yes.
 */
export function resolveResumeRecipe(
  db: DatabaseSync,
  execution: ExecutionRow,
  options: { profileId?: string | null; selection?: SessionRecipeSelection } = {}
): SessionRecipeResolution {
  if (!canonicalSessionStorePresent(db)) {
    return unresolved(
      'session-store-absent',
      'harness_sessions/session_handles are not in this database'
    )
  }
  const facts = legacyHandleFacts(execution.nativeConversation)
  const selection = options.selection

  let session: HarnessSession | null = null
  let evidence: SessionRefEvidence = 'explicit-selection'
  let onlyHandleId: string | null = null

  if (selection && selection.sessionHandleId) {
    onlyHandleId = selection.sessionHandleId
    const row = db
      .prepare('SELECT session_id FROM session_handles WHERE id=?')
      .get(selection.sessionHandleId) as { session_id?: unknown } | undefined
    const sessionId = row ? textOrNull(row.session_id) : null
    if (!sessionId) {
      return {
        kind: 'no-recipe',
        reason: 'session-not-found',
        detail: 'session handle ' + selection.sessionHandleId + ' does not exist'
      }
    }
    session = getHarnessSession(db, sessionId)
  } else if (selection && selection.sessionId) {
    session = getHarnessSession(db, selection.sessionId)
  } else if (selection && selection.nativeId) {
    const rows = db
      .prepare('SELECT DISTINCT session_id FROM session_handles WHERE native_id=?')
      .all(selection.nativeId) as unknown as Array<{ session_id: string }>
    const sessionIds = [...new Set(rows.map((row) => row.session_id))]
    if (sessionIds.length > 1) {
      return unresolved(
        'ambiguous-native-id',
        'native id ' +
          selection.nativeId +
          ' belongs to ' +
          sessionIds.length +
          ' canonical sessions'
      )
    }
    if (sessionIds.length === 1) session = getHarnessSession(db, sessionIds[0] as string)
  } else {
    const resolved = resolveExecutionSession(db, execution)
    if (resolved.kind === 'unresolved') return resolved
    evidence = resolved.evidence
    session = getHarnessSession(db, resolved.ref.sessionId)
  }

  if (!session) {
    return {
      kind: 'no-recipe',
      reason: 'session-not-found',
      detail: 'no canonical session matches the selection for execution ' + execution.id
    }
  }
  const handles = listSessionHandles(db, session.id)
  const scoped = onlyHandleId ? handles.filter((handle) => handle.id === onlyHandleId) : handles
  const supported = scoped.filter((handle) => handle.resumeSupport === 'supported')
  if (supported.length === 0) {
    const recorded = scoped.map((handle) => handle.resumeSupport).join(', ')
    return {
      kind: 'no-recipe',
      reason: 'unsupported',
      detail:
        'session ' +
        session.id +
        ' has no handle declaring a supported resume recipe (recorded: ' +
        (recorded.length > 0 ? recorded : 'none') +
        ')'
    }
  }

  const wantedNativeId =
    selection && selection.nativeId ? selection.nativeId : facts ? facts.nativeId : null
  const matchingNative = wantedNativeId
    ? supported.filter((handle) => handle.nativeId === wantedNativeId)
    : []
  const candidates = matchingNative.length > 0 ? matchingNative : supported

  const profileId = textOrNull(options.profileId)
  const allowed = profileId
    ? candidates.filter((handle) => handleProfileEvidence(session, handle) === profileId)
    : candidates
  if (profileId && allowed.length === 0) {
    return {
      kind: 'no-recipe',
      reason: 'profile-not-evidenced',
      detail:
        'no supported handle of session ' +
        session.id +
        ' records harness profile ' +
        profileId +
        ' — a changed role may not inherit this conversation'
    }
  }

  return { kind: 'recipe', evidence, ref: refOf(session, newestHandle(allowed), facts) }
}

/* ------------------------------------------------------------------ *
 * 3. explicit legacy backfill — idempotent, evidence-required
 * ------------------------------------------------------------------ */

export interface HarnessEvidence {
  /** canonical catalog harness id the legacy profile belongs to */
  harnessId: string
  /**
   * the installation whose namespace qualifies native ids. Omitted means the
   * database must hold exactly ONE installation for that harness; zero or many
   * installations refuse the conversion as unknown/ambiguous instead of
   * picking one.
   */
  installationId?: string
  /** restrict candidate installations to one machine (the local machine id) */
  machineId?: string
  /**
   * Exact executable-path evidence (harness_profiles.executable_identity_json
   * .locator). Used ONLY as a tiebreaker when several installations of the
   * harness are registered: an exact string equality against
   * inventory_installations.executable_locator. Never a basename, prefix or
   * suffix comparison — an inexact match leaves the conversion ambiguous.
   */
  installationLocator?: string
  /** native namespace inside the installation (collector default: 'default') */
  namespace?: string
  /** why these values are known — recorded in the row evidence */
  basis: string
}

export interface BackfillInput {
  executionId: string
  /** required only when the conversion has to establish a new identity */
  harness?: HarnessEvidence
  /** run inside a caller-owned transaction (default: own deps.withTx) */
  inTransaction?: boolean
}

export interface BackfillOutcome {
  executionId: string
  status: 'migrated' | 'already-canonical' | 'unsupported'
  reason?: SessionUnresolvedReason
  detail?: string
  sessionId?: string
  handleId?: string | null
  attachmentId?: string | null
  /** true when this run recorded the canonical link for the execution */
  linked?: boolean
  /** true when the execution row's session reference columns were stamped */
  referenceStamped?: boolean
  created?: { session: boolean; handle: boolean; attachment: boolean }
}

interface InstallationRow {
  id: string
  machine_id: string
  harness_id: string
  data_namespace: string
  executable_locator: string | null
}

type InstallationLookup =
  | { kind: 'installation'; installation: InstallationRow }
  | { kind: 'refused'; reason: SessionUnresolvedReason; detail: string }

function refusal(reason: SessionUnresolvedReason, detail: string): InstallationLookup {
  return { kind: 'refused', reason, detail }
}

/**
 * Establish the installation that qualifies a legacy native id.
 * An explicit installationId must match the named harness; otherwise exactly
 * one registered installation of that harness is required. Nothing here probes
 * an executable or guesses a namespace from a path.
 */
function resolveInstallation(db: DatabaseSync, harness: HarnessEvidence): InstallationLookup {
  if (!tableExists(db, 'inventory_installations')) {
    return refusal(
      'unknown-installation',
      'inventory_installations is not in this database — no installation namespace is established'
    )
  }
  if (tableExists(db, 'catalog_harnesses')) {
    const known = db
      .prepare('SELECT 1 AS present FROM catalog_harnesses WHERE id=?')
      .get(harness.harnessId)
    if (!known) {
      return refusal(
        'unknown-harness',
        'catalog_harnesses has no row for ' +
          harness.harnessId +
          ' — the harness identity is not established'
      )
    }
  }
  const columns = 'id, machine_id, harness_id, data_namespace, executable_locator'
  if (harness.installationId) {
    const row = db
      .prepare('SELECT ' + columns + ' FROM inventory_installations WHERE id=?')
      .get(harness.installationId) as InstallationRow | undefined
    if (!row) {
      return refusal(
        'unknown-installation',
        'installation ' + harness.installationId + ' does not exist'
      )
    }
    if (row.harness_id !== harness.harnessId) {
      return refusal(
        'harness-conflict',
        'installation ' +
          row.id +
          ' belongs to harness ' +
          row.harness_id +
          ', not ' +
          harness.harnessId
      )
    }
    if (harness.machineId && row.machine_id !== harness.machineId) {
      return refusal(
        'harness-conflict',
        'installation ' +
          row.id +
          ' belongs to machine ' +
          row.machine_id +
          ', not ' +
          harness.machineId
      )
    }
    return { kind: 'installation', installation: row }
  }
  const machineFilter = harness.machineId ? ' AND machine_id=?' : ''
  const rows = db
    .prepare(
      'SELECT ' +
        columns +
        ' FROM inventory_installations WHERE harness_id=?' +
        machineFilter +
        ' ORDER BY id'
    )
    .all(
      ...(harness.machineId ? [harness.harnessId, harness.machineId] : [harness.harnessId])
    ) as unknown as InstallationRow[]
  if (rows.length === 0) {
    return refusal(
      'unknown-installation',
      'harness ' +
        harness.harnessId +
        (harness.machineId ? ' on machine ' + harness.machineId : '') +
        ' has no registered installation — the native namespace is unknown'
    )
  }
  if (rows.length === 1) return { kind: 'installation', installation: rows[0] as InstallationRow }

  // several installations of one harness: only EXACT path evidence may pick one
  const locator = harness.installationLocator
  if (locator) {
    const exact = rows.filter((row) => row.executable_locator === locator)
    if (exact.length === 1)
      return { kind: 'installation', installation: exact[0] as InstallationRow }
    return refusal(
      'ambiguous-installation',
      'harness ' +
        harness.harnessId +
        ' has ' +
        rows.length +
        ' installations (' +
        rows.map((row) => row.id).join(', ') +
        ') and ' +
        exact.length +
        ' of them record executable locator ' +
        locator +
        ' — pass the intended installationId'
    )
  }
  return refusal(
    'ambiguous-installation',
    'harness ' +
      harness.harnessId +
      ' has ' +
      rows.length +
      ' installations (' +
      rows.map((row) => row.id).join(', ') +
      ') — pass the intended installationId'
  )
}

/** the collector's installation-qualified namespace, reproduced exactly */
export interface InstallationNamespaceSource {
  id: string
  data_namespace: string
}

export function installationNamespace(
  installation: InstallationNamespaceSource,
  namespace: string
): string {
  return 'installation:' + installation.id + ':' + installation.data_namespace + ':' + namespace
}

/**
 * Record the explicit canonical reference (schema v3, additive table).
 *
 * The executions row itself is never rewritten: v1 DDL is frozen, and the
 * reference is a separate 1:1 row so that a migration cannot disturb launch
 * state. Absent table is not an error — session_attachments keeps carrying the
 * authoritative link and this remains the fast path. Recording the reference is
 * a real write, so its revision advances when the REFERENCE changes.
 *
 * evidence records how the reference was FIRST established (a legacy backfill or
 * an already-canonical link), which is why it is not part of the change test: a
 * later pass that merely re-reads the row may not rewrite its provenance, and
 * re-running the backfill must not churn revisions.
 */
function stampExecutionReference(
  db: DatabaseSync,
  deps: RecoveryDeps,
  execution: ExecutionRow,
  ref: CanonicalSessionRef,
  evidence: SessionRefEvidence | 'legacy-backfill'
): { available: boolean; written: boolean } {
  if (!tableExists(db, EXECUTION_SESSION_REF_TABLE)) return { available: false, written: false }
  const result = db
    .prepare(
      'INSERT INTO canonical_execution_sessions' +
        '(execution_id,session_id,session_handle_id,evidence,recorded_at,revision)' +
        ' VALUES(?,?,?,?,?,1)' +
        ' ON CONFLICT(execution_id) DO UPDATE SET' +
        ' session_id=excluded.session_id, session_handle_id=excluded.session_handle_id,' +
        ' evidence=excluded.evidence, recorded_at=excluded.recorded_at,' +
        ' revision=canonical_execution_sessions.revision+1' +
        ' WHERE canonical_execution_sessions.session_id IS NOT excluded.session_id' +
        ' OR canonical_execution_sessions.session_handle_id IS NOT excluded.session_handle_id'
    )
    .run(execution.id, ref.sessionId, ref.handleId, evidence, deps.now())
  return { available: true, written: Number(result.changes ?? 0) > 0 }
}

interface LinkTarget {
  installationId: string | null
  machineId: string | null
}

/** machine identity for one execution→session link, from explicit rows only */
function linkTarget(
  db: DatabaseSync,
  ref: CanonicalSessionRef,
  session: HarnessSession
): LinkTarget {
  let installationId = ref.installationId
  if (!installationId) {
    const row = db
      .prepare(
        'SELECT installation_id FROM session_handles WHERE session_id=? AND installation_id IS NOT NULL' +
          ' ORDER BY observed_at DESC, id LIMIT 1'
      )
      .get(session.id) as { installation_id?: unknown } | undefined
    installationId = row ? textOrNull(row.installation_id) : null
  }
  if (installationId) {
    const installation = db
      .prepare('SELECT machine_id FROM inventory_installations WHERE id=?')
      .get(installationId) as { machine_id?: unknown } | undefined
    const machineId = installation ? textOrNull(installation.machine_id) : null
    if (machineId) return { installationId, machineId }
  }
  return { installationId, machineId: session.originMachineId ?? null }
}

/**
 * Record the execution→session link for an already-canonical resolution.
 * Insert-if-absent: an attachment the collector closed (observed_until set) is
 * never reopened by a migration re-run.
 */
function linkExecution(
  db: DatabaseSync,
  deps: RecoveryDeps,
  execution: ExecutionRow,
  session: HarnessSession,
  ref: CanonicalSessionRef,
  evidence: SessionRefEvidence | 'legacy-backfill',
  basis: string
): { attachmentId: string | null; created: boolean; detail?: string } {
  const target = linkTarget(db, ref, session)
  if (!target.machineId) {
    return {
      attachmentId: null,
      created: false,
      detail:
        'no installation/machine is recorded for this session — the execution link was not written'
    }
  }
  const attachmentId = stableSessionAttachmentId(execution.id, session.id)
  const existing = db
    .prepare('SELECT 1 AS present FROM session_attachments WHERE id=?')
    .get(attachmentId)
  if (existing) return { attachmentId, created: false }

  const facts = legacyHandleFacts(execution.nativeConversation)
  const attachment: SessionAttachment = {
    id: attachmentId,
    sessionId: session.id,
    installationId: target.installationId,
    machineId: target.machineId,
    processIdentity: execution.processIdentity ?? null,
    executionId: execution.id,
    dispatchId: null,
    observedFrom: facts && facts.capturedAt !== null ? facts.capturedAt : deps.now(),
    observedUntil: null,
    evidence: [
      {
        sourceId: 'executions:' + execution.id,
        sourceRecordKey: 'native_conversation_json',
        description:
          'session link recorded by the canonical session bridge (' + evidence + '; ' + basis + ')'
      }
    ]
  }
  putSessionAttachment(db, attachment)
  return { attachmentId, created: true }
}

function convertExecution(
  deps: RecoveryDeps,
  db: DatabaseSync,
  input: BackfillInput
): BackfillOutcome {
  const execution = loadExecution(db, input.executionId)
  if (!execution) {
    throw failure(
      'INVALID_TRANSITION',
      'execution ' + input.executionId + ' does not exist',
      'none'
    )
  }
  const resolution = resolveExecutionSession(db, execution)

  if (resolution.kind === 'resolved') {
    const ref = resolution.ref
    const session = getHarnessSession(db, ref.sessionId)
    if (!session) {
      return {
        executionId: execution.id,
        status: 'unsupported',
        reason: 'dangling-execution-reference',
        detail: ref.sessionId
      }
    }
    const linked = linkExecution(
      db,
      deps,
      execution,
      session,
      ref,
      resolution.evidence,
      'already canonical'
    )
    const stamped = stampExecutionReference(db, deps, execution, ref, resolution.evidence)
    return {
      executionId: execution.id,
      status: 'already-canonical',
      sessionId: ref.sessionId,
      handleId: ref.handleId,
      attachmentId: linked.attachmentId,
      linked: linked.created,
      referenceStamped: stamped.written,
      ...(linked.detail ? { detail: linked.detail } : {})
    }
  }

  const facts = legacyHandleFacts(execution.nativeConversation)
  if (!facts || !facts.nativeId) {
    return {
      executionId: execution.id,
      status: 'unsupported',
      reason: resolution.reason,
      detail: resolution.detail
    }
  }
  if (!input.harness) {
    return {
      executionId: execution.id,
      status: 'unsupported',
      reason: 'no-harness-evidence',
      detail:
        'execution ' +
        execution.id +
        ' has legacy handle ' +
        facts.nativeId +
        ' but no explicit harness evidence was supplied'
    }
  }
  const harness = input.harness
  const lookup = resolveInstallation(db, harness)
  if (lookup.kind === 'refused') {
    return {
      executionId: execution.id,
      status: 'unsupported',
      reason: lookup.reason,
      detail: lookup.detail
    }
  }

  const installation = lookup.installation
  const namespace = installationNamespace(installation, harness.namespace ?? 'default')
  const observedAt = facts.capturedAt !== null ? facts.capturedAt : deps.now()
  const existing = findHarnessSession(db, harness.harnessId, namespace, facts.nativeId)
  const sessionId = existing
    ? existing.id
    : stableSessionId(harness.harnessId, namespace, facts.nativeId)

  const metadata: JsonObject = {
    ...(facts.harnessProfileId ? { harnessProfileId: facts.harnessProfileId } : {}),
    sessionOrigin: 'legacy-native-conversation-backfill',
    legacySource: 'executions.' + execution.id + '.native_conversation_json'
  }
  const session = upsertHarnessSession(db, {
    id: sessionId,
    harnessId: harness.harnessId,
    originMachineId: installation.machine_id,
    namespace,
    nativeSessionKey: facts.nativeId,
    parentSessionId: null,
    title: null,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    metadata
  })

  const evidence: SessionEvidenceRef = {
    sourceId: 'executions:' + execution.id,
    sourceRecordKey: 'native_conversation_json',
    description:
      'legacy native handle (resumeSupport=' +
      (facts.nativeResumeSupport ?? 'unknown') +
      (facts.capturedBy ? ', capturedBy=' + facts.capturedBy : '') +
      '); harness evidence: ' +
      harness.basis
  }
  const locator: JsonObject = {
    source: 'legacy-native-conversation',
    ...(facts.harnessProfileId ? { harnessProfileId: facts.harnessProfileId } : {}),
    ...(facts.capturedBy ? { capturedBy: facts.capturedBy } : {})
  }
  const handleId = stableSessionHandleId(session.id, facts.nativeId)
  const handleBefore = db
    .prepare('SELECT 1 AS present FROM session_handles WHERE id=?')
    .get(handleId)
  putSessionHandle(db, {
    id: handleId,
    sessionId: session.id,
    installationId: installation.id,
    nativeId: facts.nativeId,
    locator,
    resumeSupport: facts.resumeSupport,
    observedAt,
    evidence: [evidence]
  })

  const ref: CanonicalSessionRef = {
    sessionId: session.id,
    handleId,
    harnessId: session.harnessId,
    namespace: session.namespace,
    nativeSessionKey: session.nativeSessionKey,
    nativeId: facts.nativeId,
    installationId: installation.id,
    resumeSupport: facts.resumeSupport,
    harnessProfileId: facts.harnessProfileId
  }
  const linked = linkExecution(db, deps, execution, session, ref, 'legacy-backfill', harness.basis)
  const stamped = stampExecutionReference(db, deps, execution, ref, 'legacy-backfill')

  deps.appendDomainEvent(
    db,
    execution.id,
    execution.revision + (stamped.written ? 1 : 0) + 1,
    'execution.session-reference-migrated',
    { operation: 'session.legacy-backfill', priorExecutionId: execution.id },
    {
      sessionId: session.id,
      handleId,
      harnessId: session.harnessId,
      namespace: session.namespace,
      nativeId: facts.nativeId,
      installationId: installation.id,
      resumeSupport: facts.resumeSupport,
      basis: harness.basis
    }
  )

  return {
    executionId: execution.id,
    status: 'migrated',
    sessionId: session.id,
    handleId,
    attachmentId: linked.attachmentId,
    linked: linked.created,
    referenceStamped: stamped.written,
    created: {
      session: existing === null,
      handle: handleBefore === undefined,
      attachment: linked.created
    },
    ...(linked.detail ? { detail: linked.detail } : {})
  }
}

/** Convert one execution's legacy handle into canonical session/handle rows. */
export function backfillExecutionSession(
  deps: RecoveryDeps,
  db: DatabaseSync,
  input: BackfillInput
): BackfillOutcome {
  if (input.inTransaction) return convertExecution(deps, db, input)
  return deps.withTx(db, (tx) => convertExecution(deps, tx, input))
}

/* ------------------------------------------------------------------ *
 * bounded batch driver
 * ------------------------------------------------------------------ */

export interface LegacyBackfillPointer {
  executionId: string
  memberId: string
  state: string
  harnessProfileId: string | null
  nativeId: string | null
  capturedBy: string | null
  capturedAt: number | null
  resumeSupport: SessionResumeSupport
}

export interface LegacyBackfillPlan {
  /**
   * Explicit harness/installation evidence for a legacy harness profile.
   * Returning null is a legitimate answer: the execution is then reported as
   * unresolved instead of being converted on a guess.
   */
  resolveHarness: (pointer: LegacyBackfillPointer) => HarnessEvidence | null
  /** explicit subset; when omitted, executions carrying legacy JSON are scanned */
  executionIds?: readonly string[]
  /** stable page cursor from the previous report (rowid order) */
  afterExecutionId?: string | null
  limit?: number
}

export interface LegacyBackfillReport {
  scanned: number
  migrated: number
  alreadyCanonical: number
  unsupported: Array<{ executionId: string; reason: SessionUnresolvedReason; detail: string }>
  outcomes: BackfillOutcome[]
  cursor: { afterExecutionId: string | null; exhausted: boolean }
}

const LEGACY_JSON_GUARD =
  "native_conversation_json IS NOT NULL AND native_conversation_json NOT IN ('', '{}', 'null')"

function scanLegacyExecutionIds(
  db: DatabaseSync,
  afterExecutionId: string | null,
  limit: number
): string[] {
  let cursorRowid: number | null = null
  if (afterExecutionId) {
    const row = db
      .prepare('SELECT rowid AS rid FROM executions WHERE id=?')
      .get(afterExecutionId) as { rid?: unknown } | undefined
    cursorRowid = typeof row?.rid === 'number' ? row.rid : null
  }
  const rows = (cursorRowid === null
    ? db
        .prepare('SELECT id FROM executions WHERE ' + LEGACY_JSON_GUARD + ' ORDER BY rowid LIMIT ?')
        .all(limit)
    : db
        .prepare(
          'SELECT id FROM executions WHERE ' +
            LEGACY_JSON_GUARD +
            ' AND rowid > ? ORDER BY rowid LIMIT ?'
        )
        .all(cursorRowid, limit)) as unknown as Array<{ id: string }>
  return rows.map((row) => row.id)
}

/**
 * Idempotent, bounded, explicitly driven backfill of legacy native handles.
 *
 * Bounded: at most limit executions per call, and the returned cursor lets the
 * caller resume exactly where it stopped. Idempotent: a second pass over the
 * same rows reports 'already-canonical' (or re-reports 'unsupported') and writes
 * nothing, because every id it creates derives from the evidence it was given.
 */
export function backfillLegacyExecutionSessions(
  deps: RecoveryDeps,
  db: DatabaseSync,
  plan: LegacyBackfillPlan
): LegacyBackfillReport {
  const limit = Math.max(1, Math.min(plan.limit ?? 100, 500))
  const ids = plan.executionIds
    ? [...plan.executionIds].slice(0, limit)
    : scanLegacyExecutionIds(db, plan.afterExecutionId ?? null, limit)

  const outcomes: BackfillOutcome[] = []
  const unsupported: LegacyBackfillReport['unsupported'] = []
  let migrated = 0
  let alreadyCanonical = 0

  for (const id of ids) {
    const execution = loadExecution(db, id)
    if (!execution) {
      unsupported.push({
        executionId: id,
        reason: 'no-legacy-handle',
        detail: 'execution row disappeared between the scan and the conversion'
      })
      continue
    }
    const facts = legacyHandleFacts(execution.nativeConversation)
    const harness =
      execution.sessionId !== null
        ? undefined
        : plan.resolveHarness({
            executionId: execution.id,
            memberId: execution.memberId,
            state: execution.state,
            harnessProfileId: facts ? facts.harnessProfileId : null,
            nativeId: facts ? facts.nativeId : null,
            capturedBy: facts ? facts.capturedBy : null,
            capturedAt: facts ? facts.capturedAt : null,
            resumeSupport: facts ? facts.resumeSupport : 'unknown'
          })

    let outcome: BackfillOutcome
    try {
      outcome = backfillExecutionSession(deps, db, {
        executionId: execution.id,
        ...(harness ? { harness } : {})
      })
    } catch (error) {
      // one unconvertible row must not abort the pass: this driver runs from a
      // discovery refresh, and a thrown row would take the refresh down with it
      unsupported.push({
        executionId: execution.id,
        reason: 'conversion-failed',
        detail: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    outcomes.push(outcome)
    if (outcome.status === 'migrated') migrated += 1
    else if (outcome.status === 'already-canonical') alreadyCanonical += 1
    else {
      unsupported.push({
        executionId: outcome.executionId,
        reason: outcome.reason ?? 'no-harness-evidence',
        detail: outcome.detail ?? 'unsupported'
      })
    }
  }

  const last = ids.length > 0 ? (ids[ids.length - 1] as string) : null
  return {
    scanned: ids.length,
    migrated,
    alreadyCanonical,
    unsupported,
    outcomes,
    cursor: { afterExecutionId: last, exhausted: ids.length < limit }
  }
}

/* ------------------------------------------------------------------ *
 * repeatable pass — startup + every discovery refresh
 * ------------------------------------------------------------------ */

export interface ExecutionSessionBackfillPassPlan extends LegacyBackfillPlan {
  /** persist progress in canonical_execution_session_backfill (default true) */
  persistCursor?: boolean
}

export interface ExecutionSessionBackfillPassResult extends LegacyBackfillReport {
  /** where this pass started (null = the beginning of the scan) */
  fromCursor: string | null
  /** this pass reached the end; the next one restarts from the beginning */
  wrapped: boolean
  /** the progress row was written (state table present and not disabled) */
  cursorPersisted: boolean
  /** cursor for the next pass (null = restart from the beginning) */
  nextCursor: string | null
}

interface BackfillStateRow {
  cursor_execution_id: string | null
  revision: number
}

function readBackfillState(db: DatabaseSync): BackfillStateRow | null {
  const row = db
    .prepare(
      'SELECT cursor_execution_id, revision FROM ' +
        EXECUTION_SESSION_BACKFILL_STATE_TABLE +
        ' WHERE id=?'
    )
    .get(LEGACY_NATIVE_CONVERSATION_BACKFILL_ID) as BackfillStateRow | undefined
  return row ?? null
}

/**
 * One bounded, resumable backfill pass.
 *
 * Discovery is asynchronous: harness installations only appear once the
 * collection scheduler has run, so a single startup pass would see empty
 * inventory and classify every legacy handle as unsupported — permanently, if
 * nothing looked again. This runner therefore:
 *   · continues from the persisted cursor (bounded work per pass);
 *   · wraps to the beginning when the scan reaches the end, so an execution
 *     that was unsupported because its installation was not yet discovered is
 *     retried on a later pass;
 *   · stays idempotent — re-visiting a converted execution writes nothing.
 *
 * Wiring: call once at startup (before the service reports ready) and again
 * from the discovery refresh hook (composition: options.afterRefresh(db,
 * machine)), passing the same RecoveryDeps object used for registerRecoveryOps.
 */
export function runExecutionSessionBackfillPass(
  deps: RecoveryDeps,
  db: DatabaseSync,
  plan: ExecutionSessionBackfillPassPlan
): ExecutionSessionBackfillPassResult {
  const persist =
    plan.persistCursor !== false && tableExists(db, EXECUTION_SESSION_BACKFILL_STATE_TABLE)
  const state = persist ? readBackfillState(db) : null
  const fromCursor = plan.afterExecutionId ?? (state ? state.cursor_execution_id : null)

  const report = backfillLegacyExecutionSessions(deps, db, {
    ...plan,
    afterExecutionId: fromCursor
  })
  const wrapped = report.cursor.exhausted
  const nextCursor = wrapped ? null : report.cursor.afterExecutionId

  let cursorPersisted = false
  let cursorError: string | undefined
  if (persist) {
    try {
      deps.withTx(db, (tx) => {
        tx.prepare(
          'INSERT INTO ' +
            EXECUTION_SESSION_BACKFILL_STATE_TABLE +
            '(id,cursor_execution_id,migrated,unresolved,updated_at,revision)' +
            ' VALUES(?,?,?,?,?,1)' +
            ' ON CONFLICT(id) DO UPDATE SET' +
            ' cursor_execution_id=excluded.cursor_execution_id,' +
            ' migrated=' +
            EXECUTION_SESSION_BACKFILL_STATE_TABLE +
            '.migrated+excluded.migrated,' +
            ' unresolved=excluded.unresolved, updated_at=excluded.updated_at,' +
            ' revision=' +
            EXECUTION_SESSION_BACKFILL_STATE_TABLE +
            '.revision+1'
        ).run(
          LEGACY_NATIVE_CONVERSATION_BACKFILL_ID,
          nextCursor,
          report.migrated,
          report.unsupported.length,
          deps.now()
        )
      })
      cursorPersisted = true
    } catch (error) {
      // losing the cursor costs progress bookkeeping, not a conversion: the pass
      // must not fail the refresh that called it
      cursorError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    ...report,
    fromCursor,
    wrapped,
    cursorPersisted,
    nextCursor,
    ...(cursorError ? { cursorError } : {})
  }
}
