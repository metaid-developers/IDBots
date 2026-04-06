# OpenClaw Provider Adapter

This adapter is the provider-side bridge from an OpenClaw gateway payload into the shared MetaBot runtime.

## Wake-Up Envelope Mapping

The gateway payload is normalized into `ServiceRequestContract` with these field mappings:

- `request_id` -> `correlation.requestId`
- `requester_session_id` -> `correlation.requesterSessionId`
- `requester_conversation_id` -> `correlation.requesterConversationId`
- `service_pin_id` -> `servicePinId`
- `requester_global_metaid` -> `requesterGlobalMetaId`
- `user_task` -> `userTask`
- `task_context` -> `taskContext`
- `price` -> `price`
- `currency` -> `currency`
- `payment.amount` -> `paymentProof.amount` when present, otherwise `price` -> `paymentProof.amount`
- `payment.currency` -> `paymentProof.currency` when present, otherwise `currency` -> `paymentProof.currency`
- `payment.txid` -> `paymentProof.txid`
- `payment.chain` -> `paymentProof.chain`
- `payment.order_message` -> `paymentProof.orderMessage`
- `payment.order_message_pin_id` -> `paymentProof.orderMessagePinId`

## Provider Host Contract

The provider-side host must:

- auto-create a local session with no human confirmation,
- inject exactly one normalized prompt into that new session,
- wait for exactly one final result from the session,
- return the final result back to the daemon/runtime.

For Task 8, the adapter always creates a fresh provider-side session. It does not try to resume an `existingSessionId`.

The adapter does not change business semantics. It only maps OpenClaw host operations onto the shared `HostSessionAdapter` contract.

## Attachments

Returned attachments are expected to be reference-only `metafile://...` values.

Non-`metafile://` attachments are dropped before the result is returned to the shared runtime.
