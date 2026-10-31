import type { AppContext } from '../context.js';
import { writeJson, type Route } from '../http.js';
import { quotaFor } from '../services/asr/usage.js';

/**
 * Voice channel REST surface (NEW capability, independent channel doc):
 * a pre-flight quota reading so the PWA can grey out the mic button before
 * opening the WebSocket. Cookie-auth like every other /api/v1 route.
 */
async function quota(app: AppContext, reqCtx: Parameters<Route['handler']>[1]): Promise<void> {
  const now = Date.now();
  const reading = quotaFor(app.db, {
    userId: reqCtx.user!.id,
    now,
    limitSeconds: app.config.asr.dailyLimitMinutes * 60,
    maxSessionSeconds: app.config.asr.maxSessionSeconds,
  });
  writeJson(reqCtx.res, 200, {
    limitMinutes: app.config.asr.dailyLimitMinutes,
    limitSeconds: reading.limitSeconds,
    usedSeconds: Math.round(reading.usedSeconds * 10) / 10,
    remainingSeconds: Math.round(reading.remainingSeconds * 10) / 10,
    dayStartMs: reading.dayStartMs,
    timezone: 'Asia/Shanghai',
    upstream: app.config.asr.upstream,
  });
}

export const asrRoutes: Route[] = [{ method: 'GET', path: '/api/v1/asr/quota', auth: true, handler: quota }];
