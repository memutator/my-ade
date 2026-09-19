# Usage, tokens, and sessions

Two widget tabs show what the daemon has collected about your agent
accounts: **usage** (provider quota) and **tokens** (token consumption,
statistics, and the sessions list). Add one from a pane's `+` menu → widget
→ the view you want.

Everything these views show is **stored data** — rows the control daemon
(`mahasd`) collected into its database. Opening a widget performs no
credential I/O, no provider HTTP, and no transcript scan. That separation is
the point of the design, and it shapes what the numbers mean:

- **Unknown is not zero.** A meter the store has no limit for reads
  "unknown", never 0% and never a fabricated number. Groups the store could
  not attribute stay visible as their own "unattributed" / "not reported"
  rows, and a total whose stored components are incomplete shows `≈`.
- **Failure does not erase success.** A quota card keeps the last successful
  reading with its timestamp; a failed poll is recorded separately instead
  of overwriting the numbers you were looking at.
- **Coverage travels with the number.** Summaries and statistics carry the
  coverage they were computed under — which days and sources the store has
  actually seen.

## Usage widget — provider quota

Each card is one stored quota reading for a provider connection: the
offering (e.g. ChatGPT, Claude, Grok), the account when known, and its
windows/meters as the provider reports them.

Cards group by the harness installation they are bound to. Connections that
are open but bound to no installation — for example a credential file you
registered, or a sign-in the daemon has not matched to a harness — list
under a separate **unbound connections** group, optionally labelled with the
harness they were observed under. Signing in never infers a binding: the
connection lands where the evidence puts it.

The **refresh** button does not probe providers and does not queue generic
collection — the scheduler holds no secrets, so quota polling goes through
the auth path: refresh signals `auth.quota.collect`, then re-reads the
store. If the signal fails the stored numbers stay on screen and the failure
is reported. The list also re-reads the store on a slow poll (2 min) so a
long-open widget tracks background collection.

Removing a card records the connection as removed in the store — its
bindings end and stored usage stays. The desktop never deletes the
underlying credential file.

## Sign-in and registering accounts

The person-plus icon on a harness group (or on the unbound group) opens the
sign-in panel. Flows are **per offering** and run on the daemon's dedicated
auth channel: the daemon builds the browser link or device code, the desktop
opens the URL for you, and the daemon receives the loopback callback on its
own transport. Completing a flow commits the credential, the connection,
the identity claims, and the auth intent as one stored fact — including
flows that finish entirely in a callback with no further UI. No Binding is
created by sign-in; bindings come from evidence elsewhere (e.g. an
installation locator), never inferred.

The panel starts a flow, forwards a pasted authorization code or API key,
polls the daemon's verdict, and can cancel an in-flight flow. A secret you
type lives only in the panel's input state until you submit — it is then
deposited to the daemon once as a single-use secret handle and cleared from
the field.

You can also register an existing credential file directly (the file-picker
path): the daemon records it as a read-only locator connection for the
chosen offering — a real stored connection, not a desktop-only settings
record.

What the daemon supports per offering (PKCE, device code, manual code,
API key) is vendor knowledge owned by the built-in provider Pack — see
[integrations/packs/providers/builtin-offerings/README.md](../../integrations/packs/providers/builtin-offerings/README.md).
Synthetic fixtures exercise these flows; real vendor sign-in has not been
run through the app yet — see
[../development/verification.md](../development/verification.md).

## Tokens widget — consumption and statistics

Totals come from the daemon's persisted aggregate rows and ledger entries,
so closing the widget (or deleting transcripts) does not change them. The
view shows:

- the global token summary — its own stored row, read independently rather
  than summed from the page — with per-harness breakdowns and mix bars;
- provider / offering / requested-model / served-model breakdown axes. Each
  axis selects its exact rollup shape, so a provider total never includes a
  connection row and a requested-model total never mixes in served-model
  rows — nothing is double-counted;
- verified-pool share cards, plus the usage observed outside every pool as a
  remainder;
- three stored statistics cards: the **weekly average** (last four complete
  Monday-start calendar weeks in your time zone), the **hourly-by-date**
  distribution, and the **hour-of-day** distribution — each with the
  coverage it was computed under;
- per-session usage rows joined with the sessions list below.

Summaries page independently of the global row: when a fetched page is not
exhausted the axes are marked **partial** (a whole group can sit beyond the
page) and the outside-pool remainder is withheld rather than inflated.

Refresh asks the daemon for a usage collection pass (`collection.request`
per source), then re-reads stored rows — the same stored-numbers-stay rule
applies when the scheduler is unavailable.

## Sessions list

Inside the tokens view, the sessions panel lists **stored** sessions — a
session that ran weeks ago still lists after its transcript is gone. Rows
carry the session's stored usage, its parent/child shape, and its live
state when the session is still running. A child whose parent is not on the
loaded page can appear as a flat root row marked as a child — the marker is
stored evidence, not a display guess. A stored row merges with a live
registry entry only on exact harness + native identity backed by stored
evidence; a session the store has not collected yet stands alone as a
live-only row — never as a zero-token session.

Rows that support resume show it (the store's verdict per handle,
`supported` or an honest `unknown`); opening a live session jumps to its
workspace/pane/tab. See [agents.md](agents.md) → Session resume for how
resume candidates are chosen.
