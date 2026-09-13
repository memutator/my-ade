import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface PtySpawnOpts {
  id: string
  cols: number
  rows: number
  cwd?: string
  command?: string
  args?: string[]
}

export interface PtyEvent {
  t: 'spawned' | 'attached' | 'attach-failed' | 'data' | 'exit' | 'cwd' | 'agent' | 'error'
  id: string
  d?: string // base64
  pid?: number
  shell?: string
  code?: number
  cwd?: string
  agent?: string | null
  msg?: string
}

export interface FileReadResult {
  ok: boolean
  error?: string
  name?: string
  path?: string
  ext?: string
  size?: number
  kind?: 'image' | 'text' | 'binary' | 'video' | 'audio' | 'pdf'
  mtimeMs?: number
  data?: string // base64
}

export interface FileWriteResult {
  ok: boolean
  error?: string
  mtimeMs?: number // post-write disk mtime, for the FileView save guard
}

export interface FileStatResult {
  ok: boolean
  exists?: boolean
  mtimeMs?: number
  error?: string
}

export interface FileChangedEvent {
  path: string
  mtimeMs?: number
  deleted?: boolean
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface FsOpResult {
  ok: boolean
  error?: string
  path?: string
  paths?: string[]
}

export interface WorktreeEntry {
  path: string
  branch: string | null
  head: string
  main: boolean
}

export interface GitInfo {
  isRepo: boolean
  branch?: string | null
  branches?: string[]
  worktrees?: WorktreeEntry[]
  /** suggested parent dir for new worktrees (`<repo>.worktrees/` sibling) */
  wtRoot?: string
}

export interface AgentHookEvent {
  provider: string
  event: string
  cwd?: string
  sessionId?: string
  /** set by the tailer: true when the event carries this instance's session */
  ours?: boolean
  /** session-rename payload: the new session name */
  name?: string
  message?: string
  ts?: number
}

export interface AgentHookStatus {
  id: string
  label: string
  mechanism: string
  available: boolean
  installed: boolean
  detail?: string
  configPath: string
}

export interface HookActionResult {
  ok: boolean
  error?: string
  detail?: string
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const ade = {
  pty: {
    spawn: (opts: PtySpawnOpts): Promise<void> => ipcRenderer.invoke('pty:spawn', opts),
    // attach to an existing session (remount / detached window): host replies
    // `attached` + replays its scrollback tail as `data` events. Resolves
    // false when the session is gone — caller should spawn instead.
    attach: (id: string, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke('pty:attach', { id, cols, rows }),
    write: (id: string, data: string): void =>
      ipcRenderer.send('pty:write', { id, d: toBase64(data) }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id: string): void => ipcRenderer.send('pty:kill', { id }),
    onEvent: (cb: (e: PtyEvent) => void): (() => void) => {
      const handler = (_: unknown, m: PtyEvent): void => cb(m)
      ipcRenderer.on('pty:event', handler)
      return () => ipcRenderer.removeListener('pty:event', handler)
    }
  },
  file: {
    openDialog: (): Promise<string | null> => ipcRenderer.invoke('file:openDialog'),
    read: (path: string): Promise<FileReadResult> => ipcRenderer.invoke('file:read', path),
    write: (path: string, content: string): Promise<FileWriteResult> =>
      ipcRenderer.invoke('file:write', path, content),
    stat: (path: string): Promise<FileStatResult> => ipcRenderer.invoke('file:stat', path),
    watch: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('file:watch', path),
    unwatch: (path: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('file:unwatch', path),
    onChanged: (cb: (e: FileChangedEvent) => void): (() => void) => {
      const handler = (_: unknown, e: FileChangedEvent): void => cb(e)
      ipcRenderer.on('file:changed', handler)
      return () => ipcRenderer.removeListener('file:changed', handler)
    }
  },
  fs: {
    list: (dirPath: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:list', dirPath),
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
    resolvePath: (p: string, cwd?: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:resolve', p, cwd),
    // file-tree ops (see src/main/fsops.ts)
    create: (dirPath: string, name: string, kind: 'file' | 'dir'): Promise<FsOpResult> =>
      ipcRenderer.invoke('fs:create', dirPath, name, kind),
    rename: (oldPath: string, newPath: string): Promise<FsOpResult> =>
      ipcRenderer.invoke('fs:rename', oldPath, newPath),
    trash: (paths: string[]): Promise<FsOpResult> => ipcRenderer.invoke('fs:trash', paths),
    copy: (paths: string[], destDir: string): Promise<FsOpResult> =>
      ipcRenderer.invoke('fs:copy', paths, destDir),
    move: (paths: string[], destDir: string): Promise<FsOpResult> =>
      ipcRenderer.invoke('fs:move', paths, destDir),
    exists: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:exists', p),
    reveal: (p: string): void => ipcRenderer.send('fs:reveal', p)
  },
  dir: {
    // listing watch for expanded tree dirs (see src/main/dirwatch.ts)
    watch: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('dir:watch', path),
    unwatch: (path: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('dir:unwatch', path),
    onChanged: (cb: (path: string) => void): (() => void) => {
      const handler = (_: unknown, e: { path: string }): void => cb(e.path)
      ipcRenderer.on('dir:changed', handler)
      return () => ipcRenderer.removeListener('dir:changed', handler)
    }
  },
  git: {
    // worktree 분화 (see src/main/worktree.ts)
    info: (repoPath: string): Promise<GitInfo> => ipcRenderer.invoke('git:info', repoPath),
    addWorktree: (
      repoPath: string,
      opts: { branch: string; base?: string }
    ): Promise<FsOpResult & { branch?: string }> =>
      ipcRenderer.invoke('git:worktreeAdd', repoPath, opts),
    removeWorktree: (repoPath: string, wtPath: string, force?: boolean): Promise<FsOpResult> =>
      ipcRenderer.invoke('git:worktreeRemove', repoPath, wtPath, force)
  },
  state: {
    load: (): Promise<unknown> => ipcRenderer.invoke('state:load'),
    save: (state: unknown): Promise<void> => ipcRenderer.invoke('state:save', state)
  },
  notify: {
    show: (
      title: string,
      body?: string,
      meta?: { workspaceId?: string; paneId?: string; tabId?: string }
    ): void => ipcRenderer.send('notify:show', { title, body, ...meta }),
    onClicked: (
      cb: (m: {
        title: string
        body?: string
        workspaceId?: string
        paneId?: string
        tabId?: string
      }) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        m: { title: string; body?: string; workspaceId?: string; paneId?: string; tabId?: string }
      ): void => cb(m)
      ipcRenderer.on('notify:clicked', handler)
      return () => ipcRenderer.removeListener('notify:clicked', handler)
    }
  },
  agents: {
    manifest: (): Promise<Record<string, { label: string; match: string[] }>> =>
      ipcRenderer.invoke('agents:manifest'),
    icon: (id: string): Promise<string | null> => ipcRenderer.invoke('agents:icon', id),
    configure: (patterns: Record<string, string[]>): void =>
      ipcRenderer.send('agents:config', patterns)
  },
  hooks: {
    status: (): Promise<AgentHookStatus[]> => ipcRenderer.invoke('hooks:status'),
    install: (provider: string): Promise<HookActionResult> =>
      ipcRenderer.invoke('hooks:install', provider),
    test: (provider: string): Promise<HookActionResult> =>
      ipcRenderer.invoke('hooks:test', provider),
    emit: (ev: AgentHookEvent): Promise<HookActionResult> => ipcRenderer.invoke('hooks:emit', ev),
    onEvent: (cb: (e: AgentHookEvent) => void): (() => void) => {
      const handler = (_: unknown, e: AgentHookEvent): void => cb(e)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    }
  },
  win: {
    minimize: (): void => ipcRenderer.send('win:minimize'),
    maximize: (): void => ipcRenderer.send('win:maximize'),
    close: (): void => ipcRenderer.send('win:close'),
    // detached pane windows (main window: detach/focus/close; detached
    // window: reattach = close itself, main gets `pane:reattach`)
    detach: (wsId: string, paneId: string, pane?: unknown): void =>
      ipcRenderer.send('win:detach', { wsId, paneId, pane }),
    // booting detached window claims the fresh pane snapshot passed to detach
    hello: (): Promise<{ wsId: string; paneId: string; pane: unknown } | null> =>
      ipcRenderer.invoke('pane:hello'),
    reattach: (): void => ipcRenderer.send('win:reattach'),
    closeDetached: (wsId: string, paneId: string): void =>
      ipcRenderer.send('win:closeDetached', { wsId, paneId }),
    focusDetached: (wsId: string, paneId: string): void =>
      ipcRenderer.send('win:focusDetached', { wsId, paneId }),
    onPaneReattach: (cb: (m: { wsId: string; paneId: string }) => void): (() => void) => {
      const handler = (_: unknown, m: { wsId: string; paneId: string }): void => cb(m)
      ipcRenderer.on('pane:reattach', handler)
      return () => ipcRenderer.removeListener('pane:reattach', handler)
    },
    // detached renderer → main window store command (e.g. closePane)
    paneCmd: (m: { action: string; wsId: string; paneId: string }): void =>
      ipcRenderer.send('pane:cmd', m),
    onPaneCmd: (
      cb: (m: { action: string; wsId: string; paneId: string }) => void
    ): (() => void) => {
      const handler = (_: unknown, m: { action: string; wsId: string; paneId: string }): void =>
        cb(m)
      ipcRenderer.on('pane:cmd', handler)
      return () => ipcRenderer.removeListener('pane:cmd', handler)
    },
    // detached renderer pushes its pane object up to the main store
    paneSyncUp: (m: { wsId: string; paneId: string; pane: unknown }): void =>
      ipcRenderer.send('pane:syncUp', m),
    onPaneSync: (
      cb: (m: { wsId: string; paneId: string; pane: unknown }) => void
    ): (() => void) => {
      const handler = (_: unknown, m: { wsId: string; paneId: string; pane: unknown }): void =>
        cb(m)
      ipcRenderer.on('pane:applySync', handler)
      return () => ipcRenderer.removeListener('pane:applySync', handler)
    }
  },
  webview: {
    // file:// URL of resources/webview-preload.cjs — set as the webview
    // `preload` attribute so guest keydowns for app shortcuts reach the host.
    preloadPath: (): Promise<string> => ipcRenderer.invoke('webview:preloadPath')
  },
  openExternal: (url: string): void => ipcRenderer.send('shell:openExternal', url)
}

export type AdeApi = typeof ade

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('ade', ade)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.ade = ade
}
