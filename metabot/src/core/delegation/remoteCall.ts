import { evaluateSpendCap, normalizeSpendCurrency, type SpendCap } from './spendPolicy';

export interface DelegationRequest {
  servicePinId: string;
  serviceName: string;
  providerGlobalMetaid: string;
  price: string;
  currency: string;
  userTask: string;
  taskContext: string;
  rawRequest: string;
}

export interface RemoteServiceDescriptor {
  servicePinId?: string | null;
  pinId?: string | null;
  providerGlobalMetaId?: string | null;
  serviceName?: string | null;
  displayName?: string | null;
  description?: string | null;
  price?: string | null;
  currency?: string | null;
  ratingAvg?: number | null;
  ratingCount?: number | null;
}

export interface RemoteCallRequest {
  servicePinId: string;
  providerGlobalMetaId: string;
  userTask: string;
  taskContext: string;
  rawRequest?: string;
  spendCap?: SpendCap | null;
}

export type RemoteCallPlanResult =
  | {
      ok: true;
      state: 'ready';
      code: 'remote_call_ready';
      service: {
        servicePinId: string;
        providerGlobalMetaId: string;
        serviceName: string;
        price: string;
        currency: 'SPACE' | 'BTC' | 'DOGE' | '';
      };
      payment: { amount: string; currency: 'SPACE' | 'BTC' | 'DOGE' | '' };
      traceId: string;
      session: {
        coworkSessionId: string | null;
        externalConversationId: string;
      };
    }
  | {
      ok: false;
      state: 'blocked' | 'offline' | 'manual_action_required';
      code: string;
      message: string;
      traceId?: string;
      session?: {
        coworkSessionId: string | null;
        externalConversationId: string;
      };
    };

