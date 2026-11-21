import type { MeHistoryEntryInfo } from '../../types/electron';

export type MeBurnLine = 'llm' | 'agent' | 'traffic' | 'brain' | 'other';

export interface MeBurnLineBucket {
  line: MeBurnLine;
  amountMilli: number;
  count: number;
  share: number;
}

export interface MeBurnSourceBucket {
  key: string;
  label: string;
  line: MeBurnLine;
  amountMilli: number;
  count: number;
  share: number;
}

export interface MeBurnBreakdownSummary {
  totalMilli: number;
  entryCount: number;
  byLine: MeBurnLineBucket[];
  bySource: MeBurnSourceBucket[];
}

export function normalizeBurnLine(refType?: string): MeBurnLine {
  const normalized = (refType || '').trim().toLowerCase().replace(/^metering:/, '');
  if (normalized === 'llm' || normalized === 'agent' || normalized === 'traffic' || normalized === 'brain') {
    return normalized;
  }
  return 'other';
}

function shortenAddress(addr: string): string {
  const trimmed = addr.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export function extractBurnSourceLabel(
  entry: Pick<MeHistoryEntryInfo, 'refType' | 'refId' | 'reason'>,
  line: MeBurnLine,
): string {
  const reason = (entry.reason ?? '').trim();
  if (reason) {
    // ABS relay metering writes: "metering <resourceType> <resourceKey> qty=... mult=..."
    const meteringMatch = /^metering\s+\S+\s+(\S+)/i.exec(reason);
    if (meteringMatch?.[1]) {
      return meteringMatch[1];
    }
    // ABS sponsored traffic billing writes: "freeze capture <orderId> bot=<addr> txSize=<n>"
    const botMatch = /\bbot=([^\s]+)/i.exec(reason);
    if (botMatch?.[1]) {
      return `bot ${shortenAddress(botMatch[1])}`;
    }
    return reason;
  }
  const refId = (entry.refId ?? '').trim();
  if (refId) return refId;
  return line.toUpperCase();
}

export function summarizeMeBurnBreakdown(
  entries: readonly MeHistoryEntryInfo[],
  maxSources = 6,
): MeBurnBreakdownSummary {
  const burns = entries.filter(
    (entry) =>
      (entry.type || '').trim().toLowerCase() === 'burn'
      && Number.isFinite(entry.amountMilli)
      && entry.amountMilli < 0,
  );

  if (burns.length === 0) {
    return { totalMilli: 0, entryCount: 0, byLine: [], bySource: [] };
  }

  let totalMilli = 0;
  const lineMap = new Map<MeBurnLine, { amountMilli: number; count: number }>();
  const sourceMap = new Map<string, { label: string; line: MeBurnLine; amountMilli: number; count: number }>();

  for (const entry of burns) {
    const absMilli = Math.abs(entry.amountMilli);
    totalMilli += absMilli;
    const line = normalizeBurnLine(entry.refType);

    const lineAgg = lineMap.get(line) ?? { amountMilli: 0, count: 0 };
    lineAgg.amountMilli += absMilli;
    lineAgg.count += 1;
    lineMap.set(line, lineAgg);

    const label = extractBurnSourceLabel(entry, line);
    const sourceKey = `${line}::${label}`;
    const sourceAgg = sourceMap.get(sourceKey) ?? { label, line, amountMilli: 0, count: 0 };
    sourceAgg.amountMilli += absMilli;
    sourceAgg.count += 1;
    sourceMap.set(sourceKey, sourceAgg);
  }

  const byLine: MeBurnLineBucket[] = Array.from(lineMap.entries())
    .map(([line, agg]) => ({
      line,
      amountMilli: agg.amountMilli,
      count: agg.count,
      share: totalMilli > 0 ? agg.amountMilli / totalMilli : 0,
    }))
    .sort((a, b) => b.amountMilli - a.amountMilli || b.count - a.count);

  const bySource: MeBurnSourceBucket[] = Array.from(sourceMap.entries())
    .map(([key, agg]) => ({
      key,
      label: agg.label,
      line: agg.line,
      amountMilli: agg.amountMilli,
      count: agg.count,
      share: totalMilli > 0 ? agg.amountMilli / totalMilli : 0,
    }))
    .sort((a, b) => b.amountMilli - a.amountMilli || b.count - a.count)
    .slice(0, Math.max(1, maxSources));

  return {
    totalMilli,
    entryCount: burns.length,
    byLine,
    bySource,
  };
}
