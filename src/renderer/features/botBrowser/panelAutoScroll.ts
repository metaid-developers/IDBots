export interface PanelAutoScrollMessageShape {
  id: string;
  content: string;
  metadata?: {
    isStreaming?: boolean;
  };
}

export const PANEL_AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96;
export const PANEL_SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_PX = 280;

/**
 * Produces a compact follow-scroll signal for the Studio chat panel.
 *
 * - While streaming, tracks visible message count, the last message's length,
 *   and every active streaming message's length so incremental deltas always
 *   trigger a bottom follow even when `visibleMessages.length` stays constant.
 * - While idle, tracks only the tail message (`id` + full `content` +
 *   streaming flag). Prepending older history via `loadEarlierMessages` leaves
 *   the tail unchanged so reading earlier history never jumps back to bottom.
 */
export function buildPanelAutoScrollFollowSignal(
  visibleMessages: readonly PanelAutoScrollMessageShape[] | undefined,
  isStreaming: boolean,
): string {
  if (!visibleMessages || visibleMessages.length === 0) return '';
  const last = visibleMessages[visibleMessages.length - 1];
  if (!isStreaming) {
    return `${last.id}:${last.content}:${last.metadata?.isStreaming ? '1' : '0'}`;
  }
  const live = visibleMessages.filter((message) => message.metadata?.isStreaming);
  const source = live.length > 0 ? live : [last];
  const livePart = source.map((message) => `${message.id}:${message.content.length}`).join('|');
  return `${visibleMessages.length}:${last.id}:${last.content.length}|${livePart}`;
}

export interface PanelAutoScrollDecisionInput {
  isStreaming: boolean;
  wasStreaming: boolean;
  shouldAutoScroll: boolean;
  isLoadingEarlier: boolean;
  sessionChanged: boolean;
}

/**
 * Decides whether a layout/content update in the Studio panel should pin the
 * transcript scroll container to the bottom.
 *
 * Studio policy:
 * - Never yank the scroll position while prepending earlier history.
 * - Switching sessions always lands at the bottom.
 * - During active streaming AND right as streaming finishes (`wasStreaming &&
 *   !isStreaming`), always keep the bottom-most output visible — even if the
 *   scrollbar was previously scrolled up — so new text pushes upward cleanly
 *   and the completed tail is never cut off.
 * - While idle, follow only when the viewport is still pinned (`shouldAutoScroll`).
 */
export function shouldPinPanelToBottomOnUpdate(input: PanelAutoScrollDecisionInput): boolean {
  if (input.isLoadingEarlier) return false;
  if (input.sessionChanged) return true;
  if (input.isStreaming) return true;
  if (input.wasStreaming && !input.isStreaming) return true;
  return input.shouldAutoScroll;
}

export interface PanelScrollInteractionInput {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  prevScrollTop: number;
  prevShouldAutoScroll: boolean;
}

export interface PanelScrollInteractionResult {
  distanceToBottom: number;
  nextShouldAutoScroll: boolean;
  nextShowScrollToBottom: boolean;
  nextScrollTop: number;
}

/**
 * Evaluates a user/viewport scroll event on the Studio transcript scroller.
 *
 * Increasing `scrollHeight` (content growth) or decreasing `clientHeight`
 * (bottom status bar mounting) increases `distanceToBottom` without `scrollTop`
 * decreasing; only an actual upward scroll (`scrollTop < prevScrollTop - 1`)
 * disengages auto-scroll when away from the bottom.
 */
export function resolvePanelScrollInteraction(
  input: PanelScrollInteractionInput,
): PanelScrollInteractionResult {
  const distanceToBottom = Math.max(0, input.scrollHeight - input.scrollTop - input.clientHeight);
  let nextShouldAutoScroll = input.prevShouldAutoScroll;
  if (distanceToBottom <= PANEL_AUTO_SCROLL_BOTTOM_THRESHOLD_PX) {
    nextShouldAutoScroll = true;
  } else if (input.scrollTop < input.prevScrollTop - 1) {
    nextShouldAutoScroll = false;
  }
  return {
    distanceToBottom,
    nextShouldAutoScroll,
    nextShowScrollToBottom: distanceToBottom > PANEL_SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_PX,
    nextScrollTop: input.scrollTop,
  };
}
