// workbench/bits.tsx — small shared renderers for workbench views.
//
// Wire sub-structures whose inner fields the contracts don't enumerate are
// rendered DEFENSIVELY here: prefer the documented slots, fall back to a
// compact JSON dump — never silently drop and never invent semantics.

import type { ReactNode } from 'react'
import type { OpErrorKind } from './client.ts'
import { useModelHead, useWorkbenchActions, useWorkbenchContext } from './scope.ts'

/** small status chip — tone is semantic, not decorative */
export function Pill({
  tone,
  children
}: {
  tone?: 'dim' | 'accent' | 'warn' | 'err' | 'ok'
  children: ReactNode
}): React.JSX.Element {
  return <span className={`wb-pill${tone ? ` ${tone}` : ''}`}>{children}</span>
}

/** key:value dump for an opaque object (proposedMember, grantCoverage,
 //  eligibility projections) — top-level scalars as rows, nested values as
 //  compact JSON. Displays what the server sent; claims nothing about it. */
export function KV({ value, empty }: { value: unknown; empty?: string }): React.JSX.Element {
  if (value == null || (typeof value === 'object' && Object.keys(value).length === 0)) {
    return <div className="wb-note">{empty ?? '—'}</div>
  }
  if (typeof value !== 'object') return <div className="wb-note">{String(value)}</div>
  return (
    <div className="wb-kv">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k} className="wb-kv-row">
          <span className="wb-kv-k">{k}</span>
          <span className="wb-kv-v">
            {v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** preformatted text rows (mappers in view-model.ts own the wording) */
export function TextLines({ items }: { items: string[] }): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <ul className="wb-lines">
      {items.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  )
}

/** an op failure with its own state — unavailable/stale/denied/no-match/
 //  ambiguous are different failures, not one red blob (IMP-31 §4.3). */
export function OpError({
  kind,
  message,
  onRetry
}: {
  kind: OpErrorKind
  message?: string
  onRetry?: () => void
}): React.JSX.Element {
  const label =
    kind === 'unavailable'
      ? 'control plane unavailable'
      : kind === 'stale'
        ? 'stale — re-query required'
        : kind === 'denied'
          ? 'scope denied'
          : kind === 'no-match'
            ? 'no responsible role'
            : kind === 'ambiguous'
              ? 'ambiguous'
              : kind === 'missing-impl'
                ? 'implementation missing'
                : kind === 'input-pending'
                  ? 'inputs not ready'
                  : 'error'
  return (
    <div className={`wb-err${kind === 'unavailable' || kind === 'input-pending' ? ' dim' : ''}`}>
      <Pill
        tone={kind === 'denied' || kind === 'error' ? 'err' : kind === 'stale' ? 'warn' : 'dim'}
      >
        {label}
      </Pill>
      {message && <span className="wb-err-msg">{message}</span>}
      {onRetry && (
        <button className="wb-btn" onClick={onRetry}>
          re-query
        </button>
      )}
    </div>
  )
}

/** labelled text input row */
export function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  wide
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  wide?: boolean
}): React.JSX.Element {
  return (
    <label className={`wb-field${wide ? ' wide' : ''}`}>
      <span className="wb-field-l">{label}</span>
      <input
        className={mono ? 'wb-in mono' : 'wb-in'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  )
}

export function ContextBar(): React.JSX.Element {
  const { projectId, modelVersion, runId } = useWorkbenchContext()
  const { setContext } = useWorkbenchActions()
  const head = useModelHead()
  return (
    <>
      <div className="wb-row">
        <Field
          label="project"
          value={projectId}
          onChange={(v) => setContext({ projectId: v })}
          placeholder="domain project id"
          mono
        />
        <Field
          label="model pin"
          value={modelVersion}
          onChange={(v) => setContext({ modelVersion: v })}
          mono
        />
        <Field label="run" value={runId} onChange={(v) => setContext({ runId: v })} mono />
      </div>
      <div className="wb-note">
        {!projectId
          ? 'unconnected — paste a domain project id; the desktop folder id is not a project'
          : head ? (
          <>
            server current model: <span className="mono">{head.modelVersion}</span>
            {head.snapshotRevision !== undefined
              ? ` · snapshot ${head.snapshotRevision}`
              : ''} · {head.declaredBy}
          </>
        ) : (
          'server current model: unknown — the head is never guessed from an id'
        )}
      </div>
    </>
  )
}

export function Section({
  title,
  children,
  right
}: {
  title: string
  children: ReactNode
  right?: ReactNode
}): React.JSX.Element {
  return (
    <div className="wb-sec">
      <div className="wb-sec-h">
        <span>{title}</span>
        {right}
      </div>
      <div className="wb-sec-b">{children}</div>
    </div>
  )
}