const DELEGATE_REMOTE_SERVICE_PREFIX = '[DELEGATE_REMOTE_SERVICE]';
const NUMERIC_DELEGATION_PRICE_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const DECORATED_DELEGATION_PRICE_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s+([A-Za-z]+))$/;
const DELEGATION_PARTIAL_PREFIX_MIN_CHARS = 1;
const METAAPP_GENERIC_CONFIRMATION_RE = /^(?:好|好的|好呀|好哒|行|可以|确定|确认|继续|开始吧|请开始|没问题|嗯|嗯嗯|ok|okay|yes|yep|sure)[!！。.\s]*$/i;
const METAAPP_EXPLICIT_INTENT_RE = /\b(?:open|launch|start|use|run)\b|(?:打开|开启|启动|运行|使用|进入)/i;
const METAAPP_CONTEXT_WORD_RE = /\b(?:metaapp|app|application)\b|(?:应用|应用页|本地应用|本地app|本地 App|MetaApp)/i;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCaseInsensitive(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function truncateTraceSegment(value: string): string {
  return value.replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').slice(0, 16) || 'trace';
}

function resolveServiceIdentity(service: RemoteServiceDescriptor): {
  servicePinId: string;
  providerGlobalMetaId: string;
} {
  return {
    servicePinId: normalizeText(service.servicePinId) || normalizeText(service.pinId),
    providerGlobalMetaId: normalizeText(service.providerGlobalMetaId),
  };
}

function buildRemoteCallTraceId(input: {
  request: RemoteCallRequest;
  traceId?: string | null;
}): string {
  const explicit = normalizeText(input.traceId);
  if (explicit) return explicit;
  const provider = truncateTraceSegment(normalizeText(input.request.providerGlobalMetaId) || 'provider');
  const service = truncateTraceSegment(normalizeText(input.request.servicePinId) || 'service');
  return `trace-${provider}-${service}`;
}

function buildRemoteCallSessionLinkage(input: {
  providerGlobalMetaId: string;
  traceId: string;
  sessionId?: string | null;
}): { coworkSessionId: string | null; externalConversationId: string } {
  const externalConversationId = `metaweb_order:buyer:${normalizeText(input.providerGlobalMetaId)}:${truncateTraceSegment(input.traceId)}`;
  return {
    coworkSessionId: normalizeText(input.sessionId) || null,
    externalConversationId,
  };
}

function findTrailingDelegationPrefixFragmentStart(content: string): number {
  if (typeof content !== 'string' || content.length === 0) {
    return -1;
  }

  const maxFragmentLength = Math.min(DELEGATE_REMOTE_SERVICE_PREFIX.length - 1, content.length);
  for (let length = maxFragmentLength; length >= DELEGATION_PARTIAL_PREFIX_MIN_CHARS; length -= 1) {
    if (DELEGATE_REMOTE_SERVICE_PREFIX.startsWith(content.slice(-length))) {
      return content.length - length;
    }
  }
  return -1;
}

export function containsDelegationControlPrefix(content: string): boolean {
  return typeof content === 'string' && content.includes(DELEGATE_REMOTE_SERVICE_PREFIX);
}

export function getDelegationDisplayText(content: string): string {
  if (typeof content !== 'string' || !content) {
    return '';
  }

  const fullPrefixIndex = content.indexOf(DELEGATE_REMOTE_SERVICE_PREFIX);
  if (fullPrefixIndex >= 0) {
    return content.slice(0, fullPrefixIndex).trimEnd();
  }

  const partialPrefixStart = findTrailingDelegationPrefixFragmentStart(content);
  if (partialPrefixStart >= 0) {
    return content.slice(0, partialPrefixStart).trimEnd();
  }

  return content;
}

export function isExplicitMetaAppUserRequest(userText: string, appId?: string): boolean {
  const normalizedText = normalizeText(userText).toLowerCase();
  if (!normalizedText) {
    return false;
  }
  if (METAAPP_GENERIC_CONFIRMATION_RE.test(normalizedText)) {
    return false;
  }

  const normalizedAppId = normalizeText(appId).toLowerCase();
  const mentionsAppId = normalizedAppId.length > 0 && normalizedText.includes(normalizedAppId);
  const hasIntentVerb = METAAPP_EXPLICIT_INTENT_RE.test(userText);
  const hasMetaAppContext = METAAPP_CONTEXT_WORD_RE.test(userText);

  if (mentionsAppId && (hasIntentVerb || hasMetaAppContext)) {
    return true;
  }

  return hasIntentVerb && hasMetaAppContext;
}

export function normalizeDelegationPaymentTerms(
  rawPrice: unknown,
  rawCurrency: unknown,
): { price: string; currency: string } {
  let price = normalizeText(rawPrice);
  let currency = normalizeText(rawCurrency);

  const decoratedMatch = price.match(DECORATED_DELEGATION_PRICE_RE);
  if (decoratedMatch) {
    price = decoratedMatch[1];
    if (!currency && decoratedMatch[2]) {
      currency = decoratedMatch[2];
    }
  }

  return { price, currency };
}

export function isDelegationPriceNumeric(value: string): boolean {
  return NUMERIC_DELEGATION_PRICE_RE.test(normalizeText(value));
}

export function parseDelegationMessage(content: string): DelegationRequest | null {
  const idx = content.indexOf(DELEGATE_REMOTE_SERVICE_PREFIX);
  if (idx === -1) return null;

  const afterPrefix = content.slice(idx + DELEGATE_REMOTE_SERVICE_PREFIX.length);
  const firstBrace = afterPrefix.indexOf('{');
  const lastBrace = afterPrefix.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const jsonStr = afterPrefix.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.servicePinId !== 'string' || !obj.servicePinId
    || typeof obj.serviceName !== 'string' || !obj.serviceName
    || typeof obj.providerGlobalMetaid !== 'string' || !obj.providerGlobalMetaid
  ) {
    return null;
  }

  const normalizedTerms = normalizeDelegationPaymentTerms(obj.price, obj.currency);
  return {
    servicePinId: obj.servicePinId,
    serviceName: obj.serviceName,
    providerGlobalMetaid: obj.providerGlobalMetaid,
    price: normalizedTerms.price,
    currency: normalizedTerms.currency,
    userTask: typeof obj.userTask === 'string' ? obj.userTask : '',
    taskContext: typeof obj.taskContext === 'string' ? obj.taskContext : '',
    rawRequest: typeof obj.rawRequest === 'string' ? obj.rawRequest : '',
  };
}

