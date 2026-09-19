import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { agentLabel } from '../../agents.ts'
import { useT } from '../../i18n.ts'
import AgentIcon from '../../components/AgentIcon.tsx'
import { Select } from '../../components/Menu.tsx'
import {
  cancelAuthFlow,
  pollAuthFlow,
  saveAuthSecret,
  startAuth,
  submitAuthCode
} from './domain.ts'
import type {
  DomainAuthFlow,
  DomainAuthOutcome,
  DomainOfferingView
} from '../../../../preload/domain'

/** how long a started flow is watched before the panel gives up on it */
const FLOW_TIMEOUT_MS = 10 * 60 * 1000
const POLL_MS = 2_000

/** Multi-account sign-in.
 *
 *  The DAEMON owns the flow — it opens the browser page or device code, receives
 *  the loopback callback on its own transport, writes the credential and commits
 *  the connection. This panel starts a flow for one OFFERING, forwards a pasted
 *  code or a secret (deposited once, never kept here), and observes the verdict.
 *  The flow states are the daemon's: 'effect-required' means "do this on the
 *  provider side, then keep polling".
 */
export default function UsageAuthPanel({
  harnessId,
  offerings,
  preferredOfferingIds,
  onSignedIn,
  onImported,
  onClose
}: {
  harnessId: string
  /** offerings from the persisted catalog */
  offerings: DomainOfferingView[]
  /** offerings this harness's stored bindings already point at (tried first) */
  preferredOfferingIds: string[]
  onSignedIn: (outcome: DomainAuthOutcome) => void
  /** a credential file already on this machine, imported into the canonical
   *  inventory as a read-only locator for the SELECTED offering */
  onImported: (offeringId: string, path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const ordered = (() => {
    const preferred = preferredOfferingIds
      .map((id) => offerings.find((offering) => offering.id === id))
      .filter((offering): offering is DomainOfferingView => !!offering)
    return [
      ...preferred,
      ...offerings.filter((offering) => !preferredOfferingIds.includes(offering.id))
    ]
  })()
  const [offeringId, setOfferingId] = useState(ordered[0]?.id ?? '')
  const [flow, setFlow] = useState<DomainAuthFlow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const liveFlow = useRef<string | null>(null)

  useEffect(
    () => () => {
      const open = liveFlow.current
      if (open) void cancelAuthFlow(open)
    },
    []
  )

  const outcomeOf = (next: DomainAuthFlow): DomainAuthOutcome => {
    const account =
      next.identityClaims.find((claim) => claim.kind === 'email')?.value ??
      next.identityClaims[0]?.value
    return {
      ok: next.state === 'complete',
      state: next.state,
      flowId: next.flowId,
      ...(next.connectionId ? { connectionId: next.connectionId } : {}),
      ...(next.credentialChange?.materialRef
        ? { credentialRef: next.credentialChange.materialRef }
        : {}),
      ...(account ? { account } : {}),
      ...(next.error ? { error: next.error } : {})
    }
  }

  const fail = (next: DomainAuthFlow): void => {
    liveFlow.current = null
    setFlow(null)
    setError(next.error ?? 'sign-in failed')
  }

  /** keep polling while the daemon says the flow is still open. A retryable
   *  rejection means "not decided yet"; anything else is a real failure. */
  const watchFlow = async (flowId: string): Promise<void> => {
    const deadline = Date.now() + FLOW_TIMEOUT_MS
    for (;;) {
      if (liveFlow.current !== flowId) return
      if (Date.now() > deadline) {
        liveFlow.current = null
        setFlow(null)
        setError('sign-in timed out')
        return
      }
      const retryAt = flow?.requiredInput?.retryAt
      const wait = retryAt && retryAt > Date.now() ? retryAt - Date.now() : POLL_MS
      await new Promise((resolve) => setTimeout(resolve, Math.max(500, wait)))
      if (liveFlow.current !== flowId) return
      const result = await pollAuthFlow(flowId)
      if (liveFlow.current !== flowId) return
      if (!result.ok) {
        if (result.error.retryable) continue
        liveFlow.current = null
        setFlow(null)
        setError(result.error.message)
        return
      }
      const next = result.value
      if (next.state === 'complete') {
        liveFlow.current = null
        setFlow(null)
        onSignedIn(outcomeOf(next))
        return
      }
      if (next.state === 'failed') {
        fail(next)
        return
      }
      setFlow(next)
    }
  }

  const start = async (): Promise<void> => {
    if (!offeringId) {
      setError('no offering to sign in to')
      return
    }
    setError(undefined)
    setBusy(true)
    const result = await startAuth(offeringId)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    const next = result.value
    if (next.state === 'complete') {
      onSignedIn(outcomeOf(next))
      return
    }
    if (next.state === 'failed') {
      fail(next)
      return
    }
    liveFlow.current = next.flowId
    setFlow(next)
    // A flow that only waits for the provider (loopback callback, device poll)
    // is watched here; a flow that needs input waits for the user instead.
    const kind = next.requiredInput?.kind
    if (kind === 'localhost-callback' || kind === 'device' || kind === 'device-poll') {
      await watchFlow(next.flowId)
    }
  }

  const sendCode = async (): Promise<void> => {
    if (!flow) return
    setBusy(true)
    setError(undefined)
    const result = await submitAuthCode(flow.flowId, code.trim())
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setCode('')
    if (result.value.ok) {
      liveFlow.current = null
      setFlow(null)
      onSignedIn(result.value)
      return
    }
    // keep the flow open so a corrected paste can retry
    setError(result.value.error ?? 'that code was not accepted')
  }

  const sendSecret = async (): Promise<void> => {
    if (!flow) return
    setBusy(true)
    setError(undefined)
    const result = await saveAuthSecret(flow.flowId, secret)
    setSecret('') // never kept in view state
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    if (result.value.ok) {
      liveFlow.current = null
      setFlow(null)
      onSignedIn(result.value)
      return
    }
    setError(result.value.error ?? 'the secret was not accepted')
  }

  const importFile = async (): Promise<void> => {
    if (!offeringId) {
      setError('choose an offering to import into')
      return
    }
    const path = await window.mahas.file.openDialog()
    if (path) onImported(offeringId, path)
  }

  const close = (): void => {
    const open = liveFlow.current
    if (open) {
      void cancelAuthFlow(open)
      liveFlow.current = null
    }
    onClose()
  }

  const effectUrl = flow?.effect?.kind === 'open-browser' ? flow.effect.url : undefined
  const inputKind = flow?.requiredInput?.kind

  return (
    <div className="dash-auth">
      <div className="dash-auth-h">
        <AgentIcon id={harnessId} size={14} />
        <span className="dash-auth-t">{agentLabel(harnessId)}</span>
        <button className="pbtn" onClick={close}>
          <X />
        </button>
      </div>

      {!flow && ordered.length > 1 && (
        <Select
          value={offeringId}
          options={ordered.map((offering) => ({
            value: offering.id,
            label:
              offering.providerLabel && offering.providerLabel !== offering.label
                ? `${offering.label} — ${offering.providerLabel}`
                : offering.label
          }))}
          onChange={setOfferingId}
          className="usage-sel"
        />
      )}
      {!flow && (
        <button className="sbtn accent" onClick={() => void start()} disabled={busy || !offeringId}>
          {busy ? <Loader2 className="spin" /> : null}
          {t('usageAuthSignIn')}
        </button>
      )}

      {effectUrl && inputKind !== 'device' && (
        <div className="dash-auth-msg">
          <Loader2 className="spin" />
          <span>
            {inputKind === 'authorization-code' ? t('usageAuthCode') : t('usageAuthWaiting')}
          </span>
          <button className="sbtn" onClick={() => window.mahas.openExternal(effectUrl)}>
            {t('usageAuthOpenPage')}
          </button>
        </div>
      )}
      {inputKind === 'device' && (
        <div className="dash-auth-msg">
          <Loader2 className="spin" />
          <span>
            {flow?.requiredInput?.userCode
              ? t('usageAuthDevice', {
                  code: flow.requiredInput.userCode,
                  url: flow.requiredInput.verificationUri ?? ''
                })
              : t('usageAuthWaiting')}
          </span>
          {effectUrl && (
            <button className="sbtn" onClick={() => window.mahas.openExternal(effectUrl)}>
              {t('usageAuthOpenPage')}
            </button>
          )}
        </div>
      )}
      {inputKind === 'device-poll' && <div className="usage-note">{t('usageAuthWaiting')}</div>}
      {inputKind === 'localhost-callback' && effectUrl === undefined && (
        <div className="dash-auth-msg">
          <Loader2 className="spin" />
          <span>{t('usageAuthWaiting')}</span>
        </div>
      )}
      {inputKind === 'authorization-code' && (
        <div className="dash-auth-form">
          <input
            className="sinput"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={t('usageAuthCode')}
            spellCheck={false}
            autoFocus
          />
          <button
            className="sbtn accent"
            onClick={() => void sendCode()}
            disabled={busy || !code.trim()}
          >
            {busy ? <Loader2 className="spin" /> : t('usageAdd')}
          </button>
        </div>
      )}
      {inputKind === 'secret' && (
        <div className="dash-auth-form">
          <input
            className="sinput"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={flow?.requiredInput?.label ?? t('usageApiKey')}
            spellCheck={false}
            autoFocus
          />
          <button
            className="sbtn accent"
            onClick={() => void sendSecret()}
            disabled={busy || !secret.trim()}
          >
            {busy ? <Loader2 className="spin" /> : t('usageAdd')}
          </button>
        </div>
      )}
      {!flow && (
        <button className="dash-auth-file" onClick={() => void importFile()}>
          {t('usageImportFile')}
        </button>
      )}
      {error && <div className="usage-note err">{error}</div>}
    </div>
  )
}
