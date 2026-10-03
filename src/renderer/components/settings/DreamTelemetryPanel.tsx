import React, { useMemo } from 'react';
import { i18nService } from '../../services/i18n';
import {
  cumulative,
  diaryTrustRatios,
  movingAverage,
  runsToTelemetryDays,
  type DreamRunLike,
} from './dreamTelemetrySeries';

/**
 * Four mini trend charts over completed dream runs (telemetry reaches the
 * renderer through dream:listRuns). Hand-rolled inline SVG — the project has
 * no chart library.
 */

const CHART_W = 160;
const CHART_H = 56;
const PAD_X = 3;
const PAD_TOP = 4;
const PAD_BOTTOM = 3;

const COLOR_AMBER = '#f59e0b';
const COLOR_EMERALD = '#10b981';
const COLOR_SKY = '#0ea5e9';
const COLOR_RED = '#ef4444';
const COLOR_GRAY = '#9ca3af';

interface XY {
  x: number;
  y: number;
}

const valueOrZero = (value: number | null): number => (value == null ? 0 : value);

/** Map a series into the svg box; nulls keep their x slot but yield no point. */
const toPoints = (values: Array<number | null>, max: number): Array<XY | null> => {
  const count = values.length;
  if (count === 0) return [];
  const innerW = CHART_W - PAD_X * 2;
  const innerH = CHART_H - PAD_TOP - PAD_BOTTOM;
  return values.map((value, index) => {
    if (value == null || max <= 0) return null;
    const x = count === 1 ? CHART_W / 2 : PAD_X + (innerW * index) / (count - 1);
    const y = PAD_TOP + innerH * (1 - Math.min(value, max) / max);
    return { x, y };
  });
};

/** Split a possibly gapped series into contiguous polyline segments. */
const toSegments = (points: Array<XY | null>): XY[][] => {
  const segments: XY[][] = [];
  let current: XY[] = [];
  for (const point of points) {
    if (point) {
      current.push(point);
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments.filter((segment) => segment.length > 1);
};

const pointsAttr = (points: XY[]): string =>
  points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');

const maxOf = (series: Array<Array<number | null>>): number => {
  let max = 0;
  for (const values of series) {
    for (const value of values) {
      if (value != null && value > max) max = value;
    }
  }
  return max;
};

const lastNonNull = (values: Array<number | null>): number | null => {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value != null) return value;
  }
  return null;
};

const innerW = (): number => CHART_W - PAD_X * 2;
const innerH = (): number => CHART_H - PAD_TOP - PAD_BOTTOM;

const slotGeometry = (count: number): { slotW: number; barW: number } => {
  const slotW = innerW() / Math.max(1, count);
  return { slotW, barW: Math.min(6, Math.max(1, slotW * 0.6)) };
};

const ChartSvg: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="w-full h-14 block">
    {children}
  </svg>
);

interface ChartCardProps {
  title: string;
  headline: string;
  caption: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}

const ChartCard: React.FC<ChartCardProps> = ({ title, headline, caption, legend, children }) => (
  <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-2.5 py-2">
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] font-medium dark:text-claude-darkText text-claude-text truncate">{title}</span>
      <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-nowrap">{headline}</span>
    </div>
    <div className="mt-1">{children}</div>
    {legend}
    <div className="mt-1 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{caption}</div>
  </div>
);

const LegendDot: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <span className="inline-flex items-center gap-1">
    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
    {label}
  </span>
);

export interface DreamTelemetryPanelProps {
  runs: DreamRunLike[];
}

