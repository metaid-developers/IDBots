export interface PublishedServiceDraft {
  serviceName: string;
  displayName: string;
  description: string;
  providerSkill: string;
  price: string;
  currency: string;
  outputType: string;
  serviceIconUri?: string | null;
}

export interface PublishedServiceRecord {
  id: string;
  sourceServicePinId: string;
  currentPinId: string;
  creatorMetabotId: number;
  providerGlobalMetaId: string;
  providerSkill: string;
  serviceName: string;
  displayName: string;
  description: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  skillDocument: string;
  inputType: 'text';
  outputType: string;
  endpoint: 'simplemsg';
  paymentAddress: string;
  payloadJson: string;
  available: 0 | 1;
  revokedAt: number | null;
  updatedAt: number;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePublishedServiceCurrency(value: string): string {
  const normalized = normalizeText(value).toUpperCase();
  return normalized === 'SPACE' ? 'MVC' : normalized;
}

function normalizeDraft(draft: PublishedServiceDraft): PublishedServiceDraft {
  return {
    serviceName: normalizeText(draft.serviceName),
    displayName: normalizeText(draft.displayName),
    description: normalizeText(draft.description),
    providerSkill: normalizeText(draft.providerSkill),
    price: normalizeText(draft.price),
    currency: normalizePublishedServiceCurrency(draft.currency),
    outputType: normalizeText(draft.outputType).toLowerCase() || 'text',
    serviceIconUri: normalizeText(draft.serviceIconUri) || null,
  };
}

export function buildPublishedService(input: {
  sourceServicePinId: string;
  currentPinId: string;
  creatorMetabotId: number;
  providerGlobalMetaId: string;
  paymentAddress: string;
  draft: PublishedServiceDraft;
  skillDocument: string;
  now: number;
}): {
  payload: Record<string, string>;
  record: PublishedServiceRecord;
} {
  const draft = normalizeDraft(input.draft);
  const payload = {
    serviceName: draft.serviceName,
    displayName: draft.displayName,
    description: draft.description,
    serviceIcon: draft.serviceIconUri || '',
    providerMetaBot: normalizeText(input.providerGlobalMetaId),
    providerSkill: draft.providerSkill,
    price: draft.price,
    currency: draft.currency,
    skillDocument: normalizeText(input.skillDocument),
    inputType: 'text',
    outputType: draft.outputType || 'text',
    endpoint: 'simplemsg',
    paymentAddress: normalizeText(input.paymentAddress),
  };

  const record: PublishedServiceRecord = {
    id: normalizeText(input.sourceServicePinId),
    sourceServicePinId: normalizeText(input.sourceServicePinId),
    currentPinId: normalizeText(input.currentPinId) || normalizeText(input.sourceServicePinId),
    creatorMetabotId: input.creatorMetabotId,
    providerGlobalMetaId: normalizeText(input.providerGlobalMetaId),
    providerSkill: draft.providerSkill,
    serviceName: draft.serviceName,
    displayName: draft.displayName,
    description: draft.description,
    serviceIcon: draft.serviceIconUri || null,
    price: draft.price,
    currency: draft.currency,
    skillDocument: normalizeText(input.skillDocument),
    inputType: 'text',
    outputType: draft.outputType || 'text',
    endpoint: 'simplemsg',
    paymentAddress: normalizeText(input.paymentAddress),
    payloadJson: JSON.stringify(payload),
    available: 1,
    revokedAt: null,
    updatedAt: input.now,
  };

  return { payload, record };
}

export function buildRevokedPublishedService(input: {
  sourceServicePinId: string;
  currentPinId: string;
  creatorMetabotId: number;
  providerGlobalMetaId: string;
  providerSkill: string;
  serviceName: string;
  displayName: string;
  description: string;
  serviceIcon?: string | null;
  price: string;
  currency: string;
  skillDocument: string;
  now: number;
}): PublishedServiceRecord {
  return {
    id: normalizeText(input.sourceServicePinId),
    sourceServicePinId: normalizeText(input.sourceServicePinId),
    currentPinId: normalizeText(input.currentPinId) || normalizeText(input.sourceServicePinId),
    creatorMetabotId: input.creatorMetabotId,
    providerGlobalMetaId: normalizeText(input.providerGlobalMetaId),
    providerSkill: normalizeText(input.providerSkill),
    serviceName: normalizeText(input.serviceName),
    displayName: normalizeText(input.displayName) || normalizeText(input.serviceName),
    description: normalizeText(input.description),
    serviceIcon: normalizeText(input.serviceIcon) || null,
    price: normalizeText(input.price),
    currency: normalizePublishedServiceCurrency(input.currency),
    skillDocument: normalizeText(input.skillDocument),
    inputType: 'text',
    outputType: 'text',
    endpoint: 'simplemsg',
    paymentAddress: '',
    payloadJson: '',
    available: 0,
    revokedAt: input.now,
    updatedAt: input.now,
  };
}
