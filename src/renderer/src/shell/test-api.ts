// Narrow test handle for CDP e2e. Not a copy of the zustand store: persist
// fields come from snapshotPersistedState, runtime query fields are named,
// and commands are an allowlist. Installed only when window.mahas.test.

import { snapshotPersistedState } from './persist'
import type { useStore } from '../store'

const COMMANDS = [
  'updateSettings',
  'addProject',
  'createWorkspace',
  'activateWorkspace',
  'removeProject',
  'openUrlInBrowser',
  'newBlock',
  'updatePane',
  'minimizePane',
  'restorePane',
  'floatPane',
  'detachPane',
  'attachPane',
  'closePane',
  'closeTab',
  'splitPane',
  'dockPane'
] as const

export interface ShellTestState {
  [key: string]: unknown
}

export function installShellTestApi(store: typeof useStore): void {
  const handle = {
    getState(): ShellTestState {
      const s = store.getState()
      const view: ShellTestState = {
        ...snapshotPersistedState(s),
        notifications: s.notifications,
        toasts: s.toasts
      }
      for (const name of COMMANDS) {
        const fn = s[name]
        if (typeof fn === 'function') {
          view[name] = (...args: unknown[]) =>
            (fn as (...inner: unknown[]) => unknown)(...args)
        }
      }
      return view
    },
    setState(patch: { agentSessions?: Record<string, never> }): void {
      if (patch.agentSessions !== undefined) store.setState({ agentSessions: patch.agentSessions })
    }
  }
  ;(window as Window & { __mahasTest?: typeof handle }).__mahasTest = handle
}
