import type { AppContext } from '../context.js';
import { HttpError, requireStringField, writeJson, type RequestCtx, type Route } from '../http.js';
import { maskPhone } from '../crypto.js';
import { findContainerId } from '../services/upgrade.js';
import { listReleases } from '../services/releases.js';
import {
  createAdminUser,
  disableAdminUser,
  listAdminUsers,
  loginAdmin,
  requireAdmin,
  type AdminRole,
} from './auth.js';
import { consumeApproval, decideApproval, requestApproval } from './approvals.js';

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_BODY', 'JSON object body is required');
  return body as Record<string, unknown>;
}

function query(reqCtx: RequestCtx): URLSearchParams {
  return new URL(reqCtx.req?.url ?? '/', 'http://localhost').searchParams;
}

function positiveParam(value: string | null, fallback: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, 'INVALID_QUERY', 'expected a positive integer');
  return Math.min(parsed, maximum);
}

function rolloutManager(app: AppContext) {
  if (!app.rollouts) throw new HttpError(503, 'ROLLOUTS_UNAVAILABLE', 'rollout scheduler is not configured');
  return app.rollouts;
}

async function login(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const input = objectBody(body);
  const result = loginAdmin(app, {
    username: requireStringField(input, 'username'),
    token: requireStringField(input, 'token'),
    mfaCode: requireStringField(input, 'mfaCode'),
    ip: reqCtx.ip,
  });
  const secure = app.config.publicOriginUrl.protocol === 'https:' ? '; Secure' : '';
  reqCtx.res.setHeader(
    'Set-Cookie',
    `idb_admin_session=${encodeURIComponent(result.token)}; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=1800${secure}`,
  );
  writeJson(reqCtx.res, 200, { sessionToken: result.token, expiresAt: result.expiresAt, administrator: result.principal });
}

async function overview(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  const administrator = requireAdmin(app, reqCtx, 'read');
  const grouped = (table: 'tenants' | 'releases' | 'rollout_jobs', column: string): unknown =>
    app.db.prepare(`SELECT ${column} AS name, COUNT(*) AS count FROM ${table} GROUP BY ${column} ORDER BY ${column}`).all();
  writeJson(reqCtx.res, 200, {
    generatedAt: Date.now(),
    administrator,
    tenants: {
      total: (app.db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number }).n,
      byStatus: grouped('tenants', 'status'),
      byKind: grouped('tenants', 'kind'),
      byCohort: grouped('tenants', 'cohort'),
      byImage: grouped('tenants', 'image'),
    },
    releases: grouped('releases', 'status'),
    rollouts: grouped('rollout_jobs', 'status'),
    hosts: app.db.prepare(`SELECT hosts.id, hosts.environment, hosts.capacity, hosts.status,
      (SELECT COUNT(*) FROM tenants WHERE tenants.host_id = hosts.id) AS tenants FROM hosts ORDER BY hosts.id`).all(),
  });
}

async function tenants(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  requireAdmin(app, reqCtx, 'read');
  const params = query(reqCtx);
  const limit = positiveParam(params.get('limit'), 50, 200);
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);
  const conditions: string[] = [];
  const values: string[] = [];
  for (const [key, column] of Object.entries({ status: 'tenants.status', kind: 'tenants.kind', cohort: 'tenants.cohort', environment: 'hosts.environment' })) {
    const value = params.get(key);
    if (value) {
      conditions.push(`${column} = ?`);
      values.push(value);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = app.db.prepare(`SELECT tenants.id, tenants.user_id, tenants.status, tenants.phase,
    tenants.image, tenants.image_digest, tenants.kind, tenants.cohort, tenants.app_version,
    tenants.contract_version, tenants.last_error, tenants.created_at, tenants.updated_at,
    users.display_name, users.phone_e164, hosts.id AS host_id, hosts.environment
    FROM tenants JOIN users ON users.id = tenants.user_id LEFT JOIN hosts ON hosts.id = tenants.host_id
    ${where} ORDER BY tenants.created_at, tenants.id LIMIT ? OFFSET ?`)
    .all(...values, limit, offset) as Array<Record<string, unknown>>;
  writeJson(reqCtx.res, 200, {
    tenants: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      phone: maskPhone(String(row.phone_e164)),
      status: row.status,
      phase: row.phase,
      image: row.image,
      imageDigest: row.image_digest,
      kind: row.kind,
      cohort: row.cohort,
      appVersion: row.app_version,
      contractVersion: row.contract_version,
      lastError: row.last_error,
      host: { id: row.host_id, environment: row.environment },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    limit,
    offset,
  });
}

async function classifyTenant(app: AppContext, reqCtx: RequestCtx, body: unknown, params: Record<string, string>): Promise<void> {
  const administrator = requireAdmin(app, reqCtx, 'tenant.write');
  const input = objectBody(body);
  const kind = input.kind;
  const cohort = input.cohort;
  if (!['customer', 'internal', 'synthetic', 'demo'].includes(String(kind))) throw new HttpError(400, 'INVALID_BODY', 'invalid tenant kind');
  if (!['canary', 'early', 'stable'].includes(String(cohort))) throw new HttpError(400, 'INVALID_BODY', 'invalid tenant cohort');
  const result = app.db.prepare('UPDATE tenants SET kind = ?, cohort = ?, updated_at = ? WHERE id = ?')
    .run(kind, cohort, Date.now(), params.id);
  if (result.changes !== 1) throw new HttpError(404, 'NOT_FOUND', 'tenant not found');
  app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), `admin:${administrator.username}`, 'tenant.classify', params.id, JSON.stringify({ kind, cohort }));
  writeJson(reqCtx.res, 200, { ok: true });
}

