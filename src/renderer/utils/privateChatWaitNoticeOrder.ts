/**
 * Private-chat skill wait notices ("收到，先让我……几分钟后给你完整回复") are
 * appended to the transcript only after their chain broadcast completes,
 * while the turn's real reply row keeps its model-authoring created_at and
 * is updated in place with the delivery txid afterwards. When a fast skill
 * lets the turn settle before the notice finishes its generate+broadcast
 * round trip, the notice lands AFTER the reply row in
 * (created_at, sequence) transcript order even though it went out on chain
 * BEFORE the reply — the local view then shows the acknowledgment after the
 * answer, and the ack reads as a promise that was never kept (the
 * 2026-11-20 23:53 and 2026-11-21 02:10 incidents).
 *
 * Display-side repair only: anchor each wait notice directly before the
 * outgoing reply that answers the same inbound pin (the notice carries
 * `privateChatSkillWaitNoticeForPinId`, the reply carries
 * `privateChatReplyForPinId`). Notices with no matching reply in the loaded
 * window (the turn ended silent, or the reply is paged out) keep their
 * stored position, and notices already sitting before their reply are left
 * untouched. Storage, paging cursors and every non-display consumer are
 * unaffected — this only reorders what the transcript renders.
 */
export interface WaitNoticeOrderMessageLike {
  // Deliberately a plain index signature: CoworkMessageMetadata itself is
  // index-signature based, and a structural member-list constraint would
  // fail TS's weak-type check against it.
  metadata?: Record<string, unknown> | null;
}

function asPinId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function anchorPrivateChatWaitNoticesBeforeReplies<T extends WaitNoticeOrderMessageLike>(
  messages: T[],
): T[] {
  if (messages.length < 2) return messages;

  // One pass: note where each wait notice sits and where the first outgoing
  // reply for each inbound pin sits (stored order).
  const noticePositions: Array<{ index: number; forPinId: string }> = [];
  const replyIndexByPinId = new Map<string, number>();
  messages.forEach((message, index) => {
    const metadata = message.metadata;
    if (!metadata) return;
    if (metadata.privateChatSkillWaitNotice === true) {
      const forPinId = asPinId(metadata.privateChatSkillWaitNoticeForPinId);
      if (forPinId) noticePositions.push({ index, forPinId });
      return;
    }
    const replyForPinId = asPinId(metadata.privateChatReplyForPinId);
    if (replyForPinId && !replyIndexByPinId.has(replyForPinId)) {
      replyIndexByPinId.set(replyForPinId, index);
    }
  });
  if (noticePositions.length === 0) return messages;

  // Notices to relocate, keyed by the stored index of the reply they must
  // precede. A notice only moves when its reply currently sits BEFORE it —
  // the broadcast-completed-after-authoring artifact. Ascending notice order
  // keeps multiple notices for the same reply in their stored sequence.
  const noticesToInsertByReplyIndex = new Map<number, T[]>();
  const movedNoticeIndexes = new Set<number>();
  for (const notice of noticePositions) {
    const replyIndex = replyIndexByPinId.get(notice.forPinId);
    if (replyIndex === undefined || replyIndex >= notice.index) continue;
    const bucket = noticesToInsertByReplyIndex.get(replyIndex) ?? [];
    bucket.push(messages[notice.index] as T);
    noticesToInsertByReplyIndex.set(replyIndex, bucket);
    movedNoticeIndexes.add(notice.index);
  }
  if (movedNoticeIndexes.size === 0) return messages;

  const result: T[] = [];
  messages.forEach((message, index) => {
    const noticesToInsert = noticesToInsertByReplyIndex.get(index);
    if (noticesToInsert) result.push(...noticesToInsert);
    if (!movedNoticeIndexes.has(index)) result.push(message);
  });
  return result;
}
