import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  buildPanelLocatorTicks,
  isPanelLocatorOverflow,
  PANEL_LOCATOR_CLICK_SLOP_PX,
  panelLocatorPreviewLines,
  panelLocatorPreviewTop,
  panelLocatorScrollForHandle,
  panelLocatorScrollForRow,
  panelLocatorThumbFor,
  panelLocatorTickIndexAtFraction,
  type PanelLocatorRow,
  type PanelLocatorRowBox,
  type PanelLocatorTick,
} from './panelMessageLocator';

/** Estimated preview-card height (px) used only to clamp its position. */
const PREVIEW_CARD_HEIGHT_PX = 64;

interface PanelMessageLocatorRailProps {
  /** The transcript scroll container the rail navigates. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** One row per visible transcript message (identity + preview text). */
  rows: PanelLocatorRow[];
  /** Accessible name of the rail control. */
  ariaLabel: string;
  /**
   * Called after a TICK-CLICK jump lands on a message (owner ruling
   * 2026-11-11, four-item fix ③): the host lights the landing bubble's
   * transient highlight ring. Drag-thumb scrubbing is viewport navigation,
   * not message selection, so it never fires this.
   */
  onTickJump?: (messageId: string) => void;
}

interface RailHover {
  /** Index into `ticks` (and via the tick id, into `rows`). */
  index: number;
  /** Clamped top (px) for the preview card. */
  top: number;
}

/**
 * Telegram-style message locator on the transcript's right edge (office chat
 * purity pass #2, item ③).
 *
 * A thin track carries one tick per message, each tick sized by its message's
 * rendered height; a viewport thumb is draggable with proportional jumping;
 * hovering the track shows a preview card (sender + first two lines) for the
 * message under the pointer; clicking a tick jumps to that message. The
 * component self-hides: without transcript overflow it renders nothing at
 * all. It reads scroll state only — it never scrolls on its own except in
 * response to drag/click, so the transcript's own auto-scroll-to-bottom
 * behavior is untouched.
 */
