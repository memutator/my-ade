import { useSyncExternalStore } from 'react'
import type { FloatCtxValue } from './components/floatCtx'

// Registry of DOM slots a pane can live in: a `.node.leaf` div in SplitView
// or the `.float-inner` box of a FloatLayer overlay. Panes render ONCE per
// record (see PanePortals in SplitView.tsx) and portal into whichever slot
// currently hosts them — layout restructuring (split/close/move/float/dock)
// then reparents the DOM without unmounting, so terminals, webviews and
// editors keep their live state instead of being torn down and rebuilt.
export interface PaneSlotRef {
  el: HTMLElement
  floatCtx?: FloatCtxValue | null
}

const slots = new Map<string, PaneSlotRef>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const f of listeners) f()
}

/**
 * Register a host element for paneId. Returns an unregister that only clears
 * its own registration — during a layout rewrite several slot divs un/register
 * in one commit, and a stale cleanup must not clobber a newer registration.
 */
export function registerPaneSlot(
  paneId: string,
  el: HTMLElement,
  floatCtx?: FloatCtxValue | null
): () => void {
  const rec: PaneSlotRef = { el, floatCtx }
  slots.set(paneId, rec)
  notify()
  return () => {
    if (slots.get(paneId) === rec) {
      slots.delete(paneId)
      notify()
    }
  }
}

export function usePaneSlot(paneId: string): PaneSlotRef | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => slots.get(paneId) ?? null
  )
}
