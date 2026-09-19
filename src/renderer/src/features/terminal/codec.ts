// mahas terminal — transport codec.
//
// The pty bridge moves bytes as base64 over IPC (structured clone carries a
// string far more cheaply than a byte array) and the host replays scrollback
// as the same encoding. Decoding is the terminal's business, so it lives here
// rather than in the pane component.

export function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export const utf8 = new TextDecoder()
