import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import type { PaneToastAction } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import MarkdownEditor from './MarkdownEditor'
import '../editor.css'

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

// used when settings.editorFont is blank — the CSS var() fallback can't rescue
// an explicitly-empty custom property (that resolves to "unset", not the fallback)
const EDITOR_FONT_FALLBACK = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace"

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
  wsId,
  paneId,
  tabId,
  onDirtyChange,
  onSaveError
}: {
  path: string
  wsId: string
  paneId: string
  tabId: string
  onDirtyChange?: (dirty: boolean) => void
  onSaveError?: (msg: string) => void
}): React.JSX.Element {
  const resolvedTheme = useStore((s) => s.resolvedTheme ?? 'dark')
  const editorFont = useStore((s) => s.settings.editorFont)
  const t = useT()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [langExt, setLangExt] = useState<Extension | null>(null)
  // external-change UI, VS Code style: clean buffers reload silently; a real
  // delete only leaves a meta-line note (save offers to recreate); the banner
  // is reserved for dirty-buffer conflicts — the buffer is the only copy then
  const [diskConflict, setDiskConflict] = useState<'changed' | 'deleted' | null>(null)
  const [diskDeleted, setDiskDeleted] = useState(false)
  const [reloadKey, setReloadKey] = useState(0) // bumps to remount the editor on reload
  const [raw, setRaw] = useState(false) // markdown view: false = Milkdown, true = raw CodeMirror
  // buffer snapshot captured at toggle time — refs can't be read during render
  const [mdSeed, setMdSeed] = useState<string | null>(null)
  const imgUrlRef = useRef<string | null>(null)
  const savedRef = useRef('') // content as of last load/save
  const contentRef = useRef('') // current editor content
  const dirtyRef = useRef(false)
  const mtimeRef = useRef<number | null>(null) // disk mtime as of last load/save; null = deleted
  const lastWriteRef = useRef(0) // timestamp of our own save — suppresses the watch echo
  const onDirtyChangeRef = useRef(onDirtyChange)
  const onSaveErrorRef = useRef(onSaveError)

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange
    onSaveErrorRef.current = onSaveError
  })

  // the conflict/confirm UX lives in a pane toast — same slot rules as the
  // old banner (one at a time, 'file-banner' dedupe key replaces in place)
  const bannerToastRef = useRef<string | null>(null)
  const dropBanner = useCallback((): void => {
    if (bannerToastRef.current) {
      useStore.getState().dismissPaneToast(bannerToastRef.current)
      bannerToastRef.current = null
    }
  }, [])
  const showBanner = useCallback(
    (text: string, actions: PaneToastAction[]): void => {
      bannerToastRef.current = useStore.getState().pushPaneToast({
        wsId,
        paneId,
        tabId,
        // tab-scoped key: two file tabs in one pane keep separate toasts
        key: `file-banner:${tabId}`,
        kind: 'warn',
        text,
        actions
      })
    },
    [wsId, paneId, tabId]
  )

  const save = async (force = false): Promise<void> => {
    if (!dirtyRef.current) return
    // save guard: refuse to silently clobber a file that changed on disk
    // since we loaded/saved it (or that vanished — offer to recreate)
    if (!force) {
      const st = await window.mahas.file.stat(path)
      const diskChanged =
        !st.ok || !st.exists || mtimeRef.current === null || st.mtimeMs !== mtimeRef.current
      if (diskChanged) {
        const kind = st.ok && !st.exists ? 'recreate' : 'overwrite'
        showBanner(t(kind === 'recreate' ? 'fileDeletedConfirm' : 'fileChangedConfirm'), [
          {
            id: 'save',
            label: t(kind === 'recreate' ? 'saveAnyway' : 'overwrite'),
            run: () => void save(true)
          },
          { id: 'cancel', label: t('cancel'), run: () => {} }
        ])
        return
      }
    }
    dropBanner()
    const r = await window.mahas.file.write(path, contentRef.current)
    if (r.ok) {
      // eslint-disable-next-line react-hooks/purity -- async event context, not render
      lastWriteRef.current = Date.now()
      mtimeRef.current = r.mtimeMs ?? mtimeRef.current
      savedRef.current = contentRef.current
      drafts.delete(path)
      dirtyRef.current = false
      setDirty(false)
      setSaveError(null)
      setDiskConflict(null)
      setDiskDeleted(false)
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

  // apply a file:read result to the buffer. useDraft restores the session
  // draft on mount; reloads pass false to discard it and take disk contents.
  const applyRead = useCallback(
    (r: Awaited<ReturnType<typeof window.mahas.file.read>>, useDraft: boolean): void => {
      mtimeRef.current = r.mtimeMs ?? null
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
      let text2 = text
      if (useDraft) {
        const draft = drafts.get(path)
        if (draft !== undefined && draft !== text) text2 = draft
        else drafts.delete(path)
      } else {
        drafts.delete(path)
      }
      const isDirty = text2 !== text
      savedRef.current = text
      contentRef.current = text2
      dirtyRef.current = isDirty
      setDirty(isDirty)
      onDirtyChangeRef.current?.(isDirty)
      setLoaded({ kind: 'text', text: text2, md: MD_EXTS.has(r.ext!), meta })
    },
    [path, t]
  )

  // discard the buffer and take what's on disk (auto for clean buffers,
  // explicit via the conflict banner for dirty ones)
  const reloadFromDisk = useCallback(
    async (flash = false): Promise<void> => {
      const r = await window.mahas.file.read(path)
      if (!r.ok) {
        mtimeRef.current = null
        setDiskDeleted(true)
        if (dirtyRef.current) {
          setDiskConflict('deleted')
          showBanner(t('fileDeletedOnDisk'), [
            { id: 'keep', label: t('keepMine'), run: () => setDiskConflict(null) }
          ])
        }
        return
      }
      applyRead(r, false)
      setDiskConflict(null)
      setDiskDeleted(false)
      dropBanner()
      setMdSeed(null) // fresh disk text becomes the seed again
      setReloadKey((k) => k + 1)
      if (flash) {
        useStore.getState().pushPaneToast({
          wsId,
          paneId,
          tabId,
          key: `file-banner:${tabId}`,
          kind: 'info',
          text: t('reloadedFromDisk'),
          ttl: 2500
        })
      }
    },
    [path, applyRead, t, wsId, paneId, tabId, showBanner, dropBanner]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const r = await window.mahas.file.read(path)
      if (cancelled) return
      if (!r.ok) {
        setLoaded({ kind: 'text', error: r.error })
        return
      }
      applyRead(r, true)
    })()
    return () => {
      cancelled = true
    }
  }, [path, applyRead])

  // watch the file on disk while open (deduped in main; unwatch on unmount)
  const isLoaded = loaded !== null
  useEffect(() => {
    if (!isLoaded) return
    void window.mahas.file.watch(path)
    const off = window.mahas.file.onChanged((e) => {
      if (e.path !== path) return
      if (e.deleted) {
        mtimeRef.current = null
        setDiskDeleted(true)
        // a dirty buffer is the only surviving copy — surface the choice;
        // a clean one just notes it (save recreates)
        if (dirtyRef.current) {
          setDiskConflict('deleted')
          showBanner(t('fileDeletedOnDisk'), [
            { id: 'keep', label: t('keepMine'), run: () => setDiskConflict(null) }
          ])
        }
      } else if (
        // our own file.write trips the watcher — ignore the echo (mtime match,
        // with a 300ms time window as fallback for e.g. missing mtimeMs)
        (e.mtimeMs !== undefined && e.mtimeMs === mtimeRef.current) ||
        Date.now() - lastWriteRef.current < 300
      ) {
        return
      } else if (dirtyRef.current) {
        setDiskConflict('changed') // already-bannered stays bannered
        showBanner(t('fileChangedOnDisk'), [
          { id: 'reload', label: t('reload'), run: () => void reloadFromDisk() },
          { id: 'keep', label: t('keepMine'), run: () => setDiskConflict(null) }
        ])
      } else {
        void reloadFromDisk(true)
      }
    })
    return () => {
      off()
      void window.mahas.file.unwatch(path)
    }
  }, [path, isLoaded, reloadFromDisk, showBanner, t])

  // async-resolve a CM language for the file name (plaintext fallback).
  // md files skip this while rendered (Milkdown doesn't need it); raw view does.
  const isText = loaded?.kind === 'text' && loaded.text !== undefined
  const isMd = loaded?.md === true
  useEffect(() => {
    if (!isText || (isMd && !raw)) return
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
  }, [path, isText, isMd, raw])

  useEffect(
    () => () => {
      if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
    },
    []
  )

  // drop our pane toast if the tab unmounts (close/move)
  useEffect(
    () => () => {
      dropBanner()
    },
    [dropBanner]
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
    <div
      className="file-body"
      onKeyDownCapture={onKeyDownCapture}
      style={
        {
          '--editor-font': editorFont.trim() ? editorFont : EDITOR_FONT_FALLBACK
        } as React.CSSProperties
      }
    >
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
        // both surfaces seed from the live buffer snapshot (every edit goes
        // through handleChange → contentRef → mdSeed at toggle time) and
        // remount on view switch, so unsaved edits carry across raw↔rendered
        raw ? (
          <div className="cm-wrap">
            <CodeMirror
              key={`${reloadKey}-raw`}
              value={mdSeed ?? loaded.text!}
              height="100%"
              theme={resolvedTheme === 'dark' ? oneDark : 'light'}
              extensions={extensions}
              onChange={handleChange}
            />
          </div>
        ) : (
          <MarkdownEditor
            key={`${reloadKey}-md`}
            initialValue={mdSeed ?? loaded.text!}
            onChange={handleChange}
          />
        )
      ) : (
        <div className="cm-wrap">
          <CodeMirror
            key={reloadKey}
            value={loaded.text}
            height="100%"
            theme={resolvedTheme === 'dark' ? oneDark : 'light'}
            extensions={extensions}
            onChange={handleChange}
          />
        </div>
      )}
      {isMd && (
        <div className="md-view-toggle">
          <button
            type="button"
            className={raw ? '' : 'active'}
            onClick={() => {
              setMdSeed(contentRef.current)
              setRaw(false)
            }}
          >
            {t('renderedView')}
          </button>
          <button
            type="button"
            className={raw ? 'active' : ''}
            onClick={() => {
              setMdSeed(contentRef.current)
              setRaw(true)
            }}
          >
            {t('rawView')}
          </button>
        </div>
      )}
      {loaded?.meta && !loaded.error && (
        <div className="file-meta">
          {loaded.meta}
          {dirty && <span className="file-dirty-note"> · {t('unsavedChanges')}</span>}
          {diskDeleted && !diskConflict && (
            <span className="file-dirty-note"> · {t('fileDeletedOnDisk')}</span>
          )}
          {saveError && <span className="file-err"> · {t('saveFailed', { name: saveError })}</span>}
        </div>
      )}
    </div>
  )
}
