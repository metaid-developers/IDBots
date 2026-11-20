import type { AppContext } from '../context.js';
import { HttpError, requireStringField, writeJson, type RequestCtx, type Route } from '../http.js';
import { requireTenant } from './tenantCredit.js';
import type { AgentPushEvent } from '../services/pushProviders.js';
import type { NotificationPreferences } from '../services/pushDelivery.js';

function stringField(body: unknown, field: string, maxLength: number): string {
  const value = requireStringField(body, field);
  if (value.length > maxLength) throw new HttpError(400, 'INVALID_BODY', `${field} exceeds ${maxLength} characters`);
  return value;
}

function optionalVersion(body: unknown, field: string): string | null {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 80) throw new HttpError(400, 'INVALID_BODY', `${field} must be a string of at most 80 characters`);
  return value;
}

async function registerDevice(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  if (app.config.push.provider === 'disabled') throw new HttpError(503, 'PUSH_NOT_CONFIGURED', 'push delivery is not configured');
  const provider = stringField(body, 'provider', 30);
  if (provider !== app.config.push.provider) throw new HttpError(400, 'PUSH_PROVIDER_UNSUPPORTED', 'provider is not enabled on this control plane');
  const platform = stringField(body, 'platform', 20);
  if (platform !== 'android' && platform !== 'ios') throw new HttpError(400, 'INVALID_BODY', 'platform must be android or ios');
  try {
    app.push.register(reqCtx.user!.id, {
      deviceId: stringField(body, 'deviceId', 128),
      installationId: stringField(body, 'installationId', 128),
      platform,
      provider,
      token: stringField(body, 'token', 4096),
      appVersion: optionalVersion(body, 'appVersion'),
      shellVersion: optionalVersion(body, 'shellVersion'),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'DEVICE_ID_CONFLICT') {
      throw new HttpError(409, 'DEVICE_ID_CONFLICT', 'deviceId belongs to another account');
    }
    throw error;
  }
  writeJson(reqCtx.res, 200, { registered: true });
}

async function unregisterDevice(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  app.push.unregister(reqCtx.user!.id, stringField(body, 'deviceId', 128));
  writeJson(reqCtx.res, 200, { registered: false });
}

async function getPreferences(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  writeJson(reqCtx.res, 200, {
    preferences: app.push.preferences(reqCtx.user!.id),
    provider: app.config.push.provider,
  });
}

async function setPreferences(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const input = (body as Record<string, unknown> | null)?.preferences;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'INVALID_BODY', 'preferences must be an object');
  const current = app.push.preferences(reqCtx.user!.id);
  const next = { ...current };
  for (const key of Object.keys(current) as Array<keyof NotificationPreferences>) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== 'boolean') throw new HttpError(400, 'INVALID_BODY', `${key} must be boolean`);
    if (value !== undefined) next[key] = value;
  }
  app.push.setPreferences(reqCtx.user!.id, next);
  writeJson(reqCtx.res, 200, { preferences: next });
}

function notificationEvent(body: unknown): AgentPushEvent {
  const category = stringField(body, 'category', 20);
  if (category !== 'work' && category !== 'action' && category !== 'report' && category !== 'system') {
    throw new HttpError(400, 'INVALID_BODY', 'unknown notification category');
  }
  const priority = stringField(body, 'priority', 20);
  if (priority !== 'normal' && priority !== 'high') throw new HttpError(400, 'INVALID_BODY', 'unknown notification priority');
  return {
    eventId: stringField(body, 'eventId', 200),
    type: stringField(body, 'type', 80),
    category,
    title: stringField(body, 'title', 200),
    body: stringField(body, 'body', 500),
    priority,
  };
}

async function ingestNotification(app: AppContext, reqCtx: RequestCtx, body: unknown, params: Record<string, string>): Promise<void> {
  const auth = requireTenant(app, reqCtx);
  if (auth.tenantId !== params.tenantId) throw new HttpError(401, 'TENANT_UNAUTHORIZED', 'tenant credentials missing or invalid');
  const result = await app.push.ingest(auth.tenantId, notificationEvent(body));
  reqCtx.log('info', 'notification accepted', { tenantId: auth.tenantId, eventId: result.eventId, devices: result.devices, duplicate: result.duplicate });
  writeJson(reqCtx.res, 202, { accepted: true, ...result });
}

export const pushRoutes: Route[] = [
  { method: 'POST', path: '/api/v1/devices/register', auth: true, handler: registerDevice },
  { method: 'POST', path: '/api/v1/devices/unregister', auth: true, handler: unregisterDevice },
  { method: 'GET', path: '/api/v1/notification-preferences', auth: true, handler: getPreferences },
  { method: 'PUT', path: '/api/v1/notification-preferences', auth: true, handler: setPreferences },
  { method: 'POST', path: '/internal/v1/tenants/:tenantId/notifications', skipOriginCheck: true, handler: ingestNotification },
];
