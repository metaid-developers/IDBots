import type { Database } from 'sql.js';

type RatingPinItem = Record<string, unknown>;

export interface ParsedRatingPin {
  pinId: string;
  serviceId: string;
  servicePaidTx: string | null;
  rate: number;
  comment: string | null;
  raterGlobalMetaId: string | null;
  raterMetaId: string | null;
  createdAt: number;
}

export interface RatingDelta {
  sum: number;
  count: number;
}

export interface RatingAggregate {
  ratingAvg: number;
  ratingCount: number;
}

interface RatingSyncPage {
  list: RatingPinItem[];
  nextCursor?: string | null;
}

interface SyncGigSquareRatingsInput {
  db: Database;
  latestPinId: string | null;
  backfillCursor: string | null;
  maxPages: number;
  fetchPage: (cursor?: string) => Promise<RatingSyncPage>;
  setLatestPinId: (pinId: string) => void;
  setBackfillCursor: (cursor: string) => void;
  clearBackfillCursor: () => void;
  now?: () => number;
}

const LOG_PREFIX = '[GigSquare Rating]';

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
};

const parseContentSummary = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
};

export const parseRatingPin = (
  item: RatingPinItem,
  options: { now?: () => number } = {}
): ParsedRatingPin | null => {
  const pinId = toSafeString(item.id).trim();
  if (!pinId) return null;

  const summary = parseContentSummary(item.contentSummary);
  if (!summary) return null;

  const serviceId = toSafeString(summary.serviceID).trim();
  const rateValue = summary.rate;
  const rate = typeof rateValue === 'number'
    ? rateValue
    : typeof rateValue === 'string'
      ? Number.parseFloat(rateValue)
      : Number.NaN;

  if (!serviceId || !Number.isFinite(rate) || rate < 1 || rate > 5) {
    return null;
  }

  const servicePaidTx = toSafeString(summary.servicePaidTx).trim() || null;
  const commentRaw = typeof summary.comment === 'string' ? summary.comment : '';
  const comment = commentRaw.trim() ? commentRaw : null;
  const raterGlobalMetaId = toSafeString(item.globalMetaId).trim() || null;
  const raterMetaId = toSafeString(item.metaid ?? item.createMetaId).trim() || null;
  const timestamp = typeof item.timestamp === 'number' && item.timestamp > 0
    ? item.timestamp
    : (options.now ?? Date.now)();

  return {
    pinId,
    serviceId,
    servicePaidTx,
    rate,
    comment,
    raterGlobalMetaId,
    raterMetaId,
    createdAt: timestamp,
  };
};

export const applyRatingDelta = (
  aggregate: RatingAggregate,
  delta: RatingDelta
): RatingAggregate => {
  if (!Number.isFinite(delta.count) || delta.count <= 0) {
    return {
      ratingAvg: aggregate.ratingAvg,
      ratingCount: aggregate.ratingCount,
    };
  }

  const nextCount = aggregate.ratingCount + delta.count;
  if (nextCount <= 0) {
    return { ratingAvg: 0, ratingCount: 0 };
  }

  return {
    ratingAvg: (aggregate.ratingAvg * aggregate.ratingCount + delta.sum) / nextCount,
    ratingCount: nextCount,
  };
};

export async function syncGigSquareRatings(
  input: SyncGigSquareRatingsInput
): Promise<void> {
  const now = input.now ?? (() => Date.now());
  const deltas = new Map<string, RatingDelta>();

  const processItem = (item: RatingPinItem) => {
    const parsed = parseRatingPin(item, { now });
    if (!parsed) return;

    input.db.run(
      `INSERT OR IGNORE INTO remote_skill_service_rating_seen (
        pin_id, service_id, service_paid_tx, rate, comment, rater_global_metaid, rater_metaid, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.pinId,
        parsed.serviceId,
        parsed.servicePaidTx,
        parsed.rate,
        parsed.comment,
        parsed.raterGlobalMetaId,
        parsed.raterMetaId,
        parsed.createdAt,
      ]
    );
    if ((input.db.getRowsModified?.() || 0) <= 0) return;

    const delta = deltas.get(parsed.serviceId) || { sum: 0, count: 0 };
    delta.sum += parsed.rate;
    delta.count += 1;
    deltas.set(parsed.serviceId, delta);
  };

  let newLatestPinId: string | null = null;
  let cursor: string | undefined;
  let lastIncrementalNextCursor: string | undefined;
  let hitLatest = false;

  for (let page = 0; page < input.maxPages; page += 1) {
    let response: RatingSyncPage;
    try {
      response = await input.fetchPage(cursor);
    } catch (error) {
      console.warn(`${LOG_PREFIX} fetch error`, error);
      break;
    }

    const list = Array.isArray(response.list) ? response.list : [];
    const nextCursor = typeof response.nextCursor === 'string' && response.nextCursor
      ? response.nextCursor
      : undefined;

    if (page === 0 && list.length > 0) {
      newLatestPinId = toSafeString(list[0]?.id).trim() || null;
    }
    lastIncrementalNextCursor = nextCursor;

    for (const item of list) {
      const itemId = toSafeString(item.id).trim();
      if (input.latestPinId && itemId === input.latestPinId) {
        hitLatest = true;
        break;
      }
      processItem(item);
    }

    if (hitLatest || !nextCursor) break;
    cursor = nextCursor;
  }

  const processedCount = Array.from(deltas.values()).reduce((sum, delta) => sum + delta.count, 0);
  console.debug(`${LOG_PREFIX} incremental: processed ${processedCount} ratings, hitLatest=${hitLatest}`);

  let backfillCursor = input.backfillCursor;
  if (!backfillCursor && lastIncrementalNextCursor) {
    backfillCursor = lastIncrementalNextCursor;
  }

  if (backfillCursor) {
    try {
      const response = await input.fetchPage(backfillCursor);
      const list = Array.isArray(response.list) ? response.list : [];
      const nextCursor = typeof response.nextCursor === 'string' && response.nextCursor
        ? response.nextCursor
        : null;

      for (const item of list) {
        processItem(item);
      }

      console.debug(`${LOG_PREFIX} backfill: processed ${list.length} items, nextCursor=${nextCursor ?? 'done'}`);
      if (nextCursor) {
        input.setBackfillCursor(nextCursor);
      } else {
        input.clearBackfillCursor();
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} backfill error`, error);
    }
  }

  for (const [serviceId, delta] of deltas.entries()) {
    input.db.run(
      `UPDATE remote_skill_service
       SET rating_avg = (rating_avg * rating_count + ?) / (rating_count + ?),
           rating_count = rating_count + ?
       WHERE id = ?`,
      [delta.sum, delta.count, delta.count, serviceId]
    );
  }
  console.debug(`${LOG_PREFIX} updated ${deltas.size} services`);

  if (newLatestPinId) {
    input.setLatestPinId(newLatestPinId);
  }
}
