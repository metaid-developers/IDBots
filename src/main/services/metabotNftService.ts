import type { MetabotStore } from '../metabotStore';
import { getMetabotAccountAddresses } from './metabotAccountService';
import {
  broadcastMvcTx,
  fetchMrc721AddressItemsPage,
  transferMrc721Item,
  type Mrc721ItemSummary,
} from './mrc721Service';
import { executeMvcNftTransfer, getMvcNftBalance, type MvcNftCollection } from './mvcNftService';
import { buildMvcTransferRawTx } from './walletRawTxService';

/**
 * MetaBot NFT wallet aggregation — one read per NFT format for the NFT Wallet
 * modal in the MetaBot edit view.
 *
 * Two formats, two sources:
 * - `mrc721`: pin-based MetaID NFTs indexed by man-p2p (`mrc721Service`),
 *   paged through `/api/mrc721/address/item` up to a hard cap and sorted by
 *   mint time (createTime) descending — the holder endpoint does not carry a
 *   per-item acquisition timestamp, so mint time is the ordering proxy.
 * - `metacontract`: sensible-contract NFTs held as MVC UTXOs
 *   (`mvcNftService.getMvcNftBalance`), flattened from per-series groups and
 *   sorted by acquiring-tx height descending — the UTXO height IS the
 *   acquisition order.
 *
 * Items come out normalized into one flat display shape; the per-format raw
 * record rides along for the detail view. Transfers reuse the existing
 * services unchanged (`executeMvcNftTransfer` / `transferMrc721Item`).
 */

export type MetabotNftKind = 'mrc721' | 'metacontract';

/** Hard cap for the MRC721 holder pagination loop (wallet-view scale guard). */
export const METABOT_NFT_MRC721_MAX_ITEMS = 500;
const MRC721_PAGE_SIZE = 100;

/** A MetaContract item with its series facts attached (detail-view payload). */
export interface MetabotMetaContractNftRaw {
  tokenIndex: string;
  name: string;
  satoshi: number;
  txId: string;
  outputIndex: number;
  height: number;
  icon?: string;
  imgUrl?: string;
  metaTxId?: string;
  seriesName: string;
  genesis: string;
  codeHash: string;
  sensibleId?: string;
  tokenSupply?: number;
}

export interface MetabotNftListItem {
  kind: MetabotNftKind;
  /** Stable identity: itemPinId (mrc721) or "<genesis>:<tokenIndex>" (metacontract). */
  key: string;
  name: string;
  /** Album/series label shown under the tile name. */
  collectionName: string;
  /** Artwork reference: metafile:// URI, bare pinId, or https URL (renderer resolves). */
  imageRef?: string;
  /** https direct artwork link when the source provides one (metacontract imgUrl). */
  imageUrl?: string;
  /** MRC721 mint serial (-1 = unconfirmed). */
  number?: number;
  /** MetaContract token index. */
  tokenIndex?: string;
  /** MRC721 mint time (unix seconds) — acquisition-order proxy. */
  createTime?: number;
  /** MetaContract acquiring-tx height — the acquisition order. */
  height?: number;
  raw: Mrc721ItemSummary | MetabotMetaContractNftRaw;
}

export interface MetabotNftServiceDeps {
  fetchAddressItemsPage: typeof fetchMrc721AddressItemsPage;
  fetchMvcNftBalance: typeof getMvcNftBalance;
}

const defaultDeps: MetabotNftServiceDeps = {
  fetchAddressItemsPage: fetchMrc721AddressItemsPage,
  fetchMvcNftBalance: (address) => getMvcNftBalance(address),
};

