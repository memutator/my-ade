// Detached-window mode: the renderer boots with ?detached=<wsId>:<paneId> and
// renders only that pane in its own OS window. Components consult this flag
// for context-appropriate behavior (pane actions route through pane:cmd,
// split/float controls hide, etc).
export const detachedKey = new URLSearchParams(location.search).get('detached')
export const isDetachedWin = !!detachedKey
export const [detachedWsId, detachedPaneId] = detachedKey?.split(':') ?? []
