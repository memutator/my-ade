// mahas terminal — the working pulse (tab status light).
//
// The tab close slot doubles as a status dot. `working` means "an agent owns
// this shell and a turn is in flight", inferred from pty output because not
// every harness emits hooks: agent TUIs stream/spin while working and go
// silent at their prompt, so a DENSE burst of output that sustains past a
// short window is the evidence. Hook events (attention.ts) refine the same
// flag and can latch it idle.
//
// The bookkeeping this class owns is entirely "why is this chunk not
// evidence", which is the part that is hard to see when it is interleaved
// with xterm wiring:
//
//   - replayed scrollback after attach is history, not work;
//   - keystroke echo redraws the prompt (output, but not work);
//   - a sparse trickle (git/status watchers) neither lights nor holds the
//     lamp;
//   - right after a turn ends the bar rises, so a post-turn redraw storm
//     cannot fake a new turn;
//   - a hook/agent-detect idle latch means output alone may not relight it.
//
// The pulse never touches the store: it reports transitions and the caller
// writes them onto the tab record.

/** silence that ends a turn (ms) */
const WORKING_SILENCE = 1600
/** a chunk continues the burst only within this gap (ms) */
const BURST_GAP = 350
/** dense output needed to light the lamp (ms) */
const BURST_NEED = 900
/** …and after a recent turn end, this much (ms) */
const BURST_NEED_AFTER_TURN = 2000
/** a relight within this window is the same turn (ms) */
const SAME_TURN_WINDOW = 20_000
/** "recent turn end" horizon for the raised bar (ms) */
const TURN_END_HORIZON = 60_000
/** output this soon after typing is echo, not work (ms) */
const INPUT_ECHO_WINDOW = 800
/** how long attach replay suppresses activity (ms) */
const REPLAY_QUIET = 400
/** quiet hold after a turn ends, so trailing redraws cannot relight (ms) */
const POST_TURN_QUIET = 2000

/** The subset of a term tab's record the pulse reasons about. */
export interface PulseState {
  working?: boolean
  workingSince?: number
  turnEndedAt?: number
  quietUntil?: number
  idleLocked?: boolean
}

export interface PulseTransition {
  working: boolean
  workingSince?: number
  turnEndedAt?: number
  quietUntil?: number
}

/**
 * One pulse per terminal tab view. `agent` is the detected agent owning the
 * shell (null = none, which makes all output irrelevant — there is no turn to
 * infer). `write` receives every transition the pulse decides on.
 */
export class WorkingPulse {
  agent: string | null = null

  private replayUntil = 0
  private lastInputAt = 0
  private lastDataAt = 0
  private burstStartAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly write: (t: PulseTransition) => void) {}

  /** Attach replay is starting — the tail that follows is history. */
  noteReplay(): void {
    this.replayUntil = Date.now() + REPLAY_QUIET
  }

  /** The user typed: echo suppression starts, and composing a prompt cannot
   *  keep a burst alive (else a long prompt would itself read as a turn). */
  noteInput(): void {
    this.lastInputAt = Date.now()
    this.burstStartAt = 0
  }

  /** Clear the pending deadline and report the lamp off. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.write({ working: false })
  }

  /** Output arrived; reads the tab's current flags and writes any transition. */
  noteOutput(rec: PulseState | undefined): void {
    if (!this.agent) return
    const now = Date.now()
    // replayed scrollback is history — skip it without touching the burst
    // clocks, so the first live output afterwards starts a fresh burst
    if (now < this.replayUntil) return
    // a burst is a DENSE stream — a chunk only continues it while the gap
    // stays under ~350ms. Sparser trickles (codex's git/status-watcher
    // redraws in an active repo) can neither light the lamp nor hold it
    const dense = now - this.lastDataAt < BURST_GAP
    if (!dense) this.burstStartAt = now
    this.lastDataAt = now
    // hook/agent-detect latched idle — Codex's prompt TUI is a dense frame
    // stream, so a quiet window alone never holds. Wait for the user (or a
    // turn-start) before output may light the lamp again.
    if (rec?.idleLocked) {
      this.burstStartAt = now
      return
    }
    if (!rec?.working) {
      // suppressed output isn't turn evidence either — echo redraws and the
      // quiet window's trailing redraw restart the burst clock instead of
      // accumulating toward the light
      if (now - this.lastInputAt < INPUT_ECHO_WINDOW || now < (rec?.quietUntil ?? 0)) {
        this.burstStartAt = now
        return
      }
      // right after a turn end the bar rises — a relight needs a longer dense
      // stream, so a post-turn redraw storm can't fake a new turn and
      // re-stamp the '…ago' clock
      const need =
        rec?.turnEndedAt && now - rec.turnEndedAt < TURN_END_HORIZON
          ? BURST_NEED_AFTER_TURN
          : BURST_NEED
      if (now - this.burstStartAt < need) return
      this.write({
        working: true,
        // a relight soon after the light went out is the same turn resuming
        // (a tool ran silently for a beat) — keep its start so the elapsed
        // timer tracks the turn, not the latest burst
        workingSince:
          rec?.turnEndedAt && now - rec.turnEndedAt < SAME_TURN_WINDOW
            ? (rec.workingSince ?? now)
            : now
      })
    }
    // a sparse chunk can't hold the light — let the pending silence deadline
    // stand so periodic redraws can't pin it forever
    if (!dense) return
    this.armSilence()
  }

  private armSilence(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const now = Date.now()
      this.write({
        working: false,
        // keep workingSince — a relight within the window above resumes the
        // same turn's elapsed clock
        turnEndedAt: now,
        // and hold off the lamp briefly — a trailing post-turn redraw mustn't
        // relight it and re-stamp the clock it just wrote
        quietUntil: now + POST_TURN_QUIET
      })
    }, WORKING_SILENCE)
  }

  /** Drop the pending deadline without reporting anything (unmount). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
