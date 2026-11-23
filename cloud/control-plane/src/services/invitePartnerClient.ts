import type { ControlPlaneConfig } from '../config.js';
import { HttpError } from '../http.js';

/**
 * Server-to-server HTTP client for the assist-base-service (ABS) invite module.
 * All partner endpoints authenticate with `Authorization: Bearer <CP_INVITE_API_TOKEN>`.
 */

export interface InvitePublicPreview {
  valid: boolean;
  reasonCode?: string;
  code: string;
  planId: string;
  planName: string;
  planNameEn: string;
  periodDays: number;
  dailyCapFull: boolean;
}

export interface PartnerPrecheckResponse {
  allowed: boolean;
  reasonCode?: string;
  code: string;
  planId: string;
  planName: string;
  planNameEn: string;
  periodDays: number;
  remainingToday: number;
}

export interface PartnerConsumeRequest {
  code: string;
  cpUserId: string;
  cpTenantId: string;
  phoneMasked: string;
}

export interface PartnerConsumeResponse {
  allowed: boolean;
  alreadyActivated?: boolean;
  reasonCode?: string;
  redemptionId?: string;
  grantTicket?: string;
  code: string;
  planId: string;
  planName: string;
  planNameEn: string;
  periodDays: number;
}

export interface PartnerTenantTrialStatusItem {
  cpUserId: string;
  cpTenantId?: string;
  redemptionStatus: number;
  identityAddress?: string;
  subscriptionActive: boolean;
  planId?: string;
  sourceType?: string;
  periodEnd: number;
}

interface AbsEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

export function normalizeInviteCodeInput(raw: string): string {
  const s = raw
    .trim()
    .toUpperCase()
    .replace(/[\s\t\r\n]+/g, '')
    .replace(/[—–]/g, '-');
  if (!s) return '';
  if (s.startsWith('IDB') && !s.startsWith('IDB-') && s.length >= 7 && s.length <= 15) {
    const rest = s.slice(3);
    if (/^[A-Z0-9]+$/.test(rest)) {
      return `IDB-${rest}`;
    }
  }
  return s;
}

export function mapInviteReasonToHttpError(reasonCode: string | undefined): HttpError {
  switch (reasonCode) {
    case 'INVITE_DAILY_CAP_FULL':
      return new HttpError(
        429,
        'INVITE_DAILY_CAP_FULL',
        'daily cloud signup capacity is full; your invite code stays valid, please try again tomorrow',
      );
    case 'INVITE_CODE_EXHAUSTED':
      return new HttpError(403, 'INVITE_EXHAUSTED', 'invite code has no uses left');
    case 'INVITE_INVALID_CODE':
    case 'INVITE_CODE_DISABLED':
    case 'INVITE_CODE_EXPIRED':
    default:
      return new HttpError(403, 'INVITE_INVALID', 'invite code is not valid');
  }
}

async function requestAbs<T>(
  config: ControlPlaneConfig,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; partnerAuth?: boolean },
): Promise<T> {
  const baseUrl = config.inviteService.baseUrl;
  if (!baseUrl) {
    throw new HttpError(503, 'INVITE_SERVICE_UNCONFIGURED', 'invite service is not configured');
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.partnerAuth) {
    if (!config.inviteService.token) {
      throw new HttpError(503, 'INVITE_SERVICE_UNCONFIGURED', 'invite service token is missing');
    }
    headers.Authorization = `Bearer ${config.inviteService.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new HttpError(
      502,
      'INVITE_UPSTREAM_ERROR',
      `invite service unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let envelope: AbsEnvelope<T> | null = null;
  try {
    envelope = (await res.json()) as AbsEnvelope<T>;
  } catch {
    envelope = null;
  }

  if (!res.ok || !envelope || envelope.code !== 0 || envelope.data === undefined) {
    const detail = envelope?.message ?? `HTTP_${res.status}`;
    throw new HttpError(502, 'INVITE_UPSTREAM_ERROR', `invite service error: ${detail}`);
  }
  return envelope.data;
}

export async function fetchInvitePublicPreview(
  config: ControlPlaneConfig,
  rawCode: string,
): Promise<InvitePublicPreview> {
  const code = normalizeInviteCodeInput(rawCode);
  return requestAbs<InvitePublicPreview>(
    config,
    `/v1/me/invite/public/${encodeURIComponent(code)}`,
    { method: 'GET', partnerAuth: false },
  );
}

export async function precheckPartnerInvite(
  config: ControlPlaneConfig,
  rawCode: string,
): Promise<PartnerPrecheckResponse> {
  const code = normalizeInviteCodeInput(rawCode);
  return requestAbs<PartnerPrecheckResponse>(config, '/v1/me/invite/partner/precheck', {
    method: 'POST',
    body: { code },
    partnerAuth: true,
  });
}

export async function consumePartnerInvite(
  config: ControlPlaneConfig,
  input: PartnerConsumeRequest,
): Promise<PartnerConsumeResponse> {
  return requestAbs<PartnerConsumeResponse>(config, '/v1/me/invite/partner/consume', {
    method: 'POST',
    body: {
      ...input,
      code: normalizeInviteCodeInput(input.code),
    },
    partnerAuth: true,
  });
}

export async function queryPartnerTenantTrialStatus(
  config: ControlPlaneConfig,
  cpUserIds: string[],
): Promise<PartnerTenantTrialStatusItem[]> {
  if (cpUserIds.length === 0) return [];
  const data = await requestAbs<{ items?: PartnerTenantTrialStatusItem[] }>(
    config,
    '/v1/me/invite/partner/tenant-trial-status',
    {
      method: 'POST',
      body: { cpUserIds },
      partnerAuth: true,
    },
  );
  return Array.isArray(data.items) ? data.items : [];
}
