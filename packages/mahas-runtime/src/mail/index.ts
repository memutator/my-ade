// mahas-runtime/mail — coordination/mail boundary entrypoint (C-MAIL).
//
// registerMailOps wires the seven owned operations into the IMP-11
// OperationRegistry. The composition root (mahasd bootstrap, IMP-17/30)
// supplies MailDeps — the fixed SHARED-APIS kernel functions — so this
// boundary never imports sibling service internals.
//
// mutation flags tell the dispatcher which ops need the write transaction:
//   * inbox.check is mutation:true — the generation-rebind convergence is a
//     ledger write even though the op itself is a read that never acks.
//   * inbox.wait is mutation:false and MUST be dispatched outside any
//     wrapping transaction (it polls autocommit reads while sleeping).
//   * artifact.read is mutation:false — a pure query.
//   * everything else mutates the messages/deliveries/artifacts ledger.

import type { OperationRegistry } from '../api/registry.ts'
import type { MailDeps } from './api.ts'
import { inboxCheck } from './inbox.ts'
import { inboxWait } from './wait.ts'
import { deliveryAck } from './ack.ts'
import { messageReplyAndAck, messageSend } from './message-service.ts'
import { artifactPublish } from '../artifacts/publisher.ts'
import { artifactRead } from '../artifacts/reader.ts'

export function registerMailOps(registry: OperationRegistry, deps: MailDeps): void {
  registry.register({ name: 'inbox.check', visibility: 'member', mutation: true }, inboxCheck(deps))
  registry.register(
    { name: 'inbox.wait', visibility: 'member', mutation: false, longPoll: true },
    inboxWait(deps)
  )
  registry.register(
    { name: 'delivery.ack', visibility: 'member', mutation: true },
    deliveryAck(deps)
  )
  registry.register(
    { name: 'message.send', visibility: 'member', mutation: true },
    messageSend(deps)
  )
  registry.register(
    { name: 'message.replyAndAck', visibility: 'member', mutation: true },
    messageReplyAndAck(deps)
  )
  registry.register(
    { name: 'artifact.publish', visibility: 'member', mutation: true },
    artifactPublish(deps)
  )
  registry.register(
    { name: 'artifact.read', visibility: 'member', mutation: false },
    artifactRead(deps)
  )
}

// ---- public surface --------------------------------------------------------

export type {
  MailDeps,
  MailIo,
  InboxCheckPayload,
  InboxCheckResult,
  InboxItem,
  InboxWaitPayload,
  InboxWaitResult,
  AckHandling,
  DeliveryAckPayload,
  DeliveryAckResult,
  MessageSendPayload,
  MessageSendResult,
  MessageReplyAndAckPayload,
  MessageReplyAndAckResult,
  ArtifactPublishPayload,
  ArtifactPublishResult,
  ArtifactReadPayload,
  ArtifactReadRange,
  ArtifactReadResult,
  ArtifactAvailability
} from './api.ts'

// fence helpers for the member-retire / stop path (IMP-13/22 composition)
export { rebindOutstandingDeliveries, fenceDeliveriesForMember } from './shared.ts'
export { executionWake, parseExecutionWakePayload } from './wake-service.ts'
export type { WakeReceipt, WakeReceiptStatus, ExecutionWakeInput } from './wake-service.ts'

// retention primitives (artifact-scoped pins; reclaim policy lives elsewhere)
export {
  addRetentionPin,
  pinsForHolder,
  pinsForTarget,
  releaseRetentionPins,
  type RetentionPinInput
} from '../artifacts/retention.ts'

// default fs/git backing — composition injects deps.io only to override it
export { defaultMailIo } from '../artifacts/io.ts'
