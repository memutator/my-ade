// mahas terminal — agent error-banner scan.
//
// Devin prints `[Error] Reached free model rate limit…` and stops the turn
// without emitting a Stop/StopFailure hook, so the renderer classifies that
// banner out of pty output (see AGENTS.md → agent hooks). The scan runs over a
// rolling stripped-ANSI tail because a banner can split across chunks.
//
// Keep the prefixes in sync with mahas-hook.cjs `isFailedStop`.

/** How much of the stripped tail to keep for the next chunk's scan. */
export const ERROR_SCAN_TAIL = 2500

export function stripAnsi(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 27) {
      out += s[i]
      continue
    }
    // CSI: ESC [ … @-~
    if (s[i + 1] === '[') {
      i += 2
      while (i < s.length) {
        const c = s.charCodeAt(i)
        if (c >= 64 && c <= 126) break
        i++
      }
    }
  }
  return out
}

const ERROR_BANNER_RE =
  /(?:^|[\r\n])((?:\[Error\][ \t]*|Rate limited:[ \t]*|Quota exhausted:[ \t]*)[^\r\n]+)/gi

/** The last error banner in `buf`, with the index just past it so the caller
 *  can keep scanning from there and never re-fire the same banner. */
export function lastErrorBanner(buf: string): { msg: string; end: number } | null {
  ERROR_BANNER_RE.lastIndex = 0
  let hit: { msg: string; end: number } | null = null
  let m: RegExpExecArray | null
  while ((m = ERROR_BANNER_RE.exec(buf))) {
    const msg = (m[1] || '').trim()
    if (msg) hit = { msg, end: m.index + m[0].length }
  }
  return hit
}

/** Rolling scanner: feed raw pty chunks, get back any newly completed banner.
 *  Stateful because a banner (and the CSI sequences inside it) can straddle a
 *  chunk boundary; `reset()` drops the tail when the stream restarts (attach
 *  replay), so replayed history never fires a historical banner. */
export class ErrorBannerScanner {
  private tail = ''

  reset(): void {
    this.tail = ''
  }

  /** Returns the banner message when this chunk completed one, else null. */
  push(chunk: string): string | null {
    const buf = (this.tail + stripAnsi(chunk)).slice(-ERROR_SCAN_TAIL)
    const hit = lastErrorBanner(buf)
    if (!hit) {
      this.tail = buf
      return null
    }
    this.tail = buf.slice(hit.end)
    return hit.msg
  }
}
