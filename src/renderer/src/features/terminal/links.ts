// mahas terminal — path links.
//
// xterm's web-links addon handles real URLs; this provider handles the other
// half of terminal output: file paths (with optional :line[:col] suffixes)
// that should open an editor block. Token recognition is pure and lives here
// on its own; the activate callback is supplied by the caller, which owns
// resolution against the tab's live cwd and the choice of target leaf.

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

// Whitespace-delimited candidate tokens; per-token rules in extractPath decide
// what really looks like a file path.
const PATH_TOKEN_RE = /[^\s'"`()[\]{}<>|;&*]+/g

// Extensionless basenames worth linking.
const KNOWN_BASENAMES = new Set([
  'makefile',
  'dockerfile',
  'containerfile',
  'vagrantfile',
  'jenkinsfile',
  'gemfile',
  'rakefile',
  'justfile',
  'procfile',
  'brewfile',
  'license',
  'licence',
  'readme',
  'changelog',
  'copying',
  'notice',
  'authors',
  'contributors'
])

function looksLikePath(p: string): boolean {
  if (!p || /^(\/|~|~\/|\.{1,2}|\.{1,2}\/)$/.test(p)) return false
  if (p.startsWith('/') || p.startsWith('~/') || p.startsWith('./') || p.startsWith('../'))
    return true
  if (p.includes('/')) return true
  if (/^\.[\w@+-][\w@+.-]*$/.test(p)) return true // dotfiles: .env, .gitignore
  // name.ext — single-char extensions need a stem of 2+ chars (skip "e.g")
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,14})$/.exec(p)
  if (ext && (ext[1].length > 1 || p.length - ext[1].length >= 3)) return true
  return KNOWN_BASENAMES.has(p.toLowerCase())
}

// Extract a linkable path from a raw token: strips leading/trailing junk and an
// optional `:line[:col]` suffix. Returns the path text plus its bounds inside
// `token` (bounds include the suffix), or null.
function extractPath(token: string): { path: string; start: number; end: number } | null {
  let lo = 0
  let hi = token.length
  const lead = /^[^~\w./-]+/.exec(token)
  if (lead) lo = lead[0].length
  const trail = /[,.;:!?]+$/.exec(token)
  if (trail) hi -= trail[0].length
  if (lo >= hi) return null
  let p = token.slice(lo, hi)

  // file:// URIs open in the editor; other schemes belong to the web-links addon
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      return null
    }
    return looksLikePath(p) ? { path: p, start: lo, end: hi } : null
  }
  if (/^[\w.+-]+:\/\//.test(p) || /^(mailto|tel|data|javascript):/i.test(p)) return null

  const lm = /^(.*?):\d+(?::\d+)?$/.exec(p)
  if (lm?.[1]) p = lm[1]
  // `key=path` / `--flag=path` — prefer the part after '=' when it is pathy
  const eq = p.lastIndexOf('=')
  if (eq >= 0) {
    const q = p.slice(eq + 1)
    if (looksLikePath(q)) {
      lo += eq + 1
      p = q
    }
  }
  return looksLikePath(p) ? { path: p, start: lo, end: hi } : null
}

/** Build the xterm link provider for one tab. `activate` receives the raw
 *  path text as it appeared in the buffer (the caller resolves it against the
 *  tab's live cwd and decides which leaf to open it in). */
export function makePathLinkProvider(
  term: Terminal,
  activate: (rawPath: string) => void
): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const buf = term.buffer.active
      const line = buf.getLine(bufferLineNumber - 1) // provider lines are 1-based
      const text = line?.translateToString(true)
      if (!line || !text) {
        callback(undefined)
        return
      }

      // string index → cell column (wide chars span multiple cells)
      const col = new Array<number>(text.length)
      const cell = buf.getNullCell()
      let si = 0
      for (let x = 0; x < line.length && si < text.length; x++) {
        const c = line.getCell(x, cell)
        if (!c || c.getWidth() === 0) continue
        const n = c.getChars().length || 1
        for (let k = 0; k < n && si + k < text.length; k++) col[si + k] = x
        si += n
      }

      const links: ILink[] = []
      for (const m of text.matchAll(PATH_TOKEN_RE)) {
        const r = extractPath(m[0])
        if (!r) continue
        const s = (m.index ?? 0) + r.start
        const e = (m.index ?? 0) + r.end - 1
        links.push({
          range: {
            start: { x: (col[s] ?? s) + 1, y: bufferLineNumber },
            end: { x: (col[e] ?? e) + 1, y: bufferLineNumber }
          },
          text: r.path,
          activate: () => activate(r.path)
        })
      }
      callback(links.length ? links : undefined)
    }
  }
}
