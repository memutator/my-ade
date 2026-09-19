// Legacy provider sign-in IPC — a COMPATIBILITY ADAPTER over the daemon's auth
// domain.
//
// This module used to implement nine vendor sign-in flows in the desktop (PKCE
// + loopback callbacks, device-code polling, JWT claim parsing, API-key writers
// and managed credential files under userData/usage-accounts). Provider
// knowledge now lives in the provider Offering Packs the daemon runs; the
// desktop starts a flow, forwards a pasted code or a secret, and reads the
// verdict from the daemon's DEDICATED auth channel (never the ordinary receipt
// pipeline, which persists payloads).
//
// The legacy channels name a HARNESS, while the auth domain starts a flow for an
// OFFERING. The adapter therefore resolves the offering through the stored
// inventory (the same read the UI uses) — a harness with no stored connection has
// no offering to sign in to and says so instead of guessing a vendor.

import { ipcMain } from 'electron'
import { rm } from 'fs/promises'
import { sep } from 'path'
import type { UsageAuthDone, UsageAuthStart } from '../preload/index'
import { legacyUsageAccountsRoot } from './runtime/authClient'
import {
  cancelAuthFlow,
  pollAuthFlow,
  readUsageSources,
  startAuth,
  submitAuthCode,
  submitAuthSecret
} from './runtime/domainIpc'
import type { DomainAuthFlow, DomainAuthOutcome } from '../preload/domain'

/** the offering a harness is set up for, as the stored inventory sees it */
async function offeringForHarness(harnessId: string): Promise<string | null> {
  const sources = await readUsageSources()
  if (!sources.ok) return null
  const source = sources.value.sources.find(
    (candidate) => candidate.origin === 'domain' && candidate.harnessId === harnessId
  )
  if (source?.offeringId) return source.offeringId
  const preferred = sources.value.offeringsByHarness[harnessId]?.[0]
  return preferred ?? null
}

function legacyStart(flow: DomainAuthFlow): UsageAuthStart {
  const kind = flow.requiredInput?.kind
  const url = flow.effect?.kind === 'open-browser' ? flow.effect.url : undefined
  const mode: UsageAuthStart['mode'] =
    kind === 'authorization-code'
      ? 'code'
      : kind === 'device' || kind === 'device-poll'
        ? 'device'
        : 'browser'
  return {
    flowId: flow.flowId,
    mode,
    ...(url ? { url } : {}),
    ...(flow.requiredInput?.userCode ? { userCode: flow.requiredInput.userCode } : {}),
    ...(flow.requiredInput?.verificationUri
      ? { verificationUri: flow.requiredInput.verificationUri }
      : {})
  }
}

function legacyDone(outcome: DomainAuthOutcome): UsageAuthDone {
  return {
    ok: outcome.ok,
    // The old field carried a credential FILE path. The domain store keeps
    // references, not paths, so the credential reference is reported instead.
    ...(outcome.credentialRef ? { path: outcome.credentialRef } : {}),
    ...(outcome.account ? { account: outcome.account } : {}),
    ...(outcome.error ? { error: outcome.error } : {})
  }
}

export function registerUsageAuthIpc(): void {
  ipcMain.handle('usage:authStart', async (_e, harnessId: string): Promise<UsageAuthStart> => {
    const harness = String(harnessId ?? '')
    const offeringId = await offeringForHarness(harness)
    if (!offeringId) {
      throw new Error(`no stored connection for ${harness} — add it from the usage widget`)
    }
    const result = await startAuth({ offeringId })
    if (!result.ok) throw new Error(result.error.message)
    if (result.value.state === 'failed') {
      throw new Error(result.value.error ?? 'sign-in failed')
    }
    return legacyStart(result.value)
  })

  ipcMain.handle(
    'usage:authFinish',
    async (_e, flowId: string, code?: string): Promise<UsageAuthDone> => {
      const id = String(flowId ?? '')
      if (!id) return { ok: false, error: 'flow not found or expired' }
      // A pasted code answers this flow once; without one the call observes the
      // flow's current verdict (browser callback / device poll is daemon-side).
      if (typeof code === 'string' && code) {
        const submitted = await submitAuthCode({ flowId: id, code })
        if (!submitted.ok) return { ok: false, error: submitted.error.message }
        return legacyDone(submitted.value)
      }
      const polled = await pollAuthFlow(id)
      if (!polled.ok) return { ok: false, error: polled.error.message }
      const flow = polled.value
      return legacyDone({
        ok: flow.state === 'complete',
        state: flow.state,
        flowId: flow.flowId,
        ...(flow.credentialChange?.materialRef
          ? { credentialRef: flow.credentialChange.materialRef }
          : {}),
        ...(flow.identityClaims[0]?.value ? { account: flow.identityClaims[0].value } : {}),
        ...(flow.error ? { error: flow.error } : {})
      })
    }
  )

  ipcMain.handle('usage:authCancel', async (_e, flowId: string) => {
    const result = await cancelAuthFlow(String(flowId ?? ''))
    return { ok: result.ok, ...(result.ok ? {} : { error: result.error.message }) }
  })

  /** API-key entry keeps its old calling shape: the flow is started for the
   *  harness's offering and must ask for a secret. */
  ipcMain.handle('usage:saveKey', async (_e, harnessId: string, secret: string, label?: string) => {
    void label
    const harness = String(harnessId ?? '')
    const offeringId = await offeringForHarness(harness)
    if (!offeringId) return { error: `no stored connection for ${harness}` }
    const started = await startAuth({ offeringId })
    if (!started.ok) return { error: started.error.message }
    const flow = started.value
    if (flow.requiredInput?.kind !== 'secret') {
      return { error: 'this offering does not accept an API key' }
    }
    const submitted = await submitAuthSecret({ flowId: flow.flowId, secret: String(secret ?? '') })
    if (!submitted.ok) return { error: submitted.error.message }
    return legacyDone(submitted.value)
  })

  /* Removing a local credential file stays a desktop-local deletion and is
     still limited to the managed root — imported paths elsewhere are untouched.
     Canonical removal (closing a connection in the inventory domain) is a
     daemon operation and is not reached through this legacy channel. */
  ipcMain.handle('usage:discardCred', async (_e, path: string) => {
    const root = legacyUsageAccountsRoot() + sep
    const target = String(path ?? '')
    if (!target.startsWith(root)) return { ok: false }
    await rm(target, { recursive: true, force: true })
    return { ok: true }
  })
}
