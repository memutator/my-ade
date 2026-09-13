import { Fragment, useEffect, useState } from 'react'
import {
  ArrowLeft,
  Bookmark as BookmarkIcon,
  Bot,
  Globe,
  Keyboard,
  Palette,
  Trash2
} from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import type { TKey } from '../i18n'
import { loadAgentManifest } from '../agents'
import AgentIcon from './AgentIcon'
import type { AgentHookStatus, AgentProviderInfo, Language, Theme } from '../types'
import '../settings.css'

const ACCENTS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#7dcfff', '#ff9e64']

const LANG_LABELS: Record<Language, string> = {
  system: 'system',
  en: 'English',
  ko: '한국어'
}

type Section = 'appearance' | 'browser' | 'bookmarks' | 'agents' | 'shortcuts'

const SECTIONS: Section[] = ['appearance', 'browser', 'bookmarks', 'agents', 'shortcuts']

const SECTION_ICON: Record<Section, React.JSX.Element> = {
  appearance: <Palette />,
  browser: <Globe />,
  bookmarks: <BookmarkIcon />,
  agents: <Bot />,
  shortcuts: <Keyboard />
}

// Read-only shortcut reference — keep in sync with shortcuts.ts (dispatch)
// and FileView's Ctrl+S save.
const SHORTCUT_GROUPS: { label: TKey; rows: { desc: TKey; keys: string }[] }[] = [
  {
    label: 'scPanes',
    rows: [
      { desc: 'scNewPane', keys: 'Alt+T / Alt+B / Alt+E / Alt+L' },
      { desc: 'scSplit', keys: 'Alt+D / Alt+S' },
      { desc: 'scClosePane', keys: 'Alt+W' },
      { desc: 'scMinimize', keys: 'Alt+H' },
      { desc: 'scFloat', keys: 'Alt+F' },
      { desc: 'scCycleFocus', keys: 'Alt+] / Alt+[' },
      { desc: 'scDirFocus', keys: 'Alt+←/→/↑/↓' }
    ]
  },
  {
    label: 'scTabs',
    rows: [
      { desc: 'scNextWs', keys: 'Ctrl+Alt+← / Ctrl+Alt+→' },
      { desc: 'scWsN', keys: 'Alt+1 … Alt+9' },
      { desc: 'scPaneTab', keys: 'Ctrl+Tab / Ctrl+Shift+Tab' }
    ]
  },
  {
    label: 'scWindow',
    rows: [
      { desc: 'scSidebar', keys: 'Alt+X' },
      { desc: 'scTreeOverlay', keys: 'Alt+O' }
    ]
  },
  {
    label: 'scMisc',
    rows: [
      { desc: 'scTheme', keys: 'Alt+M' },
      { desc: 'scSave', keys: 'Ctrl+S' },
      { desc: 'scEsc', keys: 'Esc' }
    ]
  }
]

