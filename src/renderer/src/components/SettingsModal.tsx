import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'
import { loadAgentManifest } from '../agents'
import type { AgentProviderInfo, Theme } from '../types'

const ACCENTS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#7dcfff', '#ff9e64']

export default function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const { setSettingsOpen, updateSettings } = useStore()
  const [providers, setProviders] = useState<Record<string, AgentProviderInfo>>({})

  useEffect(() => {
    if (open && Object.keys(providers).length === 0) {
      loadAgentManifest().then(setProviders)
    }
  }, [open, providers])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setSettingsOpen])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>settings</span>
          <button className="pbtn" onClick={() => setSettingsOpen(false)}>
            <X />
          </button>
        </div>
        <div className="modal-body">
          <section>
            <h3>appearance</h3>
            <div className="srow">
              <label>theme</label>
              <div className="seg">
                {(['dark', 'light', 'system'] as Theme[]).map((t) => (
                  <button
                    key={t}
                    className={settings.theme === t ? 'on' : ''}
                    onClick={() => updateSettings({ theme: t })}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="srow">
              <label>accent</label>
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
              <label>ui font</label>
              <input
                className="sinput"
                value={settings.uiFont}
                onChange={(e) => updateSettings({ uiFont: e.target.value })}
                spellCheck={false}
              />
            </div>
            <div className="srow">
              <label>terminal font</label>
              <input
                className="sinput"
                value={settings.termFont}
                onChange={(e) => updateSettings({ termFont: e.target.value })}
                spellCheck={false}
              />
            </div>
            <div className="srow">
              <label>terminal font size</label>
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
          </section>

          <section>
            <h3>notifications</h3>
            <div className="srow">
              <label>os notifications</label>
              <button
                className={`toggle${settings.osNotifications ? ' on' : ''}`}
                onClick={() => updateSettings({ osNotifications: !settings.osNotifications })}
              >
                <span className="knob" />
              </button>
            </div>
          </section>

          <section>
            <h3>agent providers</h3>
            {Object.keys(providers).length === 0 && (
              <div className="srow dim">no providers found</div>
            )}
            {Object.entries(providers).map(([id, info]) => (
              <div className="srow" key={id}>
                <label>{info.label ?? id}</label>
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
          </section>
        </div>
      </div>
    </div>
  )
}
