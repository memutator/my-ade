// Preload injected into every <webview> guest. A focused guest keeps its own
// keydown events — the host document never sees them, which would kill every
// app shortcut while typing in a browser pane. Forward app-shortcut combos
// (Alt+*, Ctrl+Tab) to the host via ipc-message → `ade:key`; everything else
// reaches the page untouched.
const { ipcRenderer } = require('electron')

window.addEventListener(
  'keydown',
  (e) => {
    if (e.metaKey) return
    if (!(e.altKey || (e.ctrlKey && e.key === 'Tab'))) return
    e.preventDefault()
    e.stopPropagation()
    ipcRenderer.sendToHost('ade:key', {
      key: e.key,
      alt: e.altKey,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      meta: e.metaKey
    })
  },
  true
)
