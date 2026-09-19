// Compatibility facade. Desktop/CLI client composition now belongs to
// mahas-client; this path remains until existing imports migrate.
export {
  MAHAS_RUNTIME_PROTOCOL_VERSION,
  MAHASD_ENDPOINT_ENV,
  bootstrapRuntime,
  defaultMahasdEndpoint,
  parseEndpoint
} from '../../mahas-client/src/index.ts'
export type { RuntimeBootstrapOptions, RuntimeHandle } from '../../mahas-client/src/index.ts'
