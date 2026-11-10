/**
 * Shared chain-identifier rules, injected into every bot-facing system prompt
 * (cowork sessions via the prompt composer, group-task turns via
 * buildGroupTaskSystemPrompt).
 *
 * Why: bots habitually truncate pinids/txids when quoting them in reports and
 * chat ("4c42c177…ba49b" instead of all 66 characters). Host tooling and other
 * participants match these identifiers exactly — the deliverable ledger, the
 * [DEPENDS_ON] dependency gate, and on-chain verification all broke on
 * truncated pins in the wild (task #58: a 60-hex `metafile://` prefix armed a
 * false 15-minute dependency wait). The host now also tolerates prefixes, but
 * the correct output is the verbatim identifier.
 *
 * The write-time section covers the other failure mode: hallucinated pin
 * references inside CHAIN-WRITE payloads (truncated, missing `i0`, wrong
 * characters) broadcast invalid records that are permanent with the fee
 * already spent. The host's chainPinRefGuard blocks those before broadcast;
 * the prompt teaches the model to self-check so the block is the exception.
 */

export const CHAIN_IDENTIFIER_VERBATIM_RULE = [
  '## Chain identifiers are load-bearing',
  '',
  'A pinid is 64 lowercase hex characters followed by `i` and the output index — pins minted by this host always end in `i0` (66 total); a txid is EXACTLY 64 lowercase hex characters. When you mention, quote, or report a pinid/txid — bare or inside `pin://`, `metafile://`, `metaapp://` URIs — copy it from the source VERBATIM: never truncate it, never abbreviate the middle or tail with `…`, never shorten it "for readability", and never split it across lines (shortening inside a code block is still truncation). A pin read from an indexer or another client may end in a different output index (`i1`, `i2`, …) — copy that suffix verbatim too.',
  'Host tooling and other participants match these identifiers exactly — a truncated pinid breaks deliverable matching, dependency waits, and on-chain verification. A short label like "(pin 44942d92)" may wrap the full value in prose, but the full value itself must always appear intact wherever the identifier is the reference.',
  '',
  '## Before every chain write, self-check the pin references',
  '',
  'When a tool writes to the chain (posting, commenting, answering, publishing, or any protocol payload) and the payload references a pin — a `pin://`, `metafile://`, or `metaapp://` URI, or a JSON field named like a pin (`pinId`, `coursePinId`, `rootPinId`, …) — verify EVERY reference before submitting: 64 lowercase hex characters followed by `i` and the output index, e.g. `1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0` (pins minted here end in `i0`; indexer-read foreign pins may end in `i1`, `i2`, …).',
  'Copy identifiers from the tool result that produced them — never from memory. A wrong or truncated reference is a permanently invalid on-chain record with the fee already spent. The host blocks malformed references before broadcast and tells you what to fix; a blocked write costs nothing, so fix the identifier and retry.',
].join('\n');
