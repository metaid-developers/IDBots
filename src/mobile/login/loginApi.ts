import { MOCK_LOGIN_API } from '../buildFlags';

/**
 * Login API seam (C3 control-plane auth endpoints + additive invite preview).
 *
 * The page talks ONLY to these functions. Under `VITE_MOBILE_MOCK=1`
 * (`pnpm dev:mobile`) the functions below serve the REQ-E-8 demo mocks; any
 * other build hits the real C3 endpoints per 01-interface-contracts.md and
 * CR-WSE-005-mobile-invite-system.md:
 * `GET /api/v1/auth/invite/preview`, `POST /api/v1/auth/sms/send`,
 * `POST /api/v1/auth/sms/verify`, `GET /api/v1/me`,
 * `POST /api/v1/auth/logout`, and `POST /api/v1/account/deletion-request`.
 *
 * Logging never includes the phone number, the SMS code, the invite code, or
 * the display name (SEC-12).
 */

export interface LoginUser {
  id: string;
  phoneMasked: string;
  createdAt: number;
  locale: 'zh' | 'en';
}

export interface LoginTenant {
  status:
    | 'provisioning'
    | 'booting'
    | 'onboarding'
    | 'ready'
    | 'degraded'
    | 'upgrading'
    | 'stopped'
    | 'failed'
    | 'suspended';
  phase: string | null;
  appVersion: string | null;
  contractVersion: string | null;
  error: string | null;
}

export interface SendCodeResult {
  resendAfterSec: number;
}

export interface SendCodeOptions {
  inviteCode?: string;
}

export interface InvitePreviewResult {
  valid: boolean;
  code: string;
  reasonCode?: string;
  planId?: string;
  planName?: string;
  planNameEn?: string;
  periodDays?: number;
  dailyCapFull?: boolean;
  registrationEnabled?: boolean;
}

export interface VerifyCodeResult {
  user: LoginUser;
  tenant: LoginTenant;
}

/** C3 `sms/verify` extras: invite-only sign-up and the on-chain display name. */
export interface VerifyCodeOptions {
  inviteCode?: string;
  displayName?: string;
}

export interface GetMeResult {
  user: LoginUser;
  tenant: LoginTenant;
}

export interface LogoutResult {
  success: boolean;
}

export interface AccountDeletionResult {
  success: boolean;
}

/** C3 error body: `{"error":{"code":"…","message":"…"}}`. */
interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

