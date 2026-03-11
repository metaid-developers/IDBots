/**
 * Telegram connectivity probe for IM gateway.
 * Validates bot token via getMe with retry and optional proxy.
 * Used by IMGatewayManager for connectivity test; can be unit-tested with mocked axios.
 */

import axios, { type AxiosRequestConfig } from 'axios';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_RETRIES = 3;
const RETRY_DELAY_MS = 500;

export interface TelegramProbeOptions {
  timeoutMs?: number;
  retries?: number;
  /** Optional HTTP(S) proxy URL (e.g. http://127.0.0.1:7890) for restricted networks */
  proxyUrl?: string;
}

/**
 * Parse proxy URL into axios-compatible proxy config.
 * Returns undefined if proxyUrl is empty or invalid.
 */
function parseProxy(proxyUrl: string | undefined): AxiosRequestConfig['proxy'] {
  const u = (proxyUrl || '').trim();
  if (!u) return undefined;
  try {
    const parsed = new URL(u);
    const protocol = parsed.protocol.replace(':', '') as 'http' | 'https';
    const host = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : (protocol === 'https' ? 443 : 80);
    if (!host || isNaN(port)) return undefined;
    return { host, port, protocol };
  } catch {
    return undefined;
  }
}

/**
 * Probe Telegram Bot API with getMe. Trims token, retries on transient failures.
 * @returns Success message including bot username
 * @throws Error with user-friendly message on auth or network failure
 */
export async function probeTelegramAuth(
  botToken: string,
  options: TelegramProbeOptions = {}
): Promise<string> {
  const token = (botToken || '').trim();
  if (!token) {
    throw new Error('Bot token is required');
  }

  const timeoutMs = Math.max(1000, options.timeoutMs ?? 10_000);
  const retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  const proxy = parseProxy(options.proxyUrl);
  const url = `${TELEGRAM_API_BASE}/bot${token}/getMe`;

  const axiosConfig: AxiosRequestConfig = {
    timeout: timeoutMs,
    ...(proxy && { proxy }),
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, axiosConfig);
      const data = response.data as { ok?: boolean; description?: string; result?: { username?: string } };
      if (!data?.ok) {
        const description = data?.description || 'Unknown API error';
        throw new Error(description);
      }
      const username = data.result?.username ? `@${data.result.username}` : 'unknown';
      return `Telegram 鉴权通过（Bot: ${username}）。`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isAxios = lastError && typeof (lastError as any).response !== 'undefined';
      const status = isAxios ? (lastError as any).response?.status : null;
      const apiDescription = isAxios ? (lastError as any).response?.data?.description : null;

      // Do not retry on 4xx (bad token, etc.)
      if (status >= 400 && status < 500) {
        throw new Error(apiDescription || lastError.message);
      }

      // Retry on network errors and 5xx
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      // Last attempt failed: throw with clear message
      if ((lastError as any).code === 'ECONNABORTED' || (lastError as any).message?.includes('timeout')) {
        throw new Error('连接 Telegram API 超时，请检查网络或配置代理后重试。');
      }
      if (
        (lastError as any).code === 'ENOTFOUND' ||
        (lastError as any).code === 'ECONNREFUSED' ||
        (lastError as any).code === 'ENETUNREACH'
      ) {
        throw new Error('无法连接 api.telegram.org，请检查网络或配置代理后重试。');
      }
      throw new Error(apiDescription || lastError.message);
    }
  }

  throw lastError || new Error('Telegram 鉴权失败');
}
