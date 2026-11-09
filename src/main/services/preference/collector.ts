import { contentRecoveryUrl, normalizeChainEvent, recoverTruncatedBodies } from '../metatask/collector';
import { fetchProtocolPinsFromIndexer, type ProtocolPinRecord } from '../protocolPinFetch';
import { PREFERENCE_SEGMENTS, preferencePoolPath, type PreferenceSegment } from './constants';
import type { PreferenceChainEvent } from './types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CollectPreferenceEventsOptions {
  fetchImpl?: FetchLike;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
  /** Skip the process-wide walk memo (write-following refreshes). */
  bypassCache?: boolean;
}

export interface CollectPreferenceEventsResult {
  events: PreferenceChainEvent[];
  perPath: { segment: PreferenceSegment; count: number; error?: string }[];
}

const keepRaw = (item: Record<string, unknown>): unknown => item;

async function walkPool(
  segment: PreferenceSegment,
  options: CollectPreferenceEventsOptions,
): Promise<{ pins: ProtocolPinRecord[]; error?: string }> {
  let error: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let failed = false;
    try {
      const pins = await fetchProtocolPinsFromIndexer(preferencePoolPath(segment), {
        pageSize: options.pageSize ?? 100,
        maxPages: options.maxPages ?? 1000,
        timeoutMs: options.timeoutMs ?? 8_000,
        fetchImpl: options.fetchImpl,
        bypassCache: options.bypassCache,
        selectContent: keepRaw,
        onTruncated: (info) => {
          if (info.reason === 'fetch-error') failed = true;
        },
      });
      if (!failed) return { pins };
      error = 'page walk aborted mid-pool (fetch error)';
      if (attempt === 1) return { pins, error };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return { pins: [], error };
}

export async function collectPreferenceEvents(
  options: CollectPreferenceEventsOptions = {},
): Promise<CollectPreferenceEventsResult> {
  const events: PreferenceChainEvent[] = [];
  const perPath: CollectPreferenceEventsResult['perPath'] = [];
  const pending: { event: PreferenceChainEvent; url: string }[] = [];
  for (const segment of PREFERENCE_SEGMENTS) {
    const { pins, error } = await walkPool(segment, options);
    let count = 0;
    for (const pin of pins) {
      const rawItem = (pin.content && typeof pin.content === 'object' ? pin.content : {}) as Record<string, unknown>;
      const normalized = normalizeChainEvent(pin.pinId, rawItem, pin.timestampMs ?? null);
      if (!normalized || String(normalized.path) !== segment) continue;
      const event: PreferenceChainEvent = { ...normalized, path: segment };
      events.push(event);
      const url = contentRecoveryUrl(rawItem, event.body);
      if (url) pending.push({ event, url });
      count += 1;
    }
    perPath.push({ segment, count, ...(error ? { error } : {}) });
  }
  await recoverTruncatedBodies(pending, options.fetchImpl);
  return { events, perPath };
}
