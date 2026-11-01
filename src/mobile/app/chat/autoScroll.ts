/**
 * Near-bottom guard for the chat transcript auto-scroll.
 *
 * ChatScreen used to assign scrollTop = scrollHeight on every message or
 * streaming delta, which yanked users out of history on each update. The
 * guard keeps the auto-follow only while the viewport hugs the transcript
 * bottom (within NEAR_BOTTOM_THRESHOLD_PX); further up, updates must leave
 * the scroll position untouched and the screen surfaces the floating
 * "new messages" pill instead (ChatScreen renders it above the composer).
 */

/** Distance (px) from the transcript bottom within which auto-follow stays on. */
export const NEAR_BOTTOM_THRESHOLD_PX = 120;

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * True when the viewport is near the bottom of the transcript, i.e. the
 * remaining distance (scrollHeight - scrollTop - clientHeight) is within
 * the threshold. Exactly-at-threshold counts as near (sticky follow should
 * not flicker off at the boundary), and a non-overflowing list (distance
 * clamped to >= 0) is always near.
 */
export function isNearBottom(
  metrics: ScrollMetrics,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return Math.max(distanceFromBottom, 0) <= threshold;
}
