import { getConfiguredP2PLocalBase } from './p2pLocalEndpoint';

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
 * Bound the remote fallback so a blackholed route cannot hang a read; without
 * this the fetch runs to undici's default ~300s. A caller-provided AbortSignal
 * always wins over the default timeout.
 */
const REMOTE_JSON_TIMEOUT_MS = 8_000;
/** Content payloads (metafile ZIPs, avatars) can be multi-MB — bound more generously. */
const REMOTE_CONTENT_TIMEOUT_MS = 60_000;

function withRemoteFallbackTimeout(
  options: RequestInit | undefined,
  timeoutMs: number,
): RequestInit {
  return {
    ...(options ?? {}),
    signal: options?.signal ?? AbortSignal.timeout(timeoutMs),
  };
}

/**
 * Fetch from an external indexer when IDBOTS_MAN_P2P_LOCAL_BASE is set; fall
 * back to the remote URL when it is unset, unavailable, returns a non-2xx
 * status, or times out. The remote fetch is bounded by REMOTE_JSON_TIMEOUT_MS
 * unless the caller supplies a signal.
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
  const localBase = getConfiguredP2PLocalBase();
  if (localBase) {
    const localUrl = localBase + localPath + new URL(fallbackUrl).search;

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
  }

  return fetch(fallbackUrl, withRemoteFallbackTimeout(options, REMOTE_JSON_TIMEOUT_MS));
}

/**
 * Fetch from an external indexer when IDBOTS_MAN_P2P_LOCAL_BASE is set; fall
 * back to the remote URL when it is unset, unavailable, or answers with a
 * semantically empty payload.
 *
 * @param localPath      Path starting with '/', e.g. '/api/pin/abc'
 * @param fallbackUrl    Full remote URL to use when local is unavailable
 * @param isSemanticMiss Predicate marking an otherwise-valid local payload as empty
 * @param opts.request   Optional RequestInit forwarded to both fetch calls
 * @param opts.degradeToLocalOnRemoteError
 *        When true and the remote attempt fails (unreachable or non-2xx),
 *        return the local response when one exists instead of surfacing the
 *        failure. This preserves the pre-fallback degrade-gracefully semantics
 *        for reads whose local payload may be an incomplete stub (e.g. the
 *        profile lookup during user-identity import on a fresh machine).
 */
export async function fetchJsonWithFallbackOnMiss(
  localPath: string,
  fallbackUrl: string,
  isSemanticMiss: (payload: unknown) => boolean,
  opts?: { request?: RequestInit; degradeToLocalOnRemoteError?: boolean },
): Promise<Response> {
  const localBase = getConfiguredP2PLocalBase();
  const degradeToLocal = opts?.degradeToLocalOnRemoteError === true;
  let localRes: Response | null = null;

  if (localBase) {
    const localUrl = localBase + localPath;

    try {
      localRes = await fetch(localUrl, {
        ...(opts?.request ?? {}),
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
  }

  let remoteRes: Response | null = null;
  try {
    remoteRes = await fetch(fallbackUrl, {
      ...(opts?.request ?? {}),
      signal: AbortSignal.timeout(REMOTE_JSON_TIMEOUT_MS),
    });
  } catch (error) {
    // Remote unreachable: with degradation requested and a local response in
    // hand, hand it back rather than turning a remote outage into a hard
    // failure for a read the local node already answered.
    if (degradeToLocal && localRes) {
      return localRes;
    }
    throw error;
  }

  if (degradeToLocal && localRes) {
    // Re-check the remote payload with the same predicate: when the remote
    // cannot provide a usable payload either (error status, or a content-less
    // body — e.g. a legitimately nameless identity), keep the same degradation
    // contract instead of routing the caller onto a hop that adds nothing.
    if (!remoteRes.ok) {
      return localRes;
    }
    const remotePayload = await parseJsonClone(remoteRes);
    if (isSemanticMiss(remotePayload)) {
      return localRes;
    }
  }

  return remoteRes;
}

/**
 * Fetch content for a pin from an external indexer when
 * IDBOTS_MAN_P2P_LOCAL_BASE is set, falling back to a remote URL when it is
 * unset, the response has an empty body, or errors out.
 *
 * Body emptiness is determined via the Content-Length response header only —
 * the response stream is never consumed so the caller always receives a fresh
 * readable body.
 *
 * @param pinId       The pin identifier (appended to /content/)
 * @param fallbackUrl Full remote URL to use when local content is unavailable
 * @param options     Optional RequestInit forwarded to both fetch calls; the
 *                    remote fetch is bounded by REMOTE_CONTENT_TIMEOUT_MS
 *                    unless the caller supplies a signal
 * @param validateContent Optional body validator; when the local response body
 *                        does not pass it, the local response is treated as a
 *                        miss and the remote fallback is used instead
 */
export async function fetchContentWithFallback(
  pinId: string,
  fallbackUrl: string,
  options?: RequestInit,
  validateContent?: (buffer: Buffer) => boolean,
): Promise<Response> {
  const localBase = getConfiguredP2PLocalBase();
  if (localBase) {
    const localUrl = localBase + `/content/${pinId}`;

    try {
      const localRes = await fetch(localUrl, {
        ...options,
        signal: AbortSignal.timeout(2000),
      });

      if (localRes.headers.get('x-man-content-status') === 'metadata-only') {
        return fetch(fallbackUrl, withRemoteFallbackTimeout(options, REMOTE_CONTENT_TIMEOUT_MS));
      }

      const contentLength = localRes.headers.get('content-length');
      if (localRes.ok && contentLength && parseInt(contentLength, 10) > 0) {
        if (
          !validateContent
          || validateContent(Buffer.from(await localRes.clone().arrayBuffer()))
        ) {
          return localRes;
        }
      }
      if (localRes.ok && !contentLength) {
        const bodyBytes = await localRes.clone().arrayBuffer();
        if (
          bodyBytes.byteLength > 0
          && (!validateContent || validateContent(Buffer.from(bodyBytes)))
        ) {
          return localRes;
        }
      }
    } catch (_err: unknown) {
      void _err;
    }
  }

  return fetch(fallbackUrl, withRemoteFallbackTimeout(options, REMOTE_CONTENT_TIMEOUT_MS));
}
