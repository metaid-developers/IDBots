import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DreamTelemetryPanel from '../src/renderer/components/settings/DreamTelemetryPanel';
import { i18nService } from '../src/renderer/services/i18n';

/**
 * Audit P1: the negative-decision-points chart distinguishes days whose
 * telemetry recorded NO explicit human feedback (hollow gray bars + tooltip +
 * legend) from evidenced good days (amber fill; an evidenced zero draws no
 * bar at all).
 */

const run = (dreamDate: string, points: number, hasExplicitFeedback: boolean | undefined) => ({
  dreamDate,
  status: 'completed',
  telemetry: {
    replay: { points, lessons: 0 },
    validation: { checked: 0, validated: 0, rejected: 0 },
    ...(hasExplicitFeedback === undefined ? {} : { hasExplicitFeedback }),
  },
});

const fixture = [
  run('2026-09-01', 2, true),
  run('2026-09-02', 2, false),
  run('2026-09-03', 0, false),
  run('2026-09-04', 0, true),
  run('2026-09-05', 1, undefined), // predates the flag
];

test('negative-points chart renders no-feedback days hollow and feedback days amber', () => {
  i18nService.setLanguage('en', { persist: false });
  const markup = renderToStaticMarkup(<DreamTelemetryPanel runs={fixture} />);

  // Feedback day with points: the amber filled bar with the plain count tooltip.
  assert.ok(markup.includes('fill="#f59e0b"'), 'feedback day keeps the amber fill');
  assert.ok(markup.includes('<title>2026-09-01 · 2</title>'), 'amber bar carries the plain count tooltip');

  // No-feedback day with points: hollow gray bar + no-feedback tooltip.
  assert.ok(markup.includes('stroke="#9ca3af"'), 'no-feedback day renders hollow gray');
  assert.ok(
    markup.includes('<title>2026-09-02 · 2 · No explicit feedback</title>'),
    'hollow bar tooltip says no explicit feedback',
  );

  // No-feedback day with ZERO points: the baseline tick keeps the day visible.
  assert.ok(markup.includes('<title>2026-09-03 · No explicit feedback</title>'), 'zero no-feedback day gets the baseline tick');

  // Evidenced zero (feedback present, no negative points): no bar at all.
  assert.ok(!markup.includes('2026-09-04-neg'), 'an evidenced zero draws no bar');

  // Pre-flag run (no hasExplicitFeedback key): normal amber rendering, no hollow mark.
  assert.ok(!markup.includes('2026-09-05 · 1 · No explicit feedback'), 'pre-flag days are not marked');

  // The legend line names the hollow mark.
  assert.ok(markup.includes('No explicit feedback'), 'legend names the hollow mark');
});

test('negative-points no-feedback legend localizes to Chinese', () => {
  i18nService.setLanguage('zh', { persist: false });
  const markup = renderToStaticMarkup(<DreamTelemetryPanel runs={fixture} />);
  assert.ok(markup.includes('无显式反馈'), 'zh legend label rendered');
  assert.ok(markup.includes('<title>2026-09-02 · 2 · 无显式反馈</title>'), 'zh tooltip rendered');
  i18nService.setLanguage('en', { persist: false });
});