const DreamTelemetryPanel: React.FC<DreamTelemetryPanelProps> = ({ runs }) => {
  const days = useMemo(() => runsToTelemetryDays(runs), [runs]);
  const hasTelemetry = days.some((day) => day.hasTelemetry);

  if (!hasTelemetry) {
    return (
      <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('dreamTelemetryEmpty')}
      </div>
    );
  }

  // Chart 1: daily negative decision points + 7-day moving average.
  const failureValues = days.map((day) => day.negativePoints);
  const failureMax = Math.max(1, maxOf([failureValues]));
  const failureMa = movingAverage(failureValues, 7);
  const failureMaLatest = lastNonNull(failureMa);
  const failureGeometry = slotGeometry(days.length);

  // Chart 2: cumulative validated drafts + replay lessons.
  const skillsCumulative = cumulative(days.map((day) => valueOrZero(day.draftsValidated)));
  const lessonsCumulative = cumulative(days.map((day) => valueOrZero(day.lessons)));
  const skillsTotal = skillsCumulative.length > 0 ? skillsCumulative[skillsCumulative.length - 1] : 0;
  const lessonsTotal = lessonsCumulative.length > 0 ? lessonsCumulative[lessonsCumulative.length - 1] : 0;
  const sedimentMax = Math.max(1, ...skillsCumulative, ...lessonsCumulative);

  // Chart 3: diary-trust ratio (unmatched refs / total quoted spans), as a
  // percent. Days without a denominator (pre-2026-09-23 runs) render as gaps.
  const refsValues = diaryTrustRatios(days).map((ratio) => (ratio == null ? null : ratio * 100));
  const refsMax = 100;
  const refsLatest = lastNonNull(refsValues);
  const refsLatestCounts = (() => {
    for (let index = days.length - 1; index >= 0; index -= 1) {
      const day = days[index];
      if (day.unmatchedRefs != null && day.totalRefs != null && day.totalRefs > 0) {
        return `${day.unmatchedRefs}/${day.totalRefs}`;
      }
    }
    return null;
  })();

  // Chart 4: per-day validation gate stacked bars.
  const gateDays = days.map((day) => {
    if (day.draftsChecked == null && day.draftsValidated == null && day.draftsRejected == null) return null;
    const validated = valueOrZero(day.draftsValidated);
    const rejected = valueOrZero(day.draftsRejected);
    const unresolved = Math.max(0, valueOrZero(day.draftsChecked) - validated - rejected);
    return { validated, rejected, unresolved };
  });
  const gateMax = Math.max(
    1,
    ...gateDays.map((day) => (day ? day.validated + day.rejected + day.unresolved : 0)),
  );
  const gateTotalChecked = days.reduce((sum, day) => sum + valueOrZero(day.draftsChecked), 0);
  const gateGeometry = slotGeometry(days.length);

  const renderFailureBars = () =>
    days.map((day, index) => {
      const value = day.negativePoints;
      const x = PAD_X + failureGeometry.slotW * index + (failureGeometry.slotW - failureGeometry.barW) / 2;
      // No-feedback days (audit P1): hollow gray instead of the amber fill —
      // a zero (or low) count there may mean the feedback channel was never
      // exercised, not that the bot did well. Feedback days keep the amber
      // fill; a feedback day with zero points draws nothing at all (a real,
      // evidenced zero).
      const noFeedback = day.hasExplicitFeedback === false;
      if (value == null || (value <= 0 && !noFeedback)) return null;
      if (value <= 0) {
        // Zero points on a no-feedback day: a hollow baseline tick so the day
        // stays visually distinct from an evidenced zero.
        return (
          <rect
            key={`${day.date}-neg-empty`}
            x={x}
            y={PAD_TOP + innerH() - 3}
            width={failureGeometry.barW}
            height={3}
            fill="none"
            stroke={COLOR_GRAY}
            strokeWidth={1}
          >
            <title>{`${day.date} · ${i18nService.t('dreamTelemetryNoFeedback')}`}</title>
          </rect>
        );
      }
      const height = Math.max(1, (Math.min(value, failureMax) / failureMax) * innerH());
      if (noFeedback) {
        return (
          <rect
            key={`${day.date}-neg-nf`}
            x={x}
            y={PAD_TOP + innerH() - height}
            width={failureGeometry.barW}
            height={height}
            fill="none"
            stroke={COLOR_GRAY}
            strokeWidth={1}
          >
            <title>{`${day.date} · ${value} · ${i18nService.t('dreamTelemetryNoFeedback')}`}</title>
          </rect>
        );
      }
      return (
        <rect
          key={`${day.date}-neg`}
          x={x}
          y={PAD_TOP + innerH() - height}
          width={failureGeometry.barW}
          height={height}
          fill={COLOR_AMBER}
          fillOpacity={0.45}
        >
          <title>{`${day.date} · ${value}`}</title>
        </rect>
      );
    });

  const renderGateBars = () =>
    days.map((day, index) => {
      const gate = gateDays[index];
      if (!gate) return null;
      const x = PAD_X + gateGeometry.slotW * index + (gateGeometry.slotW - gateGeometry.barW) / 2;
      let yCursor = PAD_TOP + innerH();
      const segments: Array<{ key: string; height: number; color: string }> = [
        { key: 'validated', height: gate.validated, color: COLOR_EMERALD },
        { key: 'rejected', height: gate.rejected, color: COLOR_RED },
        { key: 'unresolved', height: gate.unresolved, color: COLOR_GRAY },
      ];
      return segments.map((segment) => {
        if (segment.height <= 0) return null;
        const height = Math.max(1, (Math.min(segment.height, gateMax) / gateMax) * innerH());
        yCursor -= height;
        return (
          <rect
            key={`${day.date}-${segment.key}`}
            x={x}
            y={yCursor}
            width={gateGeometry.barW}
            height={height}
            fill={segment.color}
            fillOpacity={0.85}
          />
        );
      });
    });

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('dreamTelemetryTitle')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <ChartCard
          title={i18nService.t('dreamTelemetryFailures')}
          headline={failureMaLatest == null ? '–' : failureMaLatest.toFixed(1)}
          caption={i18nService.t('dreamTelemetryFailuresHint')}
          legend={(
            <div className="mt-1 flex items-center gap-3 text-[9px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <LegendDot color={COLOR_GRAY} label={i18nService.t('dreamTelemetryNoFeedback')} />
            </div>
          )}
        >
          <ChartSvg>
            {renderFailureBars()}
            {toSegments(toPoints(failureMa, failureMax)).map((segment, index) => (
              <polyline
                key={index}
                points={pointsAttr(segment)}
                fill="none"
                stroke={COLOR_AMBER}
                strokeWidth={1.5}
                vector-effect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </ChartSvg>
        </ChartCard>

        <ChartCard
          title={i18nService.t('dreamTelemetrySediment')}
          headline={`${skillsTotal} · ${lessonsTotal}`}
          caption={i18nService.t('dreamTelemetrySedimentHint')}
          legend={(
            <div className="mt-1 flex items-center gap-3 text-[9px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <LegendDot color={COLOR_EMERALD} label={i18nService.t('dreamTelemetrySedimentSkills')} />
              <LegendDot color={COLOR_SKY} label={i18nService.t('dreamTelemetrySedimentLessons')} />
            </div>
          )}
        >
          <ChartSvg>
            {toSegments(toPoints(skillsCumulative, sedimentMax)).map((segment, index) => (
              <polyline
                key={`skills-${index}`}
                points={pointsAttr(segment)}
                fill="none"
                stroke={COLOR_EMERALD}
                strokeWidth={1.5}
                vector-effect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {toSegments(toPoints(lessonsCumulative, sedimentMax)).map((segment, index) => (
              <polyline
                key={`lessons-${index}`}
                points={pointsAttr(segment)}
                fill="none"
                stroke={COLOR_SKY}
                strokeWidth={1.5}
                vector-effect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </ChartSvg>
        </ChartCard>

        <ChartCard
          title={i18nService.t('dreamTelemetryDiaryTrust')}
          headline={refsLatest == null ? '–' : `${refsLatest.toFixed(0)}%${refsLatestCounts ? ` (${refsLatestCounts})` : ''}`}
          caption={i18nService.t('dreamTelemetryDiaryTrustHint')}
        >
          <ChartSvg>
            {toSegments(toPoints(refsValues, refsMax)).map((segment, index) => (
              <polyline
                key={index}
                points={pointsAttr(segment)}
                fill="none"
                stroke={COLOR_RED}
                strokeWidth={1.5}
                vector-effect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </ChartSvg>
        </ChartCard>

        <ChartCard
          title={i18nService.t('dreamTelemetryGate')}
          headline={String(gateTotalChecked)}
          caption={i18nService.t('dreamTelemetryGateHint')}
        >
          <ChartSvg>{renderGateBars()}</ChartSvg>
        </ChartCard>
      </div>
    </div>
  );
};

export default DreamTelemetryPanel;
