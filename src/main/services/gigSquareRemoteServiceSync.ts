type RemoteSkillServiceItem = Record<string, unknown>;
const DEFAULT_REMOTE_SKILL_SERVICE_SYNC_MAX_PAGES = 1000;

export type ParsedRemoteSkillServiceRow = {
  id: string;
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

export const parseRemoteSkillServiceItem = (item: RemoteSkillServiceItem): ParsedRemoteSkillServiceRow | null => {
  const id = toSafeString(item.id).trim();
  const summary = parseGigSquareContentSummary(item.contentSummary);
  if (!summary) return null;
  const serviceName = toSafeString(summary.serviceName).trim();
  const displayName = toSafeString(summary.displayName).trim() || serviceName || 'Service';
  const description = toSafeString(summary.description).trim();
  const price = toSafeString(summary.price).trim() || '0';
  const currency = toSafeString(summary.currency || summary.priceUnit).trim();
  const providerMetaId = toSafeString(item.metaid || item.createMetaId).trim();
  const providerGlobalMetaId = toSafeString(item.globalMetaId).trim();
  const paymentAddress = toSafeString(summary.paymentAddress).trim();
  const providerAddress = paymentAddress || toSafeString(item.address || item.addres).trim();
  const avatar = typeof summary.avatar === 'string' ? summary.avatar : null;
  const serviceIcon = typeof summary.serviceIcon === 'string' ? summary.serviceIcon.trim() || null : null;
  if (!serviceName || !providerMetaId || !providerAddress) return null;
  const providerMetaBot = toSafeString((summary as Record<string, unknown>).providerMetaBot).trim();
  const providerSkill = toSafeString((summary as Record<string, unknown>).providerSkill).trim();
  const skillDocument = toSafeString((summary as Record<string, unknown>).skillDocument).trim();
  const inputType = toSafeString((summary as Record<string, unknown>).inputType).trim();
  const outputType = toSafeString((summary as Record<string, unknown>).outputType).trim();
  const endpoint = toSafeString((summary as Record<string, unknown>).endpoint).trim();
  const itemTimestamp = typeof item.timestamp === 'number' && item.timestamp > 0
    ? item.timestamp
    : Date.now();
  const contentSummaryJson = JSON.stringify(summary);
  return {
    id: id || serviceName,
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
    paymentAddress: paymentAddress || providerAddress,
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
      ?? row.paymentAddress
      ?? row.payment_address
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
    ratingAvg: ratingAvgRaw == null ? undefined : toSafeNumber(ratingAvgRaw),
    ratingCount: ratingCountRaw == null ? undefined : toSafeNumber(ratingCountRaw),
    updatedAt: updatedAtRaw == null ? undefined : toSafeNumber(updatedAtRaw),
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
