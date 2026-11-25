import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import { sha256Hex } from '../crypto.js';
import { HttpError } from '../http.js';
import type { AdminPrincipal } from './auth.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function approvalPayloadHash(action: string, payload: unknown): string {
  return sha256Hex(`${action}:${canonical(payload)}`);
}

export function requestApproval(
  app: AppContext,
  principal: AdminPrincipal,
  action: string,
  payload: unknown,
  reason: string,
): { id: string; status: string; expiresAt: number } {
  if (!['rollout.create', 'rollout.rollback'].includes(action)) throw new HttpError(400, 'INVALID_APPROVAL_ACTION', 'unsupported approval action');
  const id = `ap_${randomUUID().replaceAll('-', '')}`;
  const now = Date.now();
  const expiresAt = now + 10 * 60_000;
  app.db.prepare(`INSERT INTO admin_approvals (id, action, payload_hash, requested_by, status, reason, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .run(id, action, approvalPayloadHash(action, payload), principal.id, reason.slice(0, 500), now, expiresAt);
  app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(now, `admin:${principal.username}`, 'approval.request', id, JSON.stringify({ action, reason }));
  return { id, status: 'pending', expiresAt };
}

export function decideApproval(
  app: AppContext,
  principal: AdminPrincipal,
  id: string,
  decision: 'approved' | 'rejected',
): void {
  const row = app.db.prepare('SELECT * FROM admin_approvals WHERE id = ?').get(id) as {
    requested_by: string;
    status: string;
    expires_at: number;
  } | undefined;
  if (!row || row.status !== 'pending' || row.expires_at <= Date.now()) {
    throw new HttpError(409, 'APPROVAL_NOT_PENDING', 'approval is missing, expired, or already decided');
  }
  if (row.requested_by === principal.id) {
    throw new HttpError(403, 'APPROVAL_SEPARATION_REQUIRED', 'a second administrator must decide the approval');
  }
  app.db.prepare('UPDATE admin_approvals SET status = ?, approved_by = ?, decided_at = ? WHERE id = ?')
    .run(decision, principal.id, Date.now(), id);
  app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), `admin:${principal.username}`, `approval.${decision}`, id, JSON.stringify({}));
}

export function consumeApproval(
  app: AppContext,
  principal: AdminPrincipal,
  id: string,
  action: string,
  payload: unknown,
): void {
  const hash = approvalPayloadHash(action, payload);
  const result = app.db.prepare(`UPDATE admin_approvals SET status = 'consumed', consumed_at = ?
    WHERE id = ? AND action = ? AND payload_hash = ? AND status = 'approved'
      AND expires_at > ? AND approved_by IS NOT NULL AND approved_by <> requested_by`)
    .run(Date.now(), id, action, hash, Date.now());
  if (result.changes !== 1) {
    throw new HttpError(409, 'APPROVAL_INVALID', 'approval is missing, expired, already used, or does not match this action');
  }
  app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), `admin:${principal.username}`, 'approval.consume', id, JSON.stringify({ action }));
}
