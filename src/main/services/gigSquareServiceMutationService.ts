import type { MetaidDataPayload } from './metaidCore';
import {
  buildModifyMetaidPayload,
  buildRevokeMetaidPayload,
} from './metaidPinMutationService';
import { normalizeGigSquareSettlementDraft } from '../shared/gigSquareSettlementAsset.js';
import {
  getPrimaryProviderSkill,
  normalizeProviderSkillList,
  normalizeProtocolSettlementKind,
  normalizeSkillServiceCurrency,
  resolveSkillServicePaymentTerms,
} from '../shared/skillServiceProtocol.js';

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
  executionReminder?: string | null;
  providerSkills?: string[];
  providerSkill?: string;
  paymentTiming?: 'free' | 'prepaid' | string;
  price: string;
  currency: string;
  protocolSettlementKind?: 'native' | 'fiat' | string;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  metadata?: string;
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
  providerSkills?: string[] | null;
  serviceName?: string;
  displayName?: string;
  description?: string;
  executionReminder?: string | null;
  serviceIcon?: string | null;
  price?: string;
  currency?: string;
  paymentTiming?: string | null;
  protocolSettlementKind?: string | null;
  settlementKind?: string | null;
  paymentChain?: string | null;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  metadata?: string | null;
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
  providerSkills: string[];
  serviceName: string;
  displayName: string;
  description: string;
  executionReminder: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  paymentTiming: string | null;
  protocolSettlementKind: string | null;
  metadata: string;
  settlementKind: string | null;
  paymentChain: string | null;
  mrc20Ticker: string | null;
  mrc20Id: string | null;
  skillDocument: string;
  inputType: string;
  outputType: string;
  endpoint: string;
  payloadJson: string;
  revokedAt: number | null;
  updatedAt: number;
}

export interface GigSquareSettlementAddressOwner {
  mvc_address?: string | null;
  btc_address?: string | null;
  doge_address?: string | null;
}

const GIG_SQUARE_ALLOWED_CURRENCIES = new Set(['BTC', 'MVC', 'DOGE', 'SPACE']);
const GIG_SQUARE_ALLOWED_OUTPUT_TYPES = new Set(['text', 'image', 'video', 'audio', 'other']);
const GIG_SQUARE_PRICE_PATTERN = /^\d+(?:\.\d+)?$/;
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

const normalizeDraftPaymentTiming = (value: unknown): 'free' | 'prepaid' | undefined => {
  const normalized = toSafeString(value).trim().toLowerCase();
  if (normalized === 'free' || normalized === 'prepaid') return normalized;
  return undefined;
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
  providerSkills?: string[] | null;
  serviceName: string;
  displayName: string;
  description: string;
  executionReminder: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  paymentTiming?: string | null;
  protocolSettlementKind?: string | null;
  metadata?: string | null;
  settlementKind: string | null;
  paymentChain: string | null;
  mrc20Ticker: string | null;
  mrc20Id: string | null;
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
    providerSkills: normalizeProviderSkillList(input.providerSkills),
    serviceName: toSafeString(input.serviceName).trim(),
    displayName: toSafeString(input.displayName).trim(),
    description: toSafeString(input.description).trim(),
    executionReminder: toSafeString(input.executionReminder).trim(),
    serviceIcon: toSafeString(input.serviceIcon).trim() || null,
    price: toSafeString(input.price).trim(),
    currency: toSafeString(input.currency).trim(),
    paymentTiming: toSafeString(input.paymentTiming).trim() || null,
    protocolSettlementKind: toSafeString(input.protocolSettlementKind).trim() || null,
    metadata: toSafeString(input.metadata),
    settlementKind: toSafeString(input.settlementKind).trim() || null,
    paymentChain: toSafeString(input.paymentChain).trim() || null,
    mrc20Ticker: toSafeString(input.mrc20Ticker).trim() || null,
    mrc20Id: toSafeString(input.mrc20Id).trim() || null,
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
  return normalizeSkillServiceCurrency(value);
};

