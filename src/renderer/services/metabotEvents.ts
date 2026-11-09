/**
 * Cross-view "the local Bot roster moved" broadcast.
 *
 * The Twin seat and the My Bots editor write the same system-wide facts
 * (`metabot_type` above all), but they render in different surfaces that can
 * both be mounted at once (the Bot Internet panel and the My Bots pane). A
 * successful write in one place must therefore refresh the other one without
 * a pane switch — that is this event's whole job.
 *
 * The event name predates this module: the chain-restore flow already
 * dispatches a bare `app:metabots-changed` and CoworkView reloads its roster
 * from it. This module keeps that contract and only adds an optional
 * `detail.metabotIds` set so consumers can tell which bots moved. Producers
 * that only know "the roster changed" may keep dispatching the bare event —
 * subscribers must treat a missing detail as an empty id set.
 */

export const METABOTS_CHANGED_EVENT = 'app:metabots-changed';

export interface MetabotsChangedDetail {
  /** Local bot ids known to have changed; empty when the producer only knows the roster moved. */
  metabotIds: number[];
  /** Optional producer label, e.g. 'twin-seat' | 'edit' | 'restore'. */
  reason?: string;
}

/** Coerce any detail (including a bare legacy event's `undefined`) into the canonical shape. */
export function normalizeMetabotsChangedDetail(detail: unknown): MetabotsChangedDetail {
  const raw = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};
  const ids = Array.isArray(raw.metabotIds) ? raw.metabotIds : [];
  const metabotIds = [...new Set(
    ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id)),
  )];
  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : undefined;
  return reason ? { metabotIds, reason } : { metabotIds };
}

/** Announce that one or more local Bots changed, so every open roster view refetches. */
export function dispatchMetabotsChanged(
  detail: MetabotsChangedDetail,
  target: EventTarget = window,
): void {
  target.dispatchEvent(
    new CustomEvent<MetabotsChangedDetail>(METABOTS_CHANGED_EVENT, {
      detail: normalizeMetabotsChangedDetail(detail),
    }),
  );
}

/**
 * Subscribe to roster changes. Returns the unsubscribe function; a handler is
 * always called with a normalized detail object, never `undefined`.
 */
export function subscribeMetabotsChanged(
  listener: (detail: MetabotsChangedDetail) => void,
  target: EventTarget = window,
): () => void {
  const handler = (event: Event) => {
    listener(normalizeMetabotsChangedDetail((event as CustomEvent<unknown>).detail));
  };
  target.addEventListener(METABOTS_CHANGED_EVENT, handler);
  return () => target.removeEventListener(METABOTS_CHANGED_EVENT, handler);
}
