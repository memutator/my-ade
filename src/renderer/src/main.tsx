import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import DetachedApp from './components/DetachedApp'
import { detachedKey, detachedWsId, detachedPaneId } from './detached'
import { useStore } from './store'
import { installShellTestApi } from './shell/test-api'
import { loadAgentManifest } from './agents'
import './styles.css'
import './workbench/workbench.css'

// @ts-expect-error debugging handle (CDP / console poking)
window.__mahas = useStore
if (window.mahas?.test) installShellTestApi(useStore)

async function bootstrap(): Promise<void> {
  const [saved] = await Promise.all([
    window.mahas.state.load().catch(() => null),
    loadAgentManifest().catch(() => ({}))
  ])
  if (saved && typeof saved === 'object') {
    useStore.getState().hydrate(saved as never)
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {detachedKey ? <DetachedApp wsId={detachedWsId} paneId={detachedPaneId} /> : <App />}
    </React.StrictMode>
  )
}

bootstrap()
