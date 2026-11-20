import {
  getNftCaRegistry,
  type NftCaOfficialBotEntry,
  type NftCaRegistry,
  type NftCaSwapSeriesConfig,
} from './nftCaService';

export interface VerifyOfficialSwapStationInput {
  stationGlobalMetaId: string;
  vaultAddress: string;
  codehash: string;
  genesis: string;
  refresh?: boolean;
}

export type VerifyOfficialSwapStationResult =
  | {
      verified: true;
      stationEntry: NftCaOfficialBotEntry;
      seriesConfig: NftCaSwapSeriesConfig;
      registryPinId: string | null;
      badgeType: string;
      badgeLabel: string;
    }
  | {
      verified: false;
      reason: string;
      registryPinId: string | null;
    };

export interface VerifyOfficialEscrowGuarantorInput {
  guarantorGlobalMetaId: string;
  custodyAddress?: string;
  refresh?: boolean;
}

export type VerifyOfficialEscrowGuarantorResult =
  | {
      verified: true;
      guarantorEntry: NftCaOfficialBotEntry;
      registryPinId: string | null;
      badgeType: string;
      badgeLabel: string;
    }
  | {
      verified: false;
      reason: string;
      registryPinId: string | null;
    };

export interface OfficialBotVerifyDeps {
  getRegistry?: (options?: { refresh?: boolean }) => Promise<NftCaRegistry>;
}

function evaluateSwapStationAgainstRegistry(
  registry: NftCaRegistry,
  input: VerifyOfficialSwapStationInput,
): VerifyOfficialSwapStationResult {
  if (!registry.verified) {
    return {
      verified: false,
      reason: registry.detail || 'Official IDBots CA registry is not verified.',
      registryPinId: registry.pinId,
    };
  }

  const stationGlobalMetaId = String(input.stationGlobalMetaId ?? '').trim();
  const vaultAddress = String(input.vaultAddress ?? '').trim();
  const codehash = String(input.codehash ?? '').trim().toLowerCase();
  const genesis = String(input.genesis ?? '').trim().toLowerCase();

  if (!stationGlobalMetaId || !vaultAddress || !codehash || !genesis) {
    return {
      verified: false,
      reason: 'Missing required verification fields (stationGlobalMetaId, vaultAddress, codehash, genesis).',
      registryPinId: registry.pinId,
    };
  }

  const station = registry.officialBots.find(
    (entry) => entry.role === 'swap_station' && entry.globalMetaId.trim() === stationGlobalMetaId,
  );
  if (!station) {
    return {
      verified: false,
      reason: `Station ${stationGlobalMetaId} is not certified as an official swap_station in CA registry.`,
      registryPinId: registry.pinId,
    };
  }

  if (station.active !== true) {
    return {
      verified: false,
      reason: `Official swap_station ${stationGlobalMetaId} has been revoked (active !== true).`,
      registryPinId: registry.pinId,
    };
  }

  if (!station.swapConfig || station.swapConfig.vaultAddress.trim() !== vaultAddress) {
    return {
      verified: false,
      reason: 'Station vaultAddress does not match official CA swapConfig.vaultAddress.',
      registryPinId: registry.pinId,
    };
  }

  const seriesConfig = station.swapConfig.supportedSeries.find(
    (series) =>
      series.codehash.trim().toLowerCase() === codehash &&
      series.genesis.trim().toLowerCase() === genesis,
  );
  if (!seriesConfig) {
    return {
      verified: false,
      reason: `Series (${codehash}, ${genesis}) is not supported by official swap_station ${stationGlobalMetaId}.`,
      registryPinId: registry.pinId,
    };
  }

  return {
    verified: true,
    stationEntry: station,
    seriesConfig,
    registryPinId: registry.pinId,
    badgeType: station.badgeType,
    badgeLabel: station.badgeLabel,
  };
}

