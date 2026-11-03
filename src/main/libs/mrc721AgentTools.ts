import { z } from 'zod';
import { markdownSelfLink } from './metawebUri';
import { chainWriteFailureDetail, feeAssistReceiptLines } from './chainFeeAssistReceipt';
import { appendNftCardBlock, buildMrc721CardFields } from './nftCardMarkdown';
import { withNftCardHostStamp } from './tradeActivityStamp';
import {
  fetchMrc721AddressByMetaId,
  fetchMrc721AddressCollections,
  fetchMrc721AddressItems,
  fetchMrc721CollectionInfo,
  fetchMrc721CollectionItems,
  fetchMrc721CollectionPageList,
  fetchMrc721ItemInfo,
  fetchMrc721ItemTransfers,
  fetchMrc721ItemVerify,
  isMvcAddress,
  MRC721_MIN_SELL_PRICE_SATS,
  searchMrc721Collections,
  validateMrc721CollectionName,
  verifyMrc721Holding,
  waitForMrc721CollectionInfo,
  waitForMrc721ItemInfo,
  type Mrc721CollectionSummary,
  type Mrc721ItemSummary,
  type Mrc721ItemTransferRecord,
  type Mrc721VerifyInfo,
} from '../services/mrc721Service';
import type { Mrc721SellIntentContent } from '../services/mrc721SellIntentService';

/**
 * MRC-721 (pin-based MetaID NFT) agent tools — R6 of the IDBots MRC-721
 * requirements. Strictly separate from the `wallet_nft_*` tools (MetaContract
 * NFTs identified by genesis/codehash/tokenIndex): MRC-721 items are pinid-
 * addressed under /nft/mrc721/{collectionName}/... and transfers are plain
 * UTXO spends keyed by the indexer's transfer detection.
 *
 * Conventions mirror walletAgentTools.ts: reads are public index data and
 * batch over the local roster + explicit addresses; writes spend the session
 * MetaBot's OWN wallet only (private keys never leave the host) and are
 * chain-write-budgeted in the host control (main.ts). The mrc721_ prefix is
 * reserved by the protocol naming decision — never alias wallet_nft_*.
 */

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => Promise<unknown> | unknown;

/**
 * Host control surface for the mrc721 tools, wired in main.ts. Writes are
 * wrapped in the chain-write budget there; reads are direct service calls.
 */
export type Mrc721ToolsControl = {
  getMetabotMvcAddress(metabotId: number): string | null;
  resolveMetabotIdByName(name: string): number | null;
  /**
   * Best-effort index reads for S3 chat NFT card enrichment. Optional so
   * minimal harnesses keep working; main.ts wires the real service calls.
   */
  fetchItemInfo?(pinId: string): Promise<Mrc721ItemSummary | null>;
  fetchCollectionInfo?(input: { name?: string; pinId?: string }): Promise<Mrc721CollectionSummary | null>;
  /** R1: broadcast the collection_desc pin (first registration wins). */
  collectionCreate(input: {
    metabotId: number;
    collectionName: string;
    name?: string;
    totalSupply?: number;
    royaltyRate?: number;
    desc?: string;
    website?: string;
    cover?: string;
    metadata?: unknown;
    network?: 'mvc' | 'btc';
  }): Promise<{
    collectionName: string;
    pinId: string;
    txids: string[];
    totalCost: number;
    feeAssist?: unknown;
  }>;
  /** 收藏级修改:issuer-only modify pin carrying the full merged content. */
  collectionUpdate(input: {
    metabotId: number;
    collectionName: string;
    name?: string;
    desc?: string;
    website?: string;
    cover?: string;
    metadata?: unknown;
    network?: 'mvc' | 'btc';
  }): Promise<{
    collectionName: string;
    pinId: string;
    txids: string[];
    totalCost: number;
    feeAssist?: unknown;
    updatedFields: string[];
  }>;
  /** R2: mint one item pin (+ optional follow-up item_desc pin). */
  mint(input: {
    metabotId: number;
    collectionName: string;
    itemPath?: string;
    name?: string;
    desc?: string;
    cover?: string;
    metadata?: unknown;
    network?: 'mvc' | 'btc';
  }): Promise<{
    collectionName: string;
    itemPath: string;
    pinId: string;
    itemDescPinId?: string;
    txids: string[];
    totalCost: number;
    feeAssist?: unknown;
  }>;
  /** R3: forced-outpoint spend of the item's current UTXO to the recipient. */
  transfer(input: {
    metabotId: number;
    pinId: string;
    toAddress: string;
  }): Promise<{
    txId: string;
    pinId: string;
    toAddress: string;
    spentOutpoint: string;
    outputValue: number;
  }>;
  /** V1.1: seller partial signature. Returns the listing the buyer must receive. */
  sell(input: {
    metabotId: number;
    itemPinId: string;
    buyerAddress: string;
    priceSats: number;
  }): Promise<{
    listingJson: string;
    itemPinId: string;
    buyerAddress: string;
    priceSats: number;
    outpoint: string;
  }>;
  /** V1.1: verify, fund, sign, and broadcast one atomic swap. */
  buy(input: {
    metabotId: number;
    listing: unknown;
  }): Promise<{
    txId: string;
    itemPinId: string;
    priceSats: number;
    sellerAddress: string;
    feeSats: number;
    feeRateEffective: number;
  }>;
  /** V1.1: local listings this bot created, each rechecked. */
  listSellOrders(input: { metabotId: number }): Promise<Array<{
    id: string;
    status: 'valid' | 'invalid' | 'expired';
    reason?: string;
    itemPinId: string;
    buyerAddress: string;
    priceSats: number;
    outpoint: string;
  }>>;
  /** Sell-intent protocol (docs/nft-sell-protocol-draft.md): declare/cancel/list. */
  sellIntentDeclare(input: {
    metabotId: number;
    itemPinId: string;
    priceHintSats?: number;
    acceptedCurrencies?: string[];
    settlement?: string[];
    note?: string;
    expiresInHours?: number;
    network?: 'mvc' | 'btc';
  }): Promise<{
    sellPinId: string;
    txids: string[];
    totalCost: number;
    feeAssist?: unknown;
    intent: Mrc721SellIntentContent;
  }>;
  sellIntentCancel(input: {
    metabotId: number;
    itemPinId: string;
    network?: 'mvc' | 'btc';
  }): Promise<{
    sellPinId: string;
    txids: string[];
    totalCost: number;
    feeAssist?: unknown;
    intent: Mrc721SellIntentContent;
  }>;
  listSellIntents(input: {
    metabotId: number;
    collectionName?: string;
    collectionPinId?: string;
  }): Promise<Array<{
    id: string;
    itemPinId: string;
    status: 'active' | 'cancelled' | 'stale';
    reason?: string;
    intent: Mrc721SellIntentContent;
    sellPinId?: string;
  }>>;
};

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SATOSHI_PER_UNIT = 100_000_000;
const MRC721_POLL_DEFAULT_MS = 30_000;
const MRC721_POLL_MAX_MS = 120_000;

function clampPollWaitMs(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MRC721_POLL_MAX_MS, Math.round(value));
}

