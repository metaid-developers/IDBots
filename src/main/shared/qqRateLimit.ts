/**
 * QQ group rate-limit constants shared by the main process and the renderer.
 *
 * Kept dependency-free and outside `src/main/im` so the settings page can show
 * the REAL numbers instead of a hand-copied sentence that silently goes stale
 * when a guard is tuned. The per-minute values are hard-coded by design; only
 * the daily budget is configurable (see `QQConfig.dailyReplyLimit`).
 */

/** Per-sender budget inside one group, per rolling minute. */
export const QQ_RATE_SENDER_PER_MINUTE = 3;
/** Whole-group budget, per rolling minute. */
export const QQ_RATE_GROUP_PER_MINUTE = 10;
/** Rolling window for both per-minute rules. */
export const QQ_RATE_WINDOW_MS = 60_000;
/** Default daily budget for admitted group messages. Configurable in settings. */
export const QQ_DAILY_REPLY_LIMIT_DEFAULT = 500;
/** Guard rails for the configurable daily value. */
export const QQ_DAILY_REPLY_LIMIT_MIN = 1;
export const QQ_DAILY_REPLY_LIMIT_MAX = 100_000;
