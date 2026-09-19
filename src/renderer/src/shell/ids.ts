// mahas shell — opaque id minting for layout/state records.
//
// Every pane, leaf, split, tab, notification and toast id in the renderer
// comes from here. The renderer never mints an id that carries meaning (a
// path, a label, a native id) — identity is a UUID and everything else is a
// field on the record.

export const uid = (): string => crypto.randomUUID()
