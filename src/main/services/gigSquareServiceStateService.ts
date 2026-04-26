type ServiceLike = {
  id?: string;
  pinId?: string;
  sourceServicePinId?: string | null;
  status?: number;
  operation?: string | null;
  updatedAt?: number;
  available?: number;
};

type LocalServiceStateRecordLike = {
  id?: string;
  pinId?: string;
  sourceServicePinId?: string | null;
  currentPinId?: string | null;
  serviceName?: string;
  displayName?: string;
  description?: string;
  price?: string;
  currency?: string;
  settlementKind?: string | null;
  paymentChain?: string | null;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  providerGlobalMetaId?: string;
  providerSkill?: string | null;
  serviceIcon?: string | null;
  updatedAt?: number;
  revokedAt?: number | null;
};

type ServicePresentationLike = ServiceLike & {
  serviceName?: string;
  displayName?: string;
  description?: string;
  price?: string;
  currency?: string;
  settlementKind?: string | null;
  paymentChain?: string | null;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  providerGlobalMetaId?: string;
  providerSkill?: string | null;
  serviceIcon?: string | null;
};

export type GigSquareResolvedCurrentService<T extends ServiceLike> = T & {
  currentPinId: string;
  sourceServicePinId: string;
  chainPinIds: string[];
};

export type GigSquareServiceActionAvailability = {
  canModify: boolean;
  canRevoke: boolean;
  blockedReason: string | null;
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

const normalizePinId = (row: ServiceLike): string => {
  return toSafeString(row.pinId ?? row.id).trim();
};

const normalizeOperation = (row: ServiceLike): string => {
  const normalized = toSafeString(row.operation).trim().toLowerCase();
  return normalized || 'create';
};

const normalizeSourceServicePinId = (row: ServiceLike): string => {
  const normalized = toSafeString(row.sourceServicePinId).trim();
  return normalized || normalizePinId(row);
};

const compareRowsDesc = <T extends ServiceLike>(left: T, right: T): number => {
  const updatedSort = toSafeNumber(right.updatedAt) - toSafeNumber(left.updatedAt);
  if (updatedSort !== 0) return updatedSort;
  return normalizePinId(right).localeCompare(normalizePinId(left));
};

const compareRowsAsc = <T extends ServiceLike>(left: T, right: T): number => {
  return compareRowsDesc(right, left);
};

export const isServiceRowVisible = (row: ServiceLike): boolean => {
  if (normalizeOperation(row) === 'revoke') return false;
  const available = row.available == null ? 1 : toSafeNumber(row.available);
  if (available === 0) return false;
  const normalizedStatus = Math.trunc(toSafeNumber(row.status));
  return normalizedStatus === 0 || normalizedStatus === 1;
};

const resolveCanonicalSourcePinId = <T extends ServiceLike>(
  row: T,
  rowByPinId: Map<string, T>,
): string => {
  let currentPinId = normalizePinId(row);
  let nextPinId = normalizeSourceServicePinId(row);
  const visited = new Set<string>([currentPinId]);
  while (nextPinId && nextPinId !== currentPinId && !visited.has(nextPinId)) {
    const nextRow = rowByPinId.get(nextPinId);
    if (!nextRow) {
      return nextPinId;
    }
    visited.add(nextPinId);
    currentPinId = nextPinId;
    nextPinId = normalizeSourceServicePinId(nextRow);
  }
  return nextPinId || currentPinId;
};

export const resolveCurrentServiceChains = <T extends ServiceLike>(
  rows: T[],
): Array<GigSquareResolvedCurrentService<T>> => {
  const normalizedRows = rows.filter((row) => normalizePinId(row));
  const rowByPinId = new Map<string, T>(normalizedRows.map((row) => [normalizePinId(row), row] as const));
  const rowsBySourcePinId = new Map<string, T[]>();

  for (const row of normalizedRows) {
    const canonicalSourcePinId = resolveCanonicalSourcePinId(row, rowByPinId);
    const list = rowsBySourcePinId.get(canonicalSourcePinId) ?? [];
    list.push(row);
    rowsBySourcePinId.set(canonicalSourcePinId, list);
  }

  return [...rowsBySourcePinId.entries()]
    .map(([sourceServicePinId, sourceRows]) => {
      const sortedRows = [...sourceRows].sort(compareRowsDesc);
      const latestRow = sortedRows[0];
      if (!latestRow) return null;
      if (normalizeOperation(latestRow) === 'revoke') {
        return null;
      }
      const currentRow = sortedRows.find((row) => isServiceRowVisible(row));
      if (!currentRow) {
        return null;
      }
      const chainPinIds = [...new Set(
        [...sourceRows]
          .sort(compareRowsAsc)
          .filter((row) => normalizeOperation(row) !== 'revoke')
          .map((row) => normalizePinId(row))
          .filter(Boolean)
      )];
      return {
        ...currentRow,
        currentPinId: normalizePinId(currentRow),
        sourceServicePinId,
        chainPinIds,
      };
    })
    .filter((row): row is GigSquareResolvedCurrentService<T> => Boolean(row))
    .sort(compareRowsDesc);
};

const getLocalServicePinCandidates = (record: LocalServiceStateRecordLike): string[] => {
  return [...new Set([
    toSafeString(record.id).trim(),
    toSafeString(record.pinId).trim(),
    toSafeString(record.sourceServicePinId).trim(),
    toSafeString(record.currentPinId).trim(),
  ].filter(Boolean))];
};

const pickServiceOverrideString = (value: unknown, fallback: string | undefined): string | undefined => {
  const normalized = toSafeString(value).trim();
  return normalized || fallback;
};

export const applyLocalServiceState = <
  T extends ServicePresentationLike,
  L extends LocalServiceStateRecordLike,
>(
  services: Array<GigSquareResolvedCurrentService<T>>,
  localRecords: L[],
): Array<GigSquareResolvedCurrentService<T>> => {
  if (services.length === 0 || localRecords.length === 0) {
    return services;
  }

  const localRecordByPinId = new Map<string, L>();
  for (const localRecord of localRecords) {
    for (const pinId of getLocalServicePinCandidates(localRecord)) {
      if (!localRecordByPinId.has(pinId)) {
        localRecordByPinId.set(pinId, localRecord);
      }
    }
  }

  return services
    .map((service) => {
      const servicePinCandidates = [...new Set([
        ...service.chainPinIds,
        service.currentPinId,
        service.sourceServicePinId,
        normalizePinId(service),
      ].filter(Boolean))];
      const localRecord = servicePinCandidates
        .map((pinId) => localRecordByPinId.get(pinId))
        .find((candidate): candidate is L => Boolean(candidate));

      if (!localRecord) {
        return service;
      }
      if (toSafeNumber(localRecord.revokedAt) > 0) {
        return null;
      }

      const localPinIds = getLocalServicePinCandidates(localRecord);
      return {
        ...service,
        currentPinId: pickServiceOverrideString(localRecord.currentPinId, service.currentPinId) || service.currentPinId,
        sourceServicePinId: pickServiceOverrideString(localRecord.sourceServicePinId, service.sourceServicePinId) || service.sourceServicePinId,
        chainPinIds: [...new Set([...service.chainPinIds, ...localPinIds])],
        serviceName: pickServiceOverrideString(localRecord.serviceName, service.serviceName),
        displayName: pickServiceOverrideString(localRecord.displayName, service.displayName),
        description: pickServiceOverrideString(localRecord.description, service.description),
        price: pickServiceOverrideString(localRecord.price, service.price),
        currency: pickServiceOverrideString(localRecord.currency, service.currency),
        settlementKind: pickServiceOverrideString(localRecord.settlementKind, service.settlementKind),
        paymentChain: pickServiceOverrideString(localRecord.paymentChain, service.paymentChain),
        mrc20Ticker: pickServiceOverrideString(localRecord.mrc20Ticker, service.mrc20Ticker),
        mrc20Id: pickServiceOverrideString(localRecord.mrc20Id, service.mrc20Id),
        providerGlobalMetaId: pickServiceOverrideString(localRecord.providerGlobalMetaId, service.providerGlobalMetaId),
        providerSkill: pickServiceOverrideString(localRecord.providerSkill, service.providerSkill),
        serviceIcon: localRecord.serviceIcon == null ? service.serviceIcon : localRecord.serviceIcon,
        updatedAt: Math.max(toSafeNumber(service.updatedAt), toSafeNumber(localRecord.updatedAt)),
      };
    })
    .filter((service): service is GigSquareResolvedCurrentService<T> => Boolean(service))
    .sort(compareRowsDesc);
};

export const resolveCurrentMarketplaceServices = <
  T extends ServicePresentationLike,
  L extends LocalServiceStateRecordLike,
>(
  services: T[],
  localRecords: L[],
): Array<GigSquareResolvedCurrentService<T>> => (
  applyLocalServiceState(
    resolveCurrentServiceChains(services),
    localRecords,
  )
);

export const resolveServiceActionAvailability = (input: {
  currentService?: {
    currentPinId?: string;
    sourceServicePinId?: string;
    chainPinIds?: string[];
    status?: number;
    operation?: string | null;
    available?: number;
  } | null;
  creatorMetabotExists: boolean;
  isCurrent?: boolean;
  isRevoked?: boolean;
}): GigSquareServiceActionAvailability => {
  if (!input.currentService || input.isCurrent === false) {
    return {
      canModify: false,
      canRevoke: false,
      blockedReason: 'gigSquareMyServicesBlockedNotCurrent',
    };
  }

  const currentRow = input.currentService;
  if (input.isRevoked || !isServiceRowVisible(currentRow)) {
    return {
      canModify: false,
      canRevoke: false,
      blockedReason: 'gigSquareMyServicesBlockedRevoked',
    };
  }

  if (!input.creatorMetabotExists) {
    return {
      canModify: false,
      canRevoke: false,
      blockedReason: 'gigSquareMyServicesBlockedMissingCreatorMetabot',
    };
  }

  return {
    canModify: true,
    canRevoke: true,
    blockedReason: null,
  };
};
