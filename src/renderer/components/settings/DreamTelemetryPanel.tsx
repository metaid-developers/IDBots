import React, { useMemo, useRef, useState } from 'react';
import { InformationCircleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import Tooltip from '../ui/Tooltip';
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

const shortDate = (date: string): string => (date.length >= 10 ? date.slice(5) : date);

const HoverDot: React.FC<{ x: number; y: number; color: string }> = ({ x, y, color }) => (
  <circle cx={x} cy={y} r={2.4} fill={color} stroke="#ffffff" strokeWidth={0.8} vector-effect="non-scaling-stroke" />
);

// OWNER 03:16: Binance-grade polish for the four sparklines — dashed
// gridlines + solid baseline, min/max + date labels, and a hover crosshair
// with a value bubble (the native <title> tooltips read as sloppy).
const ChartShell: React.FC<{
  count: number;
  tooltips: string[];
  yMaxLabel: string;
  dateFirst: string;
  dateLast: string;
  render: (hoverIndex: number | null) => React.ReactNode;
}> = ({ count, tooltips, yMaxLabel, dateFirst, dateLast, render }) => {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const frac = hover == null ? null : count > 1 ? hover / (count - 1) : 0.5;
  const handleMove = (event: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover(count <= 1 ? 0 : Math.round(ratio * (count - 1)));
  };
  const tipLeft = frac == null ? '50%' : `${(frac * 100).toFixed(2)}%`;
  const tipShift = frac == null ? '-50%' : frac > 0.72 ? '-100%' : frac < 0.28 ? '0%' : '-50%';
  return (
    <div>
      <div
        ref={ref}
        className="relative h-14 select-none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="w-full h-full block">
          {[1 / 3, 2 / 3].map((f) => (
            <line
              key={`grid-${f}`}
              x1={0}
              x2={CHART_W}
              y1={PAD_TOP + innerH() * (1 - f)}
              y2={PAD_TOP + innerH() * (1 - f)}
              stroke="#94a3b8"
              strokeOpacity={0.22}
              strokeDasharray="2 3"
              strokeWidth={1}
              vector-effect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            x2={CHART_W}
            y1={PAD_TOP + innerH()}
            y2={PAD_TOP + innerH()}
            stroke="#94a3b8"
            strokeOpacity={0.35}
            strokeWidth={1}
            vector-effect="non-scaling-stroke"
          />
          {render(hover)}
          {frac != null && (
            <line
              x1={frac * CHART_W}
              x2={frac * CHART_W}
              y1={PAD_TOP - 2}
              y2={PAD_TOP + innerH()}
              stroke="#94a3b8"
              strokeOpacity={0.6}
              strokeWidth={1}
              vector-effect="non-scaling-stroke"
            />
          )}
        </svg>
        <div className="pointer-events-none absolute right-1 top-0 text-[9px] leading-none tabular-nums dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
          {yMaxLabel}
        </div>
        {hover != null && tooltips[hover] && (
          <div
            className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-[var(--shape-radius-sm)] border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-1.5 py-0.5 text-[9px] leading-none shadow-sm dark:text-claude-darkText text-claude-text tabular-nums"
            style={{ left: tipLeft, transform: `translateX(${tipShift}) translateY(-110%)` }}
          >
            {tooltips[hover]}
          </div>
        )}
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] leading-none tabular-nums dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
        <span>{dateFirst}</span>
        <span>{dateLast}</span>
      </div>
    </div>
  );
};

interface ChartCardProps {
  title: string;
  headline: string;
  caption?: string;
  tooltip?: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}

const ChartCard: React.FC<ChartCardProps> = ({ title, headline, caption, tooltip, legend, children }) => (
  <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-2.5 py-2">
    <div className="flex items-baseline justify-between gap-2">
      <div className="flex items-center gap-1">
        <span className="text-[11px] font-medium dark:text-claude-darkText text-claude-text truncate">{title}</span>
        {tooltip && (
          <Tooltip content={tooltip}>
            <InformationCircleIcon className="h-3.5 w-3.5 dark:text-claude-darkTextTertiary text-claude-textTertiary cursor-help flex-shrink-0" />
          </Tooltip>
        )}
      </div>
      <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-nowrap">{headline}</span>
    </div>
    <div className="mt-1">{children}</div>
    {legend}
    {caption && <div className="mt-1 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{caption}</div>}
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

  // Chart 5 (P2 frozen exam): sparse weekly scores on a 0..1 scale. Rendered
  // only when at least one exam run exists — bots without exams keep the
  // panel exactly as it was.
  const dateFirst = days.length > 0 ? shortDate(days[0].date) : '';
  const dateLast = days.length > 0 ? shortDate(days[days.length - 1].date) : '';
  const failureTooltips = days.map((day) => {
    const noFeedback = day.hasExplicitFeedback === false;
    return `${day.date} · ${day.negativePoints == null ? '–' : day.negativePoints}${noFeedback ? ` · ${i18nService.t('dreamTelemetryNoFeedback')}` : ''}`;
  });
  const sedimentTooltips = days.map((day, index) => `${day.date} · ${i18nService.t('dreamTelemetrySedimentSkills')} ${skillsCumulative[index]} · ${i18nService.t('dreamTelemetrySedimentLessons')} ${lessonsCumulative[index]}`);
  const trustTooltips = days.map((day, index) => {
    const value = refsValues[index];
    return `${day.date} · ${value == null ? '–' : `${value.toFixed(0)}%`}${day.totalRefs ? ` (${day.unmatchedRefs}/${day.totalRefs})` : ''}`;
  });
  const gateTooltips = days.map((day, index) => {
    const gate = gateDays[index];
    if (!gate) return `${day.date} · –`;
    return `${day.date} · ✓${gate.validated} ✗${gate.rejected} ?${gate.unresolved}`;
  });
  const examValues = days.map((day) => day.examScore);
  const examTooltips = days.map((day, index) => `${day.date} · ${examValues[index] == null ? '–' : `${(examValues[index] as number) * 100}%`}`);
  const examLatest = lastNonNull(examValues);
  const hasExamData = examValues.some((value) => value != null);

  const renderFailureBars = (hoverIndex: number | null) =>
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
      const hovered = hoverIndex === index;
      return (
        <rect
          key={`${day.date}-neg`}
          x={x}
          y={PAD_TOP + innerH() - height}
          width={failureGeometry.barW}
          height={height}
          rx={1}
          fill={COLOR_AMBER}
          fillOpacity={hovered ? 1 : 0.45}
        />
      );
    });

  const renderGateBars = (hoverIndex: number | null) =>
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
            rx={1}
            fill={segment.color}
            fillOpacity={hoverIndex == null ? 0.85 : hoverIndex === index ? 1 : 0.4}
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
          tooltip={i18nService.t('dreamTelemetryFailuresHint')}
          legend={(
            <div className="mt-1 flex items-center gap-3 text-[9px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <LegendDot color={COLOR_GRAY} label={i18nService.t('dreamTelemetryNoFeedback')} />
            </div>
          )}
        >
          <ChartShell
            count={days.length}
            tooltips={failureTooltips}
            yMaxLabel={String(failureMax)}
            dateFirst={dateFirst}
            dateLast={dateLast}
            render={(hover) => (
              <>
                {renderFailureBars(hover)}
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
                {hover != null && failureMa[hover] != null && (() => {
                  const point = toPoints(failureMa, failureMax)[hover];
                  return point ? <HoverDot x={point.x} y={point.y} color={COLOR_AMBER} /> : null;
                })()}
              </>
            )}
          />
        </ChartCard>

        <ChartCard
          title={i18nService.t('dreamTelemetrySediment')}
          headline={`${skillsTotal} · ${lessonsTotal}`}
          tooltip={i18nService.t('dreamTelemetrySedimentHint')}
          legend={(
            <div className="mt-1 flex items-center gap-3 text-[9px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <LegendDot color={COLOR_EMERALD} label={i18nService.t('dreamTelemetrySedimentSkills')} />
              <LegendDot color={COLOR_SKY} label={i18nService.t('dreamTelemetrySedimentLessons')} />
            </div>
          )}
        >
          <ChartShell
            count={days.length}
            tooltips={sedimentTooltips}
            yMaxLabel={String(sedimentMax)}
            dateFirst={dateFirst}
            dateLast={dateLast}
            render={(hover) => (
              <>
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
                {hover != null && (() => {
                  const sk = toPoints(skillsCumulative, sedimentMax)[hover];
                  const ls = toPoints(lessonsCumulative, sedimentMax)[hover];
                  return (
                    <>
                      {sk ? <HoverDot x={sk.x} y={sk.y} color={COLOR_EMERALD} /> : null}
                      {ls ? <HoverDot x={ls.x} y={ls.y} color={COLOR_SKY} /> : null}
                    </>
                  );
                })()}
              </>
            )}
          />
        </ChartCard>

        <ChartCard
          title={i18nService.t('dreamTelemetryDiaryTrust')}
          headline={refsLatest == null ? '–' : `${refsLatest.toFixed(0)}%${refsLatestCounts ? ` (${refsLatestCounts})` : ''}`}
          tooltip={i18nService.t('dreamTelemetryDiaryTrustHint')}
        >
          <ChartShell
            count={days.length}
            tooltips={trustTooltips}
            yMaxLabel="100%"
            dateFirst={dateFirst}
            dateLast={dateLast}
            render={(hover) => (
              <>
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
                {hover != null && refsValues[hover] != null && (() => {
                  const point = toPoints(refsValues, refsMax)[hover];
                  return point ? <HoverDot x={point.x} y={point.y} color={COLOR_RED} /> : null;
                })()}
              </>
            )}
          />
        </ChartCard>

        <ChartCard
          title={i18nService.t('dreamTelemetryGate')}
          headline={String(gateTotalChecked)}
          tooltip={i18nService.t('dreamTelemetryGateHint')}
        >
          <ChartShell
            count={days.length}
            tooltips={gateTooltips}
            yMaxLabel={String(gateMax)}
            dateFirst={dateFirst}
            dateLast={dateLast}
            render={(hover) => renderGateBars(hover)}
          />
        </ChartCard>
        {hasExamData && (
          <ChartCard
            title={i18nService.t('dreamTelemetryExam')}
            headline={examLatest == null ? '–' : `${(examLatest * 100).toFixed(0)}%`}
            tooltip={i18nService.t('dreamTelemetryExamHint')}
          >
            <ChartShell
              count={days.length}
              tooltips={examTooltips}
              yMaxLabel="100%"
              dateFirst={dateFirst}
              dateLast={dateLast}
              render={(hover) => (
                <>
                  {toSegments(toPoints(examValues, 1)).map((segment, index) => (
                    <polyline
                      key={index}
                      points={pointsAttr(segment)}
                      fill="none"
                      stroke={COLOR_EMERALD}
                      strokeWidth={1.5}
                      vector-effect="non-scaling-stroke"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ))}
                  {toPoints(examValues, 1).map((point, index) => point && (
                    <circle
                      key={index}
                      cx={point.x}
                      cy={point.y}
                      r={hover === index ? 2.4 : 1.6}
                      fill={COLOR_EMERALD}
                    />
                  ))}
                </>
              )}
            />
          </ChartCard>
        )}
      </div>
    </div>
  );
};

export default DreamTelemetryPanel;
