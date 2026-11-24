import type { AppContext } from '../context.js';
import { decryptSecret } from '../crypto.js';

export interface InviteGrantRow {
  user_id: string;
  tenant_id: string;
  code: string;
  redemption_id: string | null;
  grant_ticket_enc: string | null;
  plan_id: string;
  plan_name: string | null;
  plan_name_en: string | null;
  period_days: number;
  trial_ends_at: number | null;
  claimed_at: number | null;
  claim_attempts: number;
  last_claim_error: string | null;
  hibernated_at: number | null;
  woken_at: number | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PendingInviteGrant {
  pending: true;
  code: string;
  redemptionId: string | null;
  grantTicket: string;
  planId: string;
  planName: string | null;
  planNameEn: string | null;
  periodDays: number;
}

export function getPendingInviteGrantForUser(
  app: Pick<AppContext, 'config' | 'db'>,
  userId: string,
): PendingInviteGrant | { pending: false } {
  const row = app.db
    .prepare('SELECT * FROM invite_grants WHERE user_id = ?')
    .get(userId) as InviteGrantRow | undefined;
  if (!row || row.claimed_at !== null || !row.grant_ticket_enc) {
    return { pending: false };
  }
  const grantTicket = decryptSecret(app.config.masterKey, row.grant_ticket_enc);
  return {
    pending: true,
    code: row.code,
    redemptionId: row.redemption_id,
    grantTicket,
    planId: row.plan_id,
    planName: row.plan_name,
    planNameEn: row.plan_name_en,
    periodDays: row.period_days,
  };
}

export function recordInviteGrantClaimResult(
  app: Pick<AppContext, 'db'>,
  input: {
    userId: string;
    ok: boolean;
    periodEnd?: number | null;
    planId?: string | null;
    error?: string | null;
    now?: number;
  },
): { claimed: boolean; claimAttempts: number } {
  const now = input.now ?? Date.now();
  const row = app.db
    .prepare('SELECT * FROM invite_grants WHERE user_id = ?')
    .get(input.userId) as InviteGrantRow | undefined;
  if (!row) {
    return { claimed: false, claimAttempts: 0 };
  }
  if (input.ok) {
    const nextTrialEnds =
      typeof input.periodEnd === 'number' && Number.isFinite(input.periodEnd) && input.periodEnd > 0
        ? Math.trunc(input.periodEnd)
        : row.trial_ends_at;
    const nextPlanId = input.planId?.trim() || row.plan_id;
    app.db
      .prepare(
        `UPDATE invite_grants
         SET claimed_at = COALESCE(claimed_at, ?),
             grant_ticket_enc = NULL,
             plan_id = ?,
             trial_ends_at = ?,
             last_claim_error = NULL,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(now, nextPlanId, nextTrialEnds, now, input.userId);
    return { claimed: true, claimAttempts: row.claim_attempts };
  }

  const nextAttempts = row.claim_attempts + 1;
  const errText = (input.error ?? 'claim failed').slice(0, 512);
  app.db
    .prepare(
      `UPDATE invite_grants
       SET claim_attempts = ?,
           last_claim_error = ?,
           updated_at = ?
       WHERE user_id = ?`,
    )
    .run(nextAttempts, errText, now, input.userId);
  return { claimed: false, claimAttempts: nextAttempts };
}
