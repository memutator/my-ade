// Close-tab policy: visible and minimized managed tabs both unbind.
//
// Run: node src/renderer/src/shell/tabs.smoke.ts

import assert from 'node:assert/strict'
import { planCloseTab } from './tabs.ts'
import type { PaneTab } from '../types'

const binding = { executionId: 'ex-1', terminalId: 'term-1', revision: 4 }

function term(id: string, extra: Partial<PaneTab> = {}): PaneTab {
  return { kind: 'term', id, binding, ...extra } as PaneTab
}

{
  const plan = planCloseTab({
    wsId: 'ws',
    paneId: 'pane',
    pane: { tabs: [term('a'), term('b')], activeTabId: 'a' },
    tabId: 'a'
  })
  assert.equal(plan.closePane, false)
  assert.equal(plan.activeTabId, 'b')
  assert.deepEqual(plan.unbind, {
    viewId: 'ws:pane:a',
    expectedRevision: 4,
    terminalId: 'term-1'
  })
}

{
  const plan = planCloseTab({
    wsId: 'ws',
    paneId: 'pane',
    pane: { tabs: [term('a'), term('b', { minimized: true })], activeTabId: 'a' },
    tabId: 'b'
  })
  assert.equal(plan.closePane, false)
  assert.equal(plan.activeTabId, 'a')
  assert.equal(plan.unbind?.viewId, 'ws:pane:b', 'minimized managed tabs still unbind')
  assert.equal(plan.unbind?.terminalId, 'term-1')
}

{
  const plan = planCloseTab({
    wsId: 'ws',
    paneId: 'pane',
    pane: { tabs: [term('only')], activeTabId: 'only' },
    tabId: 'only'
  })
  assert.equal(plan.closePane, true)
  assert.ok(plan.unbind)
}

{
  const plan = planCloseTab({
    wsId: 'ws',
    paneId: 'pane',
    pane: {
      tabs: [
        { kind: 'web', id: 'w', url: 'https://x', title: '' },
        term('t', { minimized: true })
      ],
      activeTabId: 'w'
    },
    tabId: 't'
  })
  assert.equal(plan.closePane, false)
  assert.ok(plan.unbind, 'dock close of a minimized bound tab unbinds')
}

console.log('tab close policy: ok')
