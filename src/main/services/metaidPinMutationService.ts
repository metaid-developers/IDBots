import type { MetaidDataPayload } from './metaidCore';

const DEFAULT_ENCRYPTION = '0' as const;
const DEFAULT_VERSION = '1.0.0' as const;
const DEFAULT_CONTENT_TYPE = 'application/json';

const normalizeTargetPinId = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim() : String(value || '').trim();
  if (!normalized) {
    throw new Error('targetPinId is required');
  }
  return normalized;
};

export const buildRevokeMetaidPayload = (targetPinId: string): MetaidDataPayload => {
  const pinId = normalizeTargetPinId(targetPinId);
  return {
    operation: 'revoke',
    path: `@${pinId}`,
    encryption: DEFAULT_ENCRYPTION,
    version: DEFAULT_VERSION,
    contentType: DEFAULT_CONTENT_TYPE,
    payload: '',
  };
};

export const buildModifyMetaidPayload = (input: {
  targetPinId: string;
  payload: string | Buffer;
  contentType?: string;
}): MetaidDataPayload => {
  const pinId = normalizeTargetPinId(input.targetPinId);
  return {
    operation: 'modify',
    path: `@${pinId}`,
    encryption: DEFAULT_ENCRYPTION,
    version: DEFAULT_VERSION,
    contentType: (typeof input.contentType === 'string' && input.contentType.trim())
      ? input.contentType.trim()
      : DEFAULT_CONTENT_TYPE,
    payload: input.payload,
  };
};
