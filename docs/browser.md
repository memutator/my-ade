# Browser

Browser **blocks** (`web` tab kind) embed real web pages via Electron
`<webview>` — one webview per tab. Inactive tabs stay mounted (hidden), so
each keeps its own history, scroll position, and page state.

## Tabs

Web blocks are ordinary entries in the leaf's shared tab strip — they can
sit next to terminals and file tabs, close with `×`, and close the leaf when
the last one goes. `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs inside the
focused pane.

## Header controls

A web block's chrome floats *inside* the content: a translucent header card
at the top of the page that reveals on hover (and while focused). It carries
back, forward, and reload — reload becomes *stop* while a page is loading —
plus the bookmark star and the **omnibox** (bounded-width input with a
border and a text cursor on focus), which takes a URL or a search term:

- `example.com` → `https://example.com`
- `https://…` / other schemes are used as-is
- anything else becomes a Google search

Failed loads show an error card with a *retry* button; a crashed page reports
*page crashed*. Links that want a new window (`target=_blank`) open in the
system browser instead.

## Bookmarks

The **star** button opens the bookmark menu:

- **save to \<project\>** / **save to global** — bookmarks are scoped either to
  the workspace's project or globally
- the star fills when the current URL is already saved; *remove bookmark*
  clears it
- bookmarks are listed grouped by scope — click opens in the current tab,
  `+` opens in a new tab, `×` deletes

All bookmarks are also managed in **Settings → browser**, grouped by scope
with delete buttons.

## Home page

**Settings → browser → home page** sets the start URL for *newly created*
web blocks — existing tabs are untouched. Empty means a blank
page.

## Shortcuts inside pages

App shortcuts keep working while a webview is focused — a guest preload
relays `Alt+…`, `Ctrl+Tab`, and any custom bound combos back to the app, so
pane/workspace keys don't die inside a page. See
[Panes](panes.md) for the shared keys.
