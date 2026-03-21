// Keep in sync with P2P_LOCAL_BASE in p2pIndexerService.ts
const LOCAL_BASE = 'http://localhost:7281';

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
  const localUrl = LOCAL_BASE + localPath;

  try {
    const localRes = await fetch(localUrl, {
      ...options,
      signal: AbortSignal.timeout(2000),
    });

    const isEnvelopeHit = !isJsonApiPath(localPath) || await isSuccessfulEnvelope(localRes);
    if (localRes.ok && isEnvelopeHit) {
      console.log(`[p2p-proxy] local hit: ${localPath}`);
      return localRes;
    }

    // Non-2xx response from local node
    const reason = !localRes.ok ? `status ${localRes.status}` : 'code != 1';
    console.log(`[p2p-proxy] fallback: ${localPath} → ${reason}`);
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? '';
    const reason =
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error';
    console.log(`[p2p-proxy] fallback: ${localPath} → ${reason}`);
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
  const localUrl = LOCAL_BASE + localPath;

  try {
    const localRes = await fetch(localUrl, {
      signal: AbortSignal.timeout(2000),
    });

    if (localRes.headers.get('x-man-content-status') === 'metadata-only') {
      console.log(`[p2p-proxy] fallback: ${localPath} → metadata-only`);
      return fetch(fallbackUrl);
    }

    const contentLength = localRes.headers.get('content-length');
    if (localRes.ok && contentLength && parseInt(contentLength, 10) > 0) {
      console.log(`[p2p-proxy] local hit: ${localPath}`);
      return localRes;
    }
    if (localRes.ok && !contentLength) {
      const bodyBytes = await localRes.clone().arrayBuffer();
      if (bodyBytes.byteLength > 0) {
        console.log(`[p2p-proxy] local hit: ${localPath}`);
        return localRes;
      }
    }

    // Empty body or non-2xx
    const reason = !localRes.ok
      ? `status ${localRes.status}`
      : 'empty body';
    console.log(`[p2p-proxy] fallback: ${localPath} → ${reason}`);
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? '';
    const reason =
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error';
    console.log(`[p2p-proxy] fallback: ${localPath} → ${reason}`);
  }

  return fetch(fallbackUrl);
}