const PanelMessageLocatorRail: React.FC<PanelMessageLocatorRailProps> = ({
  containerRef,
  rows,
  ariaLabel,
  onTickJump,
}) => {
  const railRef = useRef<HTMLDivElement>(null);
  // Scroll content height the current ticks were built for; -1 invalidates.
  const ticksScrollHeightRef = useRef(-1);
  // Row tops in scroll-space px, keyed by message id (click-jump targets).
  const rowOffsetsRef = useRef<Map<string, number>>(new Map());
  const dragStateRef = useRef<{ startY: number; moved: boolean } | null>(null);

  const [overflowing, setOverflowing] = useState(false);
  const [ticks, setTicks] = useState<PanelLocatorTick[]>([]);
  const [thumb, setThumb] = useState({ start: 0, size: 1 });
  const [hover, setHover] = useState<RailHover | null>(null);
  const [dragging, setDragging] = useState(false);
  // Telegram-style presence: the rail is a quiet 2px line at rest and
  // widens (track + thumb + brighter ticks) while the pointer is anywhere
  // on it, so it never competes with the content for attention.
  const [railActive, setRailActive] = useState(false);
  // Overlay presence (owner design 2026-11-11 00:58/01:15): the rail hides
  // completely at rest and appears when the conversation scrolls, fading
  // back out after the scroll idles. Hovering the rail (or the transparent
  // edge zone) keeps it up for click/drag.
  const [recentlyScrolled, setRecentlyScrolled] = useState(false);
  const scrollFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = railActive || dragging || recentlyScrolled;

  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  /**
   * One rAF-coalesced measure pass: overflow gate, thumb, and — when the
   * content height actually changed — the tick map from the transcript's
   * message rows. Pure scroll movements skip the DOM row walk entirely.
   */
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const overflow = isPanelLocatorOverflow(scrollHeight, clientHeight);
    setThumb(panelLocatorThumbFor(container.scrollTop, scrollHeight, clientHeight));
    if (!overflow) {
      setOverflowing(false);
      setTicks([]);
      rowOffsetsRef.current = new Map();
      ticksScrollHeightRef.current = -1;
      return;
    }
    setOverflowing(true);
    if (ticksScrollHeightRef.current === scrollHeight) return;
    const containerRect = container.getBoundingClientRect();
    const boxes: PanelLocatorRowBox[] = [];
    const offsets = new Map<string, number>();
    container.querySelectorAll<HTMLElement>('[data-panel-message-id]').forEach((node) => {
      const id = node.getAttribute('data-panel-message-id');
      if (!id) return;
      const rect = node.getBoundingClientRect();
      const offsetTop = rect.top - containerRect.top + container.scrollTop;
      boxes.push({ id, offsetTop, offsetHeight: rect.height });
      offsets.set(id, offsetTop);
    });
    rowOffsetsRef.current = offsets;
    ticksScrollHeightRef.current = scrollHeight;
    setTicks(buildPanelLocatorTicks(boxes, scrollHeight));
  }, [containerRef]);

  // DEBUG(pass5) root cause: the rAF callback never fired in this Electron
  // window (probe: sync measure ran and detected overflow instantly, while
  // the rAF-scheduled measure never executed across fresh code and reloads),
  // so the rail stayed hidden forever. Measure synchronously — cheap at this
  // scale (the DOM row walk only runs when the content height changed).
  const scheduleMeasure = useCallback(() => {
    measure();
  }, [measure]);

  // New rows (messages added/removed/edited) always rebuild the tick map.
  useLayoutEffect(() => {
    ticksScrollHeightRef.current = -1;
    measure();
  }, [rows, measure, scheduleMeasure]);

  // Container resize (panel narrow/wide, streaming growth of siblings).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === 'undefined') {
      scheduleMeasure();
      return;
    }
    const observer = new ResizeObserver(() => scheduleMeasure());
    observer.observe(container);
    scheduleMeasure();
    return () => observer.disconnect();
  }, [containerRef, scheduleMeasure]);

  // Scroll updates the thumb every frame; ticks refresh only when the
  // content height changed (streaming growth), via the cache inside measure.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      scheduleMeasure();
      setRecentlyScrolled(true);
      if (scrollFadeRef.current !== null) clearTimeout(scrollFadeRef.current);
      scrollFadeRef.current = setTimeout(() => setRecentlyScrolled(false), 1100);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (scrollFadeRef.current !== null) clearTimeout(scrollFadeRef.current);
    };
  }, [containerRef, scheduleMeasure]);

  /** Drag mapping: thumb center follows the pointer, container scrolls. */
  const scrollToHandle = useCallback((clientY: number) => {
    const container = containerRef.current;
    const rail = railRef.current;
    if (!container || !rail) return;
    const railRect = rail.getBoundingClientRect();
    container.scrollTop = panelLocatorScrollForHandle(
      clientY - railRect.top,
      railRect.height,
      container.scrollHeight,
      container.clientHeight,
    );
  }, [containerRef]);

  const updateHover = useCallback((clientY: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const railRect = rail.getBoundingClientRect();
    const y = clientY - railRect.top;
    const index = panelLocatorTickIndexAtFraction(ticks, y / railRect.height);
    if (index < 0) {
      setHover(null);
      return;
    }
    setHover({ index, top: panelLocatorPreviewTop(y, PREVIEW_CARD_HEIGHT_PX, railRect.height) });
  }, [ticks]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = { startY: event.clientY, moved: false };
    setDragging(true);
    scrollToHandle(event.clientY);
  }, [scrollToHandle]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current) {
      if (Math.abs(event.clientY - dragStateRef.current.startY) > PANEL_LOCATOR_CLICK_SLOP_PX) {
        dragStateRef.current.moved = true;
      }
      scrollToHandle(event.clientY);
      return;
    }
    updateHover(event.clientY);
  }, [scrollToHandle, updateHover]);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag || drag.moved) return;
    // A click (no real drag) on the track: jump to the tick's message.
    const container = containerRef.current;
    const rail = railRef.current;
    if (!container || !rail) return;
    const railRect = rail.getBoundingClientRect();
    const index = panelLocatorTickIndexAtFraction(ticks, (event.clientY - railRect.top) / railRect.height);
    if (index < 0) return;
    const offset = rowOffsetsRef.current.get(ticks[index].id);
    if (offset == null) return;
    container.scrollTop = panelLocatorScrollForRow(offset, container.scrollHeight, container.clientHeight);
    // The tick click selected a message: hand its id to the host so the
    // landing bubble lights the shared transient ring (fix ③). Fires only
    // here — drag-thumb scrubbing never counts as a selection.
    onTickJump?.(ticks[index].id);
  }, [containerRef, ticks, onTickJump]);

  const handlePointerLeave = useCallback(() => {
    if (!dragStateRef.current) setHover(null);
  }, []);

  // Wheel over the thin rail must not be a dead zone: forward to the
  // transcript (the rail never prevents default scrolling).
  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    containerRef.current?.scrollBy({ top: event.deltaY });
  }, [containerRef]);

  if (!overflowing) return null;

    const hoverTick = hover ? ticks[hover.index] : null;
  const hoverRow = hoverTick ? rowById.get(hoverTick.id) ?? null : null;
  const hoverLines = hoverRow ? panelLocatorPreviewLines(hoverRow.content, 2) : [];

  return (
    <div
      ref={railRef}
      data-slot="panel-locator-rail"
      role="scrollbar"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(thumb.start * 100)}
      className="absolute bottom-1 right-0 top-1 z-20 w-3.5 cursor-pointer select-none touch-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => setRailActive(true)}
      onPointerLeave={() => {
        setRailActive(false);
        handlePointerLeave();
      }}
      onWheel={handleWheel}
    >
      {/* The visible layer: hidden at rest (overlay model — appears on
          scroll, stays while hovered/dragging, fades after idle). */}
      <div
        className={`absolute inset-y-0 right-0 w-3.5 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
      {/* The thin track line the ticks and thumb sit on. */}
      <div
        data-slot="panel-locator-track"
        className={`absolute inset-y-0 rounded-full transition-all ${
          railActive
            ? 'right-[5px] w-[4px] dark:bg-claude-darkBorder bg-claude-border'
            : 'right-[6px] w-[2px] dark:bg-claude-darkBorder/70 bg-claude-border/70'
        }`}
      />
      {/* One tick per message; height follows the message's share of the
          transcript, min 2px keeps single-line messages visible on long
          chats (exact fractions live in the tick math, not here). */}
      {ticks.map((tick, index) => {
        const isUser = rowById.get(tick.id)?.isUser ?? false;
        return (
          <div
            key={tick.id}
            data-slot="panel-locator-tick"
            data-panel-locator-tick-id={tick.id}
            className={`absolute rounded-full transition-colors ${
              railActive ? 'right-[3px] w-[7px]' : 'right-[4px] w-[6px]'
            } ${hover?.index === index
                ? 'dark:bg-claude-darkText bg-claude-text'
                : isUser
                  ? 'dark:bg-claude-accent/70 bg-claude-accent/60'
                  : 'dark:bg-claude-darkTextSecondary/50 bg-claude-textSecondary/40'
            }`}
            style={{ top: `${tick.start * 100}%`, height: `${tick.height * 100}%`, minHeight: 2 }}
          />
        );
      })}
      {/* The viewport thumb: draggable, proportional to the visible share. */}
      <div
        data-slot="panel-locator-thumb"
        className={`absolute rounded-full transition-all ${
          railActive ? 'right-[4px] w-[6px]' : 'right-[5px] w-1'
        } ${dragging
            ? 'dark:bg-claude-darkText bg-claude-text'
            : 'dark:bg-claude-darkTextSecondary bg-claude-textSecondary/80'
        }`}
        style={{ top: `${thumb.start * 100}%`, height: `${thumb.size * 100}%`, minHeight: 18 }}
      />
      {/* Hover preview card: sender + first two conversation lines. */}
      {hoverRow ? (
        <div
          data-slot="panel-locator-preview"
          className="pointer-events-none absolute right-full mr-2 w-56 rounded-xl border px-2.5 py-2 shadow-lg dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          style={{ top: hover?.top ?? 0 }}
        >
          <div className="truncate text-[11px] font-medium dark:text-claude-darkText text-claude-text">
            {hoverRow.isUser ? hoverRow.sender : hoverRow.sender || '·'}
          </div>
          {hoverLines.length > 0 ? (
            <div className="mt-0.5 line-clamp-2 whitespace-pre-line text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {hoverLines.join('\n')}
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
};

export default PanelMessageLocatorRail;
