// Assistant-turn presentation decisions shared by CoworkSessionDetail and
// the tests. Kept framework-free (plain JS) so `node --test` imports it
// without a TS compile step — same contract as coworkSessionPresentation.js.

/**
 * Whether an assistant turn's "process" (thinking rows, tool groups,
 * intermediate notes) may collapse behind the "Worked for" header.
 *
 * Completeness must NOT be inferred from streaming flags alone: between the
 * tool rounds of a still-running turn every message is settled (nothing
 * carries isStreaming) — tool execution plus the next model roundtrip spans
 * whole seconds. Owner updates and deferred final candidates can still arm
 * the delivery header during that gap, and treating the gap as completion
 * previously collapsed and re-expanded the transcript between rounds. A live
 * session's active turn is therefore complete only once the session stops
 * running; earlier turns keep the streaming-flag scan (a settled turn that
 * still carries a stuck isStreaming flag must not collapse either).
 */
export const isAssistantTurnComplete = ({ sessionLive, isActiveTurn, hasStreamingItem }) => {
  if (!sessionLive) return true;
  if (isActiveTurn) return false;
  return !hasStreamingItem;
};

/**
 * Index of the turn's delivery message within the VISIBLE assistant items:
 * the last assistant text message (thinking rows never deliver). The
 * professional-mode "Worked for" collapse uses this message as the
 * always-visible delivery and folds everything before it; assistant mode
 * collapses nothing. (Assistant mode's hover-action toolbar used to hang off
 * this one index; it is now mounted per bubble — see
 * shouldShowAssistantBubbleActions.)
 * Returns -1 when no delivery candidate exists.
 */
export const findDeliveryAssistantIndex = (visibleAssistantItems) => {
  for (let i = visibleAssistantItems.length - 1; i >= 0; i--) {
    const item = visibleAssistantItems[i];
    if (item && item.type === 'assistant' && !item.message?.metadata?.isThinking) {
      return i;
    }
  }
  return -1;
};

/**
 * Whether an assistant message bubble carries its own hover-action toolbar
 * (copy / feedback / per-message reply / branch).
 *
 * Assistant mode now mounts one toolbar PER BUBBLE, narration bubbles
 * included — the per-message reply entry must be reachable on every single
 * message, the same parity the professional mode action row gives each
 * assistant message. The old design pinned a single toolbar to the turn's
 * delivery message (via findDeliveryAssistantIndex) and skipped narration /
 * process bubbles, which left "reply to this message" missing on exactly the
 * bubbles a bot conversation mostly consists of; the final-reply-only and
 * narration-exclusion conditions were quirks of that one-toolbar layout, not
 * requirements of the reply feature, so they are gone.
 * `showCopyButton` now carries only the per-item gate (an item trailed by a
 * tool group keeps its own rows clean). The old mode-wide streaming gate —
 * toolbars hidden while the turn still streamed — is gone (owner,
 * 2026-10-28): hover affordances must exist in every session state, running
 * included; the branch action guards itself at the handler instead.
 */
export const shouldShowAssistantBubbleActions = ({ isAssistantMode, showCopyButton }) => (
  Boolean(isAssistantMode && showCopyButton)
);

/**
 * Outbound-IM receipts (im_send_message) are `system` rows written into the
 * chat the message went to. They are delivery evidence, not process chrome:
 * the professional-mode "Worked for" collapse folds process items, and a
 * receipt folded into it is a receipt the owner never sees without a click.
 * So the turn's process list is split: receipts stay always-visible, the rest
 * keeps collapsing exactly as before.
 */
export const isOutboundImReceiptItem = (item) => (
  item?.type === 'system' && item.message?.metadata?.imOutboundSend === true
);

export const splitOutboundImReceipts = (items = []) => {
  const receipts = [];
  const rest = [];
  for (const item of items) {
    (isOutboundImReceiptItem(item) ? receipts : rest).push(item);
  }
  return { receipts, rest };
};