function toSeconds(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** Pure mapping + ordering for the MRC721 holder list (burned excluded). */
export function buildMrc721NftItems(items: Mrc721ItemSummary[]): MetabotNftListItem[] {
  return items
    .filter((item) => !item.burned)
    .map<MetabotNftListItem>((item) => ({
      kind: 'mrc721',
      key: item.itemPinId,
      name: item.name?.trim() || `#${item.number ?? '?'}`,
      collectionName: item.collectionName?.trim() || '',
      imageRef: item.cover?.trim() || undefined,
      number: item.number,
      createTime: toSeconds(item.createTime),
      raw: item,
    }))
    .sort((a, b) => {
      const timeDelta = (b.createTime ?? 0) - (a.createTime ?? 0);
      if (timeDelta !== 0) return timeDelta;
      return (b.number ?? 0) - (a.number ?? 0);
    });
}

/** Pure flatten + ordering for the MetaContract per-series groups. */
export function buildMetaContractNftItems(collections: MvcNftCollection[]): MetabotNftListItem[] {
  const tokenIndexOf = (value: string | undefined): number => Number(value) || 0;
  return collections
    .flatMap<MetabotNftListItem>((collection) =>
      collection.items.map((item) => ({
        kind: 'metacontract' as const,
        key: `${collection.genesis}:${item.tokenIndex}`,
        name: item.name?.trim() || `#${item.tokenIndex}`,
        collectionName: collection.seriesName?.trim() || '',
        imageRef: item.icon?.trim() || undefined,
        imageUrl: item.imgUrl?.trim() || undefined,
        tokenIndex: item.tokenIndex,
        height: item.height,
        raw: {
          tokenIndex: item.tokenIndex,
          name: item.name,
          satoshi: item.satoshi,
          txId: item.txId,
          outputIndex: item.outputIndex,
          height: item.height,
          icon: item.icon,
          imgUrl: item.imgUrl,
          metaTxId: item.metaTxId,
          seriesName: collection.seriesName,
          genesis: collection.genesis,
          codeHash: collection.codeHash,
          sensibleId: collection.sensibleId,
          tokenSupply: collection.tokenSupply,
        } satisfies MetabotMetaContractNftRaw,
      })),
    )
    .sort((a, b) => {
      const heightDelta = (b.height ?? 0) - (a.height ?? 0);
      if (heightDelta !== 0) return heightDelta;
      return tokenIndexOf(b.tokenIndex) - tokenIndexOf(a.tokenIndex);
    });
}

/**
 * Aggregate one bot's NFT holdings for the wallet view. Throws when the bot
 * has no MVC address (nothing to query) or when the upstream read fails —
 * the IPC layer turns that into a failure envelope for the modal error state.
 */
export async function getMetabotNftItems(
  store: MetabotStore,
  input: { metabotId: number; kind: MetabotNftKind },
  deps: MetabotNftServiceDeps = defaultDeps,
): Promise<MetabotNftListItem[]> {
  if (!Number.isInteger(input?.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  if (input.kind !== 'mrc721' && input.kind !== 'metacontract') {
    throw new Error("kind must be 'mrc721' or 'metacontract'");
  }

  const { mvc_address: mvcAddress } = getMetabotAccountAddresses(store, input.metabotId);
  if (!mvcAddress) {
    throw new Error('this MetaBot has no MVC address');
  }

  if (input.kind === 'mrc721') {
    // Page through the holder endpoint; the loop stops on a missing cursor or
    // the cap, whichever comes first (cursor advance failure must not spin).
    const collected: Mrc721ItemSummary[] = [];
    let cursor: string | number | undefined;
    for (let page = 0; page * MRC721_PAGE_SIZE < METABOT_NFT_MRC721_MAX_ITEMS; page += 1) {
      const result = await deps.fetchAddressItemsPage({
        address: mvcAddress,
        cursor,
        size: MRC721_PAGE_SIZE,
      });
      collected.push(...result.items);
      if (!result.cursor || collected.length >= METABOT_NFT_MRC721_MAX_ITEMS) break;
      const nextCursor = result.cursor;
      if (nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return buildMrc721NftItems(collected);
  }

  const balance = await deps.fetchMvcNftBalance(mvcAddress);
  return buildMetaContractNftItems(balance.collections);
}

export interface MetabotMvcNftTransferInput {
  metabotId: number;
  genesis: string;
  codehash: string;
  tokenIndex: string;
  toAddress: string;
  feeRate: number;
}

/** MetaContract NFT transfer — thin pass-through to the existing service. */
export function transferMetabotMvcNft(
  store: MetabotStore,
  input: MetabotMvcNftTransferInput,
): Promise<{ txId: string; rawTx: string }> {
  return executeMvcNftTransfer(store, input);
}

export interface MetabotMrc721TransferInput {
  metabotId: number;
  pinId: string;
  toAddress: string;
  feeRate: number;
}

/** MRC721 item transfer — same deps wiring as the mrc721_transfer agent tool. */
export function transferMetabotMrc721(
  store: MetabotStore,
  input: MetabotMrc721TransferInput,
): Promise<{ txId: string; pinId: string; toAddress: string; spentOutpoint: string; outputValue: number }> {
  return transferMrc721Item(
    {
      buildRawTx: (rawTxStore, params) => buildMvcTransferRawTx(rawTxStore, params),
      broadcastTx: broadcastMvcTx,
    },
    { ...input, store },
  );
}
