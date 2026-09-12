import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createHighlighter, type Highlighter } from 'shiki'
import { useStore } from '../store'

const LANGS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.sql': 'sql',
  '.lua': 'lua',
  '.vim': 'vim',
  '.diff': 'diff',
  '.ini': 'ini',
  '.txt': 'text',
  '.log': 'text'
}

let hlPromise: Promise<Highlighter> | null = null
function getHighlighter(): Promise<Highlighter> {
  hlPromise ??= createHighlighter({ themes: ['github-dark', 'github-light'], langs: [] })
  return hlPromise
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

interface Loaded {
  kind: 'image' | 'text' | 'binary'
  html?: string
  md?: string
  imageUrl?: string
  meta?: string
  error?: string
}

export default function FileView({ path }: { path: string }): React.JSX.Element {
  const theme = useStore((s) => s.settings.theme)
  const resolvedTheme = useStore((s) => s.resolvedTheme ?? 'dark')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const imgUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const r = await window.ade.file.read(path)
      if (cancelled) return
      if (!r.ok) {
        setLoaded({ kind: 'text', error: r.error })
        return
      }
      const bytes = fromBase64(r.data!)
      const meta = `${r.name} · ${(r.size! / 1024).toFixed(1)} KB`

      if (r.kind === 'image') {
        if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
        const url = URL.createObjectURL(
          new Blob([bytes], { type: MIME[r.ext!] ?? 'application/octet-stream' })
        )
        imgUrlRef.current = url
        setLoaded({ kind: 'image', imageUrl: url, meta })
        return
      }
      if (r.kind === 'binary') {
        setLoaded({ kind: 'binary', error: 'binary file', meta })
        return
      }

      const text = new TextDecoder().decode(bytes)
      if (r.ext === '.md' || r.ext === '.markdown') {
        setLoaded({ kind: 'text', md: text, meta })
        return
      }

      try {
        const hl = await getHighlighter()
        const lang = LANGS[r.ext!] ?? 'text'
        if (lang !== 'text') {
          try {
            await hl.loadLanguage(lang as never)
          } catch {
            /* unknown lang → text */
          }
        }
        const loadedLangs = hl.getLoadedLanguages()
        const html = hl.codeToHtml(text, {
          lang: loadedLangs.includes(lang) ? lang : 'text',
          theme: resolvedTheme === 'dark' ? 'github-dark' : 'github-light'
        })
        if (!cancelled) setLoaded({ kind: 'text', html, meta })
      } catch {
        const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        if (!cancelled) setLoaded({ kind: 'text', html: `<pre><code>${esc}</code></pre>`, meta })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, resolvedTheme, theme])

  useEffect(
    () => () => {
      if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
    },
    []
  )

  return (
    <div className="file-body">
      {!loaded ? (
        <div className="file-empty">
          <span>loading…</span>
        </div>
      ) : loaded.error ? (
        <div className="file-empty">
          <span>{loaded.error}</span>
        </div>
      ) : loaded.kind === 'image' ? (
        <div className="file-image">
          <img src={loaded.imageUrl} alt={path} />
        </div>
      ) : loaded.md !== undefined ? (
        <div className="file-md">
          <Markdown remarkPlugins={[remarkGfm]}>{loaded.md}</Markdown>
        </div>
      ) : (
        <div className="file-code" dangerouslySetInnerHTML={{ __html: loaded.html ?? '' }} />
      )}
      {loaded?.meta && !loaded.error && <div className="file-meta">{loaded.meta}</div>}
    </div>
  )
}
