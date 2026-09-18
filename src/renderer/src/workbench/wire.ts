// workbench/wire.ts — helpers for loosely-typed wire sub-structures.

/** pull a readable line out of a loosely-typed wire entry: known label
 //  slots first (detail/summary/reason/kind-ish), else a stable JSON dump. */
export function entryText(e: unknown): string {
  if (e == null) return ''
  if (typeof e === 'string') return e
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>
    for (const k of ['detail', 'summary', 'reason', 'text', 'description', 'kind']) {
      const v = o[k]
      if (typeof v === 'string' && v) return v
    }
    const parts: string[] = []
    for (const [k, v] of Object.entries(o)) {
      if (v == null || v === '') continue
      parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }
    return parts.join(' · ')
  }
  return String(e)
}
