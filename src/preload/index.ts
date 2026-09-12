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
  t: 'spawned' | 'data' | 'exit' | 'cwd' | 'agent' | 'error'
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
  data?: string // base64
}

export interface FileWriteResult {
  ok: boolean
  error?: string
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface AgentHookEvent {
  provider: string
  event: string
  cwd?: string
  sessionId?: string
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
      ipcRenderer.invoke('file:write', path, content)
  },
  fs: {
    list: (dirPath: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:list', dirPath),
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
    resolvePath: (p: string, cwd?: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:resolve', p, cwd)
  },
  state: {
    load: (): Promise<unknown> => ipcRenderer.invoke('state:load'),
    save: (state: unknown): Promise<void> => ipcRenderer.invoke('state:save', state)
  },
  notify: {
    show: (title: string, body?: string, meta?: { workspaceId?: string; paneId?: string }): void =>
      ipcRenderer.send('notify:show', { title, body, ...meta }),
    onClicked: (
      cb: (m: { title: string; body?: string; workspaceId?: string; paneId?: string }) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        m: { title: string; body?: string; workspaceId?: string; paneId?: string }
      ): void => cb(m)
      ipcRenderer.on('notify:clicked', handler)
      return () => ipcRenderer.removeListener('notify:clicked', handler)
    }
  },
  agents: {
    manifest: (): Promise<Record<string, { label: string; match: string[] }>> =>
      ipcRenderer.invoke('agents:manifest'),
    configure: (patterns: Record<string, string[]>): void =>
      ipcRenderer.send('agents:config', patterns)
  },
  hooks: {
    status: (): Promise<AgentHookStatus[]> => ipcRenderer.invoke('hooks:status'),
    install: (provider: string): Promise<HookActionResult> =>
      ipcRenderer.invoke('hooks:install', provider),
    test: (provider: string): Promise<HookActionResult> =>
      ipcRenderer.invoke('hooks:test', provider),
    onEvent: (cb: (e: AgentHookEvent) => void): (() => void) => {
      const handler = (_: unknown, e: AgentHookEvent): void => cb(e)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    }
  },
  win: {
    minimize: (): void => ipcRenderer.send('win:minimize'),
    maximize: (): void => ipcRenderer.send('win:maximize'),
    close: (): void => ipcRenderer.send('win:close')
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
