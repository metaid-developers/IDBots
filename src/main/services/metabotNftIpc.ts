import type { MetabotStore } from '../metabotStore';
import type {
  MetabotMrc721TransferInput,
  MetabotMvcNftTransferInput,
  MetabotNftKind,
  MetabotNftListItem,
} from './metabotNftService';

type RegisterIpcHandlerFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

interface RegisterMetabotNftIpcHandlersDeps {
  registerIpcHandler: RegisterIpcHandlerFn;
  getMetabotStore: () => MetabotStore;
  getMetabotNftItems: (
    store: MetabotStore,
    input: { metabotId: number; kind: MetabotNftKind },
  ) => Promise<MetabotNftListItem[]>;
  transferMetabotMvcNft: (
    store: MetabotStore,
    input: MetabotMvcNftTransferInput,
  ) => Promise<{ txId: string; rawTx: string }>;
  transferMetabotMrc721: (
    store: MetabotStore,
    input: MetabotMrc721TransferInput,
  ) => Promise<{ txId: string; pinId: string; toAddress: string; spentOutpoint: string; outputValue: number }>;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

function normalizeMetabotId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  return id;
}

export function registerMetabotNftIpcHandlers(deps: RegisterMetabotNftIpcHandlersDeps): void {
  deps.registerIpcHandler(
    'idbots:getMetabotNfts',
    async (_event, input: { metabotId: number; kind: MetabotNftKind }) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const kind = input?.kind;
        if (kind !== 'mrc721' && kind !== 'metacontract') {
          return { success: false, error: "kind must be 'mrc721' or 'metacontract'" };
        }
        const items = await deps.getMetabotNftItems(deps.getMetabotStore(), { metabotId, kind });
        return { success: true, items };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  deps.registerIpcHandler(
    'idbots:transferMetabotMvcNft',
    async (_event, input: MetabotMvcNftTransferInput) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const result = await deps.transferMetabotMvcNft(deps.getMetabotStore(), { ...input, metabotId });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  deps.registerIpcHandler(
    'idbots:transferMetabotMrc721',
    async (_event, input: MetabotMrc721TransferInput) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const result = await deps.transferMetabotMrc721(deps.getMetabotStore(), { ...input, metabotId });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );
}