function errorWithCode(code: string): Error & { code: string } {
  const error = new Error(`loginApi: ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

/** Maps a C3 error response to a page-dispatchable error code. */
async function responseError(response: Response): Promise<Error & { code: string }> {
  let code = '';
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (typeof body?.error?.code === 'string' && body.error.code) {
      code = body.error.code;
    }
  } catch {
    // Non-JSON error body: fall through to the status-derived code.
  }
  if (!code && response.status === 401) {
    code = 'UNAUTHORIZED';
  }
  if (!code) {
    code = `HTTP_${response.status}`;
  }
  return errorWithCode(code);
}

async function requestJson<T>(
  path: string,
  init?: { method?: string; jsonBody?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    method: init?.method ?? 'GET',
    ...(init?.jsonBody !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.jsonBody) }
      : {}),
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Real C3 implementation.
// ---------------------------------------------------------------------------

/** Additive `GET /api/v1/auth/invite/preview?code=...` (CR-WSE-005). */
export async function previewInvite(code: string): Promise<InvitePreviewResult> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) {
    return { valid: false, code: '' };
  }
  if (MOCK_LOGIN_API) {
    return mockPreviewInvite(normalized);
  }
  console.info('[loginApi] previewInvite');
  return requestJson<InvitePreviewResult>(
    `/api/v1/auth/invite/preview?code=${encodeURIComponent(normalized)}`,
  );
}

/**
 * C3 `POST /api/v1/auth/sms/send` with `{ phone, purpose: 'login', inviteCode? }`.
 * When `inviteCode` is omitted, the exact `{ phone, purpose }` body is sent.
 */
export async function sendCode(
  phone: string,
  purpose = 'login',
  options?: SendCodeOptions,
): Promise<SendCodeResult> {
  const inviteCode = options?.inviteCode?.trim();
  if (MOCK_LOGIN_API) {
    return mockSendCode(phone, purpose, inviteCode);
  }
  console.info('[loginApi] sendCode', {
    purpose,
    ...(inviteCode ? { hasInviteCode: true } : {}),
  });
  if (!/^\+86\d{11}$/.test(phone)) {
    throw errorWithCode('INVALID_PHONE');
  }
  return requestJson<SendCodeResult>('/api/v1/auth/sms/send', {
    method: 'POST',
    jsonBody: inviteCode ? { phone, purpose, inviteCode } : { phone, purpose },
  });
}

/**
 * C3 `POST /api/v1/auth/sms/verify` with
 * `{ phone, code, inviteCode?, displayName? }`. Success sets the
 * `idb_session` cookie; error codes pass through verbatim.
 */
export async function verifyCode(
  phone: string,
  code: string,
  options?: VerifyCodeOptions,
): Promise<VerifyCodeResult> {
  if (MOCK_LOGIN_API) {
    return mockVerifyCode(phone, code, options);
  }
  const inviteCode = options?.inviteCode;
  const displayName = options?.displayName;
  console.info('[loginApi] verifyCode', {
    hasInviteCode: Boolean(inviteCode),
    hasDisplayName: Boolean(displayName),
  });
  if (!code) {
    throw errorWithCode('CODE_INVALID');
  }
  return requestJson<VerifyCodeResult>('/api/v1/auth/sms/verify', {
    method: 'POST',
    jsonBody: {
      phone,
      code,
      ...(inviteCode !== undefined ? { inviteCode } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    },
  });
}

/** C3 `GET /api/v1/me` (session cookie). */
export async function getMe(): Promise<GetMeResult> {
  if (MOCK_LOGIN_API) {
    return mockGetMe();
  }
  console.info('[loginApi] getMe');
  return requestJson<GetMeResult>('/api/v1/me');
}

/** C3 `POST /api/v1/auth/logout` (204, cookie cleared). */
export async function logout(): Promise<LogoutResult> {
  if (MOCK_LOGIN_API) {
    return mockLogout();
  }
  console.info('[loginApi] logout');
  const response = await fetch('/api/v1/auth/logout', {
    credentials: 'same-origin',
    method: 'POST',
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return { success: true };
}

/**
 * C3 `POST /api/v1/account/deletion-request` (`{ reason? }` ->
 * `202 { requestId }`; the control plane keeps the account in a
 * pending-deletion grace period server-side).
 */
export async function requestAccountDeletion(reason?: string): Promise<AccountDeletionResult> {
  if (MOCK_LOGIN_API) {
    return mockRequestAccountDeletion(reason);
  }
  const trimmed = reason?.trim();
  console.info('[loginApi] requestAccountDeletion', { hasReason: Boolean(trimmed) });
  await requestJson<{ requestId: string }>('/api/v1/account/deletion-request', {
    method: 'POST',
    jsonBody: trimmed ? { reason: trimmed } : {},
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// REQ-E-8 demo mocks, active only under VITE_MOBILE_MOCK=1.
// ---------------------------------------------------------------------------

const MOCK_LATENCY_MS = 300;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MOCK_SESSION_STORAGE_KEY = 'idbots.mockLoginSession';

function readMockSession(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(MOCK_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeMockSession(phone: string | null): void {
  mockSessionPhone = phone;
  if (typeof window === 'undefined') return;
  try {
    if (phone) window.sessionStorage.setItem(MOCK_SESSION_STORAGE_KEY, phone);
    else window.sessionStorage.removeItem(MOCK_SESSION_STORAGE_KEY);
  } catch {
    return;
  }
}

const verifiedPhones = new Set<string>();
let mockSessionPhone: string | null = readMockSession();
let mockMePollCount = 0;

async function mockPreviewInvite(normalized: string): Promise<InvitePreviewResult> {
  console.info('[loginApi] previewInvite called (mock)');
  await wait(120);
  if (normalized === 'BAD') {
    return {
      valid: false,
      code: normalized,
      reasonCode: 'INVITE_INVALID_CODE',
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
      dailyCapFull: false,
      registrationEnabled: true,
    };
  }
  if (normalized === 'FULL') {
    return {
      valid: false,
      code: normalized,
      reasonCode: 'INVITE_CODE_EXHAUSTED',
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
      dailyCapFull: false,
      registrationEnabled: true,
    };
  }
  if (normalized === 'OFF') {
    return {
      valid: false,
      code: normalized,
      reasonCode: 'INVITE_DISABLED',
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
      dailyCapFull: false,
      registrationEnabled: false,
    };
  }
  if (normalized === 'CAPFULL') {
    return {
      valid: false,
      code: normalized,
      reasonCode: 'INVITE_DAILY_CAP_FULL',
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
      dailyCapFull: true,
      registrationEnabled: true,
    };
  }
  return {
    valid: true,
    code: normalized,
    planId: 'me_pro',
    planName: 'ID.Student',
    planNameEn: 'ID.Student',
    periodDays: 14,
    dailyCapFull: false,
    registrationEnabled: true,
  };
}

function validateMockInviteCode(inviteCode: string): void {
  const upper = inviteCode.trim().toUpperCase();
  if (upper === 'FULL') {
    throw errorWithCode('INVITE_EXHAUSTED');
  }
  if (upper === 'BAD') {
    throw errorWithCode('INVITE_INVALID');
  }
  if (upper === 'CAPFULL') {
    throw errorWithCode('INVITE_DAILY_CAP_FULL');
  }
  if (upper === 'OFF') {
    throw errorWithCode('INVITE_DISABLED');
  }
}

async function mockSendCode(
  phone: string,
  purpose: string,
  inviteCode?: string,
): Promise<SendCodeResult> {
  console.info('[loginApi] sendCode called (mock)', {
    purpose,
    ...(inviteCode ? { hasInviteCode: true } : {}),
  });
  await wait(MOCK_LATENCY_MS);
  if (!/^\+86\d{11}$/.test(phone)) {
    throw errorWithCode('INVALID_PHONE');
  }
  if (inviteCode && !verifiedPhones.has(phone)) {
    validateMockInviteCode(inviteCode);
  }
  return { resendAfterSec: 60 };
}

async function mockVerifyCode(
  phone: string,
  code: string,
  options?: VerifyCodeOptions,
): Promise<VerifyCodeResult> {
  const inviteCode = options?.inviteCode;
  const displayName = options?.displayName;
  console.info('[loginApi] verifyCode called (mock)', {
    hasInviteCode: Boolean(inviteCode),
    hasDisplayName: Boolean(displayName),
  });
  await wait(MOCK_LATENCY_MS);
  if (!code) {
    throw errorWithCode('CODE_INVALID');
  }
  if (code === '000000') {
    throw errorWithCode('CODE_EXPIRED');
  }
  const isReturningPhone = verifiedPhones.has(phone);
  if (!isReturningPhone && !inviteCode) {
    throw errorWithCode('INVITE_REQUIRED');
  }
  if (inviteCode) {
    validateMockInviteCode(inviteCode);
  }
  verifiedPhones.add(phone);
  writeMockSession(phone);
  mockMePollCount = 0;
  return {
    user: {
      id: 'mock-user',
      phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
      createdAt: Date.now(),
      locale: 'zh',
    },
    tenant: {
      status: 'provisioning',
      phase: null,
      appVersion: null,
      contractVersion: null,
      error: null,
    },
  };
}

const TENANT_PROGRESSION: LoginTenant['status'][] = [
  'provisioning',
  'provisioning',
  'booting',
  'booting',
  'onboarding',
  'onboarding',
];

const TENANT_PHASE: Partial<Record<LoginTenant['status'], string>> = {
  booting: 'starting-services',
  onboarding: 'initializing-workspace',
};

async function mockGetMe(): Promise<GetMeResult> {
  console.info('[loginApi] getMe called (mock)');
  await wait(MOCK_LATENCY_MS);
  if (!mockSessionPhone) {
    throw errorWithCode('UNAUTHORIZED');
  }
  mockMePollCount += 1;
  const status = TENANT_PROGRESSION[mockMePollCount - 1] ?? 'ready';
  return {
    user: {
      id: 'mock-user',
      phoneMasked: `${mockSessionPhone.slice(0, 3)}****${mockSessionPhone.slice(-4)}`,
      createdAt: Date.now(),
      locale: 'zh',
    },
    tenant: {
      status,
      phase: TENANT_PHASE[status] ?? null,
      appVersion: null,
      contractVersion: null,
      error: null,
    },
  };
}

/** Clears the mock session and resets the tenant progression. */
async function mockLogout(): Promise<LogoutResult> {
  console.info('[loginApi] logout called (mock)');
  await wait(MOCK_LATENCY_MS);
  writeMockSession(null);
  mockMePollCount = 0;
  return { success: true };
}

async function mockRequestAccountDeletion(reason?: string): Promise<AccountDeletionResult> {
  console.info('[loginApi] requestAccountDeletion called (mock)', {
    hasReason: Boolean(reason && reason.trim()),
  });
  await wait(MOCK_LATENCY_MS);
  if (!mockSessionPhone) {
    throw errorWithCode('UNAUTHORIZED');
  }
  writeMockSession(null);
  mockMePollCount = 0;
  return { success: true };
}
