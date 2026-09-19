import type { ProviderIdentityClaim } from '../../../../mahas-contracts/src/inventory/index.ts'

export interface AuthEffect {
  kind: 'open-browser'
  url: string
}
export interface AuthRequiredInput {
  kind: 'secret' | 'authorization-code' | 'localhost-callback' | 'device' | 'device-poll'
  [key: string]: unknown
}
/**
 * Where the browser must come back to. The provider adapter owns this because only
 * it knows whether the provider registered a fixed loopback redirect (codex 1455,
 * grok 56121) or expects the client to allocate one (gemini). The runtime service
 * binds the listener; the adapter never touches a socket.
 */
export interface AuthCallbackSpec {
  mode: 'provider-registered' | 'dynamic'
  path: string
  host?: string
  /** 0 or omitted lets the daemon allocate a free loopback port */
  port?: number
  /** advertised redirect when the provider registered the exact URL */
  redirect?: string
}

export interface AuthFlowView {
  flowId: string
  /** Present only after the runtime commits inventory completion. */
  connectionId?: string
  credentialId?: string
  state: 'complete' | 'needs-input' | 'effect-required' | 'failed' | 'unknown'
  effect?: AuthEffect
  requiredInput?: AuthRequiredInput
  expiresAt?: number
  credentialChange?: {
    kind: 'create' | 'refresh'
    materialRef: string
    materialRevision: number
    previousRevision?: number
    ownership?: 'mahas'
  }
  identityClaims?: readonly ProviderIdentityClaim[]
  error?: string
  conflict?: boolean
  currentRevision?: number
}
export interface ProviderAuthDriver {
  start(input: {
    offeringId: string
    connectionId?: string
    callbackRedirect?: string
  }): Promise<AuthFlowView>
  submitCode(flowId: string, code: string): Promise<AuthFlowView>
  submitSecret(flowId: string, secret: string): Promise<AuthFlowView>
  poll(flowId: string): Promise<AuthFlowView>
  cancel(flowId: string, reason?: string): AuthFlowView
  status(flowId: string): AuthFlowView
  refresh(input: {
    credentialRef: string
    expectedMaterialRevision: number
    offeringId: string
    connectionId: string
  }): Promise<AuthFlowView>
  /** Loopback shape for this offering; null for manual-code, device and api-key flows. */
  callbackSpec?(offeringId: string): AuthCallbackSpec | null
  /** Live flows, for the service status projection. */
  list?(): readonly AuthFlowView[]
}

/** Network waits and raw secrets stay outside operation DB transactions. */
export class AuthFlowService {
  private readonly driver: ProviderAuthDriver
  // no parameter property: see CollectionScheduler — mahasd boots from source
  constructor(driver: ProviderAuthDriver) {
    this.driver = driver
  }
  start(input: {
    offeringId: string
    connectionId?: string
    callbackRedirect?: string
  }): Promise<AuthFlowView> {
    return this.driver.start(input)
  }
  submitCode(flowId: string, code: string): Promise<AuthFlowView> {
    return this.driver.submitCode(flowId, code)
  }
  /** Expose only through a non-logged, non-receipted secret-bearing method. */
  submitSecret(flowId: string, secret: string): Promise<AuthFlowView> {
    return this.driver.submitSecret(flowId, secret)
  }
  poll(flowId: string): Promise<AuthFlowView> {
    return this.driver.poll(flowId)
  }
  cancel(flowId: string): AuthFlowView {
    return this.driver.cancel(flowId)
  }
  status(flowId: string): AuthFlowView {
    return this.driver.status(flowId)
  }
  refresh(input: {
    credentialRef: string
    expectedMaterialRevision: number
    offeringId: string
    connectionId: string
  }): Promise<AuthFlowView> {
    return this.driver.refresh(input)
  }
}
