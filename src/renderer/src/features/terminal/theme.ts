// mahas terminal — xterm theme.
//
// The terminal is a content island inside the pane card, so its background
// matches `--bg-pane` rather than the chrome above it (see AGENTS.md → Visual
// system). Cursor/selection colors follow the app accent family per theme.

export const TERM_THEME = {
  dark: {
    background: '#151516',
    foreground: '#ececef',
    cursor: '#7aa2f7',
    cursorAccent: '#0e1114',
    selectionBackground: '#2a3444',
    selectionInactiveBackground: '#1d2129'
  },
  light: {
    background: '#f6f6f7',
    foreground: '#1e2126',
    cursor: '#4f6ef7',
    cursorAccent: '#fbfbfc',
    selectionBackground: '#d4dbf8',
    selectionInactiveBackground: '#e3e6ea'
  }
}