export const getGigSquarePriceLimit = (currency: string): number => {
  return GIG_SQUARE_PRICE_LIMITS[currency] ?? GIG_SQUARE_PRICE_LIMITS.SPACE;
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

export const normalizeGigSquareModifyDraft = (draft: GigSquareModifyDraft): GigSquareModifyDraft => {
  const explicitProviderSkills = normalizeProviderSkillList(draft.providerSkills);
  const providerSkills = explicitProviderSkills.length
    ? explicitProviderSkills
    : normalizeProviderSkillList(draft.providerSkill);
  const paymentTiming = normalizeDraftPaymentTiming(draft.paymentTiming);
  const paymentTerms = resolveSkillServicePaymentTerms({
    paymentTiming,
    price: toSafeString(draft.price).trim(),
    currency: draft.currency,
    protocolSettlementKind: draft.protocolSettlementKind,
  });

  return {
    serviceName: toSafeString(draft.serviceName).trim(),
    displayName: toSafeString(draft.displayName).trim(),
    description: toSafeString(draft.description).trim(),
    executionReminder: toSafeString(draft.executionReminder).trim(),
    providerSkills,
    providerSkill: getPrimaryProviderSkill(providerSkills),
    paymentTiming: paymentTerms.paymentTiming,
    price: paymentTerms.effectivePrice,
    currency: paymentTerms.currency,
    protocolSettlementKind: paymentTerms.protocolSettlementKind,
    mrc20Ticker: toSafeString(draft.mrc20Ticker).trim() || null,
    mrc20Id: toSafeString(draft.mrc20Id).trim() || null,
    metadata: toSafeString(draft.metadata),
    outputType: toSafeString(draft.outputType).trim().toLowerCase(),
    serviceIconUri: toSafeString(draft.serviceIconUri).trim() || null,
  };
};

export const validateGigSquareModifyDraft = (draft: GigSquareModifyDraft): GigSquareMutationValidationResult => {
  const normalized = normalizeGigSquareModifyDraft(draft);
  const rawPaymentTiming = toSafeString(draft.paymentTiming).trim().toLowerCase();
  const rawPrice = toSafeString(draft.price).trim();
  const requestedPaymentTiming = normalizeDraftPaymentTiming(draft.paymentTiming);
  if (!normalized.serviceName) return { ok: false, error: 'serviceName is required', errorCode: 'service_name_required' };
  if (!normalized.displayName) return { ok: false, error: 'displayName is required', errorCode: 'display_name_required' };
  if (!normalized.description) return { ok: false, error: 'description is required', errorCode: 'description_required' };
  if (!normalized.providerSkills?.length) return { ok: false, error: 'providerSkill is required', errorCode: 'provider_skill_required' };
  if (rawPaymentTiming && !requestedPaymentTiming) {
    return { ok: false, error: 'paymentTiming is invalid', errorCode: 'payment_timing_invalid' };
  }
  if (rawPrice && !GIG_SQUARE_PRICE_PATTERN.test(rawPrice)) {
    return { ok: false, error: 'price is invalid', errorCode: 'price_invalid' };
  }

  if (!GIG_SQUARE_ALLOWED_CURRENCIES.has(normalized.currency)) {
    return { ok: false, error: 'currency is invalid', errorCode: 'currency_invalid' };
  }
  if (!GIG_SQUARE_ALLOWED_OUTPUT_TYPES.has(normalized.outputType)) {
    return { ok: false, error: 'outputType is invalid', errorCode: 'output_type_invalid' };
  }

  const priceNumber = Number(normalized.price);
  if (requestedPaymentTiming === 'prepaid' && normalized.paymentTiming !== 'prepaid') {
    return { ok: false, error: 'price must be positive for prepaid services', errorCode: 'price_positive_required' };
  }
  if (normalized.paymentTiming === 'prepaid' && (!Number.isFinite(priceNumber) || priceNumber <= 0)) {
    return { ok: false, error: 'price must be positive for prepaid services', errorCode: 'price_positive_required' };
  }
  if (!Number.isFinite(priceNumber) || priceNumber < 0) {
    return { ok: false, error: 'price is invalid', errorCode: 'price_invalid' };
  }
  if (normalized.paymentTiming === 'prepaid' && priceNumber > getGigSquarePriceLimit(normalized.currency)) {
    return { ok: false, error: 'price exceeds limit', errorCode: 'price_limit_exceeded' };
  }

  try {
    normalizeGigSquareSettlementDraft({
      currency: normalized.currency,
      mrc20Ticker: normalized.mrc20Ticker,
      mrc20Id: normalized.mrc20Id,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'currency is invalid',
      errorCode: 'currency_invalid',
    };
  }

  return { ok: true };
};

export const buildGigSquareServicePayload = (input: {
  draft: GigSquareModifyDraft;
  providerGlobalMetaId: string;
  paymentAddress?: string;
}): Record<string, string | string[] | null> => {
  const normalized = normalizeGigSquareModifyDraft(input.draft);
  if (!normalized.providerSkills?.length) {
    throw new Error('providerSkill is required');
  }
  if (normalized.currency === 'MRC20') {
    throw new Error('currency is invalid');
  }
  const settlement = normalizeGigSquareSettlementDraft({
    currency: normalized.currency,
    mrc20Ticker: normalized.mrc20Ticker,
    mrc20Id: normalized.mrc20Id,
  });
  return {
    serviceName: normalized.serviceName,
    displayName: normalized.displayName,
    description: normalized.description,
    serviceIcon: normalized.serviceIconUri || '',
    providerMetaBot: toSafeString(input.providerGlobalMetaId).trim(),
    providerSkill: normalized.providerSkills,
    price: normalized.price,
    currency: settlement.protocolCurrency,
    paymentTiming: normalized.paymentTiming || 'free',
    settlementKind: normalizeProtocolSettlementKind(normalized.protocolSettlementKind),
    metadata: normalized.metadata || '',
    executionReminder: normalized.executionReminder || '',
    skillDocument: '',
    inputType: 'text',
    outputType: normalized.outputType,
    endpoint: 'simplemsg',
  };
};

export const resolveGigSquareSettlementPaymentAddress = (input: {
  owner?: GigSquareSettlementAddressOwner | null;
  settlement: ReturnType<typeof normalizeGigSquareSettlementDraft>;
}): string => {
  // Legacy paymentAddress/MRC20 routing helper; v1.1 skill-service publish does not serialize paymentAddress.
  const owner = input.owner;
  if (!owner) return '';
  if (input.settlement.paymentChain === 'btc') return toSafeString(owner.btc_address).trim();
  if (input.settlement.paymentChain === 'doge') return toSafeString(owner.doge_address).trim();
  return toSafeString(owner.mvc_address).trim();
};

export const buildGigSquareRevokeMetaidPayload = (targetPinId: string): MetaidDataPayload => {
  return buildRevokeMetaidPayload(targetPinId);
};

export const buildGigSquareModifyMetaidPayload = (input: {
  targetPinId: string;
  payloadJson: string;
}): MetaidDataPayload => {
  return {
    ...buildModifyMetaidPayload({
      targetPinId: input.targetPinId,
      payload: input.payloadJson,
      contentType: 'application/json',
    }),
    version: '1.1.0',
  };
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
    providerSkills: service.providerSkills,
    serviceName: toSafeString(service.serviceName).trim(),
    displayName: toSafeString(service.displayName).trim() || toSafeString(service.serviceName).trim(),
    description: toSafeString(service.description).trim(),
    executionReminder: toSafeString(service.executionReminder).trim(),
    serviceIcon: toSafeString(service.serviceIcon).trim() || null,
    price: toSafeString(service.price).trim(),
    currency: toSafeString(service.currency).trim(),
    paymentTiming: service.paymentTiming,
    protocolSettlementKind: service.protocolSettlementKind,
    metadata: service.metadata,
    settlementKind: toSafeString(service.settlementKind).trim() || null,
    paymentChain: toSafeString(service.paymentChain).trim() || null,
    mrc20Ticker: toSafeString(service.mrc20Ticker).trim() || null,
    mrc20Id: toSafeString(service.mrc20Id).trim() || null,
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
  providerSkills?: string[] | null;
  serviceName: string;
  displayName: string;
  description: string;
  executionReminder?: string | null;
  serviceIcon: string | null;
  price: string;
  currency: string;
  paymentTiming?: string | null;
  protocolSettlementKind?: string | null;
  metadata?: string | null;
  settlementKind?: string | null;
  paymentChain?: string | null;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  outputType: string;
  endpoint: string;
  payloadJson: string;
  now: number;
}): GigSquareLocalServiceMutationRecord => {
  return createLocalMutationRecord({
    service: input.service,
    currentPinId: input.currentPinId,
    providerSkill: input.providerSkill,
    providerSkills: input.providerSkills,
    serviceName: input.serviceName,
    displayName: input.displayName,
    description: input.description,
    executionReminder: toSafeString(input.executionReminder).trim(),
    serviceIcon: input.serviceIcon,
    price: input.price,
    currency: input.currency,
    paymentTiming: input.paymentTiming,
    protocolSettlementKind: input.protocolSettlementKind,
    metadata: input.metadata,
    settlementKind: toSafeString(input.settlementKind).trim() || null,
    paymentChain: toSafeString(input.paymentChain).trim() || null,
    mrc20Ticker: toSafeString(input.mrc20Ticker).trim() || null,
    mrc20Id: toSafeString(input.mrc20Id).trim() || null,
    outputType: input.outputType,
    endpoint: input.endpoint,
    payloadJson: input.payloadJson,
    revokedAt: null,
    now: input.now,
  });
};
