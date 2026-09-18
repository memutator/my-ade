// mahas-cli dynamic-help — subcommand surface generated FROM surface.describe.
//
// REQ-09 / spec C-ACCESS: ungranted operations must not appear in help,
// schema, or completion output. The CLI therefore owns NO static command
// dictionary — the verb table comes from the server's surface.describe for
// the authenticated principal, and a missing/unreachable surface means the
// built-in verbs are all we print.

/**
 * One operation the server says THIS principal may call. IMP-02's
 * CommandSurface wire shape is still in flight — the parser below accepts
 * the plausible shapes ({operations|actions|ops}, each a string or an
 * object with a name) and keeps optional schema/summary when present.
 */
export interface SurfaceOp {
  name: string
  summary?: string
  mutation?: boolean
  inputSchema?: unknown
}

export interface SurfaceView {
  ops: SurfaceOp[]
  digest?: string
}

/** stable, duplicate-free op list — the CLI never prints one op twice */
function dedupeSort(view: SurfaceView): SurfaceView {
  const seen = new Map<string, SurfaceOp>()
  for (const op of view.ops) seen.set(op.name, op)
  return { ...view, ops: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

function opFrom(v: unknown): SurfaceOp | null {
  if (typeof v === 'string') return v.length > 0 ? { name: v } : null
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const name =
    typeof o.name === 'string' ? o.name : typeof o.operation === 'string' ? o.operation : null
  if (name === null || name.length === 0) return null
  return {
    name,
    summary: typeof o.summary === 'string' ? o.summary : undefined,
    mutation: typeof o.mutation === 'boolean' ? o.mutation : undefined,
    inputSchema: o.inputSchema ?? o.schema
  }
}

/**
 * Tolerant structural read of a surface.describe result. Anything we cannot
 * recognize yields an empty view — the caller treats it as "no surface"
 * rather than guessing at commands.
 */
export function parseSurface(raw: unknown): SurfaceView {
  const out: SurfaceView = { ops: [] }
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const op = opFrom(v)
      if (op) out.ops.push(op)
    }
    return dedupeSort(out)
  }
  if (typeof raw !== 'object' || raw === null) return out
  const r = raw as Record<string, unknown>
  const list = Array.isArray(r.operations)
    ? r.operations
    : Array.isArray(r.actions)
      ? r.actions
      : Array.isArray(r.ops)
        ? r.ops
        : null
  if (list) {
    for (const v of list) {
      const op = opFrom(v)
      if (op) out.ops.push(op)
    }
  }
  if (typeof r.surfaceDigest === 'string') out.digest = r.surfaceDigest
  else if (typeof r.digest === 'string') out.digest = r.digest
  return dedupeSort(out)
}

/**
 * Longest-prefix match of argv words onto the allowed surface:
 * `['inbox','check', …]` → `inbox.check`. Returns the matched op, the
 * remaining argv (flags), and the completions of what the user typed (for
 * "did you mean" diagnostics — only ever from the ALLOWED set).
 */
export function matchOperation(
  view: SurfaceView,
  argv: string[]
): { op: SurfaceOp | null; rest: string[]; candidates: string[] } {
  for (let i = argv.length; i >= 1; i--) {
    const name = argv.slice(0, i).join('.')
    const op = view.ops.find((o) => o.name === name)
    if (op) return { op, rest: argv.slice(i), candidates: [] }
  }
  const typed = argv.join('.')
  const candidates = view.ops
    .filter((o) => typed === '' || o.name.startsWith(typed) || o.name.startsWith(argv[0] ?? ''))
    .map((o) => o.name)
  return { op: null, rest: [], candidates }
}

/** `mahas help` body — the verb tree of exactly the allowed operations */
export function formatSurfaceHelp(view: SurfaceView): string {
  if (view.ops.length === 0) return '  (no operations in your surface)\n'
  const lines = view.ops.map((op) => {
    const verb = op.name.replace(/\./g, ' ')
    const tag = op.mutation === false ? ' [query]' : ''
    const summary = op.summary ? `  — ${op.summary}` : ''
    return `  ${verb.padEnd(38)}${tag}${summary}`
  })
  return lines.join('\n') + '\n'
}

/** `mahas completion` body — one candidate per line for shell completion */
export function formatCompletion(view: SurfaceView): string {
  const verbs = view.ops.map((o) => o.name.replace(/\./g, ' '))
  return verbs.join('\n') + (verbs.length ? '\n' : '')
}

/** `mahas help <op>` — the schema/summary for one allowed operation */
export function formatOpHelp(op: SurfaceOp): string {
  const parts = [`operation: ${op.name}`]
  if (op.mutation !== undefined) parts.push(`kind: ${op.mutation ? 'mutation' : 'query'}`)
  if (op.summary) parts.push(`summary: ${op.summary}`)
  if (op.inputSchema !== undefined) {
    parts.push(`input schema:\n${JSON.stringify(op.inputSchema, null, 2)}`)
  } else {
    parts.push('input schema: (not published by server — use --input or --key value)')
  }
  return parts.join('\n') + '\n'
}