// Settings as a full page — slides over the workspace area (terminals stay
// mounted underneath). Left nav switches sections; content is card-grouped.
export default function SettingsPage(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const bookmarks = useStore((s) => s.bookmarks)
  const projects = useStore((s) => s.projects)
  const { setSettingsOpen, updateSettings, removeBookmark } = useStore()
  const [providers, setProviders] = useState<Record<string, AgentProviderInfo>>({})
  const [hooks, setHooks] = useState<AgentHookStatus[]>([])
  const [section, setSection] = useState<Section>('appearance')
  const t = useT()

  const SECTION_LABEL: Record<Section, string> = {
    appearance: t('appearance'),
    browser: t('browser'),
    bookmarks: t('bookmarks'),
    agents: t('agentsAndNotif'),
    shortcuts: t('shortcuts')
  }

  useEffect(() => {
    if (!open) return
    loadAgentManifest().then(setProviders)
    window.ade.hooks?.status().then(setHooks)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setSettingsOpen])

  if (!open) return null

  // Group bookmarks for display: 'global' first, then each project in registry
  // order; scopes matching no project (stale ids) fall through to the raw
  // scope string (project path/id) as their label.
  const bmGroups = (() => {
    const byScope = new Map<string, typeof bookmarks>()
    for (const b of bookmarks) {
      const list = byScope.get(b.scope)
      if (list) list.push(b)
      else byScope.set(b.scope, [b])
    }
    const known = new Set(projects.map((p) => p.id))
    const order = [
      'global',
      ...projects.map((p) => p.id),
      ...[...byScope.keys()].filter((sc) => sc !== 'global' && !known.has(sc))
    ]
    return order
      .filter((sc) => byScope.has(sc))
      .map((sc) => ({
        scope: sc,
        label: sc === 'global' ? t('bmGlobal') : (projects.find((p) => p.id === sc)?.name ?? sc),
        items: byScope.get(sc)!
      }))
  })()

  return (
    <div className="spage">
      <nav className="spage-nav">
        <button className="sback" onClick={() => setSettingsOpen(false)}>
          <ArrowLeft />
          {t('backToApp')}
        </button>
        <div className="spage-nav-title">{t('settings')}</div>
        {SECTIONS.map((s) => (
          <button
            key={s}
            className={`snav${section === s ? ' on' : ''}`}
            onClick={() => setSection(s)}
          >
            {SECTION_ICON[s]}
            {SECTION_LABEL[s]}
          </button>
        ))}
      </nav>
      <div className="spage-body">
        <h2 className="spage-h">{SECTION_LABEL[section]}</h2>

        {section === 'appearance' && (
          <div className="scard">
            <div className="srow">
              <label>{t('theme')}</label>
              <div className="seg">
                {(['dark', 'light', 'system'] as Theme[]).map((v) => (
                  <button
                    key={v}
                    className={settings.theme === v ? 'on' : ''}
                    onClick={() => updateSettings({ theme: v })}
                  >
                    {t(v)}
                  </button>
                ))}
              </div>
            </div>
            <div className="srow">
              <label>{t('language')}</label>
              <select
                className="sselect"
                value={settings.language}
                onChange={(e) => updateSettings({ language: e.target.value as Language })}
              >
                {(['system', 'en', 'ko'] as Language[]).map((v) => (
                  <option key={v} value={v}>
                    {v === 'system' ? t('system') : LANG_LABELS[v]}
                  </option>
                ))}
              </select>
            </div>
            <div className="srow">
              <label>{t('accent')}</label>
              <div className="swatches">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    className={`swatch${settings.accent === c ? ' on' : ''}`}
                    style={{ background: c }}
                    onClick={() => updateSettings({ accent: c })}
                  />
                ))}
              </div>
            </div>
            <div className="srow">
              <label>{t('uiFont')}</label>
              <input
                className="sinput"
                value={settings.uiFont}
                onChange={(e) => updateSettings({ uiFont: e.target.value })}
                spellCheck={false}
              />
            </div>
            <div className="srow">
              <label>{t('terminalFont')}</label>
              <input
                className="sinput"
                value={settings.termFont}
                onChange={(e) => updateSettings({ termFont: e.target.value })}
                spellCheck={false}
              />
            </div>
            <div className="srow">
              <label>{t('terminalFontSize')}</label>
              <input
                className="sinput narrow"
                type="number"
                step={0.5}
                min={8}
                max={24}
                value={settings.termFontSize}
                onChange={(e) => updateSettings({ termFontSize: Number(e.target.value) || 12.5 })}
              />
            </div>
            <div className="srow">
              <label>{t('editorFont')}</label>
              <input
                className="sinput"
                value={settings.editorFont}
                placeholder={settings.termFont}
                onChange={(e) => updateSettings({ editorFont: e.target.value })}
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {section === 'browser' && (
          <div className="scard">
            <div className="srow">
              <div className="srow-labelcol">
                <label>{t('homeUrl')}</label>
                <span className="srow-desc">{t('homeUrlDesc')}</span>
              </div>
              <input
                className="sinput"
                value={settings.homeUrl}
                placeholder="https://"
                onChange={(e) => updateSettings({ homeUrl: e.target.value })}
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {section === 'bookmarks' && (
          <>
            {bmGroups.length === 0 && (
              <div className="scard">
                <div className="srow dim">{t('bmEmpty')}</div>
              </div>
            )}
            {bmGroups.map((g) => (
              <Fragment key={g.scope}>
                <h3 className="ssub">{g.label}</h3>
                <div className="scard">
                  {g.items.map((b) => (
                    <div className="srow bm-row" key={b.id}>
                      <div className="bm-main">
                        <span className="bm-title">{b.title || b.url}</span>
                        <span className="bm-url">{b.url}</span>
                      </div>
                      <span className="bm-scope">{g.label}</span>
                      <button
                        className="pbtn bm-del"
                        title={t('removeBookmark')}
                        onClick={() => removeBookmark(b.id)}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  ))}
                </div>
              </Fragment>
            ))}
          </>
        )}

        {section === 'agents' && (
          <>
            <div className="scard">
              <div className="srow">
                <label>{t('osNotifications')}</label>
                <button
                  className={`toggle${settings.osNotifications ? ' on' : ''}`}
                  onClick={() => updateSettings({ osNotifications: !settings.osNotifications })}
                >
                  <span className="knob" />
                </button>
              </div>
            </div>
            <h3 className="ssub">{t('agentProviders')}</h3>
            <div className="scard">
              {Object.keys(providers).length === 0 && (
                <div className="srow dim">{t('noProviders')}</div>
              )}
              {Object.entries(providers).map(([id, info]) => (
                <div className="srow" key={id}>
                  <label className="srow-label">
                    <AgentIcon id={id} size={13} />
                    {info.label ?? id}
                  </label>
                  <button
                    className={`toggle${settings.providers[id] !== false ? ' on' : ''}`}
                    onClick={() =>
                      updateSettings({
                        providers: { ...settings.providers, [id]: settings.providers[id] === false }
                      })
                    }
                  >
                    <span className="knob" />
                  </button>
                </div>
              ))}
            </div>
            <h3 className="ssub">{t('agentHooks')}</h3>
            <div className="scard">
              {hooks.length === 0 && <div className="srow dim">{t('noHookableProviders')}</div>}
              {hooks.map((h) => (
                <div className="srow" key={h.id}>
                  <label>{h.label}</label>
                  <div className="hook-meta">
                    <span className={`hook-state${h.installed ? ' ok' : ''}`}>
                      {h.installed
                        ? t('hookInstalled')
                        : h.available
                          ? t('hookNotInstalled')
                          : t('hookCliNotFound')}
                    </span>
                    <span className="hook-mech">{h.mechanism}</span>
                  </div>
                  {!h.installed && h.available && (
                    <button
                      className="sbtn"
                      onClick={() =>
                        window.ade.hooks
                          .install(h.id)
                          .then(() => window.ade.hooks.status().then(setHooks))
                      }
                    >
                      {t('install')}
                    </button>
                  )}
                  {h.installed && (
                    <button className="sbtn" onClick={() => window.ade.hooks.test(h.id)}>
                      {t('test')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {section === 'shortcuts' &&
          SHORTCUT_GROUPS.map((g) => (
            <Fragment key={g.label}>
              <h3 className="ssub">{t(g.label)}</h3>
              <div className="scard">
                {g.rows.map((r) => (
                  <div className="srow sc-row" key={r.desc}>
                    <label>{t(r.desc)}</label>
                    <kbd className="sc-keys">{r.keys}</kbd>
                  </div>
                ))}
              </div>
            </Fragment>
          ))}
      </div>
    </div>
  )
}
