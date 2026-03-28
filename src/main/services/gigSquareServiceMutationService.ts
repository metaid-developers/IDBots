import type { MetaidDataPayload } from './metaidCore';
import {
  buildModifyMetaidPayload,
  buildRevokeMetaidPayload,
} from './metaidPinMutationService';

export const GIG_SQUARE_MUTATION_SYNC_DELAY_MS = 3000;

export type GigSquareServiceMutationAction = 'modify' | 'revoke';

export interface GigSquareMutationTargetService {
  currentPinId: string;
  creatorMetabotId?: number | null;
  canModify?: boolean;
  canRevoke?: boolean;
  blockedReason?: string | null;
}

export interface GigSquareModifyDraft {
  serviceName: string;
  displayName: string;
  description: string;
  providerSkill: string;
  price: string;
  currency: string;
  outputType: string;
  serviceIconUri?: string | null;
}

export interface GigSquareMutationValidationResult {
  ok: boolean;
  error?: string;
  errorCode?: string;
  creatorMetabotId?: number;
}

export interface GigSquareLocalMutationServiceSeed {
  id?: string;
  pinId?: string;
  sourceServicePinId?: string | null;
  currentPinId?: string | null;
  creatorMetabotId?: number | null;
  providerGlobalMetaId?: string;
  providerSkill?: string | null;
  serviceName?: string;
  displayName?: string;
  description?: string;
  serviceIcon?: string | null;
  price?: string;
  currency?: string;
  outputType?: string | null;
  endpoint?: string | null;
}

export interface GigSquareLocalServiceMutationRecord {
  id: string;
  pinId: string;
  sourceServicePinId: string;
  currentPinId: string;
  txid: string;
  metabotId: number;
  providerGlobalMetaId: string;
  providerSkill: string;
  serviceName: string;
  displayName: string;
  description: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  skillDocument: string;
  inputType: string;
  outputType: string;
  endpoint: string;
  payloadJson: string;
  revokedAt: number | null;
  updatedAt: number;
}

const GIG_SQUARE_ALLOWED_CURRENCIES = new Set(['BTC', 'MVC', 'DOGE', 'SPACE']);
const GIG_SQUARE_ALLOWED_OUTPUT_TYPES = new Set(['text', 'image', 'video', 'other']);
const GIG_SQUARE_PRICE_LIMITS: Record<string, number> = {
  BTC: 1,
  MVC: 100000,
  DOGE: 10000,
  SPACE: 100000,
};

const BLOCKED_REASON_TO_ERROR: Record<string, string> = {
  gigSquareMyServicesBlockedActiveOrders: 'Service has active orders',
  gigSquareMyServicesBlockedNotCurrent: 'Service version is not current',
  gigSquareMyServicesBlockedRevoked: 'Service is revoked',
  gigSquareMyServicesBlockedMissingCreatorMetabot: 'Creator MetaBot not found',
};

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
};

const toSafeNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const resolveSourceServicePinId = (service: GigSquareLocalMutationServiceSeed): string => {
  return (
    toSafeString(service.sourceServicePinId).trim()
    || toSafeString(service.currentPinId).trim()
    || toSafeString(service.pinId).trim()
    || toSafeString(service.id).trim()
  );
};

const createLocalMutationRecord = (input: {
  service: GigSquareLocalMutationServiceSeed;
  currentPinId: string;
  providerSkill: string;
  serviceName: string;
  displayName: string;
  description: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  outputType: string;
  endpoint: string;
  payloadJson: string;
  revokedAt: number | null;
  now: number;
}): GigSquareLocalServiceMutationRecord => {
  const sourceServicePinId = resolveSourceServicePinId(input.service);
  const pinId = toSafeString(input.service.pinId).trim() || sourceServicePinId;
  const creatorMetabotId = Math.trunc(toSafeNumber(input.service.creatorMetabotId));
  if (!sourceServicePinId) {
    throw new Error('Source service pin id is required to persist local service mutation state');
  }
  if (!creatorMetabotId || creatorMetabotId <= 0) {
    throw new Error('Creator MetaBot id is required to persist local service mutation state');
  }

  return {
    id: sourceServicePinId,
    pinId,
    sourceServicePinId,
    currentPinId: toSafeString(input.currentPinId).trim() || sourceServicePinId,
    txid: '',
    metabotId: creatorMetabotId,
    providerGlobalMetaId: toSafeString(input.service.providerGlobalMetaId).trim(),
    providerSkill: toSafeString(input.providerSkill).trim(),
    serviceName: toSafeString(input.serviceName).trim(),
    displayName: toSafeString(input.displayName).trim(),
    description: toSafeString(input.description).trim(),
    serviceIcon: toSafeString(input.serviceIcon).trim() || null,
    price: toSafeString(input.price).trim(),
    currency: toSafeString(input.currency).trim(),
    skillDocument: '',
    inputType: 'text',
    outputType: toSafeString(input.outputType).trim().toLowerCase() || 'text',
    endpoint: toSafeString(input.endpoint).trim() || 'simplemsg',
    payloadJson: toSafeString(input.payloadJson),
    revokedAt: input.revokedAt,
    updatedAt: input.now,
  };
};