function evaluateEscrowGuarantorAgainstRegistry(
  registry: NftCaRegistry,
  input: VerifyOfficialEscrowGuarantorInput,
): VerifyOfficialEscrowGuarantorResult {
  if (!registry.verified) {
    return {
      verified: false,
      reason: registry.detail || 'Official IDBots CA registry is not verified.',
      registryPinId: registry.pinId,
    };
  }

  const guarantorGlobalMetaId = String(input.guarantorGlobalMetaId ?? '').trim();
  if (!guarantorGlobalMetaId) {
    return {
      verified: false,
      reason: 'Missing guarantorGlobalMetaId.',
      registryPinId: registry.pinId,
    };
  }

  const guarantor = registry.officialBots.find(
    (entry) => entry.role === 'escrow_guarantor' && entry.globalMetaId.trim() === guarantorGlobalMetaId,
  );
  if (!guarantor) {
    return {
      verified: false,
      reason: `Guarantor ${guarantorGlobalMetaId} is not certified as an official escrow_guarantor in CA registry.`,
      registryPinId: registry.pinId,
    };
  }

  if (guarantor.active !== true) {
    return {
      verified: false,
      reason: `Official escrow_guarantor ${guarantorGlobalMetaId} has been revoked (active !== true).`,
      registryPinId: registry.pinId,
    };
  }

  if (input.custodyAddress !== undefined) {
    const custodyAddress = String(input.custodyAddress).trim();
    if (!guarantor.escrowConfig || guarantor.escrowConfig.custodyAddress.trim() !== custodyAddress) {
      return {
        verified: false,
        reason: 'Guarantor custodyAddress does not match official CA escrowConfig.custodyAddress.',
        registryPinId: registry.pinId,
      };
    }
  }

  return {
    verified: true,
    guarantorEntry: guarantor,
    registryPinId: registry.pinId,
    badgeType: guarantor.badgeType,
    badgeLabel: guarantor.badgeLabel,
  };
}

/**
 * Hard-verify an official swap station against the CA trust root.
 * Fail-closed: if the cached registry rejects (or is stale), tries one fresh
 * fetch when `refresh` is not explicitly `false`, and still fails closed if
 * any check does not pass.
 */
export async function verifyOfficialSwapStation(
  input: VerifyOfficialSwapStationInput,
  deps: OfficialBotVerifyDeps = {},
): Promise<VerifyOfficialSwapStationResult> {
  const getRegistry = deps.getRegistry ?? getNftCaRegistry;
  try {
    const first = await getRegistry(input.refresh === true ? { refresh: true } : undefined);
    const firstResult = evaluateSwapStationAgainstRegistry(first, input);
    if (firstResult.verified || input.refresh !== undefined) {
      return firstResult;
    }
    const refreshed = await getRegistry({ refresh: true });
    return evaluateSwapStationAgainstRegistry(refreshed, input);
  } catch (error) {
    return {
      verified: false,
      reason: `CA verification failed: ${error instanceof Error ? error.message : String(error)}`,
      registryPinId: null,
    };
  }
}

/**
 * Hard-verify an official escrow guarantor against the CA trust root.
 * Fail-closed on unverified registry, missing entry, revoked entry, or
 * custodyAddress mismatch.
 */
export async function verifyOfficialEscrowGuarantor(
  input: VerifyOfficialEscrowGuarantorInput,
  deps: OfficialBotVerifyDeps = {},
): Promise<VerifyOfficialEscrowGuarantorResult> {
  const getRegistry = deps.getRegistry ?? getNftCaRegistry;
  try {
    const first = await getRegistry(input.refresh === true ? { refresh: true } : undefined);
    const firstResult = evaluateEscrowGuarantorAgainstRegistry(first, input);
    if (firstResult.verified || input.refresh !== undefined) {
      return firstResult;
    }
    const refreshed = await getRegistry({ refresh: true });
    return evaluateEscrowGuarantorAgainstRegistry(refreshed, input);
  } catch (error) {
    return {
      verified: false,
      reason: `CA verification failed: ${error instanceof Error ? error.message : String(error)}`,
      registryPinId: null,
    };
  }
}

/**
 * List active verified official swap stations from the CA registry.
 * Returns an empty array when the registry itself is not verified.
 */
export async function listVerifiedOfficialSwapStations(
  options?: { refresh?: boolean },
  deps: OfficialBotVerifyDeps = {},
): Promise<{ verified: boolean; registryPinId: string | null; stations: NftCaOfficialBotEntry[] }> {
  const getRegistry = deps.getRegistry ?? getNftCaRegistry;
  try {
    const registry = await getRegistry(options);
    if (!registry.verified) {
      return { verified: false, registryPinId: registry.pinId, stations: [] };
    }
    const stations = registry.officialBots.filter(
      (entry) => entry.role === 'swap_station' && entry.active === true && !!entry.swapConfig,
    );
    return { verified: true, registryPinId: registry.pinId, stations };
  } catch {
    return { verified: false, registryPinId: null, stations: [] };
  }
}
