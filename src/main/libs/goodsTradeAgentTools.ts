import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  fetchMrc721AddressCollections,
  fetchMrc721AddressItems,
  fetchMrc721CaRegistry,
  fetchMrc721CollectionHolders,
  fetchMrc721CollectionInfo,
  fetchMrc721ItemInfo,
  fetchMrc721MarketCollections,
  fetchMrc721MarketCollectionSummary,
  fetchMrc721MarketListings,
  fetchMrc721MarketTrades,
  isMrc721PinId,
  type Mrc721ItemSummary,
  type Mrc721MarketListing,
} from '../services/mrc721Service';
import {
  fetchMrc721SellIntents,
  type GoodsAcceptedQuoteRecord,
} from '../services/mrc721SellIntentService';
import {
  describeMeNftEscrowError,
  ME_NFT_ESCROW_MIN_AMOUNT_MILLI,
  type MeBotTradeBalance,
  type MeNftEscrowOrder,
} from '../services/meNftEscrowService';
import { formatGoodsTradeWireMessage } from '../services/goodsTradeWireProtocol';
import { appendNftCardBlock, buildMrc721CardFields } from './nftCardMarkdown';
import { withNftCardHostStamp } from './tradeActivityStamp';

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>,
) => unknown;

export interface GoodsPurchaseConfirmationInfo {
  metabotId: number;
  metabotName?: string;
  orderId: string;
  itemPinId: string;
  itemName?: string;
  collectionName?: string;
  amountMilli: number;
  sellerAddress: string;
  sellerName?: string;
  sellerGlobalMetaId?: string;
}

export interface GoodsPurchaseSettledEvent {
  metabotId: number;
  sessionId?: string;
  orderId: string;
  itemPinId: string;
  deliveryTxId?: string;
  amountMilli: number;
  sellerAddress: string;
  sellerGlobalMetaId?: string;
  itemName?: string;
  collectionName?: string;
  shopMetaAppPinId?: string;
}

