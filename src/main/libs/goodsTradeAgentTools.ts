import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  fetchMrc721AddressCollections,
  fetchMrc721AddressItems,
  fetchMrc721CaRegistry,
  fetchMrc721CollectionHolders,
  fetchMrc721CollectionInfo,
  fetchMrc721ItemInfo,
  fetchMrc721ItemVerify,
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
  hydrateMarketListingTokens,
  type GoodsAcceptedQuoteRecord,
} from '../services/mrc721SellIntentService';
import {
  baseUnitsToDecimalDisplay,
  decimalDisplayToBaseUnits,
  defaultTokenGoodsWaiters,
  parseCanonicalFtAssetKey,
  type TokenGoodsWireWaiterEvent,
} from '../services/tokenForGoodsService';
import {
  assertEscrowMvcAddress,
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

export interface GoodsQuoteAcceptConfirmationInfo {
  metabotId: number;
  metabotName?: string;
  inquiryId: string;
  itemPinId: string;
  itemName?: string;
  agreedAmountMilli: number;
  buyerGlobalMetaId: string;
  buyerNftAddress?: string;
  validUntil: number;
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

export interface GoodsTokenPurchaseConfirmationInfo {
  metabotId: number;
  metabotName?: string;
  itemPinId: string;
  itemName?: string;
  collectionName?: string;
  assetKey: string;
  chain: 'btc' | 'mvc';
  symbol: string;
  amountDisplay: string;
  amountBase: string;
  sellerAddress: string;
  sellerReceiveAddress: string;
  sellerName?: string;
  sellerGlobalMetaId?: string;
  settlementMode: 'atomic_swap' | 'reserved_verify';
}

export interface GoodsTradeToolsControl {
  getMetabotIdentity(metabotId: number): {
    name: string;
    mvcAddress: string;
    btcAddress?: string;
    globalMetaId: string;
  } | null;
  getTradeBalance(metabotId: number): Promise<MeBotTradeBalance>;
  createEscrowOrder(input: {
    metabotId: number;
    orderId: string;
    itemPinId: string;
    collectionPinId?: string;
    buyerNftAddress?: string;
    sellerBotAddress?: string;
    sellerAddress?: string;
    sellerPayeeAddress?: string;
    amountMilli: number;
    listingPinId?: string;
    sellPinId?: string;
    deliveryTimeoutSec?: number;
    ttlSeconds?: number;
    idempotencyKey?: string;
    buyerMetaId?: string;
    sellerMetaId?: string;
    note?: string;
  }): Promise<MeNftEscrowOrder>;
  getEscrowOrder(input: { metabotId: number; orderId: string }): Promise<MeNftEscrowOrder>;
  sendTradeMessage(input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
  }): Promise<{ txids: string[]; pinId: string }>;
  findAcceptedQuote?(metabotId: number, itemPinId: string): GoodsAcceptedQuoteRecord | null;
  markAcceptedQuoteUsed?(metabotId: number, itemPinId: string, orderId?: string): boolean;
  recordSellerAuthorizedQuote?(
    metabotId: number,
    quote: Omit<GoodsAcceptedQuoteRecord, 'status' | 'createdAt' | 'updatedAt'>,
  ): GoodsAcceptedQuoteRecord;
  onPurchaseSettled?(event: GoodsPurchaseSettledEvent): void;
  // WS-4 Token-for-Goods capabilities
  checkSellerOnline?(sellerGlobalMetaId: string): Promise<boolean>;
  getTokenBalanceBase?(metabotId: number, assetKey: string): Promise<{ balanceBase: string; symbol?: string; decimals?: number }>;
  buildMvcFtGoodsAtomicProposal?(input: {
    metabotId: number;
    itemPinId: string;
    itemOutpoint: { txid: string; vout: number; satoshis: number };
    sellerMvcAddress: string;
    codehash: string;
    genesis: string;
    amountBase: string;
    buyerNftAddress: string;
  }): Promise<{ proposalId: string; amountCheckRawTx: string; partialTx: string }>;
  transferBtcMrc20?(input: {
    metabotId: number;
    mrc20Id: string;
    decimal: number;
    symbol: string;
    toAddress: string;
    amountDisplay: string;
  }): Promise<{ revealTxId: string; commitTxId?: string }>;
  waitForTokenGoodsEvent?(key: string, timeoutMs: number): Promise<TokenGoodsWireWaiterEvent | null>;
  hydrateMarketListingTokens?: typeof hydrateMarketListingTokens;
  // Optional overrides for deterministic unit testing
  fetchMarketCollections?: typeof fetchMrc721MarketCollections;
  fetchMarketCollectionSummary?: typeof fetchMrc721MarketCollectionSummary;
  fetchMarketListings?: typeof fetchMrc721MarketListings;
  fetchCollectionHolders?: typeof fetchMrc721CollectionHolders;
  fetchCollectionInfo?: typeof fetchMrc721CollectionInfo;
  fetchMarketTrades?: typeof fetchMrc721MarketTrades;
  fetchCaRegistry?: typeof fetchMrc721CaRegistry;
  fetchItemInfo?: typeof fetchMrc721ItemInfo;
  fetchItemVerify?: typeof fetchMrc721ItemVerify;
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
  for (const tok of listing.prices?.tokens ?? []) {
    parts.push(`${tok.amountDisplay} $${tok.symbol}`);
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
  confirmGoodsTokenPurchase?: (info: GoodsTokenPurchaseConfirmationInfo) => Promise<boolean>;
  confirmGoodsQuoteAcceptance?: (info: GoodsQuoteAcceptConfirmationInfo) => Promise<boolean>;
}): unknown[] {
  const {
    tool,
    control,
    sessionId,
    resolveMetabotId,
    confirmGoodsPurchase,
    confirmGoodsTokenPurchase,
    confirmGoodsQuoteAcceptance,
  } = deps;
  const getMarketCollections = control.fetchMarketCollections ?? fetchMrc721MarketCollections;
  const getMarketCollectionSummary = control.fetchMarketCollectionSummary ?? fetchMrc721MarketCollectionSummary;
  const getMarketListings = control.fetchMarketListings ?? fetchMrc721MarketListings;
  const getCollectionHolders = control.fetchCollectionHolders ?? fetchMrc721CollectionHolders;
  const getCollectionInfo = control.fetchCollectionInfo ?? fetchMrc721CollectionInfo;
  const getMarketTrades = control.fetchMarketTrades ?? fetchMrc721MarketTrades;
  const getCaRegistry = control.fetchCaRegistry ?? fetchMrc721CaRegistry;
  const getItemInfo = control.fetchItemInfo ?? fetchMrc721ItemInfo;
  const getItemVerify = control.fetchItemVerify ?? fetchMrc721ItemVerify;
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
      token_asset_key: z.string().optional().describe('Filter to items purchasable with this token assetKey (mrc20:<id> or mvc-ft:<codehash>:<genesis>).'),
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
      token_asset_key?: string;
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
        const tokenAssetKey = asString(args.token_asset_key).toLowerCase() || undefined;

        const [page, verifiedSet] = await Promise.all([
          getMarketListings({
            collectionPinId: collectionPinId || undefined,
            seller: asString(args.seller) || undefined,
            currency: tokenAssetKey ? (`ft:${tokenAssetKey}` as const) : (args.currency ?? 'any'),
            tokenAssetKey,
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

        const hydrateListing = control.hydrateMarketListingTokens ?? hydrateMarketListingTokens;
        const hydratedItems = await Promise.all(page.items.map((item) => hydrateListing(item)));
        const filteredItems = tokenAssetKey
          ? hydratedItems.filter((item) =>
            item.prices?.tokens?.some((t) => t.assetKey.toLowerCase() === tokenAssetKey)
            || item.acceptedCurrencies?.some((c) => c.toLowerCase() === `ft:${tokenAssetKey}`))
          : hydratedItems;

        if (!filteredItems.length) {
          return textResult('No active digital goods listings match your filters.');
        }

        const lines = [`Found ${filteredItems.length} active digital goods listing(s):`];
        for (const item of filteredItems) {
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

        const cardsToRender = filteredItems.slice(0, 6);
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
            priceTokens: listing.prices?.tokens,
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

      let collectionPinId = (
        item.collectionPinId
        || (item as { collectionid?: string }).collectionid
        || item.activeListing?.collectionPinId
        || activeListing?.collectionPinId
        || ''
      ).trim().toLowerCase();
      if (!isMrc721PinId(collectionPinId)) {
        try {
          const verify = await getItemVerify({ pinId: itemPinId });
          const verifiedCollectionId = String(verify?.collectionPinId || verify?.collectionid || '').trim().toLowerCase();
          if (isMrc721PinId(verifiedCollectionId)) {
            collectionPinId = verifiedCollectionId;
          }
        } catch {
          // Handled by missing collectionPinId check below
        }
      }
      if (!isMrc721PinId(collectionPinId)) {
        return textResult(
          `goods_buy_with_me: could not resolve collectionPinId for item ${itemPinId}; cannot lock ME escrow without a valid collectionPinId.`,
          true,
        );
      }

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

      const listingPinId = activeListing?.intentPinId || fallbackIntentMeta.sellPinId || undefined;

      let order: MeNftEscrowOrder;
      try {
        order = await control.createEscrowOrder({
          metabotId,
          orderId,
          itemPinId,
          collectionPinId,
          buyerNftAddress: buyerIdentity.mvcAddress,
          sellerBotAddress: sellerAddress,
          amountMilli,
          listingPinId,
          deliveryTimeoutSec: 900,
          idempotencyKey: orderId,
        });
      } catch (error) {
        return textResult(`goods_buy_with_me: escrow creation failed: ${describeMeNftEscrowError(error)}`, true);
      }

      const isTerminalStatus = (status: string) =>
        status === 'SETTLED'
        || status === 'CANCELED_REFUNDED'
        || status === 'EXPIRED_REFUNDED'
        || status === 'DISPUTED_HOLD'
        || status === 'settled'
        || status === 'rejected';

      // Notify remote seller bot via A2A DM (ME_ESCROW_LOCKED_V1); skip when already settled locally in-process
      let dmNotice = 'seller GlobalMetaID unknown (relying on seller 60s escrow polling)';
      if (isTerminalStatus(order.status)) {
        dmNotice = (order.status === 'SETTLED' || order.status === 'settled')
          ? 'settled locally in-process (no on-chain DM required)'
          : 'order already reached terminal state';
      } else if (sellerMetaId) {
        try {
          const wire = formatGoodsTradeWireMessage({
            type: 'ME_ESCROW_LOCKED_V1',
            orderId: order.orderId || orderId,
            itemPinId,
            amountMilli,
            buyerNftAddress: buyerIdentity.mvcAddress,
            sellerBotAddress: sellerAddress,
            buyerGlobalMetaId: buyerIdentity.globalMetaId || undefined,
            listingPinId,
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
        if (isTerminalStatus(latestOrder.status)) {
          break;
        }
        if (waitMs > 0) await delayMs(waitMs);
        try {
          latestOrder = await control.getEscrowOrder({ metabotId, orderId: order.orderId || orderId });
        } catch {
          // Keep last known order state
        }
      }

      if (latestOrder.status === 'SETTLED' || latestOrder.status === 'settled') {
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
        `ME Escrow Order ${String(latestOrder.status).toUpperCase()}: ${latestOrder.orderId}`,
        `- item: ${item.name || itemPinId} (${itemPinId})`,
        `- amount: ${formatMe(latestOrder.amountMilli || amountMilli)}`,
        `- seller: ${sellerAddress}${sellerName ? ` (${sellerName})` : ''}`,
        `- notification: ${dmNotice}`,
      ];
      if (latestOrder.deliveryTxId) {
        lines.push(`- delivery txId: ${latestOrder.deliveryTxId}`);
      }
      if (latestOrder.status === 'FROZEN_AWAITING_DELIVERY' || latestOrder.status === 'locked') {
        lines.push('- status note: ME points are locked in escrow; waiting for seller delivery (auto-refund on expiry if undelivered).');
      } else if (latestOrder.status === 'DELIVERY_SUBMITTED' || latestOrder.status === 'delivered') {
        lines.push('- status note: Seller submitted delivery txId; ABS is verifying on-chain transfer before releasing ME.');
      } else if (
        latestOrder.status === 'CANCELED_REFUNDED'
        || latestOrder.status === 'EXPIRED_REFUNDED'
        || latestOrder.status === 'rejected'
      ) {
        lines.push(`- rejection reason: ${latestOrder.rejectReason || latestOrder.verifyDetail || 'order refunded'} (ME refunded).`);
      } else if (latestOrder.status === 'DISPUTED_HOLD') {
        lines.push(`- hold reason: ${latestOrder.verifyDetail || 'delivery verification hold'}.`);
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
      const expiresAt = Math.floor(Date.now() / 1000) + 1800;
      const wire = formatGoodsTradeWireMessage({
        type: 'GOODS_INQUIRY_V1',
        inquiryId,
        itemPinId,
        ...(offerAmountMilli != null ? { offerCurrency: 'me', offerAmountMilli } : {}),
        buyerNftAddress: buyerIdentity.mvcAddress || undefined,
        buyerGlobalMetaId: buyerIdentity.globalMetaId || undefined,
        expiresAt,
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

  // -------------------------------------------------------------------------
  // 6. goods_accept_inquiry (REQ-D-03 / Contract C5.2)
  // -------------------------------------------------------------------------
  const goodsAcceptInquiry = tool(
    'goods_accept_inquiry',
    [
      'Accept a buyer inquiry/negotiation offer for an MRC-721 item held by this MetaBot.',
      'Verifies live item ownership, requires explicit owner confirmation, records a seller-side quote authorization so SellerAutoFulfillDaemon fulfills the agreed ME price (even below listing price or for unlisted items), and sends GOODS_QUOTE_ACCEPT_V1 over /protocols/simplemsg.',
    ].join(' '),
    {
      inquiry_id: z.string().min(1).describe('Inquiry ID from the buyer GOODS_INQUIRY_V1 message.'),
      item_pin_id: z.string().min(1).describe('Item pinId being quoted (64-hex txid + "i" + index).'),
      buyer_global_metaid: z.string().min(1).describe('Buyer GlobalMetaID to send GOODS_QUOTE_ACCEPT_V1 to.'),
      agreed_me: z.number().positive().min(1).describe('Agreed ME price in ME points (minimum 1 ME).'),
      buyer_nft_address: z.string().optional().describe('Optional buyer MVC address to bind this quote authorization to.'),
      seller_payee_address: z.string().optional().describe('Optional payee MVC address (defaults to seller bot MVC address).'),
      valid_minutes: z.number().int().min(5).max(1440).optional().describe('Quote validity in minutes (default 30, range 5-1440).'),
      note: z.string().optional().describe('Optional note for the buyer.'),
    },
    async (args: {
      inquiry_id: string;
      item_pin_id: string;
      buyer_global_metaid: string;
      agreed_me: number;
      buyer_nft_address?: string;
      seller_payee_address?: string;
      valid_minutes?: number;
      note?: string;
    }) => {
      const metabotId = requireSessionMetabot('goods_accept_inquiry');
      if (typeof metabotId === 'string') return textResult(metabotId, true);

      const inquiryId = asString(args.inquiry_id);
      const itemPinId = asString(args.item_pin_id).toLowerCase();
      const buyerGlobalMetaId = asString(args.buyer_global_metaid);
      if (!inquiryId) return textResult('goods_accept_inquiry: inquiry_id is required.', true);
      if (!isMrc721PinId(itemPinId)) {
        return textResult('goods_accept_inquiry: invalid item_pin_id (expected <64hex>i<index>).', true);
      }
      if (!buyerGlobalMetaId) {
        return textResult('goods_accept_inquiry: buyer_global_metaid is required.', true);
      }

      const agreedAmountMilli = Math.round(Number(args.agreed_me) * 1000);
      if (!Number.isInteger(agreedAmountMilli) || agreedAmountMilli < ME_NFT_ESCROW_MIN_AMOUNT_MILLI) {
        return textResult(`goods_accept_inquiry: agreed_me must be at least 1 ME (${ME_NFT_ESCROW_MIN_AMOUNT_MILLI} milli-ME).`, true);
      }

      const sellerIdentity = control.getMetabotIdentity(metabotId);
      if (!sellerIdentity?.mvcAddress) {
        return textResult('goods_accept_inquiry: session MetaBot has no MVC address.', true);
      }

      let buyerNftAddress: string | undefined;
      if (asString(args.buyer_nft_address)) {
        try {
          buyerNftAddress = assertEscrowMvcAddress(args.buyer_nft_address, 'buyer_nft_address');
        } catch (err) {
          return textResult(`goods_accept_inquiry: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      }

      let sellerPayeeAddress: string | undefined;
      if (asString(args.seller_payee_address)) {
        try {
          sellerPayeeAddress = assertEscrowMvcAddress(args.seller_payee_address, 'seller_payee_address');
        } catch (err) {
          return textResult(`goods_accept_inquiry: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      }

      let item: Mrc721ItemSummary | null;
      try {
        item = await getItemInfo({ pinId: itemPinId });
      } catch (error) {
        return textResult(`goods_accept_inquiry: failed to verify item on-chain: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      if (!item || item.burned) {
        return textResult(`goods_accept_inquiry: item ${itemPinId} is missing or burned.`, true);
      }
      if ((item.ownerAddress ?? '').toLowerCase() !== sellerIdentity.mvcAddress.toLowerCase()) {
        return textResult(
          `goods_accept_inquiry: seller MetaBot (${sellerIdentity.mvcAddress}) does not currently hold item ${itemPinId} (owner is ${item.ownerAddress || 'unknown'}).`,
          true,
        );
      }

      const validMinutes = args.valid_minutes ?? 30;
      const validUntil = Math.floor(Date.now() / 1000) + validMinutes * 60;

      if (!confirmGoodsQuoteAcceptance) {
        return textResult('goods_accept_inquiry: owner confirmation handler unavailable.', true);
      }
      const approved = await confirmGoodsQuoteAcceptance({
        metabotId,
        metabotName: sellerIdentity.name,
        inquiryId,
        itemPinId,
        itemName: item.name,
        agreedAmountMilli,
        buyerGlobalMetaId,
        buyerNftAddress,
        validUntil,
      });
      if (!approved) {
        return textResult('goods_accept_inquiry cancelled: owner did not confirm accepting this quote.', true);
      }

      if (!control.recordSellerAuthorizedQuote) {
        return textResult('goods_accept_inquiry: seller quote authorization storage unavailable.', true);
      }
      control.recordSellerAuthorizedQuote(metabotId, {
        inquiryId,
        itemPinId,
        agreedCurrency: 'me',
        agreedAmountMilli,
        sellerBotAddress: sellerIdentity.mvcAddress,
        ...(sellerPayeeAddress ? { sellerPayeeAddress } : {}),
        ...(buyerNftAddress ? { buyerNftAddress } : {}),
        buyerGlobalMetaId,
        validUntil,
      });

      const wire = formatGoodsTradeWireMessage({
        type: 'GOODS_QUOTE_ACCEPT_V1',
        inquiryId,
        itemPinId,
        agreedCurrency: 'me',
        agreedAmountMilli,
        sellerBotAddress: sellerIdentity.mvcAddress,
        sellerPayeeAddress: sellerPayeeAddress || sellerIdentity.mvcAddress,
        validUntil,
        sellerMetaId: sellerIdentity.globalMetaId || undefined,
        note: asString(args.note) || undefined,
      });

      const humanSummary = `Accepted inquiry ${inquiryId} for ${item.name || itemPinId} at ${formatMe(agreedAmountMilli)} (valid for ${validMinutes} min).`;
      try {
        const sent = await control.sendTradeMessage({
          metabotId,
          toGlobalMetaId: buyerGlobalMetaId,
          content: `${wire}\n\n${humanSummary}`,
        });
        return textResult([
          'Digital goods quote accepted and sent to buyer.',
          `- inquiryId: ${inquiryId}`,
          `- itemPinId: ${itemPinId}`,
          `- agreedAmount: ${formatMe(agreedAmountMilli)}`,
          `- buyerGlobalMetaId: ${buyerGlobalMetaId}`,
          ...(buyerNftAddress ? [`- bound buyerNftAddress: ${buyerNftAddress}`] : []),
          `- validUntil: ${validUntil}`,
          `- message pin: pin://${sent.pinId}`,
        ].join('\n'));
      } catch (error) {
        return textResult(`goods_accept_inquiry DM failed (local quote authorized): ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 7. goods_buy_with_token (REQ-4-02 / Contract C5.2)
  // -------------------------------------------------------------------------
  const goodsBuyWithToken = tool(
    'goods_buy_with_token',
    [
      'Buy an MRC-721 digital item directly using a fungible token accepted by the seller (/protocols/mrc721sell v2.2 prices.tokens).',
      'Supports two escrowless delivery modes: Path A (MVC same-chain MetaContract FT -> single atomic swap tx signed by buyer then co-signed & broadcast by seller daemon) and Path B (cross-chain BTC MRC-20 -> 5-minute exclusive reservation lock, on-chain MRC-20 transfer, authoritative man-p2p verification, and instant MRC-721 delivery).',
      'Always enforces max_token_amount ceiling, verifies exact assetKey (preventing ticker spoofing), checks seller presence, and requires single owner confirmation before spending.',
    ].join(' '),
    {
      item_pin_id: z.string().min(1).describe('Item pinId to buy (64-hex txid + "i" + index).'),
      asset_key: z.string().min(1).describe('Canonical token assetKey: mrc20:<mrc20Id> or mvc-ft:<codehash>:<genesis>.'),
      max_token_amount: z.string().min(1).describe('Owner-confirmed maximum token display amount willing to spend (e.g. "200").'),
      seller_address: z.string().optional().describe('Optional expected seller MVC address cross-checked against live owner.'),
    },
    async (args: {
      item_pin_id: string;
      asset_key: string;
      max_token_amount: string;
      seller_address?: string;
    }) => {
      const metabotId = requireSessionMetabot('goods_buy_with_token');
      if (typeof metabotId === 'string') return textResult(metabotId, true);

      const itemPinId = asString(args.item_pin_id).toLowerCase();
      if (!isMrc721PinId(itemPinId)) {
        return textResult('goods_buy_with_token: invalid item_pin_id (expected <64hex>i<index>).', true);
      }

      let parsedKey: ReturnType<typeof parseCanonicalFtAssetKey>;
      try {
        parsedKey = parseCanonicalFtAssetKey(args.asset_key);
      } catch (err) {
        return textResult(`goods_buy_with_token: ${err instanceof Error ? err.message : String(err)}`, true);
      }

      const buyerIdentity = control.getMetabotIdentity(metabotId);
      if (!buyerIdentity?.mvcAddress) {
        return textResult('goods_buy_with_token: session MetaBot has no MVC address.', true);
      }

      let item: Mrc721ItemSummary | null;
      try {
        item = await getItemInfo({ pinId: itemPinId });
      } catch (err) {
        return textResult(`goods_buy_with_token: failed to verify item on-chain: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      if (!item) {
        return textResult(`goods_buy_with_token: item ${itemPinId} does not exist in the indexer.`, true);
      }
      if (item.burned) {
        return textResult(`goods_buy_with_token: item ${itemPinId} is burned and cannot be purchased.`, true);
      }
      if (!item.ownerAddress) {
        return textResult(`goods_buy_with_token: could not verify current owner of item ${itemPinId}.`, true);
      }
      if (item.ownerAddress.toLowerCase() === buyerIdentity.mvcAddress.toLowerCase()) {
        return textResult(`goods_buy_with_token: this MetaBot (${buyerIdentity.mvcAddress}) already owns item ${itemPinId}.`, true);
      }
      const requestedSeller = asString(args.seller_address);
      if (requestedSeller && requestedSeller.toLowerCase() !== item.ownerAddress.toLowerCase()) {
        return textResult(
          `goods_buy_with_token: seller_address (${requestedSeller}) does not match live owner (${item.ownerAddress}).`,
          true,
        );
      }

      const hydrateListing = control.hydrateMarketListingTokens ?? hydrateMarketListingTokens;
      let matchedListing: Mrc721MarketListing | null = null;
      try {
        const marketPage = await getMarketListings({ itemPinId, size: 5 });
        const raw = marketPage.items.find((x) => x.itemPinId.toLowerCase() === itemPinId) ?? null;
        if (raw) matchedListing = await hydrateListing(raw);
      } catch {
        // Fallback to sell-intents
      }

      let fallbackIntent: {
        sellerMetaId?: string;
        prices?: { tokens?: NonNullable<Mrc721MarketListing['prices']>['tokens'] };
        autoFulfillTokens?: boolean;
      } | null = null;
      if (!matchedListing?.prices?.tokens?.length) {
        try {
          const intentsPage = await getSellIntents({ itemPinId, active: true, size: 5 });
          const rawIntent = intentsPage.items.find((x) => x.itemPinId.toLowerCase() === itemPinId && x.active !== false);
          if (rawIntent) fallbackIntent = rawIntent;
        } catch {
          // Best-effort
        }
      }

      const tokenPrices = matchedListing?.prices?.tokens ?? fallbackIntent?.prices?.tokens ?? [];
      const tokenPrice = tokenPrices.find((t) => t.assetKey.toLowerCase() === parsedKey.assetKey);
      if (!tokenPrice) {
        return textResult(
          `goods_buy_with_token: item ${itemPinId} does not declare a price in ${parsedKey.assetKey}.`,
          true,
        );
      }
      if (matchedListing?.autoFulfillTokens === false || fallbackIntent?.autoFulfillTokens === false) {
        return textResult(
          `goods_buy_with_token: seller disabled auto-fulfillment for token purchases on ${itemPinId}.`,
          true,
        );
      }

      let maxTokenBase: bigint;
      try {
        maxTokenBase = BigInt(decimalDisplayToBaseUnits(args.max_token_amount, tokenPrice.decimals));
      } catch (err) {
        return textResult(`goods_buy_with_token: invalid max_token_amount: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      const requiredBase = BigInt(tokenPrice.amountBase);
      if (requiredBase > maxTokenBase) {
        return textResult(
          `goods_buy_with_token: listing price (${tokenPrice.amountDisplay} $${tokenPrice.symbol}) exceeds max_token_amount (${args.max_token_amount}).`,
          true,
        );
      }

      if (control.getTokenBalanceBase) {
        const bal = await control.getTokenBalanceBase(metabotId, parsedKey.assetKey);
        if (BigInt(bal.balanceBase || '0') < requiredBase) {
          const haveDisplay = bal.balanceBase && BigInt(bal.balanceBase) > 0n
            ? baseUnitsToDecimalDisplay(bal.balanceBase, tokenPrice.decimals)
            : '0';
          return textResult(
            `INSUFFICIENT_TOKEN_BALANCE: have ${haveDisplay} $${tokenPrice.symbol}, need ${tokenPrice.amountDisplay} $${tokenPrice.symbol} (${parsedKey.assetKey}).`,
            true,
          );
        }
      }

      const sellerMetaId = matchedListing?.seller?.globalMetaId
        || fallbackIntent?.sellerMetaId
        || item.ownerMetaId;
      if (!sellerMetaId) {
        return textResult(
          `goods_buy_with_token: could not resolve seller GlobalMetaID for item ${itemPinId}; cannot send A2A delivery protocol.`,
          true,
        );
      }

      // Check seller presence before reserving or proposing
      if (control.checkSellerOnline) {
        const isOnline = await control.checkSellerOnline(sellerMetaId).catch(() => false);
        if (!isOnline) {
          return textResult(
            `SELLER_OFFLINE: seller ${sellerMetaId} is currently offline; direct token settlement requires the seller daemon to be online.`,
            true,
          );
        }
      } else if (matchedListing?.seller?.isOnline === false) {
        return textResult(
          `SELLER_OFFLINE: seller ${sellerMetaId} is currently offline; direct token settlement requires the seller daemon to be online.`,
          true,
        );
      }

      const waitEvent = control.waitForTokenGoodsEvent
        ?? ((key: string, timeoutMs: number) => defaultTokenGoodsWaiters.waitFor(key, timeoutMs));
      const confirmTokenFn = confirmGoodsTokenPurchase
        ?? (async (info: GoodsTokenPurchaseConfirmationInfo) => confirmGoodsPurchase({
          metabotId: info.metabotId,
          metabotName: info.metabotName,
          orderId: `tok_${randomBytes(6).toString('hex')}`,
          itemPinId: info.itemPinId,
          itemName: `${info.itemName || info.itemPinId} [${info.amountDisplay} $${info.symbol}]`,
          collectionName: info.collectionName,
          amountMilli: 0,
          sellerAddress: info.sellerReceiveAddress,
          sellerName: info.sellerName,
          sellerGlobalMetaId: info.sellerGlobalMetaId,
        }));

      // =====================================================================
      // Path A: MVC Same-Chain MetaContract FT <-> MRC-721 Single Atomic Swap
      // =====================================================================
      if (parsedKey.chain === 'mvc') {
        if (!parsedKey.codehash || !parsedKey.genesis) {
          return textResult('goods_buy_with_token: malformed mvc-ft assetKey.', true);
        }
        if (!control.buildMvcFtGoodsAtomicProposal) {
          return textResult('goods_buy_with_token: MVC FT atomic swap builder unavailable.', true);
        }
        const outMatch = /^([0-9a-fA-F]{64}):(\d+)$/.exec(String(item.output ?? '').trim());
        const outSat = Number(item.outputValue);
        if (!outMatch || !Number.isInteger(outSat) || outSat <= 0) {
          return textResult(`goods_buy_with_token: item ${itemPinId} has no valid current UTXO outpoint.`, true);
        }

        const approved = await confirmTokenFn({
          metabotId,
          metabotName: buyerIdentity.name,
          itemPinId,
          itemName: item.name || matchedListing?.itemName,
          collectionName: item.collectionName || matchedListing?.collectionName,
          assetKey: parsedKey.assetKey,
          chain: 'mvc',
          symbol: tokenPrice.symbol,
          amountDisplay: tokenPrice.amountDisplay,
          amountBase: tokenPrice.amountBase,
          sellerAddress: item.ownerAddress,
          sellerReceiveAddress: tokenPrice.sellerReceiveAddress || item.ownerAddress,
          sellerName: matchedListing?.seller?.name,
          sellerGlobalMetaId: sellerMetaId,
          settlementMode: 'atomic_swap',
        });
        if (!approved) {
          return textResult('goods_buy_with_token cancelled: owner did not confirm the atomic token purchase.', true);
        }

        const proposal = await control.buildMvcFtGoodsAtomicProposal({
          metabotId,
          itemPinId,
          itemOutpoint: {
            txid: outMatch[1].toLowerCase(),
            vout: Number(outMatch[2]),
            satoshis: outSat,
          },
          sellerMvcAddress: tokenPrice.sellerReceiveAddress || item.ownerAddress,
          codehash: parsedKey.codehash,
          genesis: parsedKey.genesis,
          amountBase: tokenPrice.amountBase,
          buyerNftAddress: buyerIdentity.mvcAddress,
        });

        const waiterPromise = waitEvent(`atomic:${proposal.proposalId}`, 25_000);
        const wire = formatGoodsTradeWireMessage({
          type: 'FT_GOODS_ATOMIC_PROPOSAL_V1',
          proposalId: proposal.proposalId,
          itemPinId,
          assetKey: parsedKey.assetKey,
          amountBase: tokenPrice.amountBase,
          buyerNftAddress: buyerIdentity.mvcAddress,
          sellerReceiveAddress: tokenPrice.sellerReceiveAddress || item.ownerAddress,
          amountCheckRawTx: proposal.amountCheckRawTx,
          partialTx: proposal.partialTx,
          buyerGlobalMetaId: buyerIdentity.globalMetaId || undefined,
        });

        await control.sendTradeMessage({
          metabotId,
          toGlobalMetaId: sellerMetaId,
          content: `${wire}\n\n[Atomic FT Proposal] Offering ${tokenPrice.amountDisplay} $${tokenPrice.symbol} for ${itemPinId}.`,
        });

        const reply = await waiterPromise;
        if (reply?.kind === 'atomic_rejected') {
          return textResult(`goods_buy_with_token rejected by seller: ${reply.reason}`, true);
        }
        if (reply?.kind === 'atomic_settled') {
          control.onPurchaseSettled?.({
            metabotId,
            sessionId,
            orderId: proposal.proposalId,
            itemPinId,
            deliveryTxId: reply.txId,
            amountMilli: 0,
            sellerAddress: item.ownerAddress,
            sellerGlobalMetaId: sellerMetaId,
            itemName: item.name || matchedListing?.itemName,
            collectionName: item.collectionName || matchedListing?.collectionName,
            shopMetaAppPinId: matchedListing?.shopMetaAppPinId,
          });
          return textResult([
            'Atomic FT-for-Goods swap SETTLED on-chain.',
            `- item: ${item.name || itemPinId} (${itemPinId})`,
            `- paid: ${tokenPrice.amountDisplay} $${tokenPrice.symbol} (${parsedKey.assetKey})`,
            `- atomic txId: ${reply.txId}`,
            `- buyer address: ${buyerIdentity.mvcAddress}`,
          ].join('\n'));
        }

        // Fallback short-check if reply DM lagged
        const refreshed = await getItemInfo({ pinId: itemPinId }).catch(() => null);
        if (refreshed?.ownerAddress?.toLowerCase() === buyerIdentity.mvcAddress.toLowerCase()) {
          return textResult([
            'Atomic FT-for-Goods swap SETTLED (confirmed via item ownership).',
            `- item: ${item.name || itemPinId} (${itemPinId})`,
            `- paid: ${tokenPrice.amountDisplay} $${tokenPrice.symbol} (${parsedKey.assetKey})`,
            `- proposalId: ${proposal.proposalId}`,
          ].join('\n'));
        }
        return textResult([
          'Atomic FT-for-Goods proposal sent to seller; awaiting settlement confirmation.',
          `- proposalId: ${proposal.proposalId}`,
          `- item: ${itemPinId}`,
          `- amount: ${tokenPrice.amountDisplay} $${tokenPrice.symbol}`,
        ].join('\n'));
      }

      // =====================================================================
      // Path B: Cross-Chain BTC MRC-20 -> 5-Min Exclusive Lock + Verify + Deliver
      // =====================================================================
      if (!parsedKey.mrc20Id) {
        return textResult('goods_buy_with_token: malformed mrc20 assetKey.', true);
      }
      if (!control.transferBtcMrc20) {
        return textResult('goods_buy_with_token: BTC MRC-20 transfer service unavailable.', true);
      }

      const reserveRequestId = `tgresreq_${randomBytes(8).toString('hex')}`;
      const reserveWaiter = waitEvent(`reserve:${reserveRequestId}`, 25_000);
      const reserveWire = formatGoodsTradeWireMessage({
        type: 'TOKEN_GOODS_RESERVE_V1',
        reserveRequestId,
        itemPinId,
        assetKey: parsedKey.assetKey,
        buyerNftAddress: buyerIdentity.mvcAddress,
        buyerGlobalMetaId: buyerIdentity.globalMetaId || undefined,
      });

      await control.sendTradeMessage({
        metabotId,
        toGlobalMetaId: sellerMetaId,
        content: `${reserveWire}\n\n[Token Reserve Request] Requesting 5-minute lock on ${itemPinId} for ${tokenPrice.amountDisplay} $${tokenPrice.symbol}.`,
      });

      const reserveReply = await reserveWaiter;
      if (!reserveReply) {
        return textResult(
          `goods_buy_with_token: timed out waiting for seller 5-minute reservation lock on ${itemPinId}; no tokens were spent.`,
          true,
        );
      }
      if (reserveReply.kind === 'reserve_rejected') {
        return textResult(
          `goods_buy_with_token: seller refused reservation lock (${reserveReply.reason}); no tokens were spent.`,
          true,
        );
      }
      if (reserveReply.kind !== 'reserved') {
        return textResult('goods_buy_with_token: unexpected reservation response; no tokens were spent.', true);
      }

      const reservedBase = BigInt(reserveReply.amountBase);
      if (reservedBase > maxTokenBase) {
        return textResult(
          `goods_buy_with_token: reserved price (${reservedBase.toString()} base) exceeds max_token_amount (${maxTokenBase.toString()}); aborted before transfer.`,
          true,
        );
      }

      const reservedDisplay = baseUnitsToDecimalDisplay(reserveReply.amountBase, tokenPrice.decimals);
      const approved = await confirmTokenFn({
        metabotId,
        metabotName: buyerIdentity.name,
        itemPinId,
        itemName: item.name || matchedListing?.itemName,
        collectionName: item.collectionName || matchedListing?.collectionName,
        assetKey: parsedKey.assetKey,
        chain: 'btc',
        symbol: tokenPrice.symbol,
        amountDisplay: reservedDisplay,
        amountBase: reserveReply.amountBase,
        sellerAddress: item.ownerAddress,
        sellerReceiveAddress: reserveReply.sellerReceiveAddress,
        sellerName: matchedListing?.seller?.name,
        sellerGlobalMetaId: sellerMetaId,
        settlementMode: 'reserved_verify',
      });
      if (!approved) {
        return textResult('goods_buy_with_token cancelled: owner did not confirm the MRC-20 token transfer.', true);
      }

      const transferRes = await control.transferBtcMrc20({
        metabotId,
        mrc20Id: parsedKey.mrc20Id,
        decimal: tokenPrice.decimals,
        symbol: tokenPrice.symbol,
        toAddress: reserveReply.sellerReceiveAddress,
        amountDisplay: reservedDisplay,
      });

      const deliverWaiter = waitEvent(`deliver:${reserveReply.reservationId}`, 30_000);
      const paidWire = formatGoodsTradeWireMessage({
        type: 'TOKEN_GOODS_PAID_V1',
        reservationId: reserveReply.reservationId,
        itemPinId,
        assetKey: parsedKey.assetKey,
        paymentTxId: transferRes.revealTxId,
        buyerNftAddress: buyerIdentity.mvcAddress,
      });

      await control.sendTradeMessage({
        metabotId,
        toGlobalMetaId: sellerMetaId,
        content: `${paidWire}\n\n[Token Paid] Sent ${reservedDisplay} $${tokenPrice.symbol} in tx ${transferRes.revealTxId} for reservation ${reserveReply.reservationId}.`,
      });

      const deliverReply = await deliverWaiter;
      if (deliverReply?.kind === 'delivery_rejected') {
        return textResult(
          `goods_buy_with_token: MRC-20 payment sent (${transferRes.revealTxId}), but seller rejected delivery: ${deliverReply.reason}`,
          true,
        );
      }
      if (deliverReply?.kind === 'delivered') {
        control.onPurchaseSettled?.({
          metabotId,
          sessionId,
          orderId: reserveReply.reservationId,
          itemPinId,
          deliveryTxId: deliverReply.nftDeliveryTxId,
          amountMilli: 0,
          sellerAddress: item.ownerAddress,
          sellerGlobalMetaId: sellerMetaId,
          itemName: item.name || matchedListing?.itemName,
          collectionName: item.collectionName || matchedListing?.collectionName,
          shopMetaAppPinId: matchedListing?.shopMetaAppPinId,
        });
        return textResult([
          'Cross-chain Token-for-Goods purchase DELIVERED.',
          `- item: ${item.name || itemPinId} (${itemPinId})`,
          `- paid: ${reservedDisplay} $${tokenPrice.symbol} (${parsedKey.assetKey})`,
          `- payment revealTxId: ${transferRes.revealTxId}`,
          `- NFT delivery txId: ${deliverReply.nftDeliveryTxId}`,
          `- reservationId: ${reserveReply.reservationId}`,
        ].join('\n'));
      }

      return textResult([
        'Cross-chain MRC-20 payment broadcast and TOKEN_GOODS_PAID_V1 dispatched; waiting for seller NFT delivery.',
        `- reservationId: ${reserveReply.reservationId}`,
        `- payment revealTxId: ${transferRes.revealTxId}`,
        `- item: ${itemPinId}`,
      ].join('\n'));
    },
  );

  return [
    goodsMarketSummary,
    goodsMarketSearch,
    goodsHolderLookup,
    goodsBuyWithMe,
    goodsBuyWithToken,
    goodsSendInquiry,
    goodsAcceptInquiry,
  ];
}
