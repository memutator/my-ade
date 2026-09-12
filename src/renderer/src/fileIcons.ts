import { useEffect, useState } from 'react'
import manifest from 'material-icon-theme/dist/material-icons.json'

interface IconManifest {
  file: string
  folder: string
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  folderNames: Record<string, string>
  iconDefinitions: Record<string, { iconPath: string }>
}

const m = manifest as IconManifest

// Lazy per-icon URL loaders — keys are file paths, we index by basename.
const modules = import.meta.glob('../../../node_modules/material-icon-theme/icons/*.svg', {
  query: '?url',
  import: 'default'
}) as Record<string, () => Promise<string>>

const loaders = new Map<string, () => Promise<string>>()
for (const [p, load] of Object.entries(modules)) loaders.set(p.split('/').pop()!, load)

const urlCache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

function iconNameFor(name: string, isDir: boolean, open?: boolean): string {
  const lc = name.toLowerCase()
  if (isDir) {
    const base = m.folderNames[lc] ?? m.folder ?? 'folder'
    return open && m.iconDefinitions[`${base}-open`] ? `${base}-open` : base
  }
  if (m.fileNames[lc]) return m.fileNames[lc]
  // longest-suffix first so 'd.ts'/'test.ts' style compound exts win
  const parts = lc.split('.')
  for (let i = 1; i < parts.length; i++) {
    const icon = m.fileExtensions[parts.slice(i).join('.')]
    if (icon) return icon
  }
  return m.file ?? 'file'
}

function fileFor(iconName: string): string {
  const def = m.iconDefinitions[iconName]
  return def ? def.iconPath.split('/').pop()! : 'file.svg'
}

function resolveUrl(name: string, isDir: boolean, open?: boolean): Promise<string | null> {
  const key = `${iconNameFor(name, isDir, open)}`
  const hit = urlCache.get(key)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(key)
  if (!p) {
    const load = loaders.get(fileFor(key))
    p = load
      ? load().then((u) => {
          urlCache.set(key, u)
          pending.delete(key)
          return u
        })
      : Promise.resolve(null)
    pending.set(key, p)
  }
  return p
}

export function useFileIcon(name: string, isDir: boolean, open?: boolean): string | null {
  const key = `${name}:${isDir}:${open ?? false}`
  const [url, setUrl] = useState<string | null>(
    () => urlCache.get(iconNameFor(name, isDir, open)) ?? null
  )
  useEffect(() => {
    if (url) return
    let on = true
    resolveUrl(name, isDir, open).then((u) => on && u && setUrl(u))
    return () => {
      on = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return url
}
