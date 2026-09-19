// Compatibility facade. Client transport ownership moved to mahas-client;
// existing imports remain valid while desktop and CLI imports migrate.
export { connectRpc } from '../../../mahas-client/src/rpc.ts'
export type { RpcCallOptions, RpcClient, RpcConnector } from '../../../mahas-client/src/rpc.ts'
