import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import { loadAgentManifest } from './agents'
import './styles.css'

if (import.meta.env.DEV) {
  // @ts-expect-error dev-only debugging handle
  window.__ade = useStore
}

async function bootstrap(): Promise<void> {
  const [saved] = await Promise.all([
    window.ade.state.load().catch(() => null),
    loadAgentManifest().catch(() => ({}))
  ])
  if (saved && typeof saved === 'object') {
    useStore.getState().hydrate(saved as never)
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

bootstrap()
