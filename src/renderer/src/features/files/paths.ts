// mahas files — posix path helpers.
//
// mahas only ever runs on this linux box, so the tree works on plain posix
// strings rather than node:path. Keeping the helpers in one place means the
// containment rule (`isUnder`) has exactly one definition — it guards both
// selection pruning and the drag-into-own-subtree check.

export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

export const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'

export const joinPath = (d: string, n: string): string => (d.endsWith('/') ? d : d + '/') + n

/** per-segment encoding — '#' or '?' in a name must not become URL syntax */
export const fileUrl = (p: string): string =>
  'file://' + p.split('/').map(encodeURIComponent).join('/')

export const isHtml = (name: string): boolean => /\.html?$/i.test(name)

/** is `p` the directory `dir` itself, or something inside it? */
export const isUnder = (p: string, dir: string): boolean =>
  p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')

/** the MIME type carrying a tree drag's path list */
export const DND_MIME = 'application/x-mahas-paths'