async function tenantLifecycle(app: AppContext, reqCtx: RequestCtx, body: unknown, params: Record<string, string>): Promise<void> {
  const administrator = requireAdmin(app, reqCtx, 'tenant.write');
  const action = requireStringField(objectBody(body), 'action');
  if (!['restart', 'stop', 'start'].includes(action)) throw new HttpError(400, 'INVALID_BODY', 'action must be restart, stop, or start');
  const tenant = app.db.prepare('SELECT id, container_name FROM tenants WHERE id = ?').get(params.id) as { id: string; container_name: string } | undefined;
  if (!tenant) throw new HttpError(404, 'NOT_FOUND', 'tenant not found');
  const containerId = await findContainerId(app, tenant.container_name);
  if (!containerId) throw new HttpError(409, 'CONTAINER_MISSING', 'tenant container was not found');
  if (action !== 'start') await app.docker.stopContainer(containerId, 30);
  if (action !== 'stop') await app.docker.startContainer(containerId);
  app.db.prepare('UPDATE tenants SET status = ?, phase = NULL, updated_at = ? WHERE id = ?')
    .run(action === 'stop' ? 'stopped' : 'booting', Date.now(), params.id);
  app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), `admin:${administrator.username}`, `tenant.${action}`, params.id, JSON.stringify({}));
  writeJson(reqCtx.res, 200, { ok: true });
}

async function releases(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  requireAdmin(app, reqCtx, 'read');
  writeJson(reqCtx.res, 200, { releases: listReleases(app.db) });
}

async function rollouts(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  requireAdmin(app, reqCtx, 'read');
  writeJson(reqCtx.res, 200, { rollouts: await rolloutManager(app).store.listJobs(positiveParam(query(reqCtx).get('limit'), 50, 200)) });
}

async function rollout(app: AppContext, reqCtx: RequestCtx, _body: unknown, params: Record<string, string>): Promise<void> {
  requireAdmin(app, reqCtx, 'read');
  const view = await rolloutManager(app).store.getJob(params.id);
  if (!view) throw new HttpError(404, 'NOT_FOUND', 'rollout not found');
  writeJson(reqCtx.res, 200, view);
}

async function createRollout(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const administrator = requireAdmin(app, reqCtx, 'rollout.write');
  const input = objectBody(body);
  const approvalId = requireStringField(input, 'approvalId');
  const mode = input.mode === 'rollback' ? 'rollback' : 'upgrade';
  const payload = {
    releaseId: requireStringField(input, 'releaseId'),
    mode,
    tenantIds: Array.isArray(input.tenantIds) ? input.tenantIds.map(String).sort() : undefined,
    kind: input.kind ?? undefined,
    cohort: input.cohort ?? undefined,
    environment: input.environment ?? undefined,
    globalConcurrency: input.globalConcurrency ?? 20,
    perHostConcurrency: input.perHostConcurrency ?? 1,
  };
  consumeApproval(app, administrator, approvalId, mode === 'rollback' ? 'rollout.rollback' : 'rollout.create', payload);
  const view = await rolloutManager(app).create({
    releaseId: payload.releaseId,
    operator: administrator.username,
    mode,
    tenantIds: payload.tenantIds,
    kind: payload.kind as 'customer' | undefined,
    cohort: payload.cohort as 'stable' | undefined,
    environment: payload.environment as 'production' | undefined,
    globalConcurrency: Number(payload.globalConcurrency),
    perHostConcurrency: Number(payload.perHostConcurrency),
  });
  writeJson(reqCtx.res, 201, view);
}

async function rolloutAction(app: AppContext, reqCtx: RequestCtx, body: unknown, params: Record<string, string>): Promise<void> {
  requireAdmin(app, reqCtx, 'rollout.write');
  const action = requireStringField(objectBody(body), 'action');
  const manager = rolloutManager(app);
  if (action === 'start' || action === 'resume') await manager.resume(params.id);
  else if (action === 'pause') await manager.pause(params.id);
  else if (action === 'retry') await manager.retryFailed(params.id);
  else if (action === 'cancel') await manager.cancel(params.id);
  else throw new HttpError(400, 'INVALID_BODY', 'unsupported rollout action');
  writeJson(reqCtx.res, 200, { ok: true });
}

