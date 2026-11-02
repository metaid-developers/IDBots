/**
 * QQ group NAME lookup — optional, whitelist-gated, and never load-bearing.
 *
 * WHAT THE PLATFORM GIVES US, VERIFIED (not assumed):
 *
 *   1. The inbound GROUP message EVENT carries NO group name. The official SDK
 *      `@tencent-connect/qqbot-nodejs@1.0.5` declares
 *      `protocol/types.d.ts → GroupMessageEvent` with exactly
 *      `{ id, content, timestamp, author{member_openid,username,bot},
 *         group_openid, attachments?, mentions?, message_scene?, message_type?,
 *         msg_elements? }`. There is no `group_name`/`groupName` field anywhere
 *      in the SDK's `dist/` tree, and `api/routes.js` defines only message /
 *      file / upload / gateway / interaction paths — no group endpoint at all.
 *      So the message payload alone can never show a name.
 *
 *   2. The OPEN PLATFORM does publish a group-info endpoint:
 *      `GET /v2/groups/{group_openid}/info` → `group_name`, `group_finger_memo`,
 *      `group_class_text`, `group_tags`, `group_member_num`, 30 QPM.
 *      (bot.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_info.get.html)
 *
 *   3. That endpoint is NOT generally available. Its own error table documents
 *      code **11253 「应用无接口访问权限 — 该接口仅白名单机器人可用，请联系平台运营申请权限」**.
 *      An ordinary bot therefore gets 11253 and NO name.
 *
 * CONSEQUENCE FOR THE UI, STATED HONESTLY: the group ID is always shown and is
 * the only reliable identifier. A name is an optional extra that appears ONLY
 * when the lookup returns `ok`; when it returns `forbidden` the settings page
 * says so explicitly instead of pretending a name exists. We never invent,
 * guess, or partially derive a name.
 *
 * SECURITY: this module is read-only against the platform. It cannot allow a
 * group — authorisation lives in `groupAllowlist` and is decided by `qqTrust`.
 * Failure of any kind degrades to "no name", never to a permissive state.
 */

/** Documented endpoint (§2 above). Kept as a template so the id is encoded once. */
export const QQ_GROUP_INFO_PATH = '/v2/groups/{group_openid}/info';

/** Documented "not whitelisted" business code (§3 above). */
export const QQ_GROUP_INFO_FORBIDDEN_CODE = 11253;

/** Client-side timeout; the settings page must not hang on a dead network. */
const DEFAULT_TIMEOUT_MS = 8_000;
/** Refresh the app access token this long before it actually expires. */
const TOKEN_REFRESH_AHEAD_MS = 60_000;

export type QQGroupNameStatus = 'ok' | 'forbidden' | 'unavailable' | 'error';

export interface QQGroupInfoLookupResult {
  status: QQGroupNameStatus;
  /** Present only when `status === 'ok'`. */
  name: string | null;
  /** Safe-to-display explanation; never contains a token or the AppSecret. */
  detail: string | null;
}

export type QQGroupInfoLookup = (groupId: string) => Promise<QQGroupInfoLookupResult>;

export interface QQGroupInfoRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface QQGroupInfoResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type QQGroupInfoFetch = (request: QQGroupInfoRequest) => Promise<QQGroupInfoResponse>;

export const defaultQQGroupInfoFetch: QQGroupInfoFetch = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};

export interface QQGroupInfoLookupOptions {
  /** Live credential reader. Returning null yields `unavailable` (no call). */
  getCredentials: () => { appId: string; appSecret: string } | null;
  fetch?: QQGroupInfoFetch;
  /** `https://bots.qq.com` — token endpoint base. */
  tokenBaseUrl?: string;
  /** `https://api.sgroup.qq.com` — REST base. */
  apiBaseUrl?: string;
  tokenPath?: string;
  timeoutMs?: number;
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBusinessCode(payload: unknown): { code: number | null; message: string | null } {
  if (!payload || typeof payload !== 'object') return { code: null, message: null };
  const record = payload as Record<string, unknown>;
  const code = readNumber(record.code) ?? readNumber(record.err_code) ?? readNumber(record.error_code);
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof record.msg === 'string'
        ? record.msg
        : typeof record.error === 'string'
          ? record.error
          : null;
  return { code, message };
}

/**
 * Build a lookup bound to one bot's credentials.
 *
 * The token is cached in this closure only; it is never logged, never returned
 * to the renderer, and never written to disk.
 */
export function createQQGroupInfoLookup(options: QQGroupInfoLookupOptions): QQGroupInfoLookup {
  const doFetch = options.fetch ?? defaultQQGroupInfoFetch;
  const tokenBaseUrl = options.tokenBaseUrl ?? 'https://bots.qq.com';
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.sgroup.qq.com';
  const tokenPath = options.tokenPath ?? '/app/getAppAccessToken';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  let cached: CachedToken | null = null;
  let inflight: Promise<string | null> | null = null;

  async function fetchToken(appId: string, appSecret: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await doFetch({
        url: `${tokenBaseUrl}${tokenPath}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      if (!data || typeof data.access_token !== 'string' || !data.access_token) return null;
      const expiresIn = readNumber(data.expires_in) ?? 7200;
      cached = {
        token: data.access_token,
        expiresAt: now() + Math.max(60, expiresIn) * 1000 - TOKEN_REFRESH_AHEAD_MS,
      };
      return data.access_token;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function accessToken(appId: string, appSecret: string): Promise<string | null> {
    if (cached && now() < cached.expiresAt) return cached.token;
    if (inflight) return inflight;
    inflight = fetchToken(appId, appSecret).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return async (groupId: string): Promise<QQGroupInfoLookupResult> => {
    const id = (groupId || '').trim();
    if (!id) return { status: 'unavailable', name: null, detail: '群 ID 为空' };

    const credentials = options.getCredentials();
    if (!credentials || !credentials.appId || !credentials.appSecret) {
      return { status: 'unavailable', name: null, detail: '还没连接机器人，查不了群名' };
    }

    const token = await accessToken(credentials.appId, credentials.appSecret);
    if (!token) {
      // Token failure is retryable and unrelated to permissions.
      cached = null;
      return { status: 'error', name: null, detail: '登录状态失效，暂时查不了群名' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await doFetch({
        url: `${apiBaseUrl}${QQ_GROUP_INFO_PATH.replace('{group_openid}', encodeURIComponent(id))}`,
        method: 'GET',
        headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (response.ok) {
        const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
        const name = typeof record?.group_name === 'string' ? record.group_name.trim() : '';
        if (name) return { status: 'ok', name, detail: null };
        // HTTP 200 without a name: the endpoint answered but said nothing useful.
        return { status: 'error', name: null, detail: 'QQ 这次没有返回群名' };
      }

      const { code, message } = readBusinessCode(payload);
      if (code === QQ_GROUP_INFO_FORBIDDEN_CODE || response.status === 403) {
        return {
          status: 'forbidden',
          name: null,
          detail:
            message
              || 'QQ 没有把这个群的群名开放给机器人，只能显示群号',
        };
      }
      // The owner-facing text stays plain; the diagnostics live in the log.
      console.warn(`[QQGroupInfo] group name lookup failed: HTTP ${response.status}, code ${code ?? 'n/a'}`);
      return {
        status: 'error',
        name: null,
        detail: '暂时查不了群名，请稍后再试',
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { status: 'error', name: null, detail: `暂时查不了群名：${detail}` };
    } finally {
      clearTimeout(timer);
    }
  };
}
