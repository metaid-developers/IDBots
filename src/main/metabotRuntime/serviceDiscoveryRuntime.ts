import { filterServicesByDiscoverySnapshot } from '../services/providerDiscoveryService';
import type { ParsedRemoteSkillServiceRow } from '../services/gigSquareRemoteServiceSync';

export interface PortableServiceDiscoverySnapshot {
  availableServices: Array<Record<string, unknown>>;
}

export interface SyncPortableServiceCatalogInput {
  syncRemoteServices(input: {
    upsertService: (row: ParsedRemoteSkillServiceRow) => void;
  }): Promise<void>;
  upsertService?: (row: ParsedRemoteSkillServiceRow) => void;
}

export interface ListCallablePortableServicesInput<T extends Record<string, unknown>> {
  syncRemoteServices: SyncPortableServiceCatalogInput['syncRemoteServices'];
  upsertService?: SyncPortableServiceCatalogInput['upsertService'];
  listSyncedServices: () => T[];
  getDiscoverySnapshot: () => PortableServiceDiscoverySnapshot;
}

export async function syncPortableServiceCatalog(
  input: SyncPortableServiceCatalogInput,
): Promise<void> {
  await input.syncRemoteServices({
    upsertService: (row) => {
      input.upsertService?.(row);
    },
  });
}

export async function listCallablePortableServices<T extends Record<string, unknown>>(
  input: ListCallablePortableServicesInput<T>,
): Promise<T[]> {
  await syncPortableServiceCatalog({
    syncRemoteServices: input.syncRemoteServices,
    upsertService: input.upsertService,
  });

  return filterServicesByDiscoverySnapshot(
    input.listSyncedServices(),
    input.getDiscoverySnapshot(),
  );
}
