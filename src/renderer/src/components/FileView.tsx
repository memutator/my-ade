import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { useStore } from '../store'
import { useT } from '../i18n'
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
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf'
}

const MD_EXTS = new Set(['.md', '.markdown'])

// Unsaved editor buffers, keyed by absolute path. Pane drags remount FileView
// and would silently drop dirty edits; keeping the draft session-scoped also
// restores it if the tab is closed and reopened (hot-exit style).
const drafts = new Map<string, string>()

interface Loaded {
  kind: 'image' | 'text' | 'binary' | 'video' | 'audio' | 'pdf'
  text?: string
  md?: boolean
  mediaUrl?: string
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
  const t = useT()
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
      drafts.delete(path)
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
    if (d) drafts.set(path, text)
    else drafts.delete(path)
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

      if (r.kind === 'image' || r.kind === 'video' || r.kind === 'audio' || r.kind === 'pdf') {
        if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
        const url = URL.createObjectURL(
          new Blob([bytes], { type: MIME[r.ext!] ?? 'application/octet-stream' })
        )
        imgUrlRef.current = url
        setLoaded({ kind: r.kind, mediaUrl: url, meta })
        return
      }
      if (r.kind === 'binary') {
        setLoaded({ kind: 'binary', error: t('binaryFile'), meta })
        return
      }

      const text = new TextDecoder().decode(bytes)
      // a draft survives remounts (pane drags) and tab close+reopen
      const draft = drafts.get(path)
      const text2 = draft !== undefined && draft !== text ? draft : text
      const isDirty = text2 !== text
      savedRef.current = text
      contentRef.current = text2
      dirtyRef.current = isDirty
      setDirty(isDirty)
      onDirtyChangeRef.current?.(isDirty)
      setLoaded({ kind: 'text', text: text2, md: MD_EXTS.has(r.ext!), meta })
    })()
    return () => {
      cancelled = true
    }
  }, [path, t])

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
          <span>{t('loading')}</span>
        </div>
      ) : loaded.error ? (
        <div className="file-empty">
          <span>{loaded.error}</span>
        </div>
      ) : loaded.kind === 'image' ? (
        <div className="file-image">
          <img src={loaded.mediaUrl} alt={path} />
        </div>
      ) : loaded.kind === 'video' ? (
        <div className="file-media">
          <video src={loaded.mediaUrl} controls />
        </div>
      ) : loaded.kind === 'audio' ? (
        <div className="file-media">
          <audio src={loaded.mediaUrl} controls />
        </div>
      ) : loaded.kind === 'pdf' ? (
        <embed className="file-pdf" src={loaded.mediaUrl} type="application/pdf" />
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
