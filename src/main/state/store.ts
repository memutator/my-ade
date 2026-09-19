// mahas main — desktop state persistence.
//
// The renderer owns the shape of the shell state; main owns the file. This
// module is the whole boundary: where it lives, who may write it, and how a
// write that must not be lost (shutdown) differs from the debounced one.
//
// Two writers, on purpose:
//   - `state:save` is the renderer's debounced snapshot. Only the MAIN window
//     may write it — a detached pane's renderer shares the same store API but
//     its state is a partial view, and letting it write would clobber the
//     canonical file with whatever that window happened to know.
//   - `state:saveSync` is the beforeunload path: the renderer's pending timer
//     dies with the window, so the last snapshot (resume records, final
//     session-end events) has to land synchronously.

import { app, ipcMain } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { StatePersistence, withShutdownEvidence } from './persistence.ts'

export const stateFilePath = (): string => join(app.getPath('userData'), 'mahas-state.json')
const persistence = new StatePersistence(stateFilePath)

/** Load the persisted shell state, or null when there is none / it is
 *  unreadable. A corrupt file is not an error the renderer can act on — it
 *  hydrates from defaults and the next save overwrites it. */
export async function loadStateFile(): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(stateFilePath(), 'utf8'))
  } catch {
    return null
  }
}

export async function saveStateFile(state: unknown): Promise<boolean> {
  return persistence.save(state)
}

export function saveStateFileSync(state: unknown): boolean {
  return persistence.saveSync(withShutdownEvidence(state, process.env.MAHAS_SESSION ?? ''))
}

/**
 * Register the state IPC. `isCanonicalSender` decides which renderer may
 * write the file — main window only (see the note above); it is a predicate
 * rather than a window reference so the wiring in index.ts stays the one
 * place that knows about windows.
 */
export function registerStateIpc(
  isCanonicalSender: (sender: Electron.WebContents) => boolean
): void {
  ipcMain.handle('state:load', () => loadStateFile())

  ipcMain.handle('state:save', async (e, state: unknown) => {
    if (!isCanonicalSender(e.sender)) return
    await saveStateFile(state)
  })

  // the debounced save can't be trusted on shutdown — the renderer's pending
  // timer dies with the window. beforeunload calls this sendSync variant so
  // the last snapshot lands on disk before the process exits.
  ipcMain.on('state:saveSync', (e, state: unknown) => {
    if (!isCanonicalSender(e.sender)) {
      e.returnValue = false
      return
    }
    e.returnValue = saveStateFileSync(state)
  })
}
