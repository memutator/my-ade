// mahas-runtime/artifacts — artifact.read (C-MAIL).
//
// Semantics (spec/domains/messaging-outcomes.md §3, C-MAIL artifact.read):
//   * Reads ONE exact artifact: (artifactId, revision) + expectedDigest must
//     match the stored digest — anything else is ARTIFACT_MISMATCH.
//   * Share scope: the caller is a member of the artifact's run OR holds a
//     delivery whose message references this artifact (Task/Delivery 공유
//     범위); the authorize() grant check then decides. Members with a fenced
//     generation get STALE_EXECUTION like every member op.
//   * A content-blob artifact returns verified bytes (base64 on the wire);
//     a git-object artifact returns an identity reference (checkoutId +
//     commit sha) — a live workspace path is NEVER emitted as a trustworthy
//     result. Missing/corrupt content reports an explicit 'unavailable'.

import type { DatabaseSync } from 'node:sqlite'
import type { OperationHandler } from '../api/registry.ts'
import type { Id } from '../../../mahas-contracts/src/common.ts'
import type { ArtifactReadPayload, ArtifactReadResult, MailDeps, MailIo } from '../mail/api.ts'
import { defaultMailIo } from './io.ts'
import {
  asObject,
  assertCurrentGeneration,
  fail,
  loadArtifact,
  loadMember,
  optInt,
  reqInt,
  reqString,
  rowToArtifact,
  type ArtifactRow
} from '../mail/shared.ts'

/** does a message carrying this artifact sit in the member's mailbox? (Task/Delivery share scope) */
function deliverySharesArtifact(db: DatabaseSync, memberId: string, artifactId: string): boolean {
  const rows = db
    .prepare(
      `SELECT m.links_json AS links
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
        WHERE d.recipient_member_id = ? AND m.links_json LIKE ?`
    )
    .all(memberId, `%"${artifactId.replace(/["%_]/g, '')}"%`) as unknown as { links: string }[]
  for (const r of rows) {
    try {
      const links = JSON.parse(r.links) as { artifactRefs?: { artifactId?: unknown }[] }
      if (
        Array.isArray(links.artifactRefs) &&
        links.artifactRefs.some((x) => x.artifactId === artifactId)
      ) {
        return true
      }
    } catch {
      // malformed links_json — skip, it grants nothing
    }
  }
  return false
}

interface StorageRef {
  kind?: string
  digest?: string
  checkoutId?: string
  commit?: string
}

export function artifactRead(deps: MailDeps): OperationHandler {
  const io: MailIo = deps.io ?? defaultMailIo
  return async (txn, raw) => {
    const op = 'artifact.read'
    const o = asObject(raw, op)
    const range =
      o.range === undefined || o.range === null
        ? undefined
        : (() => {
            const r = asObject(o.range, `${op}.range`)
            return {
              offset: reqInt(r, 'offset', `${op}.range`, 0),
              length: optInt(r, 'length', `${op}.range`, 1)
            }
          })()
    const payload: ArtifactReadPayload = {
      artifactId: reqString(o, 'artifactId', op),
      revision: reqInt(o, 'revision', op, 1),
      expectedDigest: reqString(o, 'expectedDigest', op),
      range
    }
    const { db, ctx } = txn

    const row: ArtifactRow | null = loadArtifact(db, payload.artifactId, payload.revision)
    if (!row) {
      fail(
        'ARTIFACT_MISMATCH',
        `${op}: artifact ${payload.artifactId}@${payload.revision} does not exist`,
        'none'
      )
    }
    if (row!.digest !== payload.expectedDigest) {
      fail(
        'ARTIFACT_MISMATCH',
        `${op}: digest mismatch — this is not the requested artifact content`,
        'none'
      )
    }

    // share scope for member callers; non-member principals rely on authorize()
    if (ctx.memberId) {
      const member = loadMember(db, ctx.memberId as string)
      if (!member) {
        fail('UNAUTHENTICATED', `${op}: credential member ${ctx.memberId} not found`, 'none')
      }
      // a fenced generation may not read as the current consumer
      if (ctx.executionGeneration !== undefined && ctx.executionGeneration !== null) {
        assertCurrentGeneration(ctx, member!)
      }
      const shared =
        member!.run_id === row!.run_id || deliverySharesArtifact(db, member!.id, row!.id)
      if (!shared) {
        fail(
          'SCOPE_DENIED',
          `${op}: no task/delivery share scope binds member ${member!.id} to artifact ${row!.id}`,
          'none'
        )
      }
    }
    deps.authorize(ctx, op, [{ kind: 'artifact', id: row!.id }])

    const artifact = rowToArtifact(row!)
    const storage = JSON.parse(row!.storage_ref_json) as StorageRef

    if (storage.kind === 'content-blob') {
      const blob = storage.digest ? deps.getContentBlob(db, storage.digest) : null
      if (!blob) {
        const result: ArtifactReadResult = {
          artifact,
          availability: 'unavailable',
          reason: 'content blob is not present in the store'
        }
        return result
      }
      // actual blob identity check — never trust the pointer alone
      if (deps.sha256Hex(blob.bytes) !== row!.digest) {
        const result: ArtifactReadResult = {
          artifact,
          availability: 'unavailable',
          reason: 'stored bytes fail digest verification — refusing to serve corrupt content'
        }
        return result
      }
      const offset = payload.range?.offset ?? 0
      const length = payload.range?.length ?? blob.bytes.byteLength - offset
      if (
        offset < 0 ||
        offset > blob.bytes.byteLength ||
        length < 0 ||
        offset + length > blob.bytes.byteLength
      ) {
        fail(
          'INPUT_NOT_READY',
          `${op}: range offset=${offset} length=${length} exceeds ${blob.bytes.byteLength} bytes`,
          'none'
        )
      }
      const slice = blob.bytes.subarray(offset, offset + length)
      const result: ArtifactReadResult = {
        artifact,
        availability: 'bytes',
        mediaType: blob.mediaType,
        byteLength: blob.bytes.byteLength,
        dataBase64: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString(
          'base64'
        ),
        range: { offset, length }
      }
      return result
    }

    if (storage.kind === 'git-object') {
      // return the verified identity — never a live workspace path. We probe
      // object existence where the checkout still resolves; if the checkout
      // row is gone the reference degrades to an honest 'unavailable'.
      const checkout = storage.checkoutId
        ? (db
            .prepare('SELECT canonical_path FROM checkouts WHERE id = ?')
            .get(storage.checkoutId) as { canonical_path: string } | undefined)
        : undefined
      const commit = storage.commit ?? ''
      const obj = checkout ? await io.gitResolveCommit(checkout.canonical_path, commit) : null
      if (!obj) {
        const result: ArtifactReadResult = {
          artifact,
          availability: 'unavailable',
          reason: 'git object or its checkout is no longer resolvable'
        }
        return result
      }
      const result: ArtifactReadResult = {
        artifact,
        availability: 'reference',
        gitRef: { checkoutId: storage.checkoutId as Id, commit: obj!.sha }
      }
      return result
    }

    const result: ArtifactReadResult = {
      artifact,
      availability: 'unavailable',
      reason: `unknown storage kind '${storage.kind ?? '<missing>'}'`
    }
    return result
  }
}
