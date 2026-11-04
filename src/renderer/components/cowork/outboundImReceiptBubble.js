/**
 * Render model for the outbound-IM echo (im_send_message) inside the chat it
 * went to.
 *
 * Owner ruling 2026-11-04 (third correction, from a real device): the echo must
 * read as a NORMAL outgoing chat bubble — the body the channel received and
 * nothing else. No direction/channel/time header, no target line, no "摘要"
 * field, no result tally, no 200-char cut. Attachments are drawn the way this
 * transcript already draws images and files (one thumbnail / one file entry
 * each), never as a filename list.
 *
 * Two rows must NOT take the bubble path, and this module is the single place
 * that decides:
 *   - a failed (or partially delivered) attempt: the audited card is the
 *     message there — the reason has to stay visible;
 *   - a legacy row written before `imOutboundRecordVersion` 2: its `content`
 *     IS the audit card text, and rendering that inside a chat bubble would
 *     put 方向/目标/摘要 labels right back in the bubble.
 *
 * Kept framework-free (plain JS) so `node --test` imports it without a TS
 * compile step — same contract as assistantTurnPresentation.js.
 */

/** Mirror of IM_OUTBOUND_RECORD_VERSION in src/main/im/imOutbound.ts (v2 = bubble). */
export const OUTBOUND_IM_RECEIPT_VERSION = 2;

/** The one-line degradation used when the transcript cannot draw attachment bubbles. */
export const formatOutboundAttachmentNote = (count) => `（已发送 ${count} 个附件）`;

const ATTACHMENT_KINDS = new Set(['image', 'video', 'audio', 'file']);

/**
 * A path the transcript can actually draw/open: absolute, POSIX or Windows.
 * A relative path would make the thumbnail loader fail silently (no picture,
 * no note) — counting it as undrawable keeps the degradation honest.
 */
const isDrawablePath = (value) => (
  value.startsWith('/')
  || value.startsWith('\\\\')
  || /^[A-Za-z]:[\\/]/.test(value)
);

const basenameOf = (value) => {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  const tail = normalized.slice(normalized.lastIndexOf('/') + 1);
  return tail || normalized;
};

/**
 * Decide how one message renders.
 *
 * Returns null when the message is not an outbound-IM echo that should render
 * as a bubble (not a receipt at all / failed receipt / legacy card row), so the
 * caller keeps its existing rendering.
 *
 * Otherwise:
 *   body          the sent text, verbatim (newlines kept, never truncated)
 *   attachments   [{ path, name, kind, bytes }] — one bubble each
 *   fallbackNote  '（已发送 N 个附件）' for attachments that cannot be drawn as
 *                 bubbles (legacy names-only rows, or a missing path); null when
 *                 every attachment has its own bubble
 */
export const readOutboundImReceiptBubble = (message) => {
  const metadata = message && typeof message === 'object' ? message.metadata : null;
  if (!metadata || metadata.imOutboundSend !== true) return null;
  // A failure keeps the audited card — its reason is the message.
  if (metadata.imOutboundOk !== true) return null;
  // v1 rows carry card text in `content`; never dress that up as a chat bubble.
  if (!(Number(metadata.imOutboundRecordVersion) >= OUTBOUND_IM_RECEIPT_VERSION)) return null;

  const body = typeof message.content === 'string' ? message.content : '';

  const rawItems = Array.isArray(metadata.imOutboundAttachmentItems)
    ? metadata.imOutboundAttachmentItems
    : [];
  const attachments = [];
  const seenPaths = new Set();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const filePath = typeof item.path === 'string' ? item.path.trim() : '';
    if (!filePath || !isDrawablePath(filePath) || seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    const name = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : basenameOf(filePath);
    const bytes = Number.isFinite(item.bytes) ? Number(item.bytes) : 0;
    attachments.push({
      path: filePath,
      name,
      kind: ATTACHMENT_KINDS.has(item.kind) ? item.kind : 'file',
      bytes,
    });
  }

  // Degradation is counted, not guessed: however many attachments this record
  // declares, the ones without a drawable path collapse into ONE plain note
  // ("（已发送 N 个附件）") — never a path list.
  const names = Array.isArray(metadata.imOutboundAttachments)
    ? metadata.imOutboundAttachments.filter((name) => typeof name === 'string' && name.trim())
    : [];
  const declared = Math.max(names.length, attachments.length);
  const undrawable = Math.max(0, declared - attachments.length);

  const fallbackNote = undrawable > 0 ? formatOutboundAttachmentNote(undrawable) : null;
  // A row with nothing to draw would render as an empty padded box: leave it to
  // the caller's existing (content-based) rendering instead.
  if (!body.trim() && attachments.length === 0 && !fallbackNote) return null;

  return { body, attachments, fallbackNote };
};
