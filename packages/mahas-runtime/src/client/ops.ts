// mahas-runtime — C-CLIENT operation registration.
//
// `registerClientOps` is the composition entrypoint: mahasd's bootstrap
// calls it once with the real OperationRegistry and kernel deps:
//
//   registerClientOps(registry, {
//     host: hostClient,                    // IMP-17 connectHost()
//     call: makeCaller(registry, svcCtx),  // IMP-11
//     authorize,                           // IMP-10
//     appendDomainEvent                    // IMP-03
//   })
//
// `host` may be omitted until the execution-host session exists — terminal
// ops then answer honest CONTROL_UNAVAILABLE while view bind/unbind keep
// working (they are pure control-plane state).

import {
  terminalAttach,
  terminalDetach,
  terminalInput,
  terminalResize,
  terminalSnapshot
} from './terminal.ts'
import { clientViewBind, clientViewUnbind } from './views.ts'
import type { ClientOpsDeps, ClientOpsRegistry } from './types.ts'

export function registerClientOps(registry: ClientOpsRegistry, deps: ClientOpsDeps): void {
  // terminal I/O surface — every op enforces its own resource-level scope
  // and InputLease check inside the handler (C-CLIENT)
  registry.register(
    { name: 'terminal.attach', visibility: 'operator', mutation: true },
    (txn, payload) => terminalAttach(txn, payload, deps)
  )
  registry.register(
    { name: 'terminal.input', visibility: 'operator', mutation: true },
    (txn, payload) => terminalInput(txn, payload, deps)
  )
  registry.register(
    { name: 'terminal.resize', visibility: 'operator', mutation: true },
    (txn, payload) => terminalResize(txn, payload, deps)
  )
  registry.register(
    { name: 'terminal.snapshot', visibility: 'operator', mutation: false },
    (txn, payload) => terminalSnapshot(txn, payload, deps)
  )
  registry.register(
    { name: 'terminal.detach', visibility: 'operator', mutation: true },
    (txn, payload) => terminalDetach(txn, payload, deps)
  )

  // view bindings — UI-owned state with no domain authority
  registry.register(
    { name: 'client.view.bind', visibility: 'operator', mutation: true },
    (txn, payload) => clientViewBind(txn, payload, deps)
  )
  registry.register(
    { name: 'client.view.unbind', visibility: 'operator', mutation: true },
    (txn, payload) => clientViewUnbind(txn, payload, deps)
  )
}
