import { createContext, useContext } from 'react'

// When a pane renders inside a floating overlay, FloatLayer supplies a
// titlebar-drag handler here; PaneFrame wires it onto .pane-titlebar.
export interface FloatCtxValue {
  onTitlebarPointerDown: (e: React.PointerEvent) => void
}

export const FloatCtx = createContext<FloatCtxValue | null>(null)
export const useFloatCtx = (): FloatCtxValue | null => useContext(FloatCtx)
