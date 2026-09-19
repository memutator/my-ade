import { join } from 'node:path'
import type {
  ControlResult,
  ServiceEndpoint,
  ServiceStatus,
  ShutdownAck,
  ShutdownRequest
} from '../../mahas-contracts/src/index.ts'
import { createMahasClient, type MahasClient, type MahasClientOptions } from './client.ts'
import { MAHASD_ENDPOINT_ENV } from './connection.ts'

/** Version of the typed desktop port, distinct from the RPC frame version. */
export const MAHAS_RUNTIME_PROTOCOL_VERSION = 0

export interface RuntimeBootstrapOptions extends Omit<
  MahasClientOptions,
  'endpoint' | 'configDir'
> {
  configDir: string
  endpoint?: ServiceEndpoint
}

export interface RuntimeHandle {
  readonly service: 'mahasd'
  readonly endpoint: ServiceEndpoint
  status(): ServiceStatus
  refresh(): Promise<ServiceStatus>
  readonly client: MahasClient
  requestShutdown(req: ShutdownRequest): Promise<ControlResult<ShutdownAck>>
  disconnect(): Promise<void>
}

export function defaultMahasdEndpoint(configDir: string): ServiceEndpoint {
  return { kind: 'unix-socket', address: join(configDir, 'mahasd.sock'), service: 'mahasd' }
}

export function parseEndpoint(raw: string): ServiceEndpoint | null {
  if (raw.startsWith('unix:')) {
    const address = raw.slice(5)
    return address ? { kind: 'unix-socket', address, service: 'mahasd' } : null
  }
  if (raw.startsWith('tcp:')) {
    const address = raw.slice(4)
    return address ? { kind: 'tcp', address, service: 'mahasd' } : null
  }
  return raw ? { kind: 'unix-socket', address: raw, service: 'mahasd' } : null
}

export function bootstrapRuntime(options: RuntimeBootstrapOptions): RuntimeHandle {
  const endpoint =
    options.endpoint ??
    (process.env[MAHASD_ENDPOINT_ENV]
      ? (parseEndpoint(process.env[MAHASD_ENDPOINT_ENV]!) ??
        defaultMahasdEndpoint(options.configDir))
      : defaultMahasdEndpoint(options.configDir))
  const client = createMahasClient({
    ...options,
    endpoint: endpoint.address,
    configDir: options.configDir
  })
  return {
    service: 'mahasd',
    endpoint: client.endpoint,
    status: client.currentStatus,
    refresh: client.refresh,
    client,
    requestShutdown: (request) => client.requestShutdown(request),
    disconnect: () => client.disconnect()
  }
}
