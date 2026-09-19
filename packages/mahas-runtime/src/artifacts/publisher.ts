// mahas-runtime/artifacts — artifact.publish (C-MAIL).
//
// Semantics (spec/domains/messaging-outcomes.md §3, C-MAIL artifact.publish):
//   * Producer = the CURRENT dispatch of the calling member — the dispatch
//     must belong to ctx.memberId, be authority_state='active' and run on
//     the caller's consumer generation (STALE_EXECUTION otherwise).
//   * 'file' source: bytes are read from the producer's own checkout scope,
//     hashed, and preserved into the content-addressed store via
//     putContentBlob — a live workspace path by itself is never an accepted
//     artifact. expectedDigest is re-verified against the actual bytes.
//   * 'git-commit' source: the commit OBJECT's existence is verified inside
//     the checkout's repository (rev-parse ^{commit}); the artifact digest
//     is the canonical commit sha. A retention pin on the git object is
//     recorded in the same transaction (retention intent → metadata commit).
//   * exact (id, revision) immutability: publish always creates revision 1
//     of a fresh artifact id; nothing here mutates an existing row.

import { isAbsolute, normalize, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { OperationHandler } from '../api/registry.ts'
import type { Id, Revision } from '../../../mahas-contracts/src/common.ts'
import type {
  ArtifactPublishPayload,
  ArtifactPublishResult,
  MailDeps,
  MailIo
} from '../mail/api.ts'
import { defaultMailIo } from './io.ts'
import { addRetentionPin } from './retention.ts'
import {
  asObject,
  defaultNewId,
  fail,
  loadDispatch,
  optString,
  reqString,
  requireCurrentMember,
  type DispatchRow,
  type MemberRow
} from '../mail/shared.ts'

interface CheckoutRow {
  id: string
  resource_id: string
  canonical_path: string
}

/** the checkout the caller explicitly named — must exist and be claimed by this dispatch/member */
function namedCheckout(
  db: DatabaseSync,
  checkoutId: string,
  ownerIds: string[],
  op: string
): CheckoutRow {
  const row = db
    .prepare('SELECT id, resource_id, canonical_path FROM checkouts WHERE id = ?')
    .get(checkoutId) as CheckoutRow | undefined
  if (!row) {
    fail('INPUT_NOT_READY', `${op}: checkout ${checkoutId} does not exist`, 'none')
  }
  const held = db
    .prepare(
      `SELECT 1 FROM resource_claims
        WHERE resource_id = ? AND state = 'held' AND owner_id IN (${ownerIds.map(() => '?').join(',')})
        LIMIT 1`
    )
    .get(row!.resource_id, ...ownerIds)
  if (!held) {
    fail(
      'SCOPE_DENIED',
      `${op}: checkout ${checkoutId} is not held by this dispatch/member — outside own checkout read scope`,
      'none'
    )
  }
  return row!
}

/** implicit checkout: exactly one held checkout among the caller's identities */
function heldCheckout(db: DatabaseSync, ownerIds: string[], op: string): CheckoutRow {
  const rows = db
    .prepare(
      `SELECT DISTINCT c.id, c.resource_id, c.canonical_path
         FROM checkouts c
         JOIN resource_claims rc ON rc.resource_id = c.resource_id
        WHERE rc.state = 'held' AND rc.owner_id IN (${ownerIds.map(() => '?').join(',')})`
    )
    .all(...ownerIds) as unknown as CheckoutRow[]
  if (rows.length === 0) {
    fail(
      'INPUT_NOT_READY',
      `${op}: no checkout held by this dispatch/member — pass checkoutId explicitly`,
      'none'
    )
  }
  if (rows.length > 1) {
    fail(
      'AMBIGUOUS_TERRITORY',
      `${op}: ${rows.length} checkouts are held — pass checkoutId to pick one`,
      'replan'
    )
  }
  return rows[0]!
}

/** confine sourcePath to the checkout: repo-relative or absolute-under-root, never escaping */
function resolveSourcePath(canonicalPath: string, sourcePath: string, op: string): string {
  if (sourcePath.includes('\0')) {
    fail('INPUT_NOT_READY', `${op}: sourcePath contains NUL`, 'none')
  }
  const root = resolve(canonicalPath)
  const abs = isAbsolute(sourcePath) ? normalize(sourcePath) : resolve(root, sourcePath)
  if (abs !== root && !abs.startsWith(root + sep)) {
    fail(
      'SCOPE_DENIED',
      `${op}: sourcePath '${sourcePath}' escapes checkout ${canonicalPath}`,
      'none'
    )
  }
  return abs
}

export function artifactPublish(deps: MailDeps): OperationHandler {
  const io: MailIo = deps.io ?? defaultMailIo
  return async (txn, raw) => {
    const op = 'artifact.publish'
    const o = asObject(raw, op)
    const payload: ArtifactPublishPayload = {
      dispatchId: reqString(o, 'dispatchId', op),
      outputSlot: reqString(o, 'outputSlot', op),
      source: reqSource(o, op),
      checkoutId: optString(o, 'checkoutId', op),
      sourcePath: optString(o, 'sourcePath', op),
      commit: optString(o, 'commit', op),
      mediaType: reqString(o, 'mediaType', op),
      expectedDigest: optString(o, 'expectedDigest', op)
    }
    const { db, ctx } = txn

    const member: MemberRow = requireCurrentMember(db, ctx)
    const dispatch: DispatchRow | null = loadDispatch(db, payload.dispatchId)
    if (!dispatch) {
      fail('INPUT_NOT_READY', `${op}: dispatch ${payload.dispatchId} not found`, 'none')
    }
    if (dispatch!.member_id !== member.id) {
      fail('SCOPE_DENIED', `${op}: dispatch ${dispatch!.id} belongs to another member`, 'none')
    }
    if (dispatch!.authority_state !== 'active') {
      fail(
        'SCOPE_DENIED',
        `${op}: dispatch ${dispatch!.id} authority is '${dispatch!.authority_state}', not active — not the current producer`,
        'reconcile'
      )
    }
    if (dispatch!.generation !== member.generation) {
      fail(
        'STALE_EXECUTION',
        `${op}: dispatch ${dispatch!.id} runs on generation ${dispatch!.generation}, member is at ${member.generation}`,
        'reconcile'
      )
    }

    deps.authorize(ctx, op, [
      { kind: 'dispatch', id: dispatch!.id },
      { kind: 'member', id: member.id }
    ])

    const ownerIds = [
      dispatch!.id,
      member.id,
      ...(ctx.executionId ? [ctx.executionId as string] : [])
    ]
    const checkout = payload.checkoutId
      ? namedCheckout(db, payload.checkoutId, ownerIds, op)
      : heldCheckout(db, ownerIds, op)

    // ---- snapshot the source into a pinned identity -------------------------
    let digest: string
    let byteLength: number
    let storageRef: Record<string, unknown>
    if (payload.source === 'file') {
      if (!payload.sourcePath) {
        fail('INPUT_NOT_READY', `${op}: source 'file' requires sourcePath`, 'none')
      }
      const abs = resolveSourcePath(checkout.canonical_path, payload.sourcePath, op)
      let bytes: Uint8Array
      try {
        bytes = await io.readFileBytes(abs)
      } catch {
        fail('ARTIFACT_MISMATCH', `${op}: cannot read source file '${payload.sourcePath}'`, 'none')
      }
      digest = deps.sha256Hex(bytes!)
      if (payload.expectedDigest && payload.expectedDigest !== digest) {
        fail(
          'ARTIFACT_MISMATCH',
          `${op}: file digest changed — expected ${payload.expectedDigest}, actual ${digest}`,
          'none'
        )
      }
      const ref = deps.putContentBlob(db, bytes!, payload.mediaType)
      byteLength = bytes!.byteLength
      storageRef = { kind: 'content-blob', digest: ref.digest }
    } else {
      if (!payload.commit) {
        fail('INPUT_NOT_READY', `${op}: source 'git-commit' requires commit`, 'none')
      }
      const obj = await io.gitResolveCommit(checkout.canonical_path, payload.commit)
      if (!obj) {
        fail(
          'ARTIFACT_MISMATCH',
          `${op}: commit '${payload.commit}' does not resolve to a commit object in checkout ${checkout.id}`,
          'none'
        )
      }
      if (payload.expectedDigest && payload.expectedDigest !== obj!.sha) {
        fail(
          'ARTIFACT_MISMATCH',
          `${op}: commit resolved to ${obj!.sha}, expected ${payload.expectedDigest}`,
          'none'
        )
      }
      digest = obj!.sha
      byteLength = obj!.bytes
      storageRef = { kind: 'git-object', checkoutId: checkout.id, commit: obj!.sha }
    }

    // ---- retention intent, then metadata commit — same transaction ---------
    const newId = deps.newId ?? defaultNewId
    const artifactId = newId('art') as Id
    const revision = 1 as Revision
    addRetentionPin(db, newId('pin'), {
      targetKind: storageRef.kind as string,
      targetId:
        storageRef.kind === 'git-object'
          ? (storageRef.commit as string)
          : (storageRef.digest as string),
      holderKind: 'artifact',
      holderId: `${artifactId}@${revision}`,
      reason: `output slot '${payload.outputSlot}' of dispatch ${dispatch!.id}`
    })
    db.prepare(
      `INSERT INTO artifacts (id, revision, run_id, producer_dispatch_id, output_slot, digest, media_type, byte_length, storage_ref_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      artifactId,
      revision,
      member.run_id,
      dispatch!.id,
      payload.outputSlot,
      digest!,
      payload.mediaType,
      byteLength,
      JSON.stringify(storageRef)
    )
    deps.appendDomainEvent(
      db,
      artifactId,
      revision,
      'artifact.published',
      { runId: member.run_id, dispatchId: dispatch!.id },
      {
        artifactId,
        revision,
        outputSlot: payload.outputSlot,
        digest,
        mediaType: payload.mediaType,
        byteLength
      }
    )

    const result: ArtifactPublishResult = {
      artifactId,
      revision,
      digest: digest!,
      mediaType: payload.mediaType,
      byteLength
    }
    return result
  }
}

function reqSource(o: Record<string, unknown>, op: string): 'file' | 'git-commit' {
  const v = o.source
  if (v !== 'file' && v !== 'git-commit') {
    fail('INPUT_NOT_READY', `${op}: 'source' must be 'file' | 'git-commit'`, 'none')
  }
  return v
}