export const normalizeGigSquareCurrency = (value: string): string => {
  const normalized = toSafeString(value).trim().toUpperCase();
  return normalized === 'SPACE' ? 'MVC' : normalized;
};

export const getGigSquarePriceLimit = (currency: string): number => {
  return GIG_SQUARE_PRICE_LIMITS[currency] ?? GIG_SQUARE_PRICE_LIMITS.MVC;
};

export const resolveGigSquareBlockedReasonError = (blockedReason?: string | null): {
  errorCode: string;
  error: string;
} => {
  const normalized = toSafeString(blockedReason).trim();
  if (!normalized) {
    return {
      errorCode: 'gigSquareMyServicesBlockedUnknown',
      error: 'Service mutation is currently unavailable',
    };
  }
  return {
    errorCode: normalized,
    error: BLOCKED_REASON_TO_ERROR[normalized] || 'Service mutation is currently unavailable',
  };
};

export const validateGigSquareServiceMutation = (input: {
  action: GigSquareServiceMutationAction;
  service: GigSquareMutationTargetService | null | undefined;
}): GigSquareMutationValidationResult => {
  const service = input.service;
  if (!service) {
    return { ok: false, error: 'Service not found', errorCode: 'service_not_found' };
  }

  const currentPinId = toSafeString(service.currentPinId).trim();
  if (!currentPinId) {
    return { ok: false, error: 'Service pin is missing', errorCode: 'service_pin_missing' };
  }

  const creatorMetabotId = Math.trunc(toSafeNumber(service.creatorMetabotId));
  if (!creatorMetabotId || creatorMetabotId <= 0) {
    return {
      ok: false,
      error: BLOCKED_REASON_TO_ERROR.gigSquareMyServicesBlockedMissingCreatorMetabot,
      errorCode: 'gigSquareMyServicesBlockedMissingCreatorMetabot',
    };
  }

  if (input.action === 'modify' && !service.canModify) {
    const blocked = resolveGigSquareBlockedReasonError(service.blockedReason);
    return { ok: false, error: blocked.error, errorCode: blocked.errorCode };
  }
  if (input.action === 'revoke' && !service.canRevoke) {
    const blocked = resolveGigSquareBlockedReasonError(service.blockedReason);
    return { ok: false, error: blocked.error, errorCode: blocked.errorCode };
  }

  return { ok: true, creatorMetabotId };
};

export const normalizeGigSquareModifyDraft = (draft: GigSquareModifyDraft): GigSquareModifyDraft => ({
  serviceName: toSafeString(draft.serviceName).trim(),
  displayName: toSafeString(draft.displayName).trim(),
  description: toSafeString(draft.description).trim(),
  providerSkill: toSafeString(draft.providerSkill).trim(),
  price: toSafeString(draft.price).trim(),
  currency: normalizeGigSquareCurrency(draft.currency),
  outputType: toSafeString(draft.outputType).trim().toLowerCase(),
  serviceIconUri: toSafeString(draft.serviceIconUri).trim() || null,
});