export interface GoodsTradeToolsControl {
  getMetabotIdentity(metabotId: number): {
    name: string;
    mvcAddress: string;
    globalMetaId: string;
  } | null;
  getTradeBalance(metabotId: number): Promise<MeBotTradeBalance>;
  createEscrowOrder(input: {
    metabotId: number;
    orderId: string;
    itemPinId: string;
    sellerAddress: string;
    amountMilli: number;
    collectionPinId?: string;
    sellPinId?: string;
    buyerMetaId?: string;
    sellerMetaId?: string;
    note?: string;
    ttlSeconds?: number;
  }): Promise<MeNftEscrowOrder>;
  getEscrowOrder(input: { metabotId: number; orderId: string }): Promise<MeNftEscrowOrder>;
  sendTradeMessage(input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
  }): Promise<{ txids: string[]; pinId: string }>;
  findAcceptedQuote?(metabotId: number, itemPinId: string): GoodsAcceptedQuoteRecord | null;
  markAcceptedQuoteUsed?(metabotId: number, itemPinId: string, orderId?: string): boolean;
  onPurchaseSettled?(event: GoodsPurchaseSettledEvent): void;
  // Optional overrides for deterministic unit testing
  fetchMarketCollections?: typeof fetchMrc721MarketCollections;
  fetchMarketCollectionSummary?: typeof fetchMrc721MarketCollectionSummary;
  fetchMarketListings?: typeof fetchMrc721MarketListings;
  fetchCollectionHolders?: typeof fetchMrc721CollectionHolders;
  fetchCollectionInfo?: typeof fetchMrc721CollectionInfo;
  fetchMarketTrades?: typeof fetchMrc721MarketTrades;
  fetchCaRegistry?: typeof fetchMrc721CaRegistry;
  fetchItemInfo?: typeof fetchMrc721ItemInfo;
  fetchAddressCollections?: typeof fetchMrc721AddressCollections;
  fetchAddressItems?: typeof fetchMrc721AddressItems;
  fetchSellIntents?: typeof fetchMrc721SellIntents;
  pollDelaysMs?: number[];
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatMe(milli: number | null | undefined): string {
  if (milli == null || !Number.isFinite(milli)) return 'n/a';
  const val = (milli / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${val} ME`;
}

function formatCny(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return 'n/a';
  return `¥${(cents / 100).toFixed(2)}`;
}

function formatListingPrice(listing: Pick<Mrc721MarketListing, 'prices' | 'priceHintSats'>): string {
  const parts: string[] = [];
  if (listing.prices?.me?.amountMilli != null && listing.prices.me.amountMilli > 0) {
    parts.push(formatMe(listing.prices.me.amountMilli));
  }
  if (listing.prices?.fiat?.amountCents != null && listing.prices.fiat.amountCents > 0) {
    parts.push(formatCny(listing.prices.fiat.amountCents));
  }
  if (listing.priceHintSats != null && listing.priceHintSats > 0) {
    parts.push(`${listing.priceHintSats} sats`);
  }
  return parts.length ? parts.join(' / ') : 'make an offer';
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildGoodsTradeAgentTools(deps: {
  tool: SdkToolFactory;
  control: GoodsTradeToolsControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  confirmGoodsPurchase: (info: GoodsPurchaseConfirmationInfo) => Promise<boolean>;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId, confirmGoodsPurchase } = deps;
  const getMarketCollections = control.fetchMarketCollections ?? fetchMrc721MarketCollections;
  const getMarketCollectionSummary = control.fetchMarketCollectionSummary ?? fetchMrc721MarketCollectionSummary;
  const getMarketListings = control.fetchMarketListings ?? fetchMrc721MarketListings;
  const getCollectionHolders = control.fetchCollectionHolders ?? fetchMrc721CollectionHolders;
  const getCollectionInfo = control.fetchCollectionInfo ?? fetchMrc721CollectionInfo;
  const getMarketTrades = control.fetchMarketTrades ?? fetchMrc721MarketTrades;
  const getCaRegistry = control.fetchCaRegistry ?? fetchMrc721CaRegistry;
  const getItemInfo = control.fetchItemInfo ?? fetchMrc721ItemInfo;
  const getAddressCollections = control.fetchAddressCollections ?? fetchMrc721AddressCollections;
  const getAddressItems = control.fetchAddressItems ?? fetchMrc721AddressItems;
  const getSellIntents = control.fetchSellIntents ?? fetchMrc721SellIntents;
  const pollDelaysMs = control.pollDelaysMs ?? [1500, 2000, 2500];

  const requireSessionMetabot = (toolName: string): number | string => {
    const metabotId = resolveMetabotId(sessionId);
    if (metabotId == null) {
      return `${toolName}: no MetaBot is attached to this session.`;
    }
    return metabotId;
  };

  const loadCaVerifiedSet = async (): Promise<Set<string>> => {
    try {
      const ca = await getCaRegistry();
      const set = new Set<string>();
      for (const entry of ca?.collections ?? []) {
        const pinId = typeof entry.collectionPinId === 'string'
          ? entry.collectionPinId.trim().toLowerCase()
          : typeof entry.pinId === 'string'
            ? entry.pinId.trim().toLowerCase()
            : '';
        const name = typeof entry.collectionName === 'string' ? entry.collectionName.trim().toLowerCase() : '';
        if (pinId) set.add(pinId);
        if (name) set.add(name);
      }
      return set;
    } catch {
      return new Set<string>();
    }
  };

  // -------------------------------------------------------------------------
  // 1. goods_market_summary (REQ-D-01)
  // -------------------------------------------------------------------------
  const goodsMarketSummary = tool(
    'goods_market_summary',
    [
      'Get an overview of the digital goods market: active collections, CA-verified official collections, floor/median prices (ME / CNY), active listing counts, holder counts, and recent trades.',
      'Pass collection_pin_id or collection_name to focus on a single collection, or omit both for the market catalog overview. Read-only.',
    ].join(' '),
    {
      collection_pin_id: z.string().optional().describe('Optional collection pinId to inspect a specific collection.'),
      collection_name: z.string().optional().describe('Optional collection namespace name.'),
      ca_only: z.boolean().optional().describe('Filter catalog overview to CA-verified collections only.'),
      size: z.number().int().min(1).max(50).optional().describe('Max collections/trades to display (default 10).'),
    },
    async (args: { collection_pin_id?: string; collection_name?: string; ca_only?: boolean; size?: number }) => {
      try {
        const size = args.size ?? 10;
        let collectionPinId = asString(args.collection_pin_id);
        const collectionName = asString(args.collection_name);
        const verifiedSet = await loadCaVerifiedSet();

        if (!collectionPinId && collectionName) {
          const info = await getCollectionInfo({ name: collectionName }).catch(() => null);
          if (info?.pinId) collectionPinId = info.pinId;
        }

        if (collectionPinId) {
          const [summary, tradesPage] = await Promise.all([
            getMarketCollectionSummary(collectionPinId),
            getMarketTrades({ collectionPinId, size: Math.min(size, 10) }).catch(() => ({ items: [] })),
          ]);

          if (!summary) {
            return textResult(`No market summary found for ${collectionPinId}.`);
          }
          const verified = summary.caVerified === true
            || verifiedSet.has(summary.collectionPinId.toLowerCase())
            || verifiedSet.has(summary.collectionName.toLowerCase());
          const lines = [
            `Collection Market Summary: ${summary.displayTitle || summary.collectionName || summary.collectionPinId}${verified ? ' [Verified]' : ''}`,
            `- collectionPinId: ${summary.collectionPinId}`,
            `- listed: ${summary.listedCount ?? 0} (ME: ${summary.listedMeCount ?? 0}, CNY: ${summary.listedCnyCount ?? 0}) | supply: ${summary.mintedCount ?? summary.totalSupply ?? 'n/a'} | holders: ${summary.holderCount ?? 'n/a'}`,
            `- floor ME: ${formatMe(summary.floorPriceMeMilli)} | median ME: ${formatMe(summary.medianPriceMeMilli)} | floor CNY: ${formatCny(summary.floorPriceCnyCents)}`,
          ];
          if (summary.floorSeller?.shopMetaAppPinId) {
            lines.push(`- floor seller shop MetaApp: metaapp://${summary.floorSeller.shopMetaAppPinId}`);
          }
          if (tradesPage.items.length > 0) {
            lines.push(`Recent trades (${tradesPage.items.length}):`);
            for (const t of tradesPage.items) {
              const amt = t.amountMilli != null
                ? formatMe(t.amountMilli)
                : t.amountCents != null
                  ? formatCny(t.amountCents)
                  : t.priceSats != null
                    ? `${t.priceSats} sats`
                    : 'n/a';
              lines.push(`- ${t.itemPinId} · ${amt} (${t.currency || 'me'}) · tx ${t.txId.slice(0, 12)}…`);
            }
          }
          return textResult(lines.join('\n'));
        }

        const [collectionsPage, tradesPage] = await Promise.all([
          getMarketCollections({ caOnly: args.ca_only, size }),
          getMarketTrades({ size: Math.min(size, 5) }).catch(() => ({ items: [] })),
        ]);
        if (!collectionsPage.items.length) {
          return textResult('No digital goods collections are currently listed in the market.');
        }
        const lines = [`Digital Goods Market Summary (${collectionsPage.items.length} collections):`];
        for (const col of collectionsPage.items) {
          const verified = col.caVerified === true
            || verifiedSet.has(col.collectionPinId.toLowerCase())
            || verifiedSet.has(col.collectionName.toLowerCase());
          const floorParts: string[] = [];
          if (col.floorPriceMeMilli != null) floorParts.push(formatMe(col.floorPriceMeMilli));
          if (col.floorPriceCnyCents != null) floorParts.push(formatCny(col.floorPriceCnyCents));
          lines.push(
            `- ${col.displayTitle || col.collectionName || col.collectionPinId}${verified ? ' [Verified]' : ''} · ${col.listedCount ?? 0} listed · floor ${floorParts.length ? floorParts.join(' / ') : 'n/a'} · pin://${col.collectionPinId}`,
          );
        }
        if (tradesPage.items.length > 0) {
          lines.push(`Recent market trades (${tradesPage.items.length}):`);
          for (const t of tradesPage.items) {
            const amt = t.amountMilli != null
              ? formatMe(t.amountMilli)
              : t.amountCents != null
                ? formatCny(t.amountCents)
                : t.priceSats != null
                  ? `${t.priceSats} sats`
                  : 'n/a';
            lines.push(`- ${t.itemPinId} · ${amt} · ${t.currency || 'me'}`);
          }
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        return textResult(`goods_market_summary failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 2. goods_market_search (REQ-D-01)
  // -------------------------------------------------------------------------
  const goodsMarketSearch = tool(
    'goods_market_search',
    [
      'Search active digital goods listings from the MetaSo market index with filters (collection, seller, currency, price range, sort, keyword, online_only, ca_only).',
      'Appends interactive ```nft-card``` blocks (with ME/CNY/sats pricing, Verified badge, seller online status, and Buy/Negotiate/Shop buttons) for top matches — include them verbatim in your reply to the user.',
    ].join(' '),
    {
      collection_pin_id: z.string().optional().describe('Filter by collection pinId.'),
      collection_name: z.string().optional().describe('Filter by collection name (resolved to collectionPinId if omitted).'),
      seller: z.string().optional().describe('Filter by seller MVC address or GlobalMetaID.'),
      currency: z.enum(['me', 'fiat:CNY', 'any']).optional().describe('Filter by accepted currency.'),
      sort: z.enum(['newest', 'price_me_asc', 'price_me_desc', 'price_cny_asc', 'price_cny_desc']).optional().describe('Sort order (default newest).'),
      min_me: z.number().nonnegative().optional().describe('Minimum price in ME.'),
      max_me: z.number().positive().optional().describe('Maximum price in ME.'),
      online_only: z.boolean().optional().describe('Only show listings from currently online seller bots.'),
      ca_only: z.boolean().optional().describe('Only show listings from CA-verified official collections.'),
      keyword: z.string().optional().describe('Filter keyword matched against item/collection/seller name or note.'),
      cursor: z.string().optional().describe('Pagination cursor.'),
      size: z.number().int().min(1).max(50).optional().describe('Number of listings to fetch (default 12).'),
    },
    async (args: {
      collection_pin_id?: string;
      collection_name?: string;
      seller?: string;
      currency?: 'me' | 'fiat:CNY' | 'any';
      sort?: 'newest' | 'price_me_asc' | 'price_me_desc' | 'price_cny_asc' | 'price_cny_desc';
      min_me?: number;
      max_me?: number;
      online_only?: boolean;
      ca_only?: boolean;
      keyword?: string;
      cursor?: string;
      size?: number;
    }) => {
      try {
        let collectionPinId = asString(args.collection_pin_id);
        const collectionName = asString(args.collection_name);
        if (!collectionPinId && collectionName) {
          const info = await getCollectionInfo({ name: collectionName }).catch(() => null);
          if (info?.pinId) collectionPinId = info.pinId;
        }

        const [page, verifiedSet] = await Promise.all([
          getMarketListings({
            collectionPinId: collectionPinId || undefined,
            seller: asString(args.seller) || undefined,
            currency: args.currency ?? 'any',
            sort: args.sort ?? 'newest',
            minPrice: args.min_me != null ? Math.round(args.min_me * 1000) : undefined,
            maxPrice: args.max_me != null ? Math.round(args.max_me * 1000) : undefined,
            onlineOnly: args.online_only,
            caOnly: args.ca_only,
            keyword: asString(args.keyword) || undefined,
            cursor: args.cursor,
            size: args.size ?? 12,
          }),
          loadCaVerifiedSet(),
        ]);

        if (!page.items.length) {
          return textResult('No active digital goods listings match your filters.');
        }

        const lines = [`Found ${page.items.length} active digital goods listing(s):`];
        for (const item of page.items) {
          const verified = item.caVerified === true
            || (item.collectionPinId ? verifiedSet.has(item.collectionPinId.toLowerCase()) : false)
            || (item.collectionName ? verifiedSet.has(item.collectionName.toLowerCase()) : false);
          const sellerLabel = item.seller?.name
            ? `${item.seller.name}${item.seller.isOnline ? ' (online)' : ''}`
            : item.seller?.address || 'unknown';
          lines.push(
            `- ${item.itemName || item.itemPinId}${item.collectionName ? ` [${item.collectionName}]` : ''}${verified ? ' [Verified]' : ''} · ${formatListingPrice(item)} · autoFulfill=${item.autoFulfillMe !== false} · seller=${sellerLabel} · pin://${item.itemPinId}`,
          );
          if (item.note) lines.push(`  note: ${item.note}`);
        }
        if (page.cursor) lines.push(`- next cursor: ${page.cursor}`);
        let output = lines.join('\n');

        const cardsToRender = page.items.slice(0, 6);
        for (const listing of cardsToRender) {
          const verified = listing.caVerified === true
            || (listing.collectionPinId ? verifiedSet.has(listing.collectionPinId.toLowerCase()) : false)
            || (listing.collectionName ? verifiedSet.has(listing.collectionName.toLowerCase()) : false);
          const cardFields = buildMrc721CardFields({
            pinId: listing.itemPinId,
            facts: {
              item: {
                name: listing.itemName,
                collectionName: listing.collectionName,
                cover: listing.cover,
              },
            },
            owner: listing.seller?.address,
            ownerLabel: listing.seller?.name,
            priceSats: listing.priceHintSats,
            priceMeMilli: listing.prices?.me?.amountMilli,
            priceCnyCents: listing.prices?.fiat?.amountCents,
            sellerGlobalMetaId: listing.seller?.globalMetaId,
            sellerName: listing.seller?.name,
            sellerOnline: listing.seller?.isOnline,
            shopMetaAppPinId: listing.shopMetaAppPinId,
            caVerified: verified,
            action: 'selling',
          });
          output = appendNftCardBlock(output, withNftCardHostStamp(cardFields, sessionId));
        }

        return textResult(output);
      } catch (error) {
        return textResult(`goods_market_search failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3. goods_holder_lookup (REQ-D-01)
  // -------------------------------------------------------------------------
  const goodsHolderLookup = tool(
    'goods_holder_lookup',
    [
      'Look up who holds a specific digital item, list holders of a collection, or inspect all items held by an MVC address / GlobalMetaID.',
      'Read-only.',
    ].join(' '),
    {
      item_pin_id: z.string().optional().describe('Inspect current holder & details of one item pinId.'),
      collection_pin_id: z.string().optional().describe('List top holders of a collection by collectionPinId.'),
      collection_name: z.string().optional().describe('List top holders of a collection by name.'),
      address: z.string().optional().describe('Lookup holdings by MVC address.'),
      global_metaid: z.string().optional().describe('Lookup holdings by GlobalMetaID.'),
      size: z.number().int().min(1).max(100).optional().describe('Page size (default 20).'),
    },
    async (args: {
      item_pin_id?: string;
      collection_pin_id?: string;
      collection_name?: string;
      address?: string;
      global_metaid?: string;
      size?: number;
    }) => {
      try {
        const itemPinId = asString(args.item_pin_id);
        let collectionPinId = asString(args.collection_pin_id);
        const collectionName = asString(args.collection_name);
        const address = asString(args.address);
        const globalMetaId = asString(args.global_metaid);
        const size = args.size ?? 20;

        if (itemPinId) {
          const item = await getItemInfo({ pinId: itemPinId });
          if (!item) return textResult(`Item ${itemPinId} not found.`);
          return textResult([
            `Item Holder Info: ${item.name || item.itemPinId}`,
            `- pinId: ${item.itemPinId}`,
            `- collection: ${item.collectionName || item.collectionPinId || 'unknown'}`,
            `- ownerAddress: ${item.ownerAddress || 'unknown'}`,
            `- ownerMetaId: ${item.ownerMetaId || 'unknown'}`,
            `- burned: ${item.burned ? 'yes' : 'no'}`,
          ].join('\n'));
        }

        if (!collectionPinId && collectionName) {
          const info = await getCollectionInfo({ name: collectionName }).catch(() => null);
          if (info?.pinId) collectionPinId = info.pinId;
        }

        if (collectionPinId) {
          const holders = await getCollectionHolders({
            pinId: collectionPinId,
            size,
          });
          if (!holders.list.length) {
            return textResult(`No holders found for collection ${collectionPinId}.`);
          }
          const lines = [`Collection Holders (${holders.list.length} of ${holders.holderCount}):`];
          for (const h of holders.list) {
            const label = h.name ? `${h.name} (${h.address})` : h.address;
            lines.push(`- ${label} · count=${h.itemCount}${h.listedItemCount != null ? ` (listed=${h.listedItemCount})` : ''}`);
          }
          return textResult(lines.join('\n'));
        }

        if (address || globalMetaId) {
          const [cols, items] = await Promise.all([
            getAddressCollections({
              address: address || undefined,
              globalMetaId: globalMetaId || undefined,
            }),
            getAddressItems({
              address: address || undefined,
              globalMetaId: globalMetaId || undefined,
            }),
          ]);
          const lines = [
            `Holdings for ${address || globalMetaId}: ${cols.length} collection(s), ${items.length} item(s)`,
          ];
          for (const c of cols.slice(0, 10)) {
            lines.push(`- [Collection] ${c.name || c.collectionName || c.pinid || 'collection'} · minted=${c.mintedCount ?? c.totalSupply ?? 'n/a'}`);
          }
          for (const it of items.slice(0, size)) {
            lines.push(`- [Item] ${it.name || it.itemPinId} (${it.collectionName || 'unknown'}) · pin://${it.itemPinId}`);
          }
          return textResult(lines.join('\n'));
        }

        return textResult('goods_holder_lookup: provide at least one of item_pin_id, collection_pin_id, collection_name, address, or global_metaid.', true);
      } catch (error) {
        return textResult(`goods_holder_lookup failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 4. goods_buy_with_me (REQ-D-02)
  // -------------------------------------------------------------------------
  const goodsBuyWithMe = tool(
    'goods_buy_with_me',
    [
      'Buy an on-chain MRC-721 digital item using ME points escrow (ABS /v1/me/nft-escrow/orders).',
      'Checks live item ownership, resolves seller & price (or accepted quote), verifies persistent `tradeSpendableMilli` balance (weekly grants cannot buy goods), requires explicit owner confirmation, locks ME escrow, notifies the seller bot via A2A DM (ME_ESCROW_LOCKED_V1), and short-polls for automatic fulfillment.',
    ].join(' '),
    {
      item_pin_id: z.string().min(1).describe('Item pinId to buy (64-hex txid + "i" + index).'),
      amount_me: z.number().positive().optional().describe('Price in ME points (minimum 1 ME). Optional if listing or accepted quote defines a price.'),
      seller_address: z.string().optional().describe('Expected seller MVC address (cross-checked against live owner).'),
      order_id: z.string().optional().describe('Optional custom orderId ([A-Za-z0-9_-.:]{1,80}).'),
      note: z.string().optional().describe('Optional buyer note attached to the escrow order.'),
    },
    async (args: {
      item_pin_id: string;
      amount_me?: number;
      seller_address?: string;
      order_id?: string;
      note?: string;
    }) => {
      const metabotId = requireSessionMetabot('goods_buy_with_me');
      if (typeof metabotId === 'string') return textResult(metabotId, true);

      const itemPinId = asString(args.item_pin_id).toLowerCase();
      if (!isMrc721PinId(itemPinId)) {
        return textResult('goods_buy_with_me: invalid item_pin_id (expected <64hex>i<index>).', true);
      }

      const buyerIdentity = control.getMetabotIdentity(metabotId);
      if (!buyerIdentity?.mvcAddress) {
        return textResult('goods_buy_with_me: session MetaBot has no MVC address.', true);
      }

      let item: Mrc721ItemSummary | null;
      try {
        item = await getItemInfo({ pinId: itemPinId });
      } catch (error) {
        return textResult(`goods_buy_with_me: failed to verify item on-chain: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      if (!item) {
        return textResult(`goods_buy_with_me: item ${itemPinId} does not exist in the indexer.`, true);
      }
      if (item.burned) {
        return textResult(`goods_buy_with_me: item ${itemPinId} is burned and cannot be purchased.`, true);
      }
      if (!item.ownerAddress) {
        return textResult(`goods_buy_with_me: could not verify current owner of item ${itemPinId}.`, true);
      }
      if (item.ownerAddress.toLowerCase() === buyerIdentity.mvcAddress.toLowerCase()) {
        return textResult(`goods_buy_with_me: this MetaBot (${buyerIdentity.mvcAddress}) already owns item ${itemPinId}.`, true);
      }

      const requestedSeller = asString(args.seller_address);
      if (requestedSeller && requestedSeller.toLowerCase() !== item.ownerAddress.toLowerCase()) {
        return textResult(
          `goods_buy_with_me: seller_address (${requestedSeller}) does not match current on-chain owner (${item.ownerAddress}).`,
          true,
        );
      }

      // Look up active market listing / sell-intent & local accepted quote
      let activeListing: Mrc721MarketListing | null = null;
      try {
        const marketPage = await getMarketListings({ itemPinId, size: 5 });
        activeListing = marketPage.items.find((x) => x.itemPinId.toLowerCase() === itemPinId) ?? null;
      } catch {
        // Fallback to sell-intents endpoint
      }
      let fallbackIntentMeta: { sellerMetaId?: string; sellPinId?: string; priceMeMilli?: number } = {};
      if (!activeListing) {
        try {
          const intentsPage = await getSellIntents({ itemPinId, active: true, size: 5 });
          const matchedIntent = intentsPage.items.find((x) => x.itemPinId.toLowerCase() === itemPinId && x.active !== false);
          if (matchedIntent) {
            fallbackIntentMeta = {
              sellerMetaId: matchedIntent.sellerMetaId,
              sellPinId: matchedIntent.sellPinId,
              priceMeMilli: matchedIntent.prices?.me?.amountMilli,
            };
          }
        } catch {
          // Best-effort lookup
        }
      }

      const acceptedQuote = control.findAcceptedQuote?.(metabotId, itemPinId) ?? null;
      let amountMilli: number | undefined;
      if (args.amount_me != null) {
        const raw = Math.round(Number(args.amount_me) * 1000);
        if (!Number.isInteger(raw) || raw < ME_NFT_ESCROW_MIN_AMOUNT_MILLI) {
          return textResult(`goods_buy_with_me: amount_me must be at least 1 ME (${ME_NFT_ESCROW_MIN_AMOUNT_MILLI} milli-ME).`, true);
        }
        amountMilli = raw;
      } else if (acceptedQuote?.agreedAmountMilli) {
        amountMilli = acceptedQuote.agreedAmountMilli;
      } else if (activeListing?.prices?.me?.amountMilli != null) {
        amountMilli = activeListing.prices.me.amountMilli;
      } else if (fallbackIntentMeta.priceMeMilli != null) {
        amountMilli = fallbackIntentMeta.priceMeMilli;
      }

      if (amountMilli == null || amountMilli < ME_NFT_ESCROW_MIN_AMOUNT_MILLI) {
        return textResult(
          'goods_buy_with_me: no ME price found on the active listing or accepted quote. Specify amount_me (minimum 1 ME) or negotiate a quote with goods_send_inquiry first.',
          true,
        );
      }

      // Check buyer's persistent tradeSpendableMilli balance before confirmation
      let balance: MeBotTradeBalance;
      try {
        balance = await control.getTradeBalance(metabotId);
      } catch (error) {
        return textResult(`goods_buy_with_me: failed to check ME trade balance: ${describeMeNftEscrowError(error)}`, true);
      }

      if (balance.tradeSpendableMilli < amountMilli) {
        return textResult(
          [
            `INSUFFICIENT_TRADE_ME: Trade-eligible persistent ME balance is insufficient for this purchase.`,
            `- required: ${formatMe(amountMilli)} (${amountMilli} milliME)`,
            `- tradeSpendableMilli: ${formatMe(balance.tradeSpendableMilli)} (${balance.tradeSpendableMilli} milliME)`,
            `- note: weekly grant (${formatMe(balance.weeklyRemainingMilli)}) cannot be spent on digital goods escrow; please top up ME points first.`,
          ].join('\n'),
          true,
        );
      }

      const orderId = asString(args.order_id) || `goods_${randomBytes(8).toString('hex')}`;
      const sellerAddress = item.ownerAddress;
      const sellerMetaId = activeListing?.seller?.globalMetaId
        || fallbackIntentMeta.sellerMetaId
        || item.ownerMetaId;
      const sellerName = activeListing?.seller?.name;

      const approved = await confirmGoodsPurchase({
        metabotId,
        metabotName: buyerIdentity.name,
        orderId,
        itemPinId,
        itemName: item.name || activeListing?.itemName,
        collectionName: item.collectionName || activeListing?.collectionName,
        amountMilli,
        sellerAddress,
        sellerName,
        sellerGlobalMetaId: sellerMetaId,
      });
      if (!approved) {
        return textResult('goods_buy_with_me cancelled: owner did not confirm the ME escrow purchase.', true);
      }

      let order: MeNftEscrowOrder;
      try {
        order = await control.createEscrowOrder({
          metabotId,
          orderId,
          itemPinId,
          sellerAddress,
          amountMilli,
          collectionPinId: item.collectionPinId || activeListing?.collectionPinId,
          sellPinId: activeListing?.intentPinId || fallbackIntentMeta.sellPinId,
          buyerMetaId: buyerIdentity.globalMetaId || undefined,
          sellerMetaId: sellerMetaId || undefined,
          note: asString(args.note) || undefined,
        });
      } catch (error) {
        return textResult(`goods_buy_with_me: escrow creation failed: ${describeMeNftEscrowError(error)}`, true);
      }

      // Notify seller bot via A2A DM (ME_ESCROW_LOCKED_V1) so fast-path auto-fulfill triggers immediately
      let dmNotice = 'seller GlobalMetaID unknown (relying on seller 60s escrow polling)';
      if (sellerMetaId) {
        try {
          const wire = formatGoodsTradeWireMessage({
            type: 'ME_ESCROW_LOCKED_V1',
            orderId: order.orderId || orderId,
            itemPinId,
            amountMilli,
            buyerAddress: buyerIdentity.mvcAddress,
            buyerMetaId: buyerIdentity.globalMetaId || undefined,
            sellerAddress,
            sellPinId: activeListing?.intentPinId || fallbackIntentMeta.sellPinId,
          });
          await control.sendTradeMessage({
            metabotId,
            toGlobalMetaId: sellerMetaId,
            content: `${wire}\n\n[ME Escrow Locked] Order ${order.orderId || orderId} for item ${itemPinId} (${formatMe(amountMilli)}).`,
          });
          dmNotice = `notified seller ${sellerMetaId}`;
        } catch (error) {
          dmNotice = `DM dispatch failed (${error instanceof Error ? error.message : String(error)}); seller 60s fallback polling will still detect the locked escrow`;
        }
      }

      // Short-poll ABS order status to catch instant auto-fulfillment
      let latestOrder = order;
      for (const waitMs of pollDelaysMs) {
        if (latestOrder.status === 'settled' || latestOrder.status === 'delivered' || latestOrder.status === 'rejected') {
          break;
        }
        if (waitMs > 0) await delayMs(waitMs);
        try {
          latestOrder = await control.getEscrowOrder({ metabotId, orderId: order.orderId || orderId });
        } catch {
          // Keep last known order state
        }
      }

      if (latestOrder.status === 'settled' || latestOrder.status === 'delivered') {
        control.markAcceptedQuoteUsed?.(metabotId, itemPinId, latestOrder.orderId);
        control.onPurchaseSettled?.({
          metabotId,
          sessionId,
          orderId: latestOrder.orderId,
          itemPinId,
          deliveryTxId: latestOrder.deliveryTxId,
          amountMilli,
          sellerAddress,
          sellerGlobalMetaId: sellerMetaId,
          itemName: item.name || activeListing?.itemName,
          collectionName: item.collectionName || activeListing?.collectionName,
          shopMetaAppPinId: activeListing?.shopMetaAppPinId,
        });
      }

      const lines = [
        `ME Escrow Order ${latestOrder.status.toUpperCase()}: ${latestOrder.orderId}`,
        `- item: ${item.name || itemPinId} (${itemPinId})`,
        `- amount: ${formatMe(latestOrder.amountMilli || amountMilli)}`,
        `- seller: ${sellerAddress}${sellerName ? ` (${sellerName})` : ''}`,
        `- notification: ${dmNotice}`,
      ];
      if (latestOrder.deliveryTxId) {
        lines.push(`- delivery txId: ${latestOrder.deliveryTxId}`);
      }
      if (latestOrder.status === 'locked') {
        lines.push('- status note: ME points are locked in escrow; waiting for seller delivery (auto-refund on expiry if undelivered).');
      } else if (latestOrder.status === 'rejected') {
        lines.push(`- rejection reason: ${latestOrder.rejectReason || 'rejected by seller'} (ME refunded).`);
      }
      return textResult(lines.join('\n'));
    },
  );

  // -------------------------------------------------------------------------
  // 5. goods_send_inquiry (REQ-D-02)
  // -------------------------------------------------------------------------
  const goodsSendInquiry = tool(
    'goods_send_inquiry',
    [
      'Send a structured inquiry or price negotiation offer (GOODS_INQUIRY_V1 over /protocols/simplemsg) to the seller of an MRC-721 digital item.',
      'If seller_global_metaid is omitted, resolves it from the active listing or item owner profile.',
    ].join(' '),
    {
      item_pin_id: z.string().min(1).describe('Item pinId being inquired about.'),
      seller_global_metaid: z.string().optional().describe('Target seller GlobalMetaID. Resolved from listing/item if omitted.'),
      offer_me: z.number().positive().optional().describe('Optional proposed price in ME points.'),
      note: z.string().min(1).describe('Message / negotiation terms for the seller.'),
    },
    async (args: {
      item_pin_id: string;
      seller_global_metaid?: string;
      offer_me?: number;
      note: string;
    }) => {
      const metabotId = requireSessionMetabot('goods_send_inquiry');
      if (typeof metabotId === 'string') return textResult(metabotId, true);

      const itemPinId = asString(args.item_pin_id).toLowerCase();
      if (!isMrc721PinId(itemPinId)) {
        return textResult('goods_send_inquiry: invalid item_pin_id.', true);
      }

      const buyerIdentity = control.getMetabotIdentity(metabotId);
      if (!buyerIdentity) {
        return textResult('goods_send_inquiry: session MetaBot identity unavailable.', true);
      }

      let sellerMetaId = asString(args.seller_global_metaid);
      if (!sellerMetaId) {
        try {
          const marketPage = await getMarketListings({ itemPinId, size: 5 });
          const matched = marketPage.items.find((x) => x.itemPinId.toLowerCase() === itemPinId);
          sellerMetaId = matched?.seller?.globalMetaId || '';
        } catch {
          // Ignore and try item info
        }
      }
      if (!sellerMetaId) {
        try {
          const item = await getItemInfo({ pinId: itemPinId });
          sellerMetaId = item?.ownerMetaId || '';
        } catch {
          // Ignore
        }
      }
      if (!sellerMetaId) {
        return textResult('goods_send_inquiry: could not resolve seller GlobalMetaID; please provide seller_global_metaid explicitly.', true);
      }

      const inquiryId = `inq_${randomBytes(6).toString('hex')}`;
      const offerAmountMilli = args.offer_me != null ? Math.round(args.offer_me * 1000) : undefined;
      const wire = formatGoodsTradeWireMessage({
        type: 'GOODS_INQUIRY_V1',
        inquiryId,
        itemPinId,
        ...(offerAmountMilli != null ? { offerAmountMilli, offerCurrency: 'me' } : {}),
        buyerAddress: buyerIdentity.mvcAddress || undefined,
        buyerMetaId: buyerIdentity.globalMetaId || undefined,
        note: args.note.trim(),
      });

      const humanSummary = offerAmountMilli != null
        ? `Inquiry (${inquiryId}) for item ${itemPinId}: offering ${formatMe(offerAmountMilli)} — ${args.note.trim()}`
        : `Inquiry (${inquiryId}) for item ${itemPinId}: ${args.note.trim()}`;

      try {
        const sent = await control.sendTradeMessage({
          metabotId,
          toGlobalMetaId: sellerMetaId,
          content: `${wire}\n\n${humanSummary}`,
        });
        return textResult([
          'Digital goods inquiry sent to seller.',
          `- inquiryId: ${inquiryId}`,
          `- itemPinId: ${itemPinId}`,
          `- sellerGlobalMetaId: ${sellerMetaId}`,
          ...(offerAmountMilli != null ? [`- offer: ${formatMe(offerAmountMilli)}`] : []),
          `- message pin: pin://${sent.pinId}`,
        ].join('\n'));
      } catch (error) {
        return textResult(`goods_send_inquiry failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  return [
    goodsMarketSummary,
    goodsMarketSearch,
    goodsHolderLookup,
    goodsBuyWithMe,
    goodsSendInquiry,
  ];
}
