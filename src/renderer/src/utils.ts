import { agentLabel } from './agents'
import { translate } from './i18n'
import type { Language, PaneState, PaneTab } from './types'

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
  }
}

// a leaf's identity is its active block — used by the drag ghost, dock chips
// and the detached window's title bar
export function paneLabel(pane: PaneState, lang: Language): string {
  const t = pane.tabs.find((x) => x.id === pane.activeTabId) ?? pane.tabs[0]
  return t ? blockLabel(t, lang) : ''
}
