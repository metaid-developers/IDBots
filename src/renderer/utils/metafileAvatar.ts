const METAFILE_AVATAR_PATTERN = /^metafile:\/\/([0-9a-f]{64}i\d+)(?:\.[a-z0-9][a-z0-9+-]{0,31})?$/i;

export function isMetafileAvatarReference(value: string | null | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return METAFILE_AVATAR_PATTERN.test(normalized);
}

export function getMetafileAvatarPinId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const match = normalized.match(METAFILE_AVATAR_PATTERN);
  return match?.[1]?.toLowerCase() ?? null;
}

export function withMetafileAvatarResponse(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const contentType = typeof response.headers?.get === 'function'
      ? response.headers.get('content-type') ?? ''
      : 'application/json';
    if (!contentType.includes('application/json')) {
      return response;
    }
    const jsonResponse = typeof response.clone === 'function' ? response.clone() : response;
    const payload = await jsonResponse.json().catch(() => null) as {
      data?: { avatar?: unknown; avatarId?: unknown };
    } | null;
    const rawAvatar = payload?.data?.avatar;
    const pinId = getMetafileAvatarPinId(typeof rawAvatar === 'string' ? rawAvatar : null);
    if (!payload?.data || !pinId) {
      return response;
    }
    return new Response(JSON.stringify({
      ...payload,
      data: { ...payload.data, avatar: `/content/${pinId}`, avatarId: pinId },
    }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
