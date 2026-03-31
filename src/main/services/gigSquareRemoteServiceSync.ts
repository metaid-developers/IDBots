type RemoteSkillServiceItem = Record<string, unknown>;
const DEFAULT_REMOTE_SKILL_SERVICE_SYNC_MAX_PAGES = 1000;
const UNIX_SECONDS_MAX = 10_000_000_000;

export type ParsedRemoteSkillServiceRow = {
  id: string;
  pinId: string;
  serviceName: string;
  displayName: string;
  description: string;
  price: string;
  currency: string;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
  avatar?: string | null;
  serviceIcon?: string | null;
  providerMetaBot?: string | null;
  providerSkill?: string | null;
  skillDocument?: string | null;
  inputType?: string | null;
  outputType?: string | null;
  endpoint?: string | null;
  contentSummaryJson?: string | null;
  paymentAddress?: string | null;
  status: number;
  operation: string;
  path?: string | null;
  originalId?: string | null;
  createAddress?: string | null;
  sourceServicePinId: string;
  available: number;
  updatedAt?: number;
  ratingAvg?: number;
  ratingCount?: number;
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

const normalizeTimestampMs = (value: unknown): number => {
  const parsed = toSafeNumber(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed < UNIX_SECONDS_MAX ? Math.trunc(parsed * 1000) : Math.trunc(parsed);
};

const normalizeOperation = (value: unknown): string => {
  const normalized = toSafeString(value).trim().toLowerCase();
  return normalized || 'create';
};

const normalizePath = (value: unknown): string | null => {
  const normalized = toSafeString(value).trim();
  return normalized || null;
};

const hasValidGigSquareOperation = (value: unknown): boolean => {
  const normalized = toSafeString(value).trim().toLowerCase();
  return normalized === 'create' || normalized === 'modify' || normalized === 'revoke';
};

const extractSourceServicePinId = (input: {
  pinId: string;
  operation: string;
  path: string | null;
  originalId: string | null;
}): string => {
  if (input.operation === 'create') {
    return input.pinId;
  }
  const pathTarget = input.path?.startsWith('@') ? input.path.slice(1).trim() : '';
  if (pathTarget) {
    return pathTarget;
  }
  if (input.originalId && !input.originalId.startsWith('/')) {
    return input.originalId;
  }
  return input.pinId;
};

const parseGigSquareContentSummary = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
};

const getRemoteSkillServiceList = (payload: unknown): RemoteSkillServiceItem[] => {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return [];
  }
  const list = (data as { list?: unknown }).list;
  return Array.isArray(list) ? list as RemoteSkillServiceItem[] : [];
};

export const isRemoteSkillServiceListSemanticMiss = (payload: unknown): boolean => {
  const list = getRemoteSkillServiceList(payload);
  if (list.length === 0) {
    return true;
  }
  const sample = list.slice(0, Math.min(list.length, 5));
  const hasChainMetadata = sample.some((item) => {
    const record = item as Record<string, unknown>;
    const operation = record.operation ?? record.Operation;
    const status = record.status ?? record.Status;
    return hasValidGigSquareOperation(operation) && Number.isFinite(Number(status));
  });
  return !hasChainMetadata;
};

export const parseRemoteSkillServiceItem = (item: RemoteSkillServiceItem): ParsedRemoteSkillServiceRow | null => {
  const id = toSafeString(item.id).trim();
  const pinId = id;
  const status = Math.trunc(toSafeNumber(item.status ?? 0));
  const operation = normalizeOperation((item as Record<string, unknown>).operation ?? (item as Record<string, unknown>).Operation);
  const path = normalizePath(item.path);
  const originalId = normalizePath(
    item.originalId
    ?? item.originalID
    ?? item.originalPinId
    ?? item.original_pin_id
  );
  const createAddress = toSafeString(item.createAddress ?? item.create_address ?? item.address).trim() || null;
  const sourceServicePinId = extractSourceServicePinId({
    pinId,
    operation,
    path,
    originalId,
  });
  const itemTimestamp = normalizeTimestampMs(item.timestamp) || Date.now();
  const summary = parseGigSquareContentSummary(item.contentSummary);
  const providerMetaId = toSafeString(item.metaid || item.createMetaId).trim();
  const providerGlobalMetaId = toSafeString(
    item.globalMetaId
    || (summary as Record<string, unknown> | null)?.providerMetaBot
  ).trim();
  const paymentAddress = toSafeString((summary as Record<string, unknown> | null)?.paymentAddress).trim();
  const providerAddress = createAddress || toSafeString(item.address || item.addres).trim();
  if (!summary) {
    if (operation !== 'revoke') return null;
    return {
      id: pinId || sourceServicePinId || 'revoked-service',
      pinId: pinId || sourceServicePinId || 'revoked-service',
      serviceName: sourceServicePinId || pinId || 'revoked-service',
      displayName: 'Revoked service',
      description: '',
      price: '0',
      currency: '',
      providerMetaId,
      providerGlobalMetaId,
      providerAddress,
      avatar: null,
      serviceIcon: null,
      providerMetaBot: providerGlobalMetaId || null,
      providerSkill: null,
      skillDocument: null,
      inputType: null,
      outputType: null,
      endpoint: null,
      contentSummaryJson: null,
      paymentAddress: paymentAddress || null,
      status,
      operation,
      path,
      originalId,
      createAddress,
      sourceServicePinId,
      available: 0,
      updatedAt: itemTimestamp,
    };
  }
  const serviceName = toSafeString(summary.serviceName).trim();
  const displayName = toSafeString(summary.displayName).trim() || serviceName || 'Service';
  const description = toSafeString(summary.description).trim();
  const price = toSafeString(summary.price).trim() || '0';
  const currency = toSafeString(summary.currency || summary.priceUnit).trim();
  const avatar = typeof summary.avatar === 'string' ? summary.avatar : null;
  const serviceIcon = typeof summary.serviceIcon === 'string' ? summary.serviceIcon.trim() || null : null;
  if (!serviceName || !providerMetaId || !providerAddress) return null;
  const providerMetaBot = toSafeString((summary as Record<string, unknown>).providerMetaBot).trim();
  const providerSkill = toSafeString((summary as Record<string, unknown>).providerSkill).trim();
  const skillDocument = toSafeString((summary as Record<string, unknown>).skillDocument).trim();
  const inputType = toSafeString((summary as Record<string, unknown>).inputType).trim();
  const outputType = toSafeString((summary as Record<string, unknown>).outputType).trim();
  const endpoint = toSafeString((summary as Record<string, unknown>).endpoint).trim();
  const contentSummaryJson = JSON.stringify(summary);
  return {
    id: pinId || serviceName,
    pinId: pinId || serviceName,
    serviceName,
    displayName,
    description,
    price,
    currency,
    providerMetaId,
    providerGlobalMetaId,
    providerAddress,
    avatar,
    serviceIcon,
    providerMetaBot: providerMetaBot || null,
    providerSkill: providerSkill || null,
    skillDocument: skillDocument || null,
    inputType: inputType || null,
    outputType: outputType || null,
    endpoint: endpoint || null,
    contentSummaryJson: contentSummaryJson || null,
    paymentAddress: paymentAddress || null,
    status,
    operation,
    path,
    originalId,
    createAddress,
    sourceServicePinId,
    available: status < 0 ? 0 : 1,
    updatedAt: itemTimestamp,
  };
};

