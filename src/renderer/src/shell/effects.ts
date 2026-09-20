// mahas shell — the OS-facing seam for store actions.
//
// Store actions are state math: they compute the next shell state and commit
// it. A few of them also have to touch the OS — a detached pane owns its own
// window and its own ptys, and closing that pane from the main window must
// kill the sessions and tear the window down, because the detached renderer
// is already gone by then. Those calls are named here so the store never
// inlines `window.mahas.*` and never has to branch on which window it runs
// in.
//
// Effects take the data they need as arguments rather than reaching back into
// the store: the action already knows which sessions it is tearing down, and
// an effect that cannot read state cannot disagree with the state it just
// committed.
//
// Ordering is part of the contract: an action commits its state FIRST and runs
// the effect afterwards, so a failing OS call can never leave the shell
// holding a pane it already tried to close.

export interface ShellEffects {
  /** kill live ptys owned by tabs that are leaving the shell */
  killPtys: (sessionIds: string[]) => void
  /** tear down a detached pane's OS window (the pane is already gone) */
  closeDetachedWindow: (wsId: string, paneId: string) => void
  /** raise a detached pane's window without moving focus in the main one */
  focusDetachedWindow: (wsId: string, paneId: string) => void
  /** unbind a managed execution view (tab close). no-op without exec: */
  unbindManagedTab: (u: {
    viewId: string
    expectedRevision?: number
    terminalId?: string
  }) => void
  /** relay a pane-scoped command to the renderer that owns the shell state */
  relayPaneCommand: (cmd: {
    action: string
    wsId: string
    paneId: string
    tabId?: string
    provider?: string
    url?: string
    message?: string
  }) => void
}

export function shellEffects(): ShellEffects {
  return {
    killPtys: (sessionIds) => {
      for (const id of sessionIds) window.mahas.pty.kill(id)
    },
    closeDetachedWindow: (wsId, paneId) => window.mahas.win.closeDetached?.(wsId, paneId),
    focusDetachedWindow: (wsId, paneId) => window.mahas.win.focusDetached(wsId, paneId),
    unbindManagedTab: (u) => {
      if (!window.mahas?.exec) return
      void window.mahas.exec.unbindView({
        operationId: crypto.randomUUID(),
        viewId: u.viewId,
        expectedRevision: u.expectedRevision
      })
      if (u.terminalId) {
        void window.mahas.exec.op({
          operation: 'terminal.detach',
          payload: { terminalId: u.terminalId, viewId: u.viewId }
        })
      }
    },
    relayPaneCommand: (cmd) => window.mahas.win.paneCmd(cmd)
  }
}

/** Live pty session ids owned by a pane's terminal tabs — the payload every
 *  pane-teardown path needs before it drops the records. */
export function panePtySessionIds(pane: { tabs: { kind: string; pty?: string }[] }): string[] {
  return pane.tabs.flatMap((t) => (t.kind === 'term' && t.pty ? [t.pty] : []))
}
