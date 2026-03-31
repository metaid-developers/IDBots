import { getP2PLocalBase } from './p2pLocalEndpoint';

function isJsonApiPath(localPath: string): boolean {
  return localPath.startsWith('/api/');
}

async function isSuccessfulEnvelope(localRes: Response): Promise<boolean> {
  try {
    const json = await localRes.clone().json() as { code?: unknown };
    return json?.code === 1;
  } catch {
    return false;
  }
}

async function parseJsonClone(localRes: Response): Promise<unknown> {
  try {
    return await localRes.clone().json();
  } catch {
    return undefined;
  }
}

export function isEmptyListDataPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return true;
  }
  const list = (data as { list?: unknown }).list;
  if (!Array.isArray(list)) {
    return true;
  }
  return list.length === 0;
}

/**
 * Try to fetch from the local P2P indexer first; fall back to a remote URL
 * if the local node is unavailable, returns a non-2xx status, or times out.
 *
 * @param localPath   Path starting with '/', e.g. '/api/pin/abc'
 * @param fallbackUrl Full remote URL to use when local is unavailable
 * @param options     Optional RequestInit forwarded to both fetch calls
 */
export async function fetchFromLocalOrFallback(
  localPath: string,
  fallbackUrl: string,
  options?: RequestInit,
): Promise<Response> {
  const localUrl = getP2PLocalBase() + localPath;

  try {
    const localRes = await fetch(localUrl, {
      ...options,
      signal: AbortSignal.timeout(2000),
    });

    const isEnvelopeHit = !isJsonApiPath(localPath) || await isSuccessfulEnvelope(localRes);
    if (localRes.ok && isEnvelopeHit) {
      return localRes;
    }

  } catch (_err: unknown) {
    void _err;
  }

  return fetch(fallbackUrl, options);
}

export async function fetchJsonWithFallbackOnMiss(
  localPath: string,
  fallbackUrl: string,
  isSemanticMiss: (payload: unknown) => boolean,
  options?: RequestInit,
): Promise<Response> {
  const localUrl = getP2PLocalBase() + localPath;

  try {
    const localRes = await fetch(localUrl, {
      ...options,
      signal: AbortSignal.timeout(2000),
    });

    const payload = await parseJsonClone(localRes);
    const isEnvelopeHit = !isJsonApiPath(localPath) || (payload as { code?: unknown } | undefined)?.code === 1;

    if (localRes.ok && isEnvelopeHit && !isSemanticMiss(payload)) {
      return localRes;
    }
  } catch (_err: unknown) {
    void _err;
  }

  return fetch(fallbackUrl, options);
}

/**
 * Fetch content for a pin from the local P2P indexer, falling back to a remote
 * URL when the local response is absent, has an empty body, or errors out.
 *
 * Body emptiness is determined via the Content-Length response header only —
 * the response stream is never consumed so the caller always receives a fresh
 * readable body.
 *
 * @param pinId       The pin identifier (appended to /content/)
 * @param fallbackUrl Full remote URL to use when local content is unavailable
 */
export async function fetchContentWithFallback(
  pinId: string,
  fallbackUrl: string,
): Promise<Response> {
  const localPath = `/content/${pinId}`;
  const localUrl = getP2PLocalBase() + localPath;

  try {
    const localRes = await fetch(localUrl, {
      signal: AbortSignal.timeout(2000),
    });

    if (localRes.headers.get('x-man-content-status') === 'metadata-only') {
      return fetch(fallbackUrl);
    }

    const contentLength = localRes.headers.get('content-length');
    if (localRes.ok && contentLength && parseInt(contentLength, 10) > 0) {
      return localRes;
    }
    if (localRes.ok && !contentLength) {
      const bodyBytes = await localRes.clone().arrayBuffer();
      if (bodyBytes.byteLength > 0) {
        return localRes;
      }
    }
  } catch (_err: unknown) {
    void _err;
  }

  return fetch(fallbackUrl);
}
