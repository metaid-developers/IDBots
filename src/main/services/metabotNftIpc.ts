import type { MetabotStore } from '../metabotStore';
import {
  isAvatarNormalizeFailure,
  normalizeAvatarToDataUrl,
  type AvatarNormalizeResult,
} from '../utils/avatarNormalize';
import type {
  MetabotMrc721TransferInput,
  MetabotMvcNftTransferInput,
  MetabotNftKind,
  MetabotNftListItem,
} from './metabotNftService';
import type { NftCaRegistry } from './nftCaService';

type RegisterIpcHandlerFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

/** One local MRC-721 atomic-swap listing record, refreshed per read. */
export interface MetabotMrc721SellOrderView {
  id: string;
  status: 'valid' | 'invalid' | 'expired';
  reason?: string;
  itemPinId: string;
  buyerAddress: string;
  priceSats: number;
  outpoint: string;
}

/** Read-only summary of a verified listing (idbots:verifyMrc721Listing ok:true). */
export interface MetabotMrc721ListingSummary {
  itemPinId: string;
  collectionPinId: string;
  sellerAddress: string;
  buyerAddress: string;
  priceSats: number;
  outpoint: string;
  createdAt: number;
  expiresAt: number;
  feeRate: number;
}

export interface MetabotMrc721SellResult {
  listingJson: string;
  itemPinId: string;
  buyerAddress: string;
  priceSats: number;
  outpoint: string;
}

export interface MetabotMrc721BuyResult {
  txId: string;
  itemPinId: string;
  priceSats: number;
  sellerAddress: string;
  feeSats: number;
  feeRateEffective: number;
}

/** Result shape of the shared metabot update core (the metabot:update path). */
interface MetabotAvatarUpdateResult {
  success: boolean;
  metabot?: unknown;
  sync?: unknown;
  error?: string;
}

export interface MetabotSetNftAvatarInput {
  metabotId: number;
  /** `metafile://<pinId>[.ext]`, a bare pinId, or an https artwork URL (MetaContract). */
  imageRef: string;
}

export interface MetabotSetNftAvatarResult {
  success: boolean;
  metabot?: unknown;
  /**
   * Normalized snapshot facts. The chain info-pin only accepts a data URL
   * (`metaidCore.buildEditAvatarSyncStep`), so the avatar is stored as a
   * snapshot of the NFT artwork — the reference itself never reaches the chain.
   */
  avatar?: { mime: string; bytes: number; source: string };
  /** On-chain sync outcome of the avatar step (same shape as metabot:update). */
  sync?: unknown;
  /** Structured normalization failure reason when the artwork could not be used. */
  reason?: string;
  detail?: string;
  error?: string;
}

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
  getNftCaRegistry: (input: { refresh?: boolean }) => Promise<NftCaRegistry>;
  /** Avatar normalizer (defaults to the real one; injectable for tests). */
  normalizeAvatar?: (source: string | null | undefined) => Promise<AvatarNormalizeResult>;
  /** Existing metabot-update path (updateMetaBotCore) — same write + chain sync as metabot:update. */
  updateMetabotAvatar?: (metabotId: number, input: { avatar: string }) => Promise<MetabotAvatarUpdateResult>;
  // MRC-721 atomic-swap trade (MetaBot NFT wallet modal). Same service deps
  // as the mrc721_sell/mrc721_buy agent-tool backends minus the agent-tool
  // chain-write budget — UI money movement like idbots:transferMetabotMrc721
  // does not budget either.
  sellMrc721Listing: (
    store: MetabotStore,
    input: { metabotId: number; itemPinId: string; buyerAddress: string; priceSats: number },
  ) => Promise<MetabotMrc721SellResult>;
  buyMrc721Listing: (
    store: MetabotStore,
    input: { metabotId: number; listing: unknown },
  ) => Promise<MetabotMrc721BuyResult>;
  listMrc721SellOrders: (store: MetabotStore, metabotId: number) => Promise<MetabotMrc721SellOrderView[]>;
  verifyMrc721Listing: (listing: unknown) => Promise<{
    itemPinId: string;
    collectionPinId: string;
    sellerAddress: string;
    buyerAddress: string;
    priceSats: number;
    outpoint: { txid: string; vout: number; satoshis: number };
    createdAt: number;
    expiresAt: number;
    feeRate: number;
  }>;
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

/**
 * Pulls the "check N (...)" marker out of an mrc721ListingError message
 * ("MRC-721 listing failed check 4 (unspent): ..."); non-listing errors fall
 * back to 'unknown'.
 */
