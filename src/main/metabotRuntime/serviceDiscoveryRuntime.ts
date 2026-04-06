import {
  syncRemoteSkillServicesWithCursor,
  type ParsedRemoteSkillServiceRow,
  type RemoteSkillServicePage,
} from '../services/gigSquareRemoteServiceSync';
import {
  filterServicesByDiscoverySnapshot,
  type DiscoveryServiceCandidate,
  type DiscoverySnapshot,
} from '../services/providerDiscoveryService';

export interface PortableServiceDiscoveryProvider {
  getDiscoverySnapshot(): Pick<DiscoverySnapshot, 'availableServices'>;
}

export interface SyncPortableServiceCatalogInput {
  pageSize: number;
  maxPages?: number;
  fetchPage: (cursor?: string) => Promise<RemoteSkillServicePage>;
  upsertMirroredService: (row: ParsedRemoteSkillServiceRow) => void;
}

export interface ListCallablePortableServicesInput<T extends DiscoveryServiceCandidate>
  extends SyncPortableServiceCatalogInput {
  listMirroredServices: () => T[];
  providerDiscovery: PortableServiceDiscoveryProvider;
}

export async function syncPortableServiceCatalog(
  input: SyncPortableServiceCatalogInput,
): Promise<void> {
  await syncRemoteSkillServicesWithCursor({
    pageSize: input.pageSize,
    maxPages: input.maxPages,
    fetchPage: input.fetchPage,
    upsertService: (row) => {
      input.upsertMirroredService(row);
    },
  });
}

export async function listCallablePortableServices<T extends DiscoveryServiceCandidate>(
  input: ListCallablePortableServicesInput<T>,
): Promise<T[]> {
  await syncPortableServiceCatalog({
    pageSize: input.pageSize,
    maxPages: input.maxPages,
    fetchPage: input.fetchPage,
    upsertMirroredService: input.upsertMirroredService,
  });

  return filterServicesByDiscoverySnapshot(
    input.listMirroredServices(),
    input.providerDiscovery.getDiscoverySnapshot(),
  );
}
