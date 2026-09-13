# Browser

Browser panes embed real web pages via Electron `<webview>` — one webview per
tab. Inactive tabs stay mounted (hidden), so each keeps its own history,
scroll position, and page state.

## Tabs

There's no room for a tab strip inside a pane, so tabs live behind the
**dropdown button** in the header (chevron + count). The menu lists each tab's
title and URL:

- click a row to activate it
- `×` closes a tab — closing the last one opens a fresh tab rather than
  leaving the pane empty
- *new tab* at the bottom adds one

`Ctrl+Tab` / `Ctrl+Shift+Tab` also cycle tabs inside the focused pane.

## Header controls

Back, forward, and reload sit next to the tab dropdown — reload becomes
*stop* while a page is loading. The **omnibox** (bounded-width input with a
border and a text cursor on focus) takes a URL or a search term:

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
browser panes and tabs — existing tabs are untouched. Empty means a blank
page.

## Shortcuts inside pages

App shortcuts keep working while a webview is focused — a guest preload
relays `Alt+…`, `Ctrl+Tab`, and any custom bound combos back to the app, so
pane/workspace keys don't die inside a page. See
[Panes](panes.md) for the shared keys.
