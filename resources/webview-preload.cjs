// Preload injected into every <webview> guest. A focused guest keeps its own
// keydown events — the host document never sees them, which would kill every
// app shortcut while typing in a browser pane. Forward app-shortcut combos
// (Alt+*, Ctrl+Tab, plus whatever custom combos the host pushes via
// 'mahas:bindings') via ipc-message → `mahas:key`; everything else reaches the
// page untouched.
const { ipcRenderer } = require('electron')

// user keybindings that aren't covered by the static Alt/Ctrl+Tab filter —
// the host sends the effective list whenever it changes or the guest loads
let extra = new Set()
ipcRenderer.on('mahas:bindings', (_e, combos) => {
  extra = new Set(combos)
})

window.addEventListener(
  'keydown',
  (e) => {
    if (e.metaKey) return
    const combo = [
      ...(e.ctrlKey ? ['ctrl'] : []),
      ...(e.altKey ? ['alt'] : []),
      ...(e.shiftKey ? ['shift'] : []),
      e.key === ' ' ? 'space' : e.key.toLowerCase()
    ].join('+')
    if (!(e.altKey || (e.ctrlKey && e.key === 'Tab') || extra.has(combo))) return
    e.preventDefault()
    e.stopPropagation()
    ipcRenderer.sendToHost('mahas:key', {
      key: e.key,
      alt: e.altKey,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      meta: e.metaKey
    })
  },
  true
)