export function buildRemoteServicesPrompt(availableServices: RemoteServiceDescriptor[]): string | null {
  if (!availableServices || availableServices.length === 0) return null;

  const entries = availableServices
    .map((svc) => {
      const identity = resolveServiceIdentity(svc);
      return (
        `  <remote_service>` +
        `<service_pin_id>${identity.servicePinId}</service_pin_id>` +
        `<service_name>${normalizeText(svc.displayName) || normalizeText(svc.serviceName)}</service_name>` +
        `<description>${normalizeText(svc.description)}</description>` +
        `<price_amount>${normalizeText(svc.price)}</price_amount>` +
        `<price_currency>${normalizeSpendCurrency(svc.currency)}</price_currency>` +
        `<rating_avg>${svc.ratingAvg ?? 'N/A'}</rating_avg>` +
        `<rating_count>${svc.ratingCount ?? 0}</rating_count>` +
        `<provider_global_metaid>${identity.providerGlobalMetaId}</provider_global_metaid>` +
        `</remote_service>`
      );
    })
    .join('\n');

  return (
    `\n<available_remote_services>\n` +
    `  <notice>\n` +
    `    These are remote on-chain services.\n` +
    `    If a remote service matches and the user confirms, emit [DELEGATE_REMOTE_SERVICE] plus JSON.\n` +
    `  </notice>\n` +
    entries +
    '\n' +
    `</available_remote_services>\n`
  );
}

export function planRemoteCall(input: {
  request: RemoteCallRequest;
  availableServices: RemoteServiceDescriptor[];
  sessionId?: string | null;
  traceId?: string | null;
  manualRefundRequired?: boolean;
}): RemoteCallPlanResult {
  const requestedServicePinId = normalizeCaseInsensitive(input.request.servicePinId);
  const requestedProvider = normalizeCaseInsensitive(input.request.providerGlobalMetaId);
  const service = input.availableServices.find((candidate) => {
    const identity = resolveServiceIdentity(candidate);
    return (
      normalizeCaseInsensitive(identity.servicePinId) === requestedServicePinId
      && normalizeCaseInsensitive(identity.providerGlobalMetaId) === requestedProvider
    );
  });

  const traceId = buildRemoteCallTraceId({
    request: input.request,
    traceId: input.traceId,
  });
  const session = buildRemoteCallSessionLinkage({
    providerGlobalMetaId: input.request.providerGlobalMetaId,
    traceId,
    sessionId: input.sessionId,
  });

  if (!service) {
    return {
      ok: false,
      state: 'offline',
      code: 'service_offline',
      message: 'Remote service is offline or unavailable.',
      traceId,
      session,
    };
  }

  const normalizedTerms = normalizeDelegationPaymentTerms(service.price, service.currency);
  const normalizedCurrency = normalizeSpendCurrency(normalizedTerms.currency);
  const spendDecision = evaluateSpendCap({
    price: normalizedTerms.price || '0',
    currency: normalizedCurrency,
    spendCap: input.request.spendCap,
  });
  if (!spendDecision.allowed) {
    return {
      ok: false,
      state: 'blocked',
      code: spendDecision.code || 'remote_call_blocked',
      message: spendDecision.reason || 'Remote call is blocked.',
      traceId,
      session,
    };
  }

  if (input.manualRefundRequired) {
    return {
      ok: false,
      state: 'manual_action_required',
      code: 'manual_refund_required',
      message: 'Manual refund confirmation is required before continuing.',
      traceId,
      session,
    };
  }

  return {
    ok: true,
    state: 'ready',
    code: 'remote_call_ready',
    service: {
      servicePinId: resolveServiceIdentity(service).servicePinId,
      providerGlobalMetaId: resolveServiceIdentity(service).providerGlobalMetaId,
      serviceName: normalizeText(service.displayName) || normalizeText(service.serviceName),
      price: normalizedTerms.price || '0',
      currency: normalizedCurrency,
    },
    payment: {
      amount: normalizedTerms.price || '0',
      currency: normalizedCurrency,
    },
    traceId,
    session,
  };
}