async function approvals(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  requireAdmin(app, reqCtx, 'read');
  writeJson(reqCtx.res, 200, {
    approvals: app.db.prepare(`SELECT ap.id, ap.action, ap.status, ap.reason, ap.created_at, ap.expires_at,
      ap.decided_at, requester.username AS requested_by, approver.username AS approved_by
      FROM admin_approvals ap JOIN admin_users requester ON requester.id = ap.requested_by
      LEFT JOIN admin_users approver ON approver.id = ap.approved_by
      ORDER BY ap.created_at DESC LIMIT 200`).all(),
  });
}

async function request(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const administrator = requireAdmin(app, reqCtx, 'approvals.write');
  const input = objectBody(body);
  const result = requestApproval(
    app,
    administrator,
    requireStringField(input, 'action'),
    input.payload,
    typeof input.reason === 'string' ? input.reason : '',
  );
  writeJson(reqCtx.res, 201, result);
}

async function decide(app: AppContext, reqCtx: RequestCtx, body: unknown, params: Record<string, string>): Promise<void> {
  const administrator = requireAdmin(app, reqCtx, 'approvals.write');
  const decision = requireStringField(objectBody(body), 'decision');
  if (decision !== 'approved' && decision !== 'rejected') throw new HttpError(400, 'INVALID_BODY', 'decision must be approved or rejected');
  decideApproval(app, administrator, params.id, decision);
  writeJson(reqCtx.res, 200, { ok: true });
}

async function adminUsers(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  requireAdmin(app, reqCtx, 'admins.write');
  writeJson(reqCtx.res, 200, { administrators: listAdminUsers(app.db) });
}

async function createUser(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const administrator = requireAdmin(app, reqCtx, 'admins.write');
  const input = objectBody(body);
  const result = createAdminUser(app.db, app.config.masterKey, {
    username: requireStringField(input, 'username'),
    role: requireStringField(input, 'role') as AdminRole,
  }, administrator.username);
  writeJson(reqCtx.res, 201, result);
}

async function disableUser(app: AppContext, reqCtx: RequestCtx, _body: unknown, params: Record<string, string>): Promise<void> {
  const administrator = requireAdmin(app, reqCtx, 'admins.write');
  disableAdminUser(app.db, params.id, administrator.username);
  writeJson(reqCtx.res, 200, { ok: true });
}

async function audit(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  requireAdmin(app, reqCtx, 'audit.read');
  const params = query(reqCtx);
  const limit = positiveParam(params.get('limit'), 100, 500);
  const target = params.get('target');
  const rows = app.db.prepare(`SELECT id, at, actor, action, target, detail_json FROM audit_log
    ${target ? 'WHERE target = ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(target ? [target, limit] : [limit])) as Array<Record<string, unknown>>;
  writeJson(reqCtx.res, 200, {
    entries: rows.map((row) => ({
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      target: row.target,
      detail: row.detail_json ? JSON.parse(String(row.detail_json)) : null,
    })),
  });
}

export const adminRoutes: Route[] = [
  { method: 'POST', path: '/api/v1/admin/session', handler: login },
  { method: 'GET', path: '/api/v1/admin/overview', handler: overview },
  { method: 'GET', path: '/api/v1/admin/tenants', handler: tenants },
  { method: 'POST', path: '/api/v1/admin/tenants/:id/classify', handler: classifyTenant },
  { method: 'POST', path: '/api/v1/admin/tenants/:id/lifecycle', handler: tenantLifecycle },
  { method: 'GET', path: '/api/v1/admin/releases', handler: releases },
  { method: 'GET', path: '/api/v1/admin/rollouts', handler: rollouts },
  { method: 'POST', path: '/api/v1/admin/rollouts', handler: createRollout },
  { method: 'GET', path: '/api/v1/admin/rollouts/:id', handler: rollout },
  { method: 'POST', path: '/api/v1/admin/rollouts/:id/actions', handler: rolloutAction },
  { method: 'GET', path: '/api/v1/admin/approvals', handler: approvals },
  { method: 'POST', path: '/api/v1/admin/approvals', handler: request },
  { method: 'POST', path: '/api/v1/admin/approvals/:id/decision', handler: decide },
  { method: 'GET', path: '/api/v1/admin/users', handler: adminUsers },
  { method: 'POST', path: '/api/v1/admin/users', handler: createUser },
  { method: 'POST', path: '/api/v1/admin/users/:id/disable', handler: disableUser },
  { method: 'GET', path: '/api/v1/admin/audit', handler: audit },
];
