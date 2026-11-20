/**
 * Session-row presentation for a turn that is being served by a NON-primary
 * brain (see src/main/libs/fallbackBrainStatus.ts for the write/clear side).
 *
 * Same contract as coworkSessionPresentation.js: a dependency-free pure
 * module the renderer (and its node tests) can import without a TS compile
 * step. The row only ever DECORATES the status it already shows — the
 * session status itself (idle/running/completed/...) is untouched, so no
 * lifecycle semantics change here.
 */

const RUNNING_STATUS = 'running';

/** i18n keys the row picks its visible status words from. */
export const FALLBACK_BRAIN_LABEL_KEYS = {
  /** The bot's own configured fallback brain (备用脑). */
  botFallback: 'coworkStatusFallbackBrain',
  /** A degraded-but-not-the-bot's-brain route (current default / system rescue). */
  degraded: 'coworkStatusDegradedModel',
};

function readMark(input) {
  if (!input || typeof input !== 'object') return null;
  const mark = input.activeFallbackBrain;
  if (!mark || typeof mark !== 'object') return null;
  if (typeof mark.model !== 'string' || mark.model.trim().length === 0) return null;
  return mark;
}

/**
 * Which status word the row must render instead of the plain running label.
 *
 * Returns an i18n key, or null when the row keeps its normal status word.
 * Only a RUNNING session can be "on the fallback brain right now": the mark is
 * cleared in the runner's settle point, and gating on the status as well keeps
 * a stale/odd summary from decorating a finished or failed row.
 */
export function resolveFallbackBrainStatusLabelKey(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.status !== RUNNING_STATUS) return null;
  const mark = readMark(input);
  if (!mark) return null;
  return mark.rung === 'bot-fallback' ? FALLBACK_BRAIN_LABEL_KEYS.botFallback : FALLBACK_BRAIN_LABEL_KEYS.degraded;
}

/**
 * Tooltip copy for the status word: names the failed primary route and the
 * route actually serving the turn, so a reader never has to guess which model
 * wrote the reply.
 *
 * `t` is i18nService.t (or a fake in tests). Missing template placeholders
 * degrade to the raw copy rather than throwing — a tooltip must never break a
 * sidebar render.
 */
export function buildFallbackBrainStatusDetail(input, t) {
  const mark = readMark(input);
  if (!mark) return '';
  const translate = typeof t === 'function' ? t : (key) => key;
  const template = translate('coworkStatusFallbackBrainDetail');
  const from = typeof mark.fromModel === 'string' && mark.fromModel.trim().length > 0
    ? mark.fromModel.trim()
    : translate('coworkStatusFallbackBrainUnknownPrimary');
  const provider = typeof mark.provider === 'string' && mark.provider.trim().length > 0
    ? mark.provider.trim()
    : '';
  const route = provider ? `${mark.model.trim()} (${provider})` : mark.model.trim();
  return String(template)
    .replace('{from}', from)
    .replace('{route}', route);
}

/** True when the row should render the amber degradation dot instead of the plain running glow. */
export function isFallbackBrainStatusActive(input) {
  return resolveFallbackBrainStatusLabelKey(input) !== null;
}
