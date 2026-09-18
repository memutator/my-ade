import { agentLabel } from './agents'
import { translate } from './i18n'
import type { AppNotification, Language, PaneState, PaneTab } from './types'

export function fmtTok(n: number): string {
  const a = Math.abs(n)
  if (a >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (a >= 10_000) return `${Math.round(n / 1000)}k`
  if (a >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (n >= 10) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(2)}`
  if (n > 0) return `$${n.toFixed(4)}`
  return ''
}

export function shortPath(p: string): string {
  const home = '/home/'
  if (p.startsWith(home)) return '~/' + p.slice(home.length).split('/').slice(1).join('/')
  return p
}

/** 'https://x/y' → 'x/y' — omnibox display form (the 'https://' empty sentinel
    becomes '') */
export function urlForDisplay(url: string): string {
  return url === 'https://' ? '' : url
}

// one label source for blocks — tab strip, pane grip, dock chip, detached
// title bar all read from here
export function blockLabel(tab: PaneTab, lang: Language): string {
  switch (tab.kind) {
    case 'term':
      return (
        tab.title ??
        (tab.agent ? agentLabel(tab.agent) : (tab.shell ?? translate(lang, 'terminal')))
      )
    case 'web':
      return (
        tab.title || (tab.url === 'https://' ? translate(lang, 'newTab') : urlForDisplay(tab.url))
      )
    case 'file':
      return tab.name || translate(lang, 'editor')
    case 'widget':
      return translate(
        lang,
        tab.widget === 'usage'
          ? 'widgetUsage'
          : tab.widget === 'tokens'
            ? 'widgetTokens'
            : 'widgetAgents'
      )
  }
}

export function blockSub(tab: PaneTab): string | undefined {
  switch (tab.kind) {
    case 'term':
      return tab.cwd ? shortPath(tab.cwd) : undefined
    case 'web':
      return urlForDisplay(tab.url) || undefined
    case 'file':
      return tab.path || undefined
    case 'widget': {
      if (tab.widget !== 'usage') return undefined
      const ids = tab.providers?.length ? tab.providers : tab.provider ? [tab.provider] : []
      if (!ids.length) return undefined
      if (ids.length === 1) return agentLabel(ids[0])
      return `${agentLabel(ids[0])} +${ids.length - 1}`
    }
  }
}

// The close-slot status dot's precedence, shared by the leaf's tab strip and
// the sidebar/widget agents list: an unanswered ask outranks a past failure,
// both outrank the live working pulse, all outrank generic news
// (unread / file-dirty / exited shell).
export type TabStatus = 'working' | 'input' | 'error' | 'news'

export function statusForTab(
  tab: PaneTab,
  notifications: AppNotification[]
): TabStatus | undefined {
  const unread = notifications.filter((n) => !n.read && n.tabId === tab.id)
  if (unread.some((n) => n.kind === 'needs-input')) return 'input'
  if (unread.some((n) => n.kind === 'error')) return 'error'
  if (tab.kind === 'term' && tab.working) return 'working'
  const news =
    tab.kind === 'term'
      ? tab.exited || unread.length > 0
      : tab.kind === 'file'
        ? tab.dirty || unread.length > 0
        : unread.length > 0
  return news ? 'news' : undefined
}

// a leaf's content description: its user-set name, else the active block —
// used by the drag ghost, dock chips and the detached window's title bar
export function paneLabel(pane: PaneState, lang: Language): string {
  if (pane.name) return pane.name
  const t = pane.tabs.find((x) => x.id === pane.activeTabId) ?? pane.tabs[0]
  return t ? blockLabel(t, lang) : ''
}

// a leaf's identity where content doesn't answer 'which pane' (the agents
// panel's group headers): the user-set name, else the stable creation-order
// number — never the volatile active-tab label
export function paneTitle(pane: PaneState, lang: Language): string {
  return pane.name ?? translate(lang, 'paneN', { n: String(pane.num ?? 0) })
}

/* elapsed time — the agents list's running timer ("1h 2m 3s", "1m 23s") */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m ${sec}s`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

/* coarse age for the '… ago' label ("12s", "5m", "2h", "3d") */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
