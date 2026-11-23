/**
 * 火花线 (process sparkline) — ONE renderer for both surfaces that show it:
 *   - the run row's 48×12 inline strip (`variant="row"`)
 *   - the process dossier's own block (`variant="detail"`)
 *
 * The rule this component exists to enforce: a bar means "there were messages
 * in this slot". A session with no message timestamps renders the explicit
 * empty state — never 24 placeholder bars of equal height, which is what the
 * old stub did and what the owner flagged as fabricated.
 */

import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { PROCESS_STATE_DOT_COLOR } from '../../utils/processCenter';
import {
  PROCESS_SPARK_BUCKET_COUNT,
  normalizeSparkReading,
  sparkActiveBuckets,
  sparkBarPercents,
  sparkHasData,
  type ProcessSparkReading,
} from '../../utils/processSpark';

const t = (key: string): string => i18nService.t(key);

const VARIANT = {
  row: { width: 48, height: 12, gap: 1, bar: 2, radius: '1px', opacity: 0.55 },
  detail: { width: 168, height: 26, gap: 2, bar: 5, radius: '1px', opacity: 0.7 },
} as const;

const ProcessSparkline: React.FC<{
  reading: ProcessSparkReading | null | undefined;
  variant?: keyof typeof VARIANT;
  testId?: string;
  className?: string;
}> = ({ reading, variant = 'row', testId = 'process-spark', className = '' }) => {
  const geometry = VARIANT[variant];
  const percents = sparkBarPercents(reading);
  const hasData = sparkHasData(reading);
  const total = reading?.total ?? 0;
  const active = sparkActiveBuckets(reading);
  const emptyLabel = t('processSparkEmpty');

  if (!hasData) {
    // Empty state: the slot is shown (so the surface is honest about being
    // empty), but no bar is drawn. The detail variant spells it out in words;
    // the row variant has 48px, so it draws a dashed baseline and carries the
    // same words in the tooltip.
    return (
      <span
        data-testid={`${testId}-empty`}
        data-spark-empty="true"
        title={`${emptyLabel} — ${t('processSparkEmptyHint')}`}
        className={`inline-flex items-center ${variant === 'detail' ? 'gap-2' : ''} ${className}`}
      >
        <span
          aria-hidden
          className="block border-t border-dashed border-claude-border dark:border-claude-darkBorder"
          style={{ width: geometry.width, height: 1 }}
        />
        {variant === 'detail' && (
          <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {emptyLabel}
          </span>
        )}
      </span>
    );
  }

  return (
    <span
      data-testid={testId}
      data-spark-total={total}
      data-spark-active={active}
      data-spark-buckets={PROCESS_SPARK_BUCKET_COUNT}
      title={t('processSparkTitle')
        .replace('{count}', String(total))
        .replace('{active}', String(active))
        .replace('{buckets}', String(PROCESS_SPARK_BUCKET_COUNT))}
      className={`inline-flex items-end ${className}`}
      style={{ width: geometry.width, height: geometry.height, gap: geometry.gap }}
    >
      {percents.map((percent, index) => (
        <i
          key={index}
          data-testid={`${testId}-bar`}
          data-spark-index={index}
          className="block"
          style={{
            // Zero slots stay 0% — a visible stub would claim activity that
            // never happened.
            width: geometry.bar,
            height: percent > 0 ? `${percent}%` : 0,
            borderRadius: `${geometry.radius} ${geometry.radius} 0 0`,
            backgroundColor: PROCESS_STATE_DOT_COLOR.live,
            opacity: percent > 0 ? geometry.opacity : 0,
          }}
        />
      ))}
    </span>
  );
};


/**
 * The dossier's own 火花线 block: one session, its own read, and — when the
 * session has no message timestamps — the empty state IN WORDS (the row's
 * 48px slot can only carry a tooltip, this surface can say it outright).
 */
export const ProcessSparkPanel: React.FC<{
  sessionId: string;
  /** Re-read when this changes (a finished turn means new timestamps). */
  refreshKey?: string;
  className?: string;
}> = ({ sessionId, refreshKey = 'idle', className = '' }) => {
  const [reading, setReading] = useState<ProcessSparkReading | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setReading(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      const reader = window.electron?.cowork?.activitySpark;
      if (typeof reader !== 'function') return null;
      const result = await reader({ sessionIds: [sessionId] });
      if (!result?.success || !result.sparks) return null;
      return normalizeSparkReading(result.sparks[sessionId]);
    };
    void read()
      .then((next) => {
        if (!cancelled) setReading(next);
      })
      .catch(() => {
        if (!cancelled) setReading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  const hasData = sparkHasData(reading);
  return (
    <div
      data-testid="process-spark-panel"
      data-spark-empty={hasData ? 'false' : 'true'}
      className={`mx-auto flex w-full max-w-[clamp(680px,64%,920px)] items-center gap-2 ${className}`}
    >
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {t('processSparkLabel')}
      </span>
      <ProcessSparkline reading={reading} variant="detail" testId="process-spark-panel-line" />
      {hasData && (
        <span
          data-testid="process-spark-panel-summary"
          className="text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
        >
          {t('processSparkSummary')
            .replace('{count}', String(reading?.total ?? 0))
            .replace('{active}', String(sparkActiveBuckets(reading)))}
        </span>
      )}
    </div>
  );
};

export default ProcessSparkline;