export const parseRemoteSkillServiceRow = (row: Record<string, unknown>): ParsedRemoteSkillServiceRow => {
  const ratingAvgRaw = row.ratingAvg ?? row.rating_avg;
  const ratingCountRaw = row.ratingCount ?? row.rating_count;
  const updatedAtRaw = row.updatedAt ?? row.updated_at;
  return {
    id: toSafeString(row.id).trim(),
    serviceName: toSafeString(row.serviceName ?? row.service_name).trim(),
    displayName: toSafeString(row.displayName ?? row.display_name).trim(),
    description: toSafeString(row.description).trim(),
    price: toSafeString(row.price).trim(),
    currency: toSafeString(row.currency).trim(),
    providerMetaId: toSafeString(row.providerMetaId ?? row.metaid).trim(),
    providerGlobalMetaId: toSafeString(row.providerGlobalMetaId ?? row.global_metaid).trim(),
    providerAddress: toSafeString(
      row.providerAddress
      ?? row.createAddress
      ?? row.create_address
      ?? row.address
    ).trim(),
    avatar: toSafeString(row.avatar).trim() || undefined,
    serviceIcon: toSafeString(row.serviceIcon ?? row.service_icon).trim() || undefined,
    providerMetaBot: toSafeString(row.providerMetaBot ?? row.provider_meta_bot).trim() || undefined,
    providerSkill: toSafeString(row.providerSkill ?? row.provider_skill).trim() || undefined,
    skillDocument: toSafeString(row.skillDocument ?? row.skill_document).trim() || undefined,
    inputType: toSafeString(row.inputType ?? row.input_type).trim() || undefined,
    outputType: toSafeString(row.outputType ?? row.output_type).trim() || undefined,
    endpoint: toSafeString(row.endpoint).trim() || undefined,
    contentSummaryJson: toSafeString(row.contentSummaryJson ?? row.content_summary_json).trim() || undefined,
    paymentAddress: toSafeString(row.paymentAddress ?? row.payment_address).trim() || undefined,
    pinId: toSafeString(row.pinId ?? row.pin_id ?? row.id).trim(),
    status: Math.trunc(toSafeNumber(row.status)),
    operation: normalizeOperation(row.operation),
    path: normalizePath(row.path) ?? undefined,
    originalId: normalizePath(row.originalId ?? row.original_id) ?? undefined,
    createAddress: toSafeString(row.createAddress ?? row.create_address).trim() || undefined,
    sourceServicePinId: toSafeString(row.sourceServicePinId ?? row.source_service_pin_id ?? row.id).trim(),
    available: Math.trunc(toSafeNumber(row.available == null ? 1 : row.available)),
    ratingAvg: ratingAvgRaw == null ? undefined : toSafeNumber(ratingAvgRaw),
    ratingCount: ratingCountRaw == null ? undefined : toSafeNumber(ratingCountRaw),
    updatedAt: updatedAtRaw == null ? undefined : normalizeTimestampMs(updatedAtRaw),
  };
};

export async function syncRemoteSkillServicesWithCursor(input: {
  pageSize: number;
  maxPages?: number;
  fetchPage: (cursor?: string) => Promise<{ list: RemoteSkillServiceItem[]; nextCursor?: string | null }>;
  upsertService: (row: ParsedRemoteSkillServiceRow) => void;
}): Promise<void> {
  const maxPages = Number.isFinite(input.maxPages) && (input.maxPages as number) > 0
    ? Math.floor(input.maxPages as number)
    : DEFAULT_REMOTE_SKILL_SERVICE_SYNC_MAX_PAGES;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let pages = 0;
  do {
    if (pages >= maxPages) break;
    const page = await input.fetchPage(cursor);
    pages += 1;
    for (const item of page.list) {
      const parsed = parseRemoteSkillServiceItem(item);
      if (parsed) input.upsertService(parsed);
    }
    const nextCursor = page.nextCursor || undefined;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (true);
}