function formatShortAddress(address: string | undefined): string {
  const text = String(address || '');
  if (text.length <= 18) return text || '(unknown)';
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

function formatMetaIdIdentity(metaId: string | undefined, address: string | undefined): string {
  if (metaId) return `${metaId} (${formatShortAddress(address)})`;
  return formatShortAddress(address) || '(unknown)';
}

/** One collection line shared by the list/square/mine renderers. */
export function formatMrc721CollectionLine(collection: Mrc721CollectionSummary): string {
  const supply = collection.totalSupply != null && collection.totalSupply >= 0
    ? `${collection.totalnum ?? 0}/${collection.totalSupply}`
    : `${collection.totalnum ?? 0} (unlimited)`;
  const parts = [
    `${collection.name || collection.collectionName}`,
    `${supply} minted`,
    `royalty ${collection.royaltyRate ?? 0}%`,
    `issuer ${formatMetaIdIdentity(collection.createMetaId, collection.createAddress)}`,
    collection.genesisChainName ? `[${collection.genesisChainName}]` : '',
    collection.pinid ? `collectionid ${collection.pinid}` : '',
  ].filter(Boolean);
  return `- ${parts.join(' | ')}`;
}

/** Holdings render: grouped by collection, one line per item. */
export function formatMrc721Items(items: Mrc721ItemSummary[]): string {
  if (!items.length) return '- no MRC-721 items held at this address';
  const grouped = new Map<string, Mrc721ItemSummary[]>();
  for (const item of items) {
    const key = item.collectionName || '(unknown collection)';
    const bucket = grouped.get(key);
    if (bucket) bucket.push(item);
    else grouped.set(key, [item]);
  }
  const lines: string[] = [`${items.length} MRC-721 item(s) held:`];
  for (const [collectionName, group] of grouped) {
    lines.push(`- ${collectionName}: ${group.length} item(s)`);
    for (const item of group) {
      const title = item.name || '(unnamed — item_desc not indexed)';
      const badge = item.creatorMinted ? ' [creator-minted]' : '';
      const chain = item.genesisChainName ? ` [${item.genesisChainName}]` : '';
      lines.push(`  - ${title} · pinid ${item.itemPinId}${item.number != null ? ` · #${item.number}` : ''}${badge}${chain}`);
    }
  }
  return lines.join('\n');
}

export function formatMrc721Transfers(transfers: Mrc721ItemTransferRecord[]): string {
  if (!transfers.length) return '- no transfers recorded yet (genesis mint only)';
  const lines: string[] = [`${transfers.length} transfer(s):`];
  for (const transfer of transfers) {
    const when = transfer.time ? new Date(transfer.time).toISOString() : `height ${transfer.height ?? '?'}`;
    lines.push(
      `  - ${when}: ${formatShortAddress(transfer.fromAddress)} → ${formatShortAddress(transfer.toAddress)}`
      + `${transfer.txId ? ` · tx ${transfer.txId}` : ''}${transfer.chainName ? ` [${transfer.chainName}]` : ''}`,
    );
  }
  return lines.join('\n');
}

/** Detail sheet for mrc721_item_info (R5: 归属/溯源/真伪). */
export function formatMrc721ItemDetail(input: {
  item: Mrc721ItemSummary;
  verify?: Mrc721VerifyInfo | null;
  verifyError?: string;
  transfers?: Mrc721ItemTransferRecord[];
  transfersError?: string;
}): string {
  const item = input.item;
  const lines: string[] = [];
  lines.push(`MRC-721 item ${item.itemPinId}`);
  lines.push(`- collection: ${item.collectionName || '(unknown)'}${item.collectionPinId ? ` (collectionid ${item.collectionPinId})` : ''}`);
  if (item.number != null) lines.push(`- number: #${item.number}`);
  if (item.name) lines.push(`- name: ${item.name}`);
  if (item.desc) lines.push(`- desc: ${item.desc}`);
  if (item.cover) lines.push(`- cover: ${item.cover}`);
  if (item.metadata) lines.push(`- metadata: ${item.metadata}`);
  lines.push(`- current owner: ${formatMetaIdIdentity(item.ownerMetaId, item.ownerAddress)}`);
  if (item.output) {
    lines.push(`- current UTXO: ${item.output} (${item.outputValue ?? '?'} sats)`);
  }
  const genesisBits = [
    item.genesisChainName ? `chain ${item.genesisChainName}` : '',
    item.genesisHeight != null ? `height ${item.genesisHeight}` : '',
    item.genesisTx ? `tx ${item.genesisTx}` : '',
  ].filter(Boolean).join(', ');
  if (genesisBits) lines.push(`- genesis: ${genesisBits}`);
  if (item.transferCount != null) lines.push(`- transfer count: ${item.transferCount}`);
  if (item.burned) lines.push('- BURNED: this item was melted down and can no longer move');

  const verify = input.verify;
  if (verify) {
    const collected = verify.collected !== false;
    const official = verify.creatorMinted ?? item.creatorMinted;
    lines.push(`- authenticity: ${collected ? 'indexed (collected)' : 'NOT collected by the indexer'}`
      + ` · ${official ? 'OFFICIAL mint (creator-minted)' : 'third-party mint (open minting)'}`);
    if (verify.collectionid || verify.collectionPinId) {
      lines.push(`  - collectionid: ${verify.collectionid || verify.collectionPinId}`);
    }
  } else if (input.verifyError) {
    lines.push(`- authenticity: unavailable (${input.verifyError})`);
  } else {
    lines.push(`- authenticity: ${item.creatorMinted ? 'OFFICIAL mint (creator-minted)' : 'third-party mint (open minting)'} (from item/info)`);
  }

  if (input.transfers) {
    lines.push(formatMrc721Transfers(input.transfers));
  } else if (input.transfersError) {
    lines.push(`- transfer history: unavailable (${input.transfersError})`);
  }
  lines.push(`- view link: ${markdownSelfLink(`pin://${item.itemPinId}`)}`);
  return lines.join('\n');
}

export function formatMrc721CollectionCreateResult(input: {
  collectionName: string;
  pinId: string;
  txids: string[];
  totalCost: number;
  feeAssist?: unknown;
  confirmation: { hit: Mrc721CollectionSummary | null; lastError?: string };
  waitMs: number;
  precheckWarning?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Collection "${input.collectionName}" issued — collection_desc pin broadcast on-chain.`);
  if (input.precheckWarning) lines.push(`- precheck: ${input.precheckWarning}`);
  lines.push(`- collectionid (collection_desc pinId): ${input.pinId}`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  const confirm = input.confirmation;
  if (confirm.hit) {
    lines.push('- index confirmation: REGISTERED — the collection is live in the indexer.');
  } else {
    const reason = confirm.lastError ? ` (last lookup error: ${confirm.lastError})` : '';
    const waited = input.waitMs > 0
      ? `not visible after ${Math.round(input.waitMs / 1000)}s`
      : 'confirmation wait skipped';
    lines.push(
      `- index confirmation: ${waited}${reason} — the pin may still be `
      + 'confirming. Verify with mrc721_collection_info before minting; if it never appears, the name was likely '
      + 'registered first (first-registration-wins).',
    );
  }
  lines.push(`- view link: ${markdownSelfLink(`pin://${input.pinId}`)}`);
  lines.push('- next: mrc721_mint to add items under this collection.');
  return lines.join('\n');
}

export function formatMrc721CollectionUpdateResult(input: {
  collectionName: string;
  pinId: string;
  txids: string[];
  totalCost: number;
  feeAssist?: unknown;
  updatedFields: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Collection "${input.collectionName}" update broadcast on-chain (operation=modify pin at the collection_desc path).`);
  lines.push(`- modify pinId: ${input.pinId}`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  lines.push(`- updated fields: ${input.updatedFields.join(', ')} — merged into the FULL latest collection content (full rewrite, not a diff); issuer permission verified against the collection_desc creator.`);
  lines.push(
    '- visibility: the indexed collection shows the merged content once the indexer ingests the modify pin '
    + '(indexing latency = pin confirmation latency) — verify with mrc721_collection_info (cover / modify history).',
  );
  lines.push(`- view link: ${markdownSelfLink(`pin://${input.pinId}`)}`);
  return lines.join('\n');
}

export function formatMrc721MintResult(input: {
  collectionName: string;
  itemPath: string;
  pinId: string;
  itemDescPinId?: string;
  txids: string[];
  totalCost: number;
  feeAssist?: unknown;
  confirmation: { hit: Mrc721ItemSummary | null; lastError?: string };
  waitMs: number;
  precheckWarning?: string;
}): string {
  const lines: string[] = [];
  lines.push(`NFT minted into "${input.collectionName}" (item path ${input.itemPath}) — pin broadcast on-chain.`);
  if (input.precheckWarning) lines.push(`- precheck: ${input.precheckWarning}`);
  lines.push(`- item pinId: ${input.pinId}`);
  if (input.itemDescPinId) lines.push(`- item_desc pinId: ${input.itemDescPinId} (display info backfill)`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  const confirm = input.confirmation;
  if (confirm.hit) {
    lines.push(`- index confirmation: COLLECTED as #${confirm.hit.number ?? '?'} of "${confirm.hit.collectionName || input.collectionName}".`);
  } else {
    const reason = confirm.lastError ? ` (last lookup error: ${confirm.lastError})` : '';
    const waited = input.waitMs > 0
      ? `not visible after ${Math.round(input.waitMs / 1000)}s`
      : 'confirmation wait skipped';
    lines.push(
      `- index confirmation: ${waited}${reason} — the pin may still be `
      + 'confirming. Verify with mrc721_item_info; if the collection itself is not yet indexed, this mint stays '
      + 'pending until the collection registers.',
    );
  }
  lines.push(`- view link: ${markdownSelfLink(`pin://${input.pinId}`)}`);
  lines.push('- transfers spend this item UTXO — use mrc721_transfer with this pinId.');
  return lines.join('\n');
}

export function formatMrc721TransferResult(input: {
  txId: string;
  pinId: string;
  toAddress: string;
  spentOutpoint: string;
  outputValue: number;
}): string {
  const lines: string[] = [
    'MRC-721 transfer broadcast on-chain (plain UTXO spend — no protocol message).',
    `- txid: ${input.txId}`,
    `- item pinId: ${input.pinId}`,
    `- spent UTXO: ${input.spentOutpoint} (${input.outputValue} sats)`,
    `- to: ${input.toAddress}`,
    'The NFT moves to the recipient when the tx confirms; the indexer rewrites ownership from the spend. '
      + 'Verify with mrc721_item_info (owner + transfer history) after confirmation.',
  ];
  return lines.join('\n');
}

/**
 * Resolve `to` (metabot_id | local bot name | raw MVC address) to an MVC
 * address — same three-form convention as wallet_transfer/wallet_nft_transfer.
 */
function resolveTransferTarget(
  toRaw: string,
  control: Mrc721ToolsControl,
): { address: string; metabotId: number | null; name?: string } | { error: string } {
  if (/^\d+$/.test(toRaw)) {
    const id = Number(toRaw);
    const address = control.getMetabotMvcAddress(id);
    if (address) return { address, metabotId: id };
    return { error: `local MetaBot not found: ${toRaw}` };
  }
  if (!isMvcAddress(toRaw)) {
    // Local bot name (the tool description's third accepted form — same
    // resolution chain as wallet_nft_transfer). The matched name rides along
    // so the transfer card can prefill the new owner's label.
    const id = control.resolveMetabotIdByName(toRaw);
    if (id == null) {
      return { error: `"${toRaw}" is neither a local MetaBot id/name nor an MVC address. For an external recipient pass the full MVC address.` };
    }
    const address = control.getMetabotMvcAddress(id);
    if (!address) {
      return { error: `MetaBot ${toRaw} has no MVC address.` };
    }
    return { address, metabotId: id, name: toRaw };
  }
  return { address: toRaw, metabotId: null };
}

/**
 * Batch address resolution shared by the read tools: metabot_ids + names →
 * local roster addresses; explicit address appended as-is. Falls back to the
 * session bot's own address when nothing is passed.
 */
function resolveReadTargets(input: {
  metabot_ids?: number[];
  names?: string[];
  address?: string;
}, control: Mrc721ToolsControl, sessionMetabotId: number | null): Array<{ metabotId: number | null; address: string }> {
  const targets: Array<{ metabotId: number | null; address: string }> = [];
  const seen = new Set<string>();
  const push = (metabotId: number | null, address: string) => {
    // Keep address-less roster entries so the renderer can report them
    // (a bot with no MVC address must not silently vanish from a batch read).
    const key = `${metabotId ?? 'addr'}:${address}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ metabotId, address });
  };
  for (const rawId of input.metabot_ids ?? []) {
    const id = Number(rawId);
    if (Number.isInteger(id) && id > 0) push(id, control.getMetabotMvcAddress(id) ?? '');
  }
  for (const rawName of input.names ?? []) {
    const name = asString(rawName);
    if (!name) continue;
    const id = control.resolveMetabotIdByName(name);
    if (id != null) push(id, control.getMetabotMvcAddress(id) ?? '');
  }
  const explicit = asString(input.address);
  if (explicit) push(null, explicit);
  if (!targets.length && sessionMetabotId != null) {
    push(sessionMetabotId, control.getMetabotMvcAddress(sessionMetabotId) ?? '');
  }
  return targets;
}

/**
 * MetaID read-target flavor (requirement S8): resolve a 64-hex MetaID to its
 * holder address through the metafile-indexer user-info route. Returns null
 * when unresolvable — callers surface a descriptive error instead of silently
 * dropping the target.
 */
async function resolveMetaidTargetAddress(metaIdRaw: string): Promise<string | null> {
  const metaId = asString(metaIdRaw);
  if (!metaId) return null;
  try {
    return await fetchMrc721AddressByMetaId({ metaId });
  } catch {
    return null;
  }
}

/** Issuer filter resolution for the search tool: local name → address → MetaID. */
async function resolveIssuerFilter(
  issuerRaw: string,
  control: Mrc721ToolsControl,
): Promise<string | { error: string }> {
  const raw = asString(issuerRaw);
  if (!raw) return { error: 'issuer is empty' };
  if (isMvcAddress(raw)) return raw;
  const localId = control.resolveMetabotIdByName(raw);
  if (localId != null) {
    const address = control.getMetabotMvcAddress(localId);
    if (address) return address;
  }
  const byMetaId = await resolveMetaidTargetAddress(raw);
  if (byMetaId) return byMetaId;
  return { error: `"${raw}" is neither a local MetaBot name, an MVC address, nor a resolvable MetaID` };
}

/**
 * Card-enrichment reads (S3 chat NFT cards). Both go through the host control
 * when wired (main.ts), falling back to the direct service calls — every
 * failure degrades to an identity-only card, never a failed action.
 */
async function loadMrc721CardItem(control: Mrc721ToolsControl, pinId: string): Promise<Mrc721ItemSummary | null> {
  try {
    return control.fetchItemInfo ? await control.fetchItemInfo(pinId) : await fetchMrc721ItemInfo({ pinId });
  } catch {
    return null;
  }
}

async function loadMrc721CollectionForCard(
  control: Mrc721ToolsControl,
  input: { name?: string; pinId?: string },
): Promise<{ collection: Mrc721CollectionSummary | null; error?: string }> {
  try {
    const collection = control.fetchCollectionInfo
      ? await control.fetchCollectionInfo(input)
      : await fetchMrc721CollectionInfo(input);
    return { collection };
  } catch (error) {
    return { collection: null, error: errorMessage(error) };
  }
}

/** Collection issuer address for the card's issuer chip — best-effort. */
async function loadMrc721IssuerAddress(
  control: Mrc721ToolsControl,
  collectionName: string | undefined,
): Promise<string | undefined> {
  const name = asString(collectionName);
  if (!name) return undefined;
  const { collection } = await loadMrc721CollectionForCard(control, { name });
  return collection?.createAddress || undefined;
}

export function buildMrc721AgentTools(deps: {
  tool: SdkToolFactory;
  control: Mrc721ToolsControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const sessionMetabotId = (): number | null => {
    const id = resolveMetabotId(sessionId);
    return id == null ? null : id;
  };

  const requireSessionMetabot = (toolLabel: string): number | string | null => {
    const id = sessionMetabotId();
    if (id == null) {
      return `${toolLabel} could not determine which MetaBot owns this session; writes must spend the session bot's own wallet.`;
    }
    return id;
  };

  // -------------------------------------------------------------------------
  // mrc721_collection_create (R1, write)
  // -------------------------------------------------------------------------
  const mrc721CollectionCreate = tool(
    'mrc721_collection_create',
    [
      'Issue (register) an MRC-721 collection (MetaID native, pin-based NFT) as THIS session MetaBot — NOT the MetaContract wallet_nft_* line.',
      'Broadcasts the collection_desc pin at /nft/mrc721/{collection_name}/collection_desc; the FIRST registration of a collection_name wins globally (cross-chain namespace). Prechecks the indexer first: a taken name is refused.',
      'collection_name: lowercase [a-z0-9-] (no "/"); total_supply: -1 = unlimited (default); royalty_rate: 0-20% (default 0); cover: a metafile pinId (64-hex…i0) or metafile:// URI — upload the artwork first (metabot-upload-file) to get it.',
      'Waits for indexer confirmation (indexing latency = pin confirmation latency) and returns the collectionid (= collection_desc pinId). On-chain write with fees.',
    ].join(' '),
    {
      collection_name: z.string().min(1).describe('Collection namespace name: lowercase [a-z0-9-], no "/", globally unique — first registration wins.'),
      name: z.string().optional().describe('Display name of the collection (defaults to collection_name).'),
      total_supply: z.number().int().optional().describe('Max items, integer in [-1, 1e12]; -1 or omitted = unlimited.'),
      royalty_rate: z.number().int().min(0).max(20).optional().describe('Royalty percentage [0, 20]; default 0.'),
      desc: z.string().optional().describe('Collection description.'),
      website: z.string().optional().describe('Collection website URL.'),
      cover: z.string().optional().describe('Cover image: metafile pinId (64-hex…i0) or metafile:// URI (upload via metabot-upload-file first).'),
      metadata: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Extra metadata (JSON object or JSON string), stored verbatim.'),
      network: z.enum(['mvc', 'btc']).optional().describe('Write network; default mvc (BTC writes are not yet supported for MRC-721 in this version).'),
      wait_ms: z.number().int().nonnegative().optional().describe('Indexer confirmation wait in ms (default 30000, max 120000, 0 = skip waiting).'),
    },
    async (args: {
      collection_name: string;
      name?: string;
      total_supply?: number;
      royalty_rate?: number;
      desc?: string;
      website?: string;
      cover?: string;
      metadata?: unknown;
      network?: 'mvc' | 'btc';
      wait_ms?: number;
    }) => {
      const owner = requireSessionMetabot('mrc721_collection_create');
      if (typeof owner === 'string') return textResult(owner, true);
      let collectionName: string;
      try {
        collectionName = validateMrc721CollectionName(args.collection_name);
      } catch (error) {
        return textResult(`mrc721_collection_create: ${errorMessage(error)}`, true);
      }
      if (args.network === 'btc') {
        return textResult('mrc721_collection_create: BTC-side writes are not supported in this version — use network mvc.', true);
      }

      // Precheck: is the name already registered? (first-registration-wins)
      let precheckWarning: string | undefined;
      try {
        const existing = await fetchMrc721CollectionInfo({ name: collectionName });
        if (existing) {
          return textResult(
            `mrc721_collection_create: collection_name "${collectionName}" is already registered `
            + `(collectionid ${existing.pinid || '?'}, issuer ${existing.createMetaId || existing.createAddress || '?'}). `
            + 'First registration wins globally — pick another collection_name, or mint into it with mrc721_mint.',
            true,
          );
        }
      } catch (error) {
        precheckWarning = `indexer precheck unavailable (${errorMessage(error)}) — proceeding; the pin is authoritative and first-registration-wins.`;
      }

      try {
        const result = await control.collectionCreate({
          metabotId: owner,
          collectionName,
          name: asString(args.name) || undefined,
          totalSupply: args.total_supply,
          royaltyRate: args.royalty_rate,
          desc: asString(args.desc) || undefined,
          website: asString(args.website) || undefined,
          cover: asString(args.cover) || undefined,
          metadata: args.metadata,
          network: 'mvc',
        });
        const waitMs = args.wait_ms == null ? MRC721_POLL_DEFAULT_MS : clampPollWaitMs(args.wait_ms);
        const confirmation = waitMs > 0
          ? await waitForMrc721CollectionInfo({ name: collectionName, timeoutMs: waitMs })
          : { hit: null };
        return textResult(formatMrc721CollectionCreateResult({
          collectionName: result.collectionName,
          pinId: result.pinId,
          txids: result.txids,
          totalCost: result.totalCost,
          feeAssist: result.feeAssist,
          confirmation,
          waitMs,
          precheckWarning,
        }));
      } catch (error) {
        return textResult(`mrc721_collection_create failed: ${errorMessage(error)}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // mrc721_collection_update (收藏级修改, write)
  // -------------------------------------------------------------------------
  const mrc721CollectionUpdate = tool(
    'mrc721_collection_update',
    [
      'Modify the display info of an MRC-721 collection THIS session MetaBot issued (pin-based MetaID NFT — NOT the MetaContract wallet_nft_* line): name / desc / website / cover / metadata, with cover addable AND replaceable after creation.',
      'Broadcasts an operation=modify pin at the SAME collection_desc path carrying the FULL latest content merged with the overrides (not a diff); the indexer resolves the modify chain to the latest version. Issuer-only: the tool verifies the session bot is the collection_desc creator and refuses otherwise.',
      'Upload new artwork first (metabot-upload-file) to get a cover pinId; cover accepts a metafile pinId or metafile:// URI (same behavior as mrc721_mint). The collection must be registered and indexed. On-chain write with fees.',
    ].join(' '),
    {
      collection_name: z.string().min(1).describe('Collection namespace name to modify (must be indexed; see mrc721_collection_info).'),
      name: z.string().optional().describe('New display name.'),
      desc: z.string().optional().describe('New description.'),
      website: z.string().optional().describe('New website URL.'),
      cover: z.string().optional().describe('New cover: metafile pinId (64-hex…i0) or metafile:// URI — added or replaced (upload via metabot-upload-file first).'),
      metadata: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('New extra metadata (JSON object or JSON string), replaces the previous value.'),
      network: z.enum(['mvc', 'btc']).optional().describe('Write network; default mvc (BTC writes are not yet supported for MRC-721 in this version).'),
    },
    async (args: {
      collection_name: string;
      name?: string;
      desc?: string;
      website?: string;
      cover?: string;
      metadata?: unknown;
      network?: 'mvc' | 'btc';
    }) => {
      const owner = requireSessionMetabot('mrc721_collection_update');
      if (typeof owner === 'string') return textResult(owner, true);
      let collectionName: string;
      try {
        collectionName = validateMrc721CollectionName(args.collection_name);
      } catch (error) {
        return textResult(`mrc721_collection_update: ${errorMessage(error)}`, true);
      }
      if (args.network === 'btc') {
        return textResult('mrc721_collection_update: BTC-side writes are not supported in this version — use network mvc.', true);
      }
      const hasOverride = Boolean(
        asString(args.name) || asString(args.desc) || asString(args.website) || asString(args.cover)
        || (args.metadata != null && (typeof args.metadata !== 'string' || args.metadata.trim() !== '')),
      );
      if (!hasOverride) {
        return textResult(
          'mrc721_collection_update: nothing to update — pass at least one of name/desc/website/cover/metadata.',
          true,
        );
      }

      try {
        const result = await control.collectionUpdate({
          metabotId: owner,
          collectionName,
          name: asString(args.name) || undefined,
          desc: asString(args.desc) || undefined,
          website: asString(args.website) || undefined,
          cover: asString(args.cover) || undefined,
          metadata: args.metadata,
          network: 'mvc',
        });
        return textResult(formatMrc721CollectionUpdateResult({
          collectionName: result.collectionName,
          pinId: result.pinId,
          txids: result.txids,
          totalCost: result.totalCost,
          feeAssist: result.feeAssist,
          updatedFields: result.updatedFields,
        }));
      } catch (error) {
        return textResult(`mrc721_collection_update failed: ${errorMessage(error)}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // mrc721_mint (R2, write)
  // -------------------------------------------------------------------------
  const mrc721Mint = tool(
    'mrc721_mint',
    [
      'Mint ONE MRC-721 NFT item into a collection as THIS session MetaBot (pin-based MetaID NFT — NOT the MetaContract wallet_nft_* line).',
      'Broadcasts an item create pin at /nft/mrc721/{collection_name}/{item_path} (any create pin under the collection mints); optional name/desc/cover/metadata ride a follow-up item_desc pin referencing the mint pinId (display info is derived from item_desc only).',
      'Open minting: anyone may mint into any registered collection until total_supply is reached; items minted by the collection issuer show the OFFICIAL badge. The indexer precheck refuses mints into an exhausted collection.',
      'Returns the item pinId (the NFT identifier — transfers use it). On-chain write with fees.',
    ].join(' '),
    {
      collection_name: z.string().min(1).describe('Target collection namespace (must be registered; see mrc721_collections / mrc721_collection_info).'),
      item_path: z.string().optional().describe('Item path segment, lowercase [a-z0-9._-], not collection_desc/item_desc; auto-generated when omitted.'),
      name: z.string().optional().describe('Item display name (rides the item_desc pin).'),
      desc: z.string().optional().describe('Item description (rides the item_desc pin).'),
      cover: z.string().optional().describe('Item cover: metafile pinId or metafile:// URI (upload via metabot-upload-file first).'),
      metadata: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Extra item metadata (JSON object or JSON string).'),
      network: z.enum(['mvc', 'btc']).optional().describe('Write network; default mvc (BTC writes not supported in this version).'),
      wait_ms: z.number().int().nonnegative().optional().describe('Indexer confirmation wait in ms (default 30000, max 120000, 0 = skip waiting).'),
    },
    async (args: {
      collection_name: string;
      item_path?: string;
      name?: string;
      desc?: string;
      cover?: string;
      metadata?: unknown;
      network?: 'mvc' | 'btc';
      wait_ms?: number;
    }) => {
      const owner = requireSessionMetabot('mrc721_mint');
      if (typeof owner === 'string') return textResult(owner, true);
      let collectionName: string;
      try {
        collectionName = validateMrc721CollectionName(args.collection_name);
      } catch (error) {
        return textResult(`mrc721_mint: ${errorMessage(error)}`, true);
      }
      if (args.network === 'btc') {
        return textResult('mrc721_mint: BTC-side writes are not supported in this version — use network mvc.', true);
      }

      let precheckWarning: string | undefined;
      let precheckIssuerAddress: string | undefined;
      const precheck = await loadMrc721CollectionForCard(control, { name: collectionName });
      if (precheck.error) {
        precheckWarning = `indexer precheck unavailable (${precheck.error}) — proceeding; supply is enforced by the indexer at ingest.`;
      } else if (!precheck.collection) {
        precheckWarning = `collection "${collectionName}" is not indexed yet — the mint still lands on-chain, but it only gets collected `
          + 'after the collection registers. If the collection was never issued, this mint will never index (fee wasted).';
      } else {
        precheckIssuerAddress = precheck.collection.createAddress || undefined;
        const collection = precheck.collection;
        if (collection.totalSupply != null && collection.totalSupply >= 0
          && (collection.totalnum ?? 0) >= collection.totalSupply) {
          return textResult(
            `mrc721_mint: collection "${collectionName}" is exhausted (${collection.totalnum}/${collection.totalSupply} minted) — `
            + 'the indexer rejects mints beyond total_supply.',
            true,
          );
        }
      }

      try {
        const result = await control.mint({
          metabotId: owner,
          collectionName,
          itemPath: asString(args.item_path) || undefined,
          name: asString(args.name) || undefined,
          desc: asString(args.desc) || undefined,
          cover: asString(args.cover) || undefined,
          metadata: args.metadata,
          network: 'mvc',
        });
        const waitMs = args.wait_ms == null ? MRC721_POLL_DEFAULT_MS : clampPollWaitMs(args.wait_ms);
        const confirmation = waitMs > 0
          ? await waitForMrc721ItemInfo({ pinId: result.pinId, timeoutMs: waitMs })
          : { hit: null };
        // S3 chat card: index snapshot first, then the mint arguments the
        // emitter itself holds — every field degrades independently, so an
        // unconfirmed mint still renders an identity-only card.
        const snapshot = confirmation.hit ?? await loadMrc721CardItem(control, result.pinId);
        const cardFields = buildMrc721CardFields({
          pinId: result.pinId,
          facts: {
            item: {
              name: snapshot?.name || asString(args.name) || undefined,
              collectionName: snapshot?.collectionName || result.collectionName,
              number: snapshot?.number,
              cover: snapshot?.cover || asString(args.cover) || undefined,
              ownerAddress: snapshot?.ownerAddress || control.getMetabotMvcAddress(owner) || undefined,
            },
            issuerAddress: precheckIssuerAddress,
          },
          owner: control.getMetabotMvcAddress(owner) || undefined,
          action: 'minted',
        });
        return textResult(appendNftCardBlock(formatMrc721MintResult({
          collectionName: result.collectionName,
          itemPath: result.itemPath,
          pinId: result.pinId,
          itemDescPinId: result.itemDescPinId,
          txids: result.txids,
          totalCost: result.totalCost,
          feeAssist: result.feeAssist,
          confirmation,
          waitMs,
          precheckWarning,
        }), cardFields));
      } catch (error) {
        return textResult(`mrc721_mint failed: ${errorMessage(error)}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // mrc721_transfer (R3, write)
  // -------------------------------------------------------------------------
  const mrc721Transfer = tool(
    'mrc721_transfer',
    [
      'Transfer ONE MRC-721 NFT (pin-based, identified by its item pinId) from THIS session MetaBot to a target address or local MetaBot — NOT the MetaContract wallet_nft_transfer line.',
      'Spends the item pin\'s current UTXO (from the indexer item/info) as the FIRST input of a plain transfer tx — the indexer rewrites ownership from that spend; there is no protocol message.',
      '`to` accepts a local metabot_id, a local bot name, or a raw MVC address. MVC-chain items only in this version (BTC-side items are read-only).',
      'Transfers are irreversible on-chain — confirm the pinId and receiver with the owner before calling when ambiguous. Verify delivery with mrc721_item_info after the tx confirms.',
    ].join(' '),
    {
      pin_id: z.string().min(1).describe('Item pinId of the NFT to transfer (64-hex txid + "i" + output index; see mrc721_balance / mrc721_item_info).'),
      to: z.string().min(1).describe('Recipient: local metabot_id (e.g. "15"), local bot name, or MVC address.'),
    },
    async (args: { pin_id: string; to: string }) => {
      const owner = requireSessionMetabot('mrc721_transfer');
      if (typeof owner === 'string') return textResult(owner, true);
      const pinId = asString(args.pin_id);
      if (!pinId) {
        return textResult('mrc721_transfer requires `pin_id` (the item pinId).', true);
      }
      const toRaw = asString(args.to);
      if (!toRaw) {
        return textResult('mrc721_transfer requires `to` (metabot_id, name, or address).', true);
      }
      const target = resolveTransferTarget(toRaw, control);
      if ('error' in target) {
        return textResult(`mrc721_transfer: ${target.error}`, true);
      }
      try {
        // Pre-action snapshot: the item sits in the session bot's wallet right
        // now, so its display facts are the freshest they will ever be; the
        // card then records the RECIPIENT as the post-transfer owner.
        const snapshot = await loadMrc721CardItem(control, pinId);
        const result = await control.transfer({
          metabotId: owner,
          pinId,
          toAddress: target.address,
        });
        const cardFields = buildMrc721CardFields({
          pinId,
          facts: {
            item: snapshot,
            issuerAddress: await loadMrc721IssuerAddress(control, snapshot?.collectionName),
          },
          owner: target.address || undefined,
          ownerLabel: 'name' in target ? target.name : undefined,
          action: 'transferred',
        });
        return textResult(appendNftCardBlock(
          formatMrc721TransferResult(result),
          withNftCardHostStamp(cardFields, sessionId),
        ));
      } catch (error) {
        return textResult(`mrc721_transfer failed: ${errorMessage(error)}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // mrc721_balance (R6 read: 我的持仓)
  // -------------------------------------------------------------------------
  const mrc721Balance = tool(
    'mrc721_balance',
    [
      'Query the MRC-721 NFT holdings (pin-based MetaID NFTs) of local MetaBots by id, or of a raw address or external MetaID — the pin-based counterpart of wallet_nft_balance (MetaContract NFTs).',
      'Reads the indexer holder view (address/item), optionally filtered to one collection; grouping and per-item identity (item pinId, collection, number, official-mint badge) come from the index.',
      'Read-only index data; cross-chain — a raw BTC address works as-is. Batch multiple metabot_ids in ONE call. Defaults to THIS session bot when nothing is passed.',
    ].join(' '),
    {
      metabot_ids: z.array(z.number().int().positive()).optional().describe('Local MetaBot ids to query, e.g. [1, 15]. Batch in one call.'),
      names: z.array(z.string()).optional().describe('Local MetaBot names to resolve and query, e.g. ["AI_Sunny"].'),
      address: z.string().optional().describe('Explicit address to query (MVC or BTC; used as-is).'),
      metaid: z.string().optional().describe('64-hex MetaID to query — resolved to its holder address via the user-info indexer (external users).'),
      collection_name: z.string().optional().describe('Filter to one collection by name (resolved via the indexer).'),
      collection_pinid: z.string().optional().describe('Filter to one collection by collectionid (the collection_desc pinId).'),
    },
    async (args: {
      metabot_ids?: number[];
      names?: string[];
      address?: string;
      metaid?: string;
      collection_name?: string;
      collection_pinid?: string;
    }) => {
      let metaidAddress: string | undefined;
      if (args.metaid) {
        metaidAddress = (await resolveMetaidTargetAddress(args.metaid)) ?? undefined;
        if (!metaidAddress) {
          return textResult(`mrc721_balance: could not resolve MetaID "${asString(args.metaid)}" to a holder address.`, true);
        }
      }
      let collectionPinId = asString(args.collection_pinid) || undefined;
      const collectionName = asString(args.collection_name);
      if (!collectionPinId && collectionName) {
        try {
          const collection = await fetchMrc721CollectionInfo({ name: collectionName });
          if (!collection?.pinid) {
            return textResult(`mrc721_balance: collection "${collectionName}" is not indexed (yet) — no holdings can be filtered.`, true);
          }
          collectionPinId = collection.pinid;
        } catch (error) {
          return textResult(`mrc721_balance: collection lookup failed: ${errorMessage(error)}`, true);
        }
      }
      const targets = resolveReadTargets(
        { metabot_ids: args.metabot_ids, names: args.names, address: metaidAddress ?? args.address },
        control,
        sessionMetabotId(),
      );
      if (!targets.length) {
        return textResult('mrc721_balance requires metabot_ids, address, metaid (or a session bot).', true);
      }
      const lines: string[] = [];
      for (const target of targets) {
        const label = target.metabotId != null ? `metabot_id ${target.metabotId}` : 'address';
        if (!target.address) {
          lines.push(`# ${label}\n- lookup failed: local MetaBot not found or has no MVC address`);
          continue;
        }
        try {
          const items = await fetchMrc721AddressItems({ address: target.address, pinId: collectionPinId });
          lines.push(`# ${label} ${target.address}\n${formatMrc721Items(items)}`);
        } catch (error) {
          lines.push(`# ${label} ${target.address}\n- lookup failed: ${errorMessage(error)}`);
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  // -------------------------------------------------------------------------
  // mrc721_collections (R6 read: 我的专辑 + 广场)
  // -------------------------------------------------------------------------
  const mrc721Collections = tool(
    'mrc721_collections',
    [
      'List MRC-721 collections: scope "mine" = collections held/issued by local MetaBots or an address (indexer holder view); scope "market" = the public collection page list (the square/marketplace view).',
      'Each line: display name, mint progress (totalnum/totalSupply), royalty %, issuer identity (MetaID preferred), genesis chain and the collectionid (= collection_desc pinId).',
      'Read-only index data. Use before mrc721_mint (find a target collection) or mrc721_collection_info (drill into one).',
    ].join(' '),
    {
      scope: z.enum(['mine', 'market']).optional().describe('"mine" (default): collections held by the given bots/address; "market": the public page list.'),
      metabot_ids: z.array(z.number().int().positive()).optional().describe('Local MetaBot ids for scope "mine". Batch in one call.'),
      names: z.array(z.string()).optional().describe('Local MetaBot names for scope "mine", e.g. ["AI_Sunny"].'),
      address: z.string().optional().describe('Explicit address for scope "mine" (used as-is).'),
      metaid: z.string().optional().describe('64-hex MetaID for scope "mine" — resolved to its holder address via the user-info indexer (external users).'),
      cursor: z.string().optional().describe('Page cursor for scope "market" (from the previous call).'),
      size: z.number().int().positive().max(100).optional().describe('Page size for scope "market".'),
    },
    async (args: {
      scope?: 'mine' | 'market';
      metabot_ids?: number[];
      names?: string[];
      address?: string;
      metaid?: string;
      cursor?: string;
      size?: number;
    }) => {
      const scope = args.scope ?? 'mine';
      if (scope === 'market') {
        try {
          const page = await fetchMrc721CollectionPageList({ cursor: args.cursor, size: args.size });
          const lines = [`${page.items.length} collection(s) on the market page:`];
          for (const collection of page.items) lines.push(formatMrc721CollectionLine(collection));
          if (page.cursor) lines.push(`- next cursor: ${page.cursor}`);
          return textResult(lines.join('\n'));
        } catch (error) {
          return textResult(`mrc721_collections (market) failed: ${errorMessage(error)}`, true);
        }
      }
      let metaidAddress: string | undefined;
      if (args.metaid) {
        metaidAddress = (await resolveMetaidTargetAddress(args.metaid)) ?? undefined;
        if (!metaidAddress) {
          return textResult(`mrc721_collections: could not resolve MetaID "${asString(args.metaid)}" to a holder address.`, true);
        }
      }
      const targets = resolveReadTargets(
        { metabot_ids: args.metabot_ids, names: args.names, address: metaidAddress ?? args.address },
        control,
        sessionMetabotId(),
      );
      if (!targets.length) {
        return textResult('mrc721_collections (mine) requires metabot_ids, address, metaid (or a session bot).', true);
      }
      const lines: string[] = [];
      for (const target of targets) {
        const label = target.metabotId != null ? `metabot_id ${target.metabotId}` : 'address';
        if (!target.address) {
          lines.push(`# ${label}\n- lookup failed: local MetaBot not found or has no MVC address`);
          continue;
        }
        try {
          const collections = await fetchMrc721AddressCollections({ address: target.address });
          lines.push(`# ${label} ${target.address}`);
          if (!collections.length) lines.push('- no MRC-721 collections held at this address');
          else for (const collection of collections) lines.push(formatMrc721CollectionLine(collection));
        } catch (error) {
          lines.push(`# ${label} ${target.address}\n- lookup failed: ${errorMessage(error)}`);
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  // -------------------------------------------------------------------------
  // mrc721_item_info (R6 read: 详情 + 真伪 + 溯源)
  // -------------------------------------------------------------------------
  const mrc721ItemInfo = tool(
    'mrc721_item_info',
    [
      'Full detail sheet for ONE MRC-721 NFT by item pinId: current owner, current UTXO (the transfer spend target), genesis facts (chain/height/tx), authenticity (indexed? creator-minted?), and the full transfer timeline.',
      'Use to verify a mint landed, to check ownership before mrc721_transfer, or to prove provenance/authenticity to the user ("已收录 / 官方铸造 / 第三方铸造").',
      'Read-only index data.',
    ].join(' '),
    {
      pin_id: z.string().min(1).describe('Item pinId (64-hex txid + "i" + output index).'),
      include_transfers: z.boolean().optional().describe('Include the transfer timeline (default true).'),
      include_verify: z.boolean().optional().describe('Include the authenticity fact set from item/verify (default true).'),
    },
    async (args: {
      pin_id: string;
      include_transfers?: boolean;
      include_verify?: boolean;
    }) => {
      const pinId = asString(args.pin_id);
      if (!pinId) {
        return textResult('mrc721_item_info requires `pin_id`.', true);
      }
      let item: Mrc721ItemSummary | null;
      try {
        item = await fetchMrc721ItemInfo({ pinId });
      } catch (error) {
        return textResult(`mrc721_item_info failed: ${errorMessage(error)}`, true);
      }
      if (!item) {
        return textResult(
          `mrc721_item_info: item ${pinId} is not in the index — wrong pinId, or the pin is not confirmed/indexed yet.`,
          true,
        );
      }
      const wantTransfers = args.include_transfers !== false;
      const wantVerify = args.include_verify !== false;
      const [verifyResult, transfersResult] = await Promise.all([
        wantVerify
          ? fetchMrc721ItemVerify({ pinId }).then((verify) => ({ verify }), (error) => ({ verifyError: errorMessage(error) }))
          : Promise.resolve({}),
        wantTransfers
          ? fetchMrc721ItemTransfers({ pinId }).then((page) => ({ transfers: page.items }), (error) => ({ transfersError: errorMessage(error) }))
          : Promise.resolve({}),
      ]);
      return textResult(formatMrc721ItemDetail({
        item,
        ...verifyResult,
        ...transfersResult,
      }));
    }
  );

  // -------------------------------------------------------------------------
  // mrc721_collection_info (R6 read: 专辑详情与条目)
  // -------------------------------------------------------------------------
  const mrc721CollectionInfo = tool(
    'mrc721_collection_info',
    [
      'Detail sheet for ONE MRC-721 collection (by name or collectionid) with its first page of items: registration facts (issuer, genesis, royalty, supply), mint progress, and the item list.',
      'Use to verify a collection_create landed, to inspect supply before minting, or to browse what a collection contains.',
      'Read-only index data.',
    ].join(' '),
    {
      name: z.string().optional().describe('Collection namespace name.'),
      pin_id: z.string().optional().describe('Collectionid (the collection_desc pinId) — use when the name is unknown.'),
      include_items: z.boolean().optional().describe('Include the first page of items (default true).'),
      size: z.number().int().positive().max(100).optional().describe('Item page size.'),
    },
    async (args: {
      name?: string;
      pin_id?: string;
      include_items?: boolean;
      size?: number;
    }) => {
      const name = asString(args.name);
      const pinId = asString(args.pin_id);
      if (!name && !pinId) {
        return textResult('mrc721_collection_info requires `name` or `pin_id` (the collectionid).', true);
      }
      let collection: Mrc721CollectionSummary | null;
      try {
        collection = await fetchMrc721CollectionInfo({ name: name || undefined, pinId: pinId || undefined });
      } catch (error) {
        return textResult(`mrc721_collection_info failed: ${errorMessage(error)}`, true);
      }
      if (!collection) {
        return textResult(
          `mrc721_collection_info: collection ${name || pinId} is not indexed — never registered, or the collection_desc pin is not confirmed yet.`,
          true,
        );
      }
      const lines: string[] = [`MRC-721 collection "${collection.name || collection.collectionName}"`];
      lines.push(formatMrc721CollectionLine(collection));
      if (collection.desc) lines.push(`- desc: ${collection.desc}`);
      if (collection.website) lines.push(`- website: ${collection.website}`);
      if (collection.cover) lines.push(`- cover: ${collection.cover}`);
      if (collection.metadata) lines.push(`- metadata: ${collection.metadata}`);
      lines.push(`- genesis: ${[collection.genesisChainName ? `chain ${collection.genesisChainName}` : '', collection.genesisHeight != null ? `height ${collection.genesisHeight}` : '', collection.genesisTx ? `tx ${collection.genesisTx}` : ''].filter(Boolean).join(', ') || '(unknown)'}`);
      // Modify chain (version history of collection_desc modify pins). The
      // indexer exposes it permissively today — accept both key casings and
      // string-or-object entries until the P2 contract freezes the shape.
      const rawHistory = (collection as { modifyHistory?: unknown; modify_history?: unknown }).modifyHistory
        ?? (collection as { modify_history?: unknown }).modify_history;
      if (Array.isArray(rawHistory) && rawHistory.length) {
        const ids = rawHistory
          .map((entry) => (typeof entry === 'string'
            ? entry
            : String((entry as { pinid?: unknown; pinId?: unknown })?.pinid ?? (entry as { pinId?: unknown })?.pinId ?? '')))
          .filter(Boolean);
        if (ids.length) {
          lines.push(`- modify history (${ids.length}): ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}`);
        }
      }
      if (args.include_items !== false && (collection.pinid || pinId)) {
        try {
          const page = await fetchMrc721CollectionItems({ pinid: collection.pinid || pinId, size: args.size });
          if (!page.items.length) {
            lines.push('- items: none minted yet (mrc721_mint to add the first one)');
          } else {
            lines.push(`- items (${page.items.length} shown):`);
            for (const item of page.items) {
              const title = item.name || '(unnamed)';
              const badge = item.creatorMinted ? ' [creator-minted]' : '';
              lines.push(`  - #${item.number ?? '?'} ${title} · pinid ${item.itemPinId} · owner ${formatShortAddress(item.ownerAddress)}${badge}`);
            }
            if (page.cursor) lines.push(`  - next cursor: ${page.cursor}`);
          }
        } catch (error) {
          lines.push(`- items: lookup failed (${errorMessage(error)})`);
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  const mrc721Sell = tool(
    'mrc721_sell',
    [
      'List one MRC-721 item for sale as an atomic swap (pin-based MetaID NFT — NOT wallet_nft_*).',
      'Builds a partial MVC transaction: input 0 is the NFT (seller-signed), output 0 sends the NFT to buyer_address, output 1 pays price_sats to you.',
      `price_sats must be at least ${MRC721_MIN_SELL_PRICE_SATS}. Returns the listing JSON — give that text to the buyer. Nothing is broadcast until they buy.`,
    ].join(' '),
    {
      item_pin_id: z.string().min(1).describe('Item pinId from mrc721_item_info (64-hex txid + "i" + index).'),
      buyer_address: z.string().min(1).describe('MVC address of the buyer. The listing pays the NFT only to this address.'),
      price_sats: z.number().int().describe(`Ask price in satoshis. Minimum ${MRC721_MIN_SELL_PRICE_SATS}.`),
    },
    async (args: { item_pin_id: string; buyer_address: string; price_sats: number }) => {
      const owner = requireSessionMetabot('mrc721_sell');
      if (typeof owner === 'string') return textResult(owner, true);
      if (!Number.isInteger(args.price_sats) || args.price_sats < MRC721_MIN_SELL_PRICE_SATS) {
        return textResult(
          `mrc721_sell: Selling Price must be greater than or equals to ${MRC721_MIN_SELL_PRICE_SATS} satoshis. 销售价格最低为${MRC721_MIN_SELL_PRICE_SATS}聪。`,
          true,
        );
      }
      try {
        // Pre-action snapshot: the item still sits in the bot's wallet, so
        // the artwork/name facts survive even if the indexer lags behind the
        // listing handoff.
        const snapshot = await loadMrc721CardItem(control, args.item_pin_id);
        const result = await control.sell({
          metabotId: owner,
          itemPinId: args.item_pin_id,
          buyerAddress: args.buyer_address,
          priceSats: args.price_sats,
        });
        const cardFields = buildMrc721CardFields({
          pinId: result.itemPinId,
          facts: {
            item: snapshot,
            issuerAddress: await loadMrc721IssuerAddress(control, snapshot?.collectionName),
          },
          owner: control.getMetabotMvcAddress(owner) || undefined,
          priceSats: result.priceSats,
          action: 'listed',
        });
        return textResult(appendNftCardBlock([
          'MRC-721 listing is ready. Give the listing JSON below to the buyer — they complete payment and the NFT transfer in one transaction.',
          `- item pinId: ${result.itemPinId}`,
          `- buyer: ${result.buyerAddress}`,
          `- price: ${result.priceSats} sats`,
          `- NFT outpoint: ${result.outpoint}`,
          '- listing JSON:',
          result.listingJson,
        ].join('\n'), withNftCardHostStamp(cardFields, sessionId)));
      } catch (error) {
        return textResult(`mrc721_sell failed: ${errorMessage(error)}${chainWriteFailureDetail(error)}`, true);
      }
    },
  );

  const mrc721Buy = tool(
    'mrc721_buy',
    [
      'Buy an MRC-721 item from a seller listing JSON (atomic swap — one MVC transaction pays the seller and moves the NFT).',
      'Refuses tampered listings, listings whose NFT has already moved, and payments that would overpay the miner because there is no change output.',
      'Pass the listing object the seller gave you. You must be the buyer_address on that listing.',
    ].join(' '),
    {
      listing: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('Seller listing JSON object, or the same JSON as a string.'),
    },
    async (args: { listing: unknown }) => {
      const owner = requireSessionMetabot('mrc721_buy');
      if (typeof owner === 'string') return textResult(owner, true);
      try {
        const result = await control.buy({ metabotId: owner, listing: args.listing });
        // Post-action snapshot from the index doubles as the enrichment read;
        // indexer lag behind the just-broadcast swap degrades to an
        // identity-only card (format+pinId+owner+price always survive).
        const snapshot = await loadMrc721CardItem(control, result.itemPinId);
        const cardFields = buildMrc721CardFields({
          pinId: result.itemPinId,
          facts: {
            item: snapshot,
            issuerAddress: await loadMrc721IssuerAddress(control, snapshot?.collectionName),
          },
          owner: control.getMetabotMvcAddress(owner) || undefined,
          priceSats: result.priceSats,
          action: 'bought',
        });
        return textResult(appendNftCardBlock([
          'MRC-721 purchase broadcast on-chain. Payment and the NFT transfer are the same transaction.',
          `- txid: ${result.txId}`,
          `- item pinId: ${result.itemPinId}`,
          `- paid seller ${result.sellerAddress}: ${result.priceSats} sats`,
          `- miner fee: ${result.feeSats} sats (${result.feeRateEffective.toFixed(2)} sat/byte, no change output)`,
          'When it confirms, mrc721_item_info should show you as owner and mrc721_item_info transfer history should include this txid.',
        ].join('\n'), withNftCardHostStamp(cardFields, sessionId)));
      } catch (error) {
        return textResult(`mrc721_buy failed: ${errorMessage(error)}${chainWriteFailureDetail(error)}`, true);
      }
    },
  );

  const mrc721SellOrders = tool(
    'mrc721_sell_orders',
    [
      'List MRC-721 atomic-swap listings THIS session MetaBot created locally, and recheck each one.',
      'There is no on-chain order book. A listing is valid only while the seller signature, indexer ownership, and unspent outpoint still match. Expired means the off-chain expiresAt passed. Optional collection filter resolves each item\'s collection via the indexer (best effort).',
    ].join(' '),
    {
      collection_name: z.string().optional().describe('Filter to one collection by namespace name (resolved per item via the indexer).'),
      collection_pinid: z.string().optional().describe('Filter to one collection by collectionid.'),
    },
    async (args: { collection_name?: string; collection_pinid?: string }) => {
      const owner = requireSessionMetabot('mrc721_sell_orders');
      if (typeof owner === 'string') return textResult(owner, true);
      const filterName = asString(args.collection_name) || undefined;
      const filterPinId = asString(args.collection_pinid) || undefined;
      try {
        let orders = await control.listSellOrders({ metabotId: owner });
        if (filterName || filterPinId) {
          const kept = [];
          for (const order of orders) {
            const item = await loadMrc721CardItem(control, order.itemPinId);
            if (filterPinId && (item?.collectionPinId ?? '') !== filterPinId) continue;
            if (filterName && (item?.collectionName ?? '') !== filterName) continue;
            kept.push(order);
          }
          orders = kept;
        }
        if (!orders.length) {
          return textResult('No local MRC-721 listings. Create one with mrc721_sell and give the listing JSON to the buyer.');
        }
        const lines = [`Local MRC-721 listings (${orders.length}):`];
        for (const order of orders) {
          lines.push(`- ${order.status} ${order.id} · ${order.itemPinId} · ${order.priceSats} sats → ${order.buyerAddress} · ${order.outpoint}`);
          if (order.reason) lines.push(`  reason: ${order.reason}`);
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        return textResult(`mrc721_sell_orders failed: ${errorMessage(error)}`, true);
      }
    },
  );

  // -------------------------------------------------------------------------
  // mrc721_sell_intent / cancel / list (sell-intent protocol, "NFT 售")
  // -------------------------------------------------------------------------
  const mrc721SellIntent = tool(
    'mrc721_sell_intent',
    [
      'Declare the intent to sell one MRC-721 item (pin-based MetaID NFT) as an on-chain sell-intent pin (docs/nft-sell-protocol-draft.md) — the discoverable, currency-agnostic "I want to sell this" announcement.',
      'The pin moves no funds and transfers nothing: settlement later runs over the locked atomic-swap rail (mrc721_sell to the agreed buyer, native SPACE) or the escrow/guarantor rail (any currency). The item must currently be held by this bot; the declaration is refused otherwise.',
      'price_hint_sats is a display reference only, NOT an on-chain ask. accepted_currencies is an open vocabulary (space, btc, fiat:CNY, points:<scope>, ...). Broadcasts a pin under /nft/mrc721sell/ and appends an ```nft-card fence with action "selling" — include it verbatim in your announcement.',
    ].join(' '),
    {
      item_pin_id: z.string().min(1).describe('Item pinId from mrc721_item_info (64-hex txid + "i" + index).'),
      price_hint_sats: z.number().int().positive().optional().describe('Reference price in native sats, display only. Omit for "make an offer".'),
      accepted_currencies: z.array(z.string().min(1)).optional().describe('Accepted settlement currencies, e.g. ["space","btc","fiat:CNY"]. Default ["space"].'),
      settlement: z.array(z.enum(['atomic-swap', 'escrow'])).optional().describe('Settlement rails the seller accepts. Default both.'),
      note: z.string().optional().describe('Free-text note for potential buyers.'),
      expires_in_hours: z.number().int().positive().optional().describe('Display-only expiry window in hours (e.g. 168 for a week). Omit = no stated expiry.'),
      network: z.enum(['mvc', 'btc']).optional().describe('Write network; default mvc (BTC writes are not yet supported in this version).'),
    },
    async (args: {
      item_pin_id: string;
      price_hint_sats?: number;
      accepted_currencies?: string[];
      settlement?: string[];
      note?: string;
      expires_in_hours?: number;
      network?: 'mvc' | 'btc';
    }) => {
      const owner = requireSessionMetabot('mrc721_sell_intent');
      if (typeof owner === 'string') return textResult(owner, true);
      if (args.network === 'btc') {
        return textResult('mrc721_sell_intent: BTC-side writes are not supported in this version — use network mvc.', true);
      }
      try {
        const snapshot = await loadMrc721CardItem(control, args.item_pin_id);
        const result = await control.sellIntentDeclare({
          metabotId: owner,
          itemPinId: args.item_pin_id,
          priceHintSats: args.price_hint_sats,
          acceptedCurrencies: args.accepted_currencies,
          settlement: args.settlement,
          note: args.note,
          expiresInHours: args.expires_in_hours,
          network: args.network,
        });
        const cardFields = buildMrc721CardFields({
          pinId: result.intent.itemPinId,
          facts: { item: snapshot, issuerAddress: await loadMrc721IssuerAddress(control, result.intent.collectionName) },
          owner: control.getMetabotMvcAddress(owner) || undefined,
          priceSats: result.intent.priceHintSats,
          action: 'selling',
        });
        return textResult(appendNftCardBlock([
          'MRC-721 sell intent declared on-chain. This is a discoverable announcement, not an escrowed listing — buyers reach you, then settlement runs over atomic-swap (locked listing) or the guarantor flow.',
          `- item pinId: ${result.intent.itemPinId}`,
          `- sell-intent pin: pin://${result.sellPinId}`,
          `- price hint: ${result.intent.priceHintSats != null ? `${result.intent.priceHintSats} sats` : 'make an offer'}`,
          `- accepted currencies: ${result.intent.acceptedCurrencies.join(', ')}`,
          `- settlement: ${result.intent.settlement.join(' / ')}`,
        ].join('\n'), withNftCardHostStamp(cardFields, sessionId)));
      } catch (error) {
        return textResult(`mrc721_sell_intent failed: ${errorMessage(error)}${chainWriteFailureDetail(error)}`, true);
      }
    },
  );

  const mrc721SellIntentCancel = tool(
    'mrc721_sell_intent_cancel',
    [
      'Cancel one of THIS bot\'s MRC-721 sell-intent declarations: modifies the /nft/mrc721sell/ pin with active=false and flips the local record. The item itself is untouched.',
      'Read-only on funds; one modify pin. Use mrc721_sell_intents to see your declared intents first.',
    ].join(' '),
    {
      item_pin_id: z.string().min(1).describe('Item pinId of the intent to cancel.'),
      network: z.enum(['mvc', 'btc']).optional().describe('Write network; default mvc.'),
    },
    async (args: { item_pin_id: string; network?: 'mvc' | 'btc' }) => {
      const owner = requireSessionMetabot('mrc721_sell_intent_cancel');
      if (typeof owner === 'string') return textResult(owner, true);
      if (args.network === 'btc') {
        return textResult('mrc721_sell_intent_cancel: BTC-side writes are not supported in this version — use network mvc.', true);
      }
      try {
        const result = await control.sellIntentCancel({ metabotId: owner, itemPinId: args.item_pin_id, network: args.network });
        return textResult([
          'MRC-721 sell intent cancelled on-chain.',
          `- item pinId: ${result.intent.itemPinId}`,
          `- sell-intent pin: pin://${result.sellPinId} (modified, active=false)`,
        ].join('\n'));
      } catch (error) {
        return textResult(`mrc721_sell_intent_cancel failed: ${errorMessage(error)}${chainWriteFailureDetail(error)}`, true);
      }
    },
  );

  const mrc721SellIntents = tool(
    'mrc721_sell_intents',
    [
      'List THIS bot\'s MRC-721 sell-intent declarations (the /nft/mrc721sell/ pins recorded locally). Each row is re-checked against the live holder view: active = still held and declared; stale = the item is no longer in this bot\'s hand (transferred away — declare nothing, sell nothing); cancelled = withdrawn.',
      'Read-only, no wallet involvement. There is no indexer-side market yet (requirements R-C pending); discovery of OTHER bots\' intents runs through chat announcements.',
    ].join(' '),
    {
      collection_name: z.string().optional().describe('Filter to one collection by namespace name.'),
      collection_pinid: z.string().optional().describe('Filter to one collection by collectionid.'),
    },
    async (args: { collection_name?: string; collection_pinid?: string }) => {
      const owner = requireSessionMetabot('mrc721_sell_intents');
      if (typeof owner === 'string') return textResult(owner, true);
      try {
        const views = await control.listSellIntents({
          metabotId: owner,
          collectionName: asString(args.collection_name) || undefined,
          collectionPinId: asString(args.collection_pinid) || undefined,
        });
        if (!views.length) return textResult('No sell intents declared by this bot.');
        const lines = [`${views.length} sell intent(s):`];
        for (const view of views) {
          lines.push(`- ${view.status.toUpperCase()} ${view.itemPinId} | hint ${view.intent.priceHintSats != null ? `${view.intent.priceHintSats} sats` : 'make an offer'} | ${view.intent.acceptedCurrencies.join(',')} | pin://${view.sellPinId ?? '(unrecorded)'}`);
          if (view.reason) lines.push(`  reason: ${view.reason}`);
          if (view.intent.note) lines.push(`  note: ${view.intent.note}`);
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        return textResult(`mrc721_sell_intents failed: ${errorMessage(error)}`, true);
      }
    },
  );

  // -------------------------------------------------------------------------
  // mrc721_verify_holding (S4 read: hard holder gate for badge/access flows)
  // -------------------------------------------------------------------------
  const mrc721VerifyHolding = tool(
    'mrc721_verify_holding',
    [
      'Verify whether a holder currently holds at least one MRC-721 item (pin-based MetaID NFT) of a given collection — the hard holder gate for badge/access flows (e.g. only fans holding the badge collection may get a reply).',
      'Holders: local MetaBot ids/names, a raw address, or an external 64-hex MetaID (resolved via the user-info indexer). The verdict covers live (non-burned) items only and reads the live holder view, so a transferred-away NFT flips it to NOT_HOLDING.',
      'Read-only, no wallet involvement. Use for gating decisions; use mrc721_balance for full holdings inventories.',
    ].join(' '),
    {
      metabot_ids: z.array(z.number().int().positive()).optional().describe('Local MetaBot ids to check, e.g. [1, 15]. Batch in one call.'),
      names: z.array(z.string()).optional().describe('Local MetaBot names to check, e.g. ["AI_Sunny"].'),
      address: z.string().optional().describe('Explicit holder address (MVC livenet; BTC addresses read-only).'),
      metaid: z.string().optional().describe('64-hex MetaID to check — resolved to its holder address via the user-info indexer (external users).'),
      collection_name: z.string().optional().describe('Collection to check against, by namespace name (resolved via the indexer).'),
      collection_pinid: z.string().optional().describe('Collection to check against, as the collectionid (collection_desc pinId).'),
    },
    async (args: {
      metabot_ids?: number[];
      names?: string[];
      address?: string;
      metaid?: string;
      collection_name?: string;
      collection_pinid?: string;
    }) => {
      const collectionName = asString(args.collection_name) || undefined;
      const collectionPinId = asString(args.collection_pinid) || undefined;
      if (!collectionName && !collectionPinId) {
        return textResult('mrc721_verify_holding requires collection_name or collection_pinid.', true);
      }
      let metaidAddress: string | undefined;
      if (args.metaid) {
        metaidAddress = (await resolveMetaidTargetAddress(args.metaid)) ?? undefined;
        if (!metaidAddress) {
          return textResult(`mrc721_verify_holding: could not resolve MetaID "${asString(args.metaid)}" to a holder address.`, true);
        }
      }
      const targets = resolveReadTargets(
        { metabot_ids: args.metabot_ids, names: args.names, address: metaidAddress ?? args.address },
        control,
        sessionMetabotId(),
      );
      if (!targets.length) {
        return textResult('mrc721_verify_holding requires metabot_ids, names, address, or metaid.', true);
      }
      const lines: string[] = [`MRC-721 holding check — collection: ${collectionName ?? collectionPinId}`];
      for (const target of targets) {
        const label = target.metabotId != null ? `metabot_id ${target.metabotId}` : 'address';
        if (!target.address) {
          lines.push(`# ${label}\n- lookup failed: local MetaBot not found or has no MVC address`);
          continue;
        }
        try {
          const verdict = await verifyMrc721Holding({
            holderAddress: target.address,
            collectionName,
            collectionPinId,
          });
          lines.push(`# ${label} ${target.address}\n- verdict: ${verdict.holds ? `HOLDS (${verdict.count} item(s))` : 'NOT_HOLDING'}`);
          if (verdict.count) {
            const itemList = verdict.items
              .map((item) => `${item.itemPinId}${item.number != null ? ` (#${item.number})` : ''}`)
              .join(', ');
            lines.push(`- items: ${itemList}`);
          }
        } catch (error) {
          // Distinguishable from NOT_HOLDING on purpose: an unindexed
          // collection or an index outage must not read as "no badge".
          lines.push(`# ${label} ${target.address}\n- lookup failed: ${errorMessage(error)}`);
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  // -------------------------------------------------------------------------
  // mrc721_search_collections (S1 read: keyword/issuer collection search)
  // -------------------------------------------------------------------------
  const mrc721SearchCollections = tool(
    'mrc721_search_collections',
    [
      'Search MRC-721 collections (pin-based MetaID NFT albums) by keyword and/or by issuer — keyword matches (case-insensitive) the display name, the collection namespace, the description, and the collectionid; issuer accepts a local MetaBot name, a 64-hex MetaID, or an MVC address.',
      'Returns matching collection summaries (display name, mint progress, royalty, issuer identity, collectionid) plus each description. supply_state=true also computes per-collection minted counts (minted vs totalSupply, first 20 matches) for issuer/creator flows like "which of my albums still has slots".',
      'Read-only index data. Filtering runs client-side over the registered-collection page list (scanned count is reported); use max_pages for deeper scans.',
    ].join(' '),
    {
      keyword: z.string().optional().describe('Search text matched (case-insensitive) against name, collection namespace, description, collectionid.'),
      issuer: z.string().optional().describe('Issuer filter: local MetaBot name, 64-hex MetaID, or MVC address (collections this issuer created).'),
      supply_state: z.boolean().optional().describe('Also compute mintedCount vs totalSupply per matched collection (first 20 matches; slower). Default false.'),
      max_pages: z.number().int().min(1).max(50).optional().describe('Indexer page-list pages to scan (default 20).'),
      size: z.number().int().min(1).max(50).optional().describe('Max collections returned (default 20).'),
    },
    async (args: {
      keyword?: string;
      issuer?: string;
      supply_state?: boolean;
      max_pages?: number;
      size?: number;
    }) => {
      const keyword = asString(args.keyword);
      let issuerAddress: string | undefined;
      if (args.issuer) {
        const resolved = await resolveIssuerFilter(args.issuer, control);
        if (typeof resolved === 'object') {
          return textResult(`mrc721_search_collections: ${resolved.error}.`, true);
        }
        issuerAddress = resolved;
      }
      if (!keyword && !issuerAddress) {
        return textResult('mrc721_search_collections requires a keyword or an issuer.', true);
      }
      try {
        const result = await searchMrc721Collections({
          keyword: keyword || undefined,
          issuerAddress,
          includeSupplyState: args.supply_state === true,
          maxPages: args.max_pages,
        });
        const lines: string[] = ['MRC-721 collection search:'];
        lines.push(`- keyword: ${keyword ? `"${keyword}"` : '(none)'} | issuer: ${issuerAddress ?? '(none)'}`);
        lines.push(`- scanned ${result.scanned} registered collection(s)${result.truncated ? ' (page cap hit — raise max_pages for deeper scans)' : ''}, matched: ${result.items.length}`);
        if (!result.items.length) lines.push('- no matching collections');
        for (const collection of result.items.slice(0, args.size ?? 20)) {
          lines.push(formatMrc721CollectionLine(collection));
          if (collection.desc) lines.push(`  desc: ${collection.desc}`);
          const state = result.supplyState?.[collection.pinid ?? ''];
          if (state) {
            const supplySuffix = state.totalSupply != null && state.totalSupply >= 0 ? `/${state.totalSupply}` : '';
            const suffix = state.complete === true ? ' (supply exhausted)' : state.complete === false ? ' (slots remaining)' : '';
            lines.push(`  minted: ${state.mintedCount}${supplySuffix}${suffix}`);
          }
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        return textResult(`mrc721_search_collections failed: ${errorMessage(error)}`, true);
      }
    }
  );

  return [
    mrc721CollectionCreate,
    mrc721CollectionUpdate,
    mrc721Mint,
    mrc721Transfer,
    mrc721Sell,
    mrc721Buy,
    mrc721SellOrders,
    mrc721SellIntent,
    mrc721SellIntentCancel,
    mrc721SellIntents,
    mrc721Balance,
    mrc721Collections,
    mrc721ItemInfo,
    mrc721CollectionInfo,
    mrc721VerifyHolding,
    mrc721SearchCollections,
  ];
}