function extractListingCheck(message: string): string {
  const match = /MRC-721 listing failed (check [^:]+):/.exec(message);
  return match ? match[1] : 'unknown';
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

  // MRC-721 atomic-swap listing creation (MetaBot NFT wallet "sell" flow):
  // builds + seller-signs the partial transaction and records the listing
  // locally. Nothing is broadcast — the buyer completes the swap.
  deps.registerIpcHandler(
    'idbots:sellMrc721Listing',
    async (_event, input: { metabotId: number; itemPinId: string; buyerAddress: string; priceSats: number }) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const priceSats = Number(input?.priceSats);
        if (!Number.isInteger(priceSats) || priceSats <= 0) {
          return { success: false, error: 'priceSats must be a positive integer' };
        }
        const result = await deps.sellMrc721Listing(deps.getMetabotStore(), {
          metabotId,
          itemPinId: String(input?.itemPinId ?? ''),
          buyerAddress: String(input?.buyerAddress ?? ''),
          priceSats,
        });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  // MRC-721 atomic-swap purchase (MetaBot NFT wallet "buy" flow): verifies
  // the five listing checks, enforces the buyer lock, then completes and
  // broadcasts the swap transaction.
  deps.registerIpcHandler(
    'idbots:buyMrc721Listing',
    async (_event, input: { metabotId: number; listing: unknown }) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const result = await deps.buyMrc721Listing(deps.getMetabotStore(), {
          metabotId,
          listing: input?.listing,
        });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  // Local sell-order records for one bot, each re-verified on read (status
  // valid/invalid/expired plus the failing check as reason). Read-only.
  deps.registerIpcHandler(
    'idbots:listMrc721SellOrders',
    async (_event, input: { metabotId: number }) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const orders = await deps.listMrc721SellOrders(deps.getMetabotStore(), metabotId);
        return { success: true, orders };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  // Read-only pre-buy listing check (checks 1–5). Never throws raw: shape,
  // ownership and node/indexer hiccups all surface as ok:false with the
  // failing check name, so the modal can block before the money step.
  deps.registerIpcHandler(
    'idbots:verifyMrc721Listing',
    async (_event, input: { listing: unknown }) => {
      try {
        const listing = await deps.verifyMrc721Listing(input?.listing);
        return {
          success: true,
          result: {
            ok: true,
            listing: {
              itemPinId: listing.itemPinId,
              collectionPinId: listing.collectionPinId,
              sellerAddress: listing.sellerAddress,
              buyerAddress: listing.buyerAddress,
              priceSats: listing.priceSats,
              outpoint: `${listing.outpoint.txid}:${listing.outpoint.vout}`,
              createdAt: listing.createdAt,
              expiresAt: listing.expiresAt,
              feeRate: listing.feeRate,
            } satisfies MetabotMrc721ListingSummary,
          },
        };
      } catch (error) {
        const message = getErrorMessage(error);
        return { success: true, result: { ok: false, check: extractListingCheck(message), error: message } };
      }
    },
  );

  // Read-only CA registry read for the NFT-avatar certified badge. The
  // reader itself degrades to an empty/verified:false registry and never
  // throws; `refresh: true` bypasses the main-process TTL cache.
  deps.registerIpcHandler(
    'idbots:getNftCaRegistry',
    async (_event, input: { refresh?: boolean }) => {
      try {
        const registry = await deps.getNftCaRegistry({ refresh: input?.refresh === true });
        return { success: true, registry };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  /**
   * "Use this NFT as the bot avatar" — the backing mechanism behind the one
   * NFT-avatar entry (MetaBotNftAvatarPickerModal). The artwork reference is
   * normalized to a data-URL snapshot HERE (main process: metafile:// resolves
   * thumbnail-first with a 200 KB structured cap) and then flows through the
   * exact same updateMetaBotCore path as metabot:update, so the local row, the
   * avatar_blob column and the on-chain /info/avatar info-pin stay consistent.
   * Every failure is a structured payload — the picker renders it instead of
   * throwing.
   */
  deps.registerIpcHandler(
    'metabot:setNftAvatar',
    async (_event, input: MetabotSetNftAvatarInput): Promise<MetabotSetNftAvatarResult> => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const imageRef = typeof input?.imageRef === 'string' ? input.imageRef.trim() : '';
        if (!imageRef) {
          return {
            success: false,
            reason: 'empty',
            error: 'imageRef is required (metafile://<pinId>, a bare pinId, or an https artwork URL)',
          };
        }

        const normalizeAvatar = deps.normalizeAvatar ?? ((source) => normalizeAvatarToDataUrl(source));
        const normalized = await normalizeAvatar(imageRef);
        if (isAvatarNormalizeFailure(normalized)) {
          return {
            success: false,
            reason: normalized.reason,
            detail: normalized.detail,
            error: `${normalized.reason}: ${normalized.detail}`,
          };
        }

        if (!deps.updateMetabotAvatar) {
          return {
            success: false,
            reason: 'update-unavailable',
            error: 'The MetaBot avatar update path is not wired on this host',
          };
        }

        const updated = await deps.updateMetabotAvatar(metabotId, { avatar: normalized.dataUrl });
        if (!updated?.success) {
          return {
            success: false,
            reason: 'update-failed',
            error: updated?.error || 'Failed to update the MetaBot avatar',
          };
        }

        return {
          success: true,
          metabot: updated.metabot,
          sync: updated.sync,
          avatar: { mime: normalized.mime, bytes: normalized.bytes, source: normalized.source },
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );
}
