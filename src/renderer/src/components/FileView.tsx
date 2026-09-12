import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { useStore } from '../store'
import MarkdownEditor from './MarkdownEditor'

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

const MD_EXTS = new Set(['.md', '.markdown'])

interface Loaded {
  kind: 'image' | 'text' | 'binary'
  text?: string
  md?: boolean
  imageUrl?: string
  meta?: string
  error?: string
}

export default function FileView({
  path,
  onDirtyChange,
  onSaveError
}: {
  path: string
  onDirtyChange?: (dirty: boolean) => void
  onSaveError?: (msg: string) => void
}): React.JSX.Element {
  const resolvedTheme = useStore((s) => s.resolvedTheme ?? 'dark')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [langExt, setLangExt] = useState<Extension | null>(null)
  const imgUrlRef = useRef<string | null>(null)
  const savedRef = useRef('') // content as of last load/save
  const contentRef = useRef('') // current editor content
  const dirtyRef = useRef(false)
  const onDirtyChangeRef = useRef(onDirtyChange)
  const onSaveErrorRef = useRef(onSaveError)

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange
    onSaveErrorRef.current = onSaveError
  })

  const save = async (): Promise<void> => {
    if (!dirtyRef.current) return
    const r = await window.ade.file.write(path, contentRef.current)
    if (r.ok) {
      savedRef.current = contentRef.current
      dirtyRef.current = false
      setDirty(false)
      setSaveError(null)
      onDirtyChangeRef.current?.(false)
    } else {
      const msg = r.error ?? 'save failed'
      setSaveError(msg)
      onSaveErrorRef.current?.(msg)
    }
  }
  const handleChange = (text: string): void => {
    contentRef.current = text
    const d = text !== savedRef.current
    if (d !== dirtyRef.current) {
      dirtyRef.current = d
      setDirty(d)
      onDirtyChangeRef.current?.(d)
    }
  }

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
      savedRef.current = text
      contentRef.current = text
      dirtyRef.current = false
      setDirty(false)
      onDirtyChangeRef.current?.(false) // clear stale dirty flag from persisted state
      setLoaded({ kind: 'text', text, md: MD_EXTS.has(r.ext!), meta })
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  // async-resolve a CM language for the file name (plaintext fallback)
  const isText = loaded?.kind === 'text' && loaded.text !== undefined
  const isMd = loaded?.md === true
  useEffect(() => {
    if (!isText || isMd) return
    let cancelled = false
    const name = path.split('/').pop() ?? path
    const desc = LanguageDescription.matchFilename(languages, name)
    if (desc)
      desc
        .load()
        .then((l) => {
          if (!cancelled) setLangExt(l)
        })
        .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [path, isText, isMd])

  useEffect(
    () => () => {
      if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
    },
    []
  )

  const extensions = useMemo<Extension[]>(() => (langExt ? [langExt] : []), [langExt])

  const onKeyDownCapture = (e: React.KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      void save()
    }
  }

  return (
    <div className="file-body" onKeyDownCapture={onKeyDownCapture}>
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
      ) : isMd ? (
        <MarkdownEditor initialValue={loaded.text!} onChange={handleChange} />
      ) : (
        <div className="cm-wrap">
          <CodeMirror
            value={loaded.text}
            height="100%"
            theme={resolvedTheme === 'dark' ? oneDark : 'light'}
            extensions={extensions}
            onChange={handleChange}
          />
        </div>
      )}
      {loaded?.meta && !loaded.error && (
        <div className="file-meta">
          {loaded.meta}
          {dirty && <span className="file-dirty-note"> · unsaved</span>}
          {saveError && <span className="file-err"> · save failed: {saveError}</span>}
        </div>
      )}
    </div>
  )
}
