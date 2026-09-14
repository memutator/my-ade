/* A native dialog steals and returns focus without any mousedown reaching
   the window — Popup's focus-theft close fires on return, killing whichever
   card launched it. Callers that invoke a dialog from inside a popup wrap
   the IPC promise in this so open popups survive the round-trip (the tail
   covers the focus event landing just after the promise resolves). */
let openDialogs = 0

export function withNativeDialog<T>(p: Promise<T>): Promise<T> {
  openDialogs++
  return p.finally(() => setTimeout(() => openDialogs--, 300))
}

export function nativeDialogOpen(): boolean {
  return openDialogs > 0
}