export const validateGigSquareModifyDraft = (draft: GigSquareModifyDraft): GigSquareMutationValidationResult => {
  const normalized = normalizeGigSquareModifyDraft(draft);
  if (!normalized.serviceName) return { ok: false, error: 'serviceName is required', errorCode: 'service_name_required' };
  if (!normalized.displayName) return { ok: false, error: 'displayName is required', errorCode: 'display_name_required' };
  if (!normalized.description) return { ok: false, error: 'description is required', errorCode: 'description_required' };
  if (!normalized.providerSkill) return { ok: false, error: 'providerSkill is required', errorCode: 'provider_skill_required' };
  if (!normalized.price) return { ok: false, error: 'price is required', errorCode: 'price_required' };

  if (!GIG_SQUARE_ALLOWED_CURRENCIES.has(normalized.currency)) {
    return { ok: false, error: 'currency is invalid', errorCode: 'currency_invalid' };
  }
  if (!GIG_SQUARE_ALLOWED_OUTPUT_TYPES.has(normalized.outputType)) {
    return { ok: false, error: 'outputType is invalid', errorCode: 'output_type_invalid' };
  }
  if (!/^\d+(\.\d+)?$/.test(normalized.price)) {
    return { ok: false, error: 'price is invalid', errorCode: 'price_invalid' };
  }

  const priceNumber = Number(normalized.price);
  if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
    return { ok: false, error: 'price is invalid', errorCode: 'price_invalid' };
  }
  if (priceNumber > getGigSquarePriceLimit(normalized.currency)) {
    return { ok: false, error: 'price exceeds limit', errorCode: 'price_limit_exceeded' };
  }

  return { ok: true };
};

export const buildGigSquareServicePayload = (input: {
  draft: GigSquareModifyDraft;
  providerGlobalMetaId: string;
  paymentAddress: string;
}): Record<string, string> => {
  const normalized = normalizeGigSquareModifyDraft(input.draft);
  return {
    serviceName: normalized.serviceName,
    displayName: normalized.displayName,
    description: normalized.description,
    serviceIcon: normalized.serviceIconUri || '',
    providerMetaBot: toSafeString(input.providerGlobalMetaId).trim(),
    providerSkill: normalized.providerSkill,
    price: normalized.price,
    currency: normalized.currency,
    skillDocument: '',
    inputType: 'text',
    outputType: normalized.outputType,
    endpoint: 'simplemsg',
    paymentAddress: toSafeString(input.paymentAddress).trim(),
  };
};

export const buildGigSquareRevokeMetaidPayload = (targetPinId: string): MetaidDataPayload => {
  return buildRevokeMetaidPayload(targetPinId);
};

export const buildGigSquareModifyMetaidPayload = (input: {
  targetPinId: string;
  payloadJson: string;
}): MetaidDataPayload => {
  return buildModifyMetaidPayload({
    targetPinId: input.targetPinId,
    payload: input.payloadJson,
    contentType: 'application/json',
  });
};

export const buildGigSquareLocalServiceRecordForRevoke = (input: {
  service: GigSquareLocalMutationServiceSeed;
  now: number;
}): GigSquareLocalServiceMutationRecord => {
  const service = input.service;
  const currentPinId = toSafeString(service.currentPinId).trim()
    || toSafeString(service.pinId).trim()
    || resolveSourceServicePinId(service);
  return createLocalMutationRecord({
    service,
    currentPinId,
    providerSkill: toSafeString(service.providerSkill).trim(),
    serviceName: toSafeString(service.serviceName).trim(),
    displayName: toSafeString(service.displayName).trim() || toSafeString(service.serviceName).trim(),
    description: toSafeString(service.description).trim(),
    serviceIcon: toSafeString(service.serviceIcon).trim() || null,
    price: toSafeString(service.price).trim(),
    currency: toSafeString(service.currency).trim(),
    outputType: toSafeString(service.outputType).trim().toLowerCase() || 'text',
    endpoint: toSafeString(service.endpoint).trim() || 'simplemsg',
    payloadJson: '',
    revokedAt: input.now,
    now: input.now,
  });
};

export const buildGigSquareLocalServiceRecordForModify = (input: {
  service: GigSquareLocalMutationServiceSeed;
  currentPinId: string;
  providerSkill: string;
  serviceName: string;
  displayName: string;
  description: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  outputType: string;
  endpoint: string;
  payloadJson: string;
  now: number;
}): GigSquareLocalServiceMutationRecord => {
  return createLocalMutationRecord({
    service: input.service,
    currentPinId: input.currentPinId,
    providerSkill: input.providerSkill,
    serviceName: input.serviceName,
    displayName: input.displayName,
    description: input.description,
    serviceIcon: input.serviceIcon,
    price: input.price,
    currency: input.currency,
    outputType: input.outputType,
    endpoint: input.endpoint,
    payloadJson: input.payloadJson,
    revokedAt: null,
    now: input.now,
  });
};
