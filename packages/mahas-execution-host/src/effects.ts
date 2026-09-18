// effects.ts — primitive effect receipt store over host_effects
// (spec/storage.md §4, spec/contracts/execution-host.md "primitive receipt의
// 원칙", spec/common.md §5 effect states).
//
// Receipt discipline the rest of the host relies on:
//   * record the INTENT before the OS call ("host가 effect_started를 저장한
//     뒤 OS를 호출한다") — begin() writes the row, record() settles it.
//   * same effectKey + same fingerprint = the SAME effect: begin() returns
//     the existing row untouched (dedup by identity, never a silent re-run).
//   * same effectKey + different fingerprint = OPERATION_CONFLICT.
//   * 'unknown' is a first-class terminal-ambiguous state — crash gaps stay
//     visible instead of being rewritten (REQ-14).

import type { DatabaseSync } from 'node:sqlite'
import type { EffectState } from '../../mahas-contracts/src/common.ts'
import { HostOpError } from './lease.ts'

export interface StoredEffect {
  effectKey: string
  fingerprint: string
  kind: string
  state: EffectState
  intent: unknown
  receipt: unknown
}

interface EffectRow {
  effect_key: string
  fingerprint: string
  kind: string
  state: string
  intent_json: string
  receipt_json: string
}

function rowToEffect(row: EffectRow): StoredEffect {
  return {
    effectKey: row.effect_key,
    fingerprint: row.fingerprint,
    kind: row.kind,
    state: row.state as EffectState,
    intent: JSON.parse(row.intent_json),
    receipt: JSON.parse(row.receipt_json)
  }
}

/**
 * Storage port for host primitive effects. IMP-18 (process/PTY) and
 * IMP-16 (workspace) obtain one via HostCallContext.effects and journal
 * every OS side effect through it — spawn, stop, input, worktree prepare.
 */
export interface HostEffectStore {
  /** existing receipt row or null */
  get(effectKey: string): StoredEffect | null
  /**
   * Journal an intent. Idempotent: an existing row with the same key +
   * fingerprint is returned with `replayed: true` and NOT overwritten —
   * its recorded state/receipt is the durable answer. A key with a
   * different fingerprint throws OPERATION_CONFLICT.
   */
  begin(input: { effectKey: string; kind: string; fingerprint: string; intent: unknown }): {
    effect: StoredEffect
    replayed: boolean
  }
  /** settle/annotate an existing effect row (state + receipt payload). */
  record(effectKey: string, state: EffectState, receipt: unknown): void
  /** every recorded effect key — the inventory's "effect receipt ids" */
  listKeys(): string[]
}

export function openEffectStore(db: DatabaseSync): HostEffectStore {
  return {
    get(effectKey) {
      const row = db
        .prepare(
          'SELECT effect_key, fingerprint, kind, state, intent_json, receipt_json FROM host_effects WHERE effect_key=?'
        )
        .get(effectKey) as EffectRow | undefined
      return row ? rowToEffect(row) : null
    },

    begin({ effectKey, kind, fingerprint, intent }) {
      const existing = this.get(effectKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new HostOpError(
            'OPERATION_CONFLICT',
            `effectKey ${effectKey} already recorded with a different payload fingerprint`,
            'none'
          )
        }
        return { effect: existing, replayed: true }
      }
      const receipt = { recordedAt: Date.now() }
      db.prepare(
        'INSERT INTO host_effects(effect_key, fingerprint, kind, state, intent_json, receipt_json) VALUES(?,?,?,?,?,?)'
      ).run(
        effectKey,
        fingerprint,
        kind,
        'prepared',
        JSON.stringify(intent),
        JSON.stringify(receipt)
      )
      return {
        effect: { effectKey, fingerprint, kind, state: 'prepared', intent, receipt },
        replayed: false
      }
    },

    record(effectKey, state, receipt) {
      const existing = this.get(effectKey)
      if (!existing) {
        throw new HostOpError(
          'INVALID_ARGUMENT',
          `no effect row for key ${effectKey} — begin() must journal the intent first`,
          'none'
        )
      }
      db.prepare('UPDATE host_effects SET state=?, receipt_json=? WHERE effect_key=?').run(
        state,
        JSON.stringify(receipt),
        effectKey
      )
    },

    listKeys() {
      const rows = db
        .prepare('SELECT effect_key FROM host_effects ORDER BY effect_key')
        .all() as Array<{
        effect_key: string
      }>
      return rows.map((r) => r.effect_key)
    }
  }
}
