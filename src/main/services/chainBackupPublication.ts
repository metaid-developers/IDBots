import { DEFAULT_MANAPI_BASE_URL } from './manapiPinService';
import { CHAIN_BACKUP_MANIFEST_PATH } from './chainBackupProtocol';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ChainBackupManifestState {
  pinId: string;
  content: string;
}

interface PublicationOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface AddressPin {
  id: string;
  modifyHistory: string[];
}

export class ChainBackupPausedError extends Error {
  readonly code = 'BACKUP_NETWORK_PAUSED';

  constructor(message: string) {
    super(message);
    this.name = 'ChainBackupPausedError';
  }
}

export function isChainBackupNetworkError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/insufficient|mnemonic|invalid|permission|unauthorized|forbidden|user_identity|bot_identity|not supported/.test(message)) {
    return false;
  }
  return /failed to fetch|fetch failed|network|timeout|timed out|aborted|etimedout|econnreset|econnrefused|eai_again|enotfound|socket|408|429|500|502|503|504|rate limit|service unavailable|bad gateway|gateway timeout|indexer error 5|http 5/.test(message);
}

export function computeBackupRetryDelayMs(retryIndex: number): number {
  const base = Math.min(10_000, 1_000 * (2 ** Math.max(0, retryIndex - 1)));
  return Math.floor(base * (0.8 + Math.random() * 0.4));
}

async function fetchJson(url: string, options?: PublicationOptions): Promise<Record<string, unknown>> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new Error(`indexer returned an invalid response (HTTP ${response.status})`);
    }
    if (Number(body.code) !== 1) {
      throw new Error(`indexer error ${String(body.code)}: ${typeof body.message === 'string' ? body.message : 'unknown'}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, options?: PublicationOptions): Promise<string> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`pin content fetch failed: HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function listAddressPins(
  mvcAddress: string,
  path: string,
  size: number,
  options?: PublicationOptions,
): Promise<AddressPin[]> {
  const baseUrl = (options?.baseUrl || DEFAULT_MANAPI_BASE_URL).replace(/\/+$/, '');
  const query = new URLSearchParams({ path, size: String(size) });
  const body = await fetchJson(`${baseUrl}/api/address/pin/list/${encodeURIComponent(mvcAddress)}?${query.toString()}`, options);
  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
  const list = Array.isArray(data.list) ? data.list : [];
  return list.map((raw) => {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const history = Array.isArray(record.modify_history)
      ? record.modify_history.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean)
      : [];
    return { id, modifyHistory: history.length > 0 ? history : [id] };
  }).filter((pin) => pin.id);
}

export async function fetchChainBackupManifestState(input: {
  mvcAddress: string;
  botGlobalMetaId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<ChainBackupManifestState | null> {
  const options = { baseUrl: input.baseUrl, fetchImpl: input.fetchImpl };
  const candidates = await listAddressPins(input.mvcAddress, CHAIN_BACKUP_MANIFEST_PATH, 1, options);
  if (!candidates.length) return null;
  const candidate = candidates[0];
  const pinId = candidate.modifyHistory[candidate.modifyHistory.length - 1] || candidate.id;
  const baseUrl = (input.baseUrl || DEFAULT_MANAPI_BASE_URL).replace(/\/+$/, '');
  const content = await fetchText(`${baseUrl}/content/${encodeURIComponent(pinId)}`, options);
  const manifest = JSON.parse(content) as { bot?: unknown };
  if (manifest.bot !== input.botGlobalMetaId) return null;
  return { pinId, content };
}
