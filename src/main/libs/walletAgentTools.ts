import { z } from 'zod';
import type {
  ExternalTransferInfo,
  WalletMvcTransferParams,
  WalletTransferResult,
} from '../services/walletTransferService';
import type {
  MetabotWalletBalanceEntry,
  WalletBalanceQueryResult,
  WalletBalanceSnapshot,
  WalletQueryChain,
} from '../services/walletQueryService';
import type { MvcNftBalance, MvcNftSellOrders, MvcNftSellOrder } from '../services/mvcNftService';

/**
 * Host control surface for the wallet tools, wired in main.ts: UTXO-sum
 * balance snapshots (R1) and two-channel MVC transfers with the audit ledger
 * (R2). `transfer` accepts a session-scoped owner-confirmation callback so
 * the channel-B gate renders the host's approval dialog.
 */
export type WalletToolsControl = {
  getBalances(input: { metabotIds?: number[]; chains?: WalletQueryChain[] }): Promise<WalletBalanceQueryResult>;
  getBalanceForAddress(chain: WalletQueryChain, address: string): Promise<WalletBalanceSnapshot>;
  resolveMetabotIdByName(name: string): number | null;
  getMetabotMvcAddress(metabotId: number): string | null;
  transfer(
    params: WalletMvcTransferParams,
    host?: { confirmExternal?: (info: ExternalTransferInfo) => Promise<boolean> },
  ): Promise<WalletTransferResult>;
  listTransfers(limit?: number, metabotId?: number): unknown[];
  listMvcNfts(input: {
    metabotIds?: number[];
    address?: string;
  }): Promise<Array<{
    metabotId: number | null;
    address: string;
    balance?: MvcNftBalance;
    error?: string;
  }>>;
  transferNft(params: {
    metabotId: number;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    toAddress: string;
  }): Promise<{ txId: string }>;
  sellNft(params: {
    metabotId: number;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    priceSats: number;
  }): Promise<{ txId: string; fundingTxId: string }>;
  cancelNftSell(params: {
    metabotId: number;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    sellUtxo?: { txId: string; outputIndex: number; sellerAddress?: string; price?: number };
  }): Promise<{ txId: string; fundingTxId: string }>;
  buyNft(params: {
    metabotId: number;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    sellUtxo?: { txId: string; outputIndex: number; sellerAddress?: string; price?: number };
  }): Promise<{ txId: string; fundingTxId: string }>;
  listMvcNftSellOrders(input: {
    metabotIds?: number[];
    address?: string;
  }): Promise<Array<{
    metabotId: number | null;
    address: string;
    orders?: MvcNftSellOrders;
    error?: string;
  }>>;
  // ----- FT TokenSell (LIST / take / cancel=self-take; mirrors the NFT block) -----
  listMvcFtTokens(input: {
    metabotIds?: number[];
    address?: string;
  }): Promise<Array<{
    metabotId: number | null;
    address: string;
    balance?: import('../services/mvcTokenSellService').MvcFtTokenBalance;
    error?: string;
  }>>;
  verifyMvcTokenSellListing(listing: import('../services/walletRawTxService').MvcTokenSellListingRef): Promise<import('../services/mvcTokenSellService').MvcTokenSellOrderVerify>;
  sellToken(params: {
    metabotId: number;
    genesis: string;
    codehash: string;
    tokenTxid?: string;
    tokenVout?: number;
    tokenAmount?: string;
    priceSats: number;
    seedSats?: number;
  }): Promise<{ txId: string; fundingTxIds: string[]; listing?: import('../services/walletRawTxService').MvcTokenSellListing }>;
  takeToken(params: {
    metabotId: number;
    listing: import('../services/walletRawTxService').MvcTokenSellListingRef;
    receiverAddress: string;
  }): Promise<{ txId: string; fundingTxIds: string[] }>;
  cancelTokenSell(params: {
    metabotId: number;
    listing: import('../services/walletRawTxService').MvcTokenSellListingRef;
  }): Promise<{ txId: string; fundingTxIds: string[] }>;
};

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const SATOSHI_PER_UNIT = 100_000_000;

function formatSnapshot(snapshot: WalletBalanceSnapshot): string {
  const total = (snapshot.total_sats / SATOSHI_PER_UNIT).toFixed(8);
  return (
    `- ${snapshot.chain}: balance ${snapshot.total_sats} sats (${total} ${snapshot.unit}), ${snapshot.utxo_count} UTXOs ` +
    `[spendable = confirmed ${snapshot.confirmed_sats} + unconfirmed ${snapshot.unconfirmed_sats}]`
  );
}

function formatBalanceEntry(entry: MetabotWalletBalanceEntry): string {
  const lines: string[] = [`# ${entry.name} (metabot_id ${entry.metabot_id})`];
  for (const chain of ['mvc', 'btc', 'doge'] as WalletQueryChain[]) {
    const snapshot = entry.balances[chain];
    if (snapshot) lines.push(formatSnapshot(snapshot));
    const error = entry.errors[chain];
    if (error) lines.push(`- ${chain}: lookup failed: ${error}`);
  }
  return lines.join('\n');
}

function looksLikeMvcAddress(value: string): boolean {
  // MVC/SPACE livenet addresses are base58 (start with 1, 20+ chars).
  return /^[1-9A-HJ-NP-Za-km-z]{20,}$/.test(value);
}

function formatTransferSuccess(result: WalletTransferResult & { success: true }): string {
  const lines: string[] = ['Transfer broadcast on-chain.'];
  lines.push(`- txid: ${result.txid}`);
  lines.push(`- fee (estimated): ${result.fee_sats} sats`);
  lines.push(`- channel: ${result.channel}${result.channel === 'local' ? ' (local roster, no confirmation required)' : ' (external, owner-confirmed)'}`);
  if (result.to_metabot_id != null) lines.push(`- to metabot_id: ${result.to_metabot_id}`);
  lines.push(`- audit record id: ${result.audit_id}`);
  return lines.join('\n');
}

function formatTransferFailure(result: WalletTransferResult & { success: false }): string {
  const lines = [`Transfer failed (${result.error_code}): ${result.error}`];
  if (result.have_sats != null) lines.push(`- have: ${result.have_sats} sats (${(result.have_sats / SATOSHI_PER_UNIT).toFixed(8)} SPACE)`);
  if (result.need_sats != null) lines.push(`- need: ${result.need_sats} sats (${(result.need_sats / SATOSHI_PER_UNIT).toFixed(8)} SPACE, amount + estimated fee)`);
  return lines.join('\n');
}

function formatMvcNftBalance(balance: MvcNftBalance): string {
  const lines: string[] = [`- ${balance.address}: ${balance.count} NFT(s)`];
  for (const collection of balance.collections) {
    const supply = collection.tokenSupply != null ? ` / supply ${collection.tokenSupply}` : '';
    lines.push(`- ${collection.seriesName || '(unnamed series)'}: ${collection.count} owned${supply} [genesis ${collection.genesis}]`);
    for (const item of collection.items) {
      lines.push(`  - #${item.tokenIndex} ${item.name || '(unnamed)'} (${item.satoshi} sats, tx ${item.txId}:${item.outputIndex})`);
    }
  }
  return lines.join('\n');
}

/**
 * wallet_balance (R1) and wallet_transfer (R2) inline MCP tools for every
 * cowork surface. Balance queries are read-only (public chain data) and
 * batch over the LOCAL metabot roster plus explicitly passed addresses.
 * Transfers always spend the session MetaBot's OWN wallet; local-roster
 * targets go straight through, external targets ask the owner unless the
 * gate is disabled in settings.
 */
export function buildWalletAgentTools(deps: {
  tool: SdkToolFactory;
  control: WalletToolsControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  /** Renders the channel-B owner approval dialog; wired by coworkRunner. */
  confirmExternalTransfer?: (info: ExternalTransferInfo) => Promise<boolean>;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const walletBalance = tool(
    'wallet_balance',
    [
      'Query wallet balances (UTXO sums) for local MetaBots by id, name, or raw address, optionally per chain.',
      'Use when the user asks for a bot wallet balance, "全班余额一览", or before planning on-chain work that costs fees. Batch multiple metabot_ids in ONE call (add names for name-based lookup).',
      'Read-only public chain data: MVC/DOGE walk the Metalet utxo-list (flag pagination), BTC uses the v3 btc-utxo endpoint. Balance is the spendable total in sats (confirmed + unconfirmed — unconfirmed funds are usable on these chains) plus the query time.',
      'Batch queries cover the LOCAL metabot roster plus explicitly passed addresses only.',
    ].join(' '),
    {
      metabot_ids: z
        .array(z.number().int().positive())
        .optional()
        .describe('Local MetaBot ids to query, e.g. [1, 15]. Batch in one call.'),
      names: z
        .array(z.string())
        .optional()
        .describe('Local MetaBot names to resolve and query, e.g. ["AI_Sunny", "Builder阿码"].'),
      address: z
        .string()
        .optional()
        .describe('Explicit address to query (chain-specific; used as-is).'),
      chain: z
        .enum(['mvc', 'btc', 'doge'])
        .optional()
        .describe('Limit to one chain; omit for all three.'),
    },
    async (args: {
      metabot_ids?: number[];
      names?: string[];
      address?: string;
      chain?: WalletQueryChain;
    }) => {
      const chains: WalletQueryChain[] | undefined = args.chain ? [args.chain] : undefined;
      const metabotIds: number[] = [];
      for (const raw of args.metabot_ids ?? []) {
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0 && !metabotIds.includes(id)) metabotIds.push(id);
      }
      for (const rawName of args.names ?? []) {
        const name = asString(rawName);
        if (!name) continue;
        const id = control.resolveMetabotIdByName(name);
        if (id == null) {
          return textResult(`wallet_balance: local MetaBot not found by name: ${name}`, true);
        }
        if (!metabotIds.includes(id)) metabotIds.push(id);
      }

      const sections: string[] = [];
      try {
        if (metabotIds.length > 0) {
          const result = await control.getBalances({ metabotIds, chains });
          sections.push(...result.entries.map(formatBalanceEntry));
        }
        const address = asString(args.address);
        if (address) {
          const list = chains ?? (['mvc', 'btc', 'doge'] as WalletQueryChain[]);
          for (const chain of list) {
            try {
              sections.push(formatSnapshot(await control.getBalanceForAddress(chain, address)));
            } catch (error) {
              sections.push(`- ${chain}: lookup failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        if (sections.length === 0) {
          return textResult(
            'wallet_balance requires metabot_ids, names, or address (pass the ids you want in ONE call).',
            true,
          );
        }
        return textResult(sections.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_balance failed: ${msg}`, true);
      }
    }
  );

  const walletTransfer = tool(
    'wallet_transfer',
    [
      'Transfer SPACE (MVC native coin) from THIS session MetaBot\'s own wallet to a target address or local MetaBot.',
      'Use when the owner asks to top up / recharge a worker bot, move funds between local bots, or send SPACE. `to` accepts a local metabot_id, a local bot name, or a raw MVC address; `amount` is in SPACE.',
      'Channel A (target resolves to the local roster): executes immediately, no confirmation. Channel B (external address): asks the owner by default (from/to/amount/estimated fee), unless disabled in settings; when the surface has no owner dialog, the owner\'s explicit in-conversation approval must be passed as `external_confirmed: true` (the same acknowledgement the RPC path accepts).',
      'Every attempt (broadcast, refused, failed) is recorded in the local transfer audit ledger. Insufficient balance fails fast with a structured have/need error. Signing stays inside the host; no key material is exposed.',
    ].join(' '),
    {
      to: z
        .string()
        .min(1)
        .describe('Target: local metabot_id (e.g. "15"), local bot name, or MVC address.'),
      amount: z
        .number()
        .positive()
        .describe('Amount in SPACE (e.g. 0.001). Dust limit applies (600 sats).'),
      memo: z.string().optional().describe('Optional note stored in the audit record.'),
      external_confirmed: z
        .boolean()
        .optional()
        .describe(
          'Set true ONLY when the owner has already approved this external transfer in the conversation. ' +
            'Equivalent to the RPC path\'s external_confirmed. Ignored whenever the host renders its own owner dialog.'
        ),
    },
    async (args: { to: string; amount: number; memo?: string; external_confirmed?: boolean }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'wallet_transfer could not determine which MetaBot owns this session; transfers must spend the session bot\'s own wallet.',
          true,
        );
      }

      const toRaw = asString(args.to);
      if (!toRaw) {
        return textResult('wallet_transfer requires `to` (metabot_id, name, or address).', true);
      }
      // Resolve `to`: metabot id or local name → local mvc address; else raw address.
      let toAddress = '';
      let toMetabotId: number | null = null;
      if (/^\d+$/.test(toRaw)) {
        const id = Number(toRaw);
        const address = control.getMetabotMvcAddress(id);
        if (address) {
          toAddress = address;
          toMetabotId = id;
        } else {
          return textResult(`wallet_transfer: local MetaBot not found: ${toRaw}`, true);
        }
      } else if (!looksLikeMvcAddress(toRaw)) {
        const id = control.resolveMetabotIdByName(toRaw);
        if (id == null) {
          return textResult(
            `wallet_transfer: "${toRaw}" is neither a local MetaBot name nor an address. For an external address pass the full MVC address.`,
            true,
          );
        }
        toMetabotId = id;
        toAddress = control.getMetabotMvcAddress(id) ?? '';
        if (!toAddress) {
          return textResult(`wallet_transfer: MetaBot ${toRaw} has no mvc address.`, true);
        }
      } else {
        toAddress = toRaw;
      }

      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return textResult('wallet_transfer requires a positive `amount` in SPACE.', true);
      }
      const amountSats = Math.round(amount * SATOSHI_PER_UNIT);
      if (!Number.isInteger(amountSats) || amountSats < 600) {
        return textResult('wallet_transfer: amount below the MVC dust limit (600 sats).', true);
      }

      try {
        const result = await control.transfer(
          {
            metabotId,
            to: toAddress,
            amountSats,
            memo: asString(args.memo) || undefined,
            sessionId,
            origin: 'tool:wallet_transfer',
            // Channel-B owner acknowledgement for surfaces that render no dialog.
            // The service consults it ONLY when no confirmExternal callback is
            // wired, so a host dialog always keeps precedence.
            externalConfirmed: args.external_confirmed === true ? true : undefined,
          },
          deps.confirmExternalTransfer ? { confirmExternal: deps.confirmExternalTransfer } : undefined,
        );
        // `=== true` (not bare truthiness): the project runs without
        // strictNullChecks, where boolean truthiness does not narrow the
        // discriminated union.
        return result.success === true
          ? textResult(formatTransferSuccess(result))
          : textResult(formatTransferFailure(result), true);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_transfer failed: ${msg}`, true);
      }
    }
  );

  const walletNftBalance = tool(
    'wallet_nft_balance',
    [
      'Query MVC NFT (MetaContract) holdings for local MetaBots by id or name, or for a raw address.',
      'Use when the user asks what NFTs a bot holds, before planning an NFT transfer, or to cross-check a transfer landed.',
      'Returns structured on-chain data per address: total count, per-series aggregation (series name / owned / supply / genesis) and item details (tokenIndex, name, satoshi, outpoint) via the wallet-api count/summary-list/utxo-list endpoints.',
      'Read-only public chain data. Batch multiple metabot_ids in ONE call.',
    ].join(' '),
    {
      metabot_ids: z
        .array(z.number().int().positive())
        .optional()
        .describe('Local MetaBot ids to query, e.g. [1, 15]. Batch in one call.'),
      names: z
        .array(z.string())
        .optional()
        .describe('Local MetaBot names to resolve and query, e.g. ["AI_Sunny", "Builder阿码"].'),
      address: z
        .string()
        .optional()
        .describe('Explicit MVC address to query (used as-is).'),
    },
    async (args: {
      metabot_ids?: number[];
      names?: string[];
      address?: string;
    }) => {
      const metabotIds: number[] = [];
      for (const raw of args.metabot_ids ?? []) {
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0 && !metabotIds.includes(id)) metabotIds.push(id);
      }
      for (const rawName of args.names ?? []) {
        const name = asString(rawName);
        if (!name) continue;
        const id = control.resolveMetabotIdByName(name);
        if (id == null) {
          return textResult(`wallet_nft_balance: local MetaBot not found by name: ${name}`, true);
        }
        if (!metabotIds.includes(id)) metabotIds.push(id);
      }
      const address = asString(args.address);
      if (metabotIds.length === 0 && !address) {
        return textResult(
          'wallet_nft_balance requires metabot_ids, names, or address (pass the ids you want in ONE call).',
          true,
        );
      }

      const sections: string[] = [];
      const results = await control.listMvcNfts({ metabotIds, address });
      for (const result of results) {
        const label = result.metabotId != null ? `metabot_id ${result.metabotId}` : 'address';
        if (result.error) {
          sections.push(`# ${label} ${result.address}\n- lookup failed: ${result.error}`);
          continue;
        }
        sections.push(`# ${label}\n${formatMvcNftBalance(result.balance!)}`);
      }
      if (sections.length === 0) {
        return textResult('wallet_nft_balance: nothing to query.', true);
      }
      return textResult(sections.join('\n'));
    }
  );

  const walletNftTransfer = tool(
    'wallet_nft_transfer',
    [
      'Transfer ONE MVC NFT (MetaContract token identified by genesis + codehash + tokenIndex) from THIS session MetaBot\'s own wallet to a target address or local MetaBot.',
      'Use when the owner asks to send/give an NFT to another bot or address. `to` accepts a local metabot_id, a local bot name, or a raw MVC address; the token is identified by its series genesis, codehash and tokenIndex (see wallet_nft_balance).',
      'Signing runs in a subprocess worker; the raw tx broadcasts via wallet-api. Returns the txid; verify ownership change with wallet_nft_balance afterwards.',
      'NFT transfers are irreversible on-chain — confirm the token index and receiver with the owner before calling when ambiguous.',
    ].join(' '),
    {
      to: z
        .string()
        .min(1)
        .describe('Target: local metabot_id (e.g. "15"), local bot name, or MVC address.'),
      genesis: z.string().min(1).describe('NFT series genesis id (64 hex).'),
      codehash: z.string().min(1).describe('NFT series codehash (40 hex).'),
      token_index: z
        .string()
        .regex(/^\d+$/)
        .describe('Token index of the single NFT to transfer, e.g. "2671".'),
    },
    async (args: {
      to: string;
      genesis: string;
      codehash: string;
      token_index: string;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'wallet_nft_transfer could not determine which MetaBot owns this session; transfers must spend the session bot\'s own wallet.',
          true,
        );
      }

      const toRaw = asString(args.to);
      if (!toRaw) {
        return textResult('wallet_nft_transfer requires `to` (metabot_id, name, or address).', true);
      }
      let toAddress = '';
      let toMetabotId: number | null = null;
      if (/^\d+$/.test(toRaw)) {
        const id = Number(toRaw);
        const address = control.getMetabotMvcAddress(id);
        if (address) {
          toAddress = address;
          toMetabotId = id;
        } else {
          return textResult(`wallet_nft_transfer: local MetaBot not found: ${toRaw}`, true);
        }
      } else if (!looksLikeMvcAddress(toRaw)) {
        const id = control.resolveMetabotIdByName(toRaw);
        if (id == null) {
          return textResult(
            `wallet_nft_transfer: "${toRaw}" is neither a local MetaBot name nor an address. For an external address pass the full MVC address.`,
            true,
          );
        }
        toMetabotId = id;
        toAddress = control.getMetabotMvcAddress(id) ?? '';
        if (!toAddress) {
          return textResult(`wallet_nft_transfer: MetaBot ${toRaw} has no mvc address.`, true);
        }
      } else {
        toAddress = toRaw;
      }

      const genesis = asString(args.genesis);
      const codehash = asString(args.codehash);
      const tokenIndex = asString(args.token_index);
      if (!genesis || !codehash || !/^\d+$/.test(tokenIndex)) {
        return textResult(
          'wallet_nft_transfer requires genesis, codehash, and token_index (digits). Use wallet_nft_balance to look them up.',
          true,
        );
      }

      try {
        const result = await control.transferNft({
          metabotId,
          genesis,
          codehash,
          tokenIndex,
          toAddress,
        });
        const lines = [
          'NFT transfer broadcast on-chain.',
          `- txid: ${result.txId}`,
          `- token: #${tokenIndex} (genesis ${genesis})`,
          `- to: ${toAddress}${toMetabotId != null ? ` (metabot_id ${toMetabotId})` : ''}`,
          '- Verify with wallet_nft_balance after the tx confirms.',
        ];
        return textResult(lines.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_nft_transfer failed: ${msg}`, true);
      }
    }
  );

  const formatSellOrder = (order: MvcNftSellOrder): string => {
    const parts = [
      `#${order.tokenIndex ?? '?'} ${order.name || order.seriesName || ''}`.trim(),
      order.genesis ? `(genesis ${order.genesis})` : '',
      `sellUtxo ${order.txId}:${order.outputIndex}`,
      order.priceSats != null ? `price ${order.priceSats} sats` : 'price: embedded in the sell contract (resolved on-chain at buy/cancel)',
    ].filter(Boolean);
    if (order.address) parts.push(`seller ${order.address}`);
    return `  - ${parts.join(' | ')}`;
  };

  const walletNftSellOrders = tool(
    'wallet_nft_sell_orders',
    [
      'Query on-chain MVC NFT sell orders (MetaContract sell contract UTXOs) for local MetaBots by id or name, or for a raw address.',
      'Use to discover listings before a buy (wallet_nft_buy) or to verify a wallet_nft_sell landed / a wallet_nft_cancel_sell removed the order.',
      'Returns per address: order count and each order with token index, genesis, sellUtxo (txid:outputIndex), ask price in sats and seller address.',
      'Read-only public chain data via the wallet-api sell utxo-list endpoint. Batch multiple metabot_ids in ONE call.',
    ].join(' '),
    {
      metabot_ids: z
        .array(z.number().int().positive())
        .optional()
        .describe('Local MetaBot ids to query, e.g. [1, 15]. Batch in one call.'),
      names: z
        .array(z.string())
        .optional()
        .describe('Local MetaBot names to resolve and query.'),
      address: z
        .string()
        .optional()
        .describe('Explicit MVC address to query (used as-is).'),
    },
    async (args: {
      metabot_ids?: number[];
      names?: string[];
      address?: string;
    }) => {
      const metabotIds: number[] = [];
      for (const raw of args.metabot_ids ?? []) {
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0 && !metabotIds.includes(id)) metabotIds.push(id);
      }
      for (const rawName of args.names ?? []) {
        const id = control.resolveMetabotIdByName(String(rawName || '').trim());
        if (id != null && !metabotIds.includes(id)) metabotIds.push(id);
      }
      const address = asString(args.address);
      if (!metabotIds.length && !address) {
        return textResult('wallet_nft_sell_orders requires metabot_ids, names, or address.', true);
      }
      try {
        const entries = await control.listMvcNftSellOrders({ metabotIds, address: address || undefined });
        const lines: string[] = [];
        for (const entry of entries) {
          if (entry.error) {
            lines.push(`- ${entry.metabotId != null ? `metabot_id ${entry.metabotId}` : entry.address}: lookup failed: ${entry.error}`);
            continue;
          }
          const orders = entry.orders;
          if (!orders || orders.count === 0) {
            lines.push(`- ${entry.address}: 0 open sell order(s)`);
            continue;
          }
          lines.push(`- ${entry.address}: ${orders.count} open sell order(s)`);
          for (const order of orders.orders) lines.push(formatSellOrder(order));
        }
        return textResult(lines.join('\n') || 'No addresses resolved.');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_nft_sell_orders failed: ${msg}`, true);
      }
    }
  );

  const walletNftSell = tool(
    'wallet_nft_sell',
    [
      'List ONE MVC NFT (MetaContract token) owned by THIS session MetaBot for sale on-chain.',
      'The token is identified by genesis + codehash + token_index (see wallet_nft_balance); price_sats is the ask price in satoshis (minimum 22000, e.g. 0.001 SPACE = 100000).',
      'Signing runs in a subprocess worker; two chained txs broadcast (contract funding, then the listing). Returns both txids.',
      'Verify the open order with wallet_nft_sell_orders afterwards; take it down with wallet_nft_cancel_sell. Listing is irreversible until cancelled — confirm the price with the owner when ambiguous.',
    ].join(' '),
    {
      genesis: z.string().min(1).describe('NFT series genesis id (64 hex).'),
      codehash: z.string().min(1).describe('NFT series codehash (40 hex).'),
      token_index: z.string().regex(/^\d+$/).describe('Token index of the NFT to list, e.g. "5421".'),
      price_sats: z.number().int().positive().describe('Ask price in satoshis, minimum 22000 (0.001 SPACE = 100000).'),
    },
    async (args: {
      genesis: string;
      codehash: string;
      token_index: string;
      price_sats: number;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult('wallet_nft_sell could not determine which MetaBot owns this session; sells must spend the session bot\'s own wallet.', true);
      }
      const genesis = asString(args.genesis);
      const codehash = asString(args.codehash);
      const tokenIndex = asString(args.token_index);
      const priceSats = Number(args.price_sats);
      if (!genesis || !codehash || !/^\d+$/.test(tokenIndex) || !Number.isInteger(priceSats) || priceSats <= 0) {
        return textResult('wallet_nft_sell requires genesis, codehash, token_index (digits) and an integer price_sats > 0.', true);
      }
      if (priceSats < 22000) {
        return textResult('wallet_nft_sell: price_sats must be at least 22000 (the NftManager sell floor; 0.001 SPACE = 100000).', true);
      }
      try {
        const result = await control.sellNft({ metabotId, genesis, codehash, tokenIndex, priceSats });
        const lines = [
          'NFT listed for sale on-chain.',
          `- listing txid: ${result.txId}`,
          `- funding txid: ${result.fundingTxId}`,
          `- token: #${tokenIndex} (genesis ${genesis})`,
          `- ask price: ${priceSats} sats (${(priceSats / 100000000).toFixed(8)} SPACE)`,
          '- Verify with wallet_nft_sell_orders; cancel with wallet_nft_cancel_sell.',
        ];
        return textResult(lines.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_nft_sell failed: ${msg}`, true);
      }
    }
  );

  const buildSellUtxoArg = (args: {
    sell_txid?: string;
    sell_output_index?: number;
    seller_address?: string;
    sell_price_sats?: number;
  }): { txId: string; outputIndex: number; sellerAddress?: string; price?: number } | null => {
    const txId = asString(args.sell_txid);
    const outputIndex = Number(args.sell_output_index);
    if (!/^[0-9a-fA-F]{64}$/.test(txId) || !Number.isInteger(outputIndex) || outputIndex < 0) return null;
    const sellerAddress = asString(args.seller_address);
    const price = Number(args.sell_price_sats);
    return {
      txId,
      outputIndex,
      ...(sellerAddress ? { sellerAddress } : {}),
      ...(Number.isFinite(price) && price > 0 ? { price } : {}),
    };
  };

  const walletNftCancelSell = tool(
    'wallet_nft_cancel_sell',
    [
      'Take down ONE of THIS session MetaBot\'s on-chain MVC NFT sell orders (cancels the listing, the NFT returns to the bot\'s wallet).',
      'The order is identified by genesis + codehash + token_index; optionally pass the sell order outpoint from wallet_nft_sell_orders (sell_txid + sell_output_index + seller_address + sell_price_sats) instead of letting the signer resolve it on-chain.',
      'Signing runs in a subprocess worker; two chained txs broadcast (unlock check, then the cancel). Returns both txids.',
      'Verify the order disappeared with wallet_nft_sell_orders afterwards.',
    ].join(' '),
    {
      genesis: z.string().min(1).describe('NFT series genesis id (64 hex).'),
      codehash: z.string().min(1).describe('NFT series codehash (40 hex).'),
      token_index: z.string().regex(/^\d+$/).describe('Token index of the listed NFT.'),
      sell_txid: z.string().optional().describe('Sell order txid from wallet_nft_sell_orders (optional; with sell_output_index).'),
      sell_output_index: z.number().int().nonnegative().optional().describe('Sell order output index from wallet_nft_sell_orders.'),
      seller_address: z.string().optional().describe('Seller address of the order (optional, from wallet_nft_sell_orders).'),
      sell_price_sats: z.number().int().positive().optional().describe('Ask price in sats of the order (optional, from wallet_nft_sell_orders).'),
    },
    async (args: {
      genesis: string;
      codehash: string;
      token_index: string;
      sell_txid?: string;
      sell_output_index?: number;
      seller_address?: string;
      sell_price_sats?: number;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult('wallet_nft_cancel_sell could not determine which MetaBot owns this session; cancels must spend the session bot\'s own wallet.', true);
      }
      const genesis = asString(args.genesis);
      const codehash = asString(args.codehash);
      const tokenIndex = asString(args.token_index);
      if (!genesis || !codehash || !/^\d+$/.test(tokenIndex)) {
        return textResult('wallet_nft_cancel_sell requires genesis, codehash, and token_index (digits).', true);
      }
      let sellUtxo: { txId: string; outputIndex: number; sellerAddress?: string; price?: number } | undefined;
      if (args.sell_txid != null || args.sell_output_index != null) {
        sellUtxo = buildSellUtxoArg(args);
        if (!sellUtxo) {
          return textResult('wallet_nft_cancel_sell: sell_txid must be 64 hex and sell_output_index a non-negative integer.', true);
        }
      }
      try {
        const result = await control.cancelNftSell({ metabotId, genesis, codehash, tokenIndex, sellUtxo });
        const lines = [
          'NFT sell order cancelled on-chain.',
          `- cancel txid: ${result.txId}`,
          `- check txid: ${result.fundingTxId}`,
          `- token: #${tokenIndex} (genesis ${genesis})`,
          '- Verify the order is gone with wallet_nft_sell_orders.',
        ];
        return textResult(lines.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_nft_cancel_sell failed: ${msg}`, true);
      }
    }
  );

  const walletNftBuy = tool(
    'wallet_nft_buy',
    [
      'Buy ONE listed MVC NFT (take an on-chain sell order) with THIS session MetaBot\'s own wallet: pays the ask price + fees, receives the token.',
      'Look up the open order first with wallet_nft_sell_orders; pass its sell order outpoint (sell_txid + sell_output_index, plus seller_address + sell_price_sats when known) or let the signer resolve the current order on-chain from genesis + codehash + token_index.',
      'Signing runs in a subprocess worker; two chained txs broadcast (unlock check, then the purchase). Returns both txids.',
      'The ask price + fees leave the bot\'s wallet irreversibly — confirm the order (price_sats shown by wallet_nft_sell_orders) with the owner before calling when ambiguous.',
    ].join(' '),
    {
      genesis: z.string().min(1).describe('NFT series genesis id (64 hex).'),
      codehash: z.string().min(1).describe('NFT series codehash (40 hex).'),
      token_index: z.string().regex(/^\d+$/).describe('Token index of the listed NFT to buy.'),
      sell_txid: z.string().optional().describe('Sell order txid from wallet_nft_sell_orders (optional; with sell_output_index).'),
      sell_output_index: z.number().int().nonnegative().optional().describe('Sell order output index from wallet_nft_sell_orders.'),
      seller_address: z.string().optional().describe('Seller address of the order (optional, from wallet_nft_sell_orders).'),
      sell_price_sats: z.number().int().positive().optional().describe('Ask price in sats of the order (optional, from wallet_nft_sell_orders).'),
    },
    async (args: {
      genesis: string;
      codehash: string;
      token_index: string;
      sell_txid?: string;
      sell_output_index?: number;
      seller_address?: string;
      sell_price_sats?: number;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult('wallet_nft_buy could not determine which MetaBot owns this session; buys must spend the session bot\'s own wallet.', true);
      }
      const genesis = asString(args.genesis);
      const codehash = asString(args.codehash);
      const tokenIndex = asString(args.token_index);
      if (!genesis || !codehash || !/^\d+$/.test(tokenIndex)) {
        return textResult('wallet_nft_buy requires genesis, codehash, and token_index (digits). Use wallet_nft_sell_orders to find listed tokens.', true);
      }
      let sellUtxo: { txId: string; outputIndex: number; sellerAddress?: string; price?: number } | undefined;
      if (args.sell_txid != null || args.sell_output_index != null) {
        sellUtxo = buildSellUtxoArg(args);
        if (!sellUtxo) {
          return textResult('wallet_nft_buy: sell_txid must be 64 hex and sell_output_index a non-negative integer.', true);
        }
      }
      try {
        const result = await control.buyNft({ metabotId, genesis, codehash, tokenIndex, sellUtxo });
        const lines = [
          'NFT purchase broadcast on-chain.',
          `- purchase txid: ${result.txId}`,
          `- check txid: ${result.fundingTxId}`,
          `- token: #${tokenIndex} (genesis ${genesis})`,
          '- Verify ownership with wallet_nft_balance and the order closure with wallet_nft_sell_orders after the txs confirm.',
        ];
        return textResult(lines.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_nft_buy failed: ${msg}`, true);
      }
    }
  );

  // -------------------------------------------------------------------------
  // FT TokenSell tools (mirror of the wallet_nft_* block; the TokenSell
  // contract lineage is live-fire validated — see docs/token-sell-protocol.md).
  // -------------------------------------------------------------------------

  const formatFtBalance = (balance: import('../services/mvcTokenSellService').MvcFtTokenBalance): string => {
    if (!balance.tokens.length) return '- no FT holdings';
    return balance.tokens
      .map(
        (t) =>
          `- ${t.symbol || '?'} balance ${t.balance}${t.decimal !== undefined ? ` (decimal ${t.decimal})` : ''} ` +
          `[genesis ${t.genesis}${t.codeHash ? ` codehash ${t.codeHash}` : ''}]`,
      )
      .join('\n');
  };

  const walletTokenBalance = tool(
    'wallet_token_balance',
    [
      'Query MVC FT (fungible token / MetaContract FT) holdings for local MetaBots by id or name, or for a raw address.',
      'Use when the user asks what tokens a bot holds, or before listing a token for sale (wallet_token_sell).',
      'Returns per address: token count and each token with symbol, base-unit balance (string), decimal, genesis and codehash — the identifiers wallet_token_sell needs.',
      'Read-only public chain data via the open-api-mvc contract/ft endpoints. Batch multiple metabot_ids in ONE call.',
    ].join(' '),
    {
      metabot_ids: z
        .array(z.number().int().positive())
        .optional()
        .describe('Local MetaBot ids to query, e.g. [1, 15]. Batch in one call.'),
      names: z
        .array(z.string())
        .optional()
        .describe('Local MetaBot names to resolve and query.'),
      address: z
        .string()
        .optional()
        .describe('Explicit MVC address to query (used as-is).'),
    },
    async (args: {
      metabot_ids?: number[];
      names?: string[];
      address?: string;
    }) => {
      const metabotIds: number[] = [];
      for (const raw of args.metabot_ids ?? []) {
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0 && !metabotIds.includes(id)) metabotIds.push(id);
      }
      for (const rawName of args.names ?? []) {
        const name = asString(rawName);
        if (!name) continue;
        const id = control.resolveMetabotIdByName(name);
        if (id == null) {
          return textResult(`wallet_token_balance: local MetaBot not found by name: ${name}`, true);
        }
        if (!metabotIds.includes(id)) metabotIds.push(id);
      }
      const address = asString(args.address);
      if (metabotIds.length === 0 && !address) {
        return textResult('wallet_token_balance requires metabot_ids, names, or address (pass the ids you want in ONE call).', true);
      }
      try {
        const entries = await control.listMvcFtTokens({ metabotIds, address: address || undefined });
        const sections: string[] = [];
        for (const entry of entries) {
          const label = entry.metabotId != null ? `metabot_id ${entry.metabotId}` : 'address';
          if (entry.error) {
            sections.push(`# ${label} ${entry.address}\n- lookup failed: ${entry.error}`);
            continue;
          }
          sections.push(`# ${label} ${entry.address}\n${formatFtBalance(entry.balance!)}`);
        }
        return textResult(sections.join('\n') || 'No addresses resolved.');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_token_balance failed: ${msg}`, true);
      }
    }
  );

  const buildTokenListingArg = (args: {
    sell_txid?: string;
    sell_output_index?: number;
    sell_price_sats?: number;
    seller_address?: string;
    seed_txid?: string;
    seed_vout?: number;
    token_txid?: string;
    token_vout?: number;
  }): import('../services/walletRawTxService').MvcTokenSellListingRef | null => {
    const sellTxid = asString(args.sell_txid).toLowerCase();
    const outputIndex = Number(args.sell_output_index);
    const price = Number(args.sell_price_sats);
    const sellerAddress = asString(args.seller_address);
    if (!/^[0-9a-f]{64}$/.test(sellTxid) || !Number.isInteger(outputIndex) || outputIndex < 0) return null;
    if (!Number.isSafeInteger(price) || price <= 0 || !sellerAddress) return null;
    const seedTxid = asString(args.seed_txid).toLowerCase();
    const seedVout = Number(args.seed_vout);
    const tokenTxid = asString(args.token_txid).toLowerCase();
    const tokenVout = Number(args.token_vout);
    return {
      sell_txid: sellTxid,
      sell_output_index: outputIndex,
      sell_price_sats: price,
      seller_address: sellerAddress,
      ...(seedTxid && /^[0-9a-f]{64}$/.test(seedTxid) ? { seed_txid: seedTxid } : {}),
      ...(Number.isInteger(seedVout) && seedVout >= 0 ? { seed_vout: seedVout } : {}),
      ...(tokenTxid && /^[0-9a-f]{64}$/.test(tokenTxid) ? { token_txid: tokenTxid } : {}),
      ...(Number.isInteger(tokenVout) && tokenVout >= 0 ? { token_vout: tokenVout } : {}),
    };
  };

  const walletTokenSellOrders = tool(
    'wallet_token_sell_orders',
    [
      'Verify an MVC FT TokenSell listing against its listing tuple — this is tuple VERIFICATION, not order discovery: TokenSell has NO chain-wide order index, the listing {sell_txid, sell_output_index, sell_price_sats, seller_address} travels off-chain between counterparties.',
      'Given a tuple, this fetches the LIST tx, recomputes its v10 consensus txid, decodes the TokenSell seed lock back into (seller, price) and cross-checks the claims — a counterparty cannot misquote a listing.',
      'Use before wallet_token_buy to validate what you are about to buy; use the wallet_token_sell output to obtain your own listing tuple.',
      'Read-only public chain data. No arguments = explanation of the discovery model.',
    ].join(' '),
    {
      sell_txid: z.string().optional().describe('LIST txid (64 hex) from the listing tuple.'),
      sell_output_index: z.number().int().nonnegative().optional().describe('Token output index in the LIST tx (from the listing tuple).'),
      sell_price_sats: z.number().int().positive().optional().describe('Claimed ask price in sats — cross-checked against the on-chain seed lock.'),
      seller_address: z.string().optional().describe('Claimed seller address — cross-checked against the seed lock.'),
      seed_txid: z.string().optional().describe('Seed utxo txid when seed lives in a different tx than the LIST (optional).'),
      seed_vout: z.number().int().nonnegative().optional().describe('Seed output index (optional, default 0).'),
    },
    async (args: {
      sell_txid?: string;
      sell_output_index?: number;
      sell_price_sats?: number;
      seller_address?: string;
      seed_txid?: string;
      seed_vout?: number;
    }) => {
      if (args.sell_txid == null || args.sell_output_index == null) {
        return textResult(
          [
            'TokenSell listings are discovered off-chain: the seller shares the listing tuple after wallet_token_sell.',
            'Pass sell_txid + sell_output_index + sell_price_sats + seller_address (and optional seed_txid/seed_vout) to verify one against the chain.',
          ].join('\n'),
        );
      }
      const listing = buildTokenListingArg(args);
      if (!listing) {
        return textResult(
          'wallet_token_sell_orders: sell_txid must be 64 hex, sell_output_index a non-negative integer, sell_price_sats a positive integer, seller_address required.',
          true,
        );
      }
      try {
        const verified = await control.verifyMvcTokenSellListing(listing);
        const lines = [
          verified.verified ? 'Listing VERIFIED against the chain.' : 'Listing FAILED verification:',
          `- LIST txid: ${verified.txid} (v10 consensus recomputation)`,
          `- on-chain price: ${verified.decoded.priceSats} sats (${(Number(verified.decoded.priceSats) / SATOSHI_PER_UNIT).toFixed(8)} SPACE)`,
          `- seller hash160 (from seed lock): ${verified.decoded.sellerHash160Hex}`,
          `- seller address (base58): ${verified.decoded.sellerAddressBase58 ?? "(decode unavailable)"}`,
          `- token amount listed: ${verified.tokenAmount || 'unknown'}`,
          `- sale output: ${verified.sellSats} sats at out${listing.sell_output_index}`,
        ];
        for (const problem of verified.problems) lines.push(`- problem: ${problem}`);
        return textResult(lines.join('\n'), verified.verified ? false : true);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_token_sell_orders failed: ${msg}`, true);
      }
    }
  );

  const walletTokenSell = tool(
    'wallet_token_sell',
    [
      'List ONE FT token utxo (MetaContract FT, full-utxo listing) owned by THIS session MetaBot for sale on-chain via the TokenSell contract.',
      'Identify the token with genesis + codehash (see wallet_token_balance); when the address holds several utxos of that genesis also pass token_txid/token_vout. price_sats is the ask price in satoshis (1 SPACE = 1e8 sats; pass price_space to convert). Minimum 22000 sats — mirrors the wallet_nft_sell floor.',
      'Partial-quantity listings are REJECTED at construction (they break the checker conservation) — the whole token utxo is listed; split the token first if you need less.',
      'Signing runs in a subprocess worker; ordered txs broadcast (checker mint → seed → listing). Returns the listing tuple to share with takers. Confirm the price with the owner when ambiguous.',
    ].join(' '),
    {
      genesis: z.string().min(1).describe('FT genesis id (64 hex).'),
      codehash: z.string().min(1).describe('FT codehash (40 hex).'),
      token_txid: z.string().optional().describe('Token utxo txid (64 hex) — required when the address holds several utxos of this genesis.'),
      token_vout: z.number().int().nonnegative().optional().describe('Token utxo output index.'),
      token_amount: z.string().optional().describe('Explicit amount — MUST equal the utxo\'s full amount (full-utxo listings only).'),
      price_sats: z.number().int().positive().optional().describe('Ask price in satoshis (1 SPACE = 1e8 sats).'),
      price_space: z.number().positive().optional().describe('Ask price in SPACE (converted to sats; sats wins if both given).'),
      seed_sats: z.number().int().min(600).optional().describe('Seed utxo denomination (default 2032, the live-fire value).'),
    },
    async (args: {
      genesis: string;
      codehash: string;
      token_txid?: string;
      token_vout?: number;
      token_amount?: string;
      price_sats?: number;
      price_space?: number;
      seed_sats?: number;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult('wallet_token_sell could not determine which MetaBot owns this session; sells must spend the session bot\'s own wallet.', true);
      }
      const genesis = asString(args.genesis);
      const codehash = asString(args.codehash);
      if (!/^[0-9a-fA-F]{64}$/.test(genesis) || !/^[0-9a-fA-F]{40}$/.test(codehash)) {
        return textResult('wallet_token_sell requires genesis (64 hex) and codehash (40 hex). Use wallet_token_balance to look them up.', true);
      }
      let priceSats = Number(args.price_sats);
      if (!Number.isSafeInteger(priceSats) || priceSats <= 0) {
        const space = Number(args.price_space);
        if (!(space > 0)) {
          return textResult('wallet_token_sell requires price_sats (integer sats) or price_space (> 0). 1 SPACE = 1e8 sats.', true);
        }
        priceSats = Math.round(space * SATOSHI_PER_UNIT);
      }
      if (priceSats < 22000) {
        return textResult('wallet_token_sell: price below the 22000 sats floor (mirrors wallet_nft_sell; avoids dust-level asks).', true);
      }
      const tokenTxid = asString(args.token_txid).toLowerCase();
      if (tokenTxid && !/^[0-9a-f]{64}$/.test(tokenTxid)) {
        return textResult('wallet_token_sell: token_txid must be 64 hex.', true);
      }
      try {
        const result = await control.sellToken({
          metabotId,
          genesis: genesis.toLowerCase(),
          codehash: codehash.toLowerCase(),
          tokenTxid: tokenTxid || undefined,
          tokenVout: args.token_vout,
          tokenAmount: asString(args.token_amount) || undefined,
          priceSats,
          seedSats: args.seed_sats,
        });
        const l = result.listing;
        const lines = [
          'TokenSell LISTING broadcast on-chain.',
          `- listing txid: ${result.txId}`,
          `- funding txids: ${result.fundingTxIds.join(', ')}`,
          `- price: ${priceSats} sats (${(priceSats / SATOSHI_PER_UNIT).toFixed(8)} SPACE)`,
          l ? `- listing tuple for takers: sell_txid=${l.sell_txid} sell_output_index=${l.sell_output_index} sell_price_sats=${l.sell_price_sats} seller_address=${l.seller_address}` : '',
          '- Verify with wallet_token_sell_orders (pass the tuple); take it down with wallet_token_cancel_sell (self-take).',
        ].filter(Boolean);
        return textResult(lines.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_token_sell failed: ${msg}`, true);
      }
    }
  );

  const tokenBuyDescription = [
      'wallet_token_buy — take (buy) an MVC FT TokenSell listing (op=2 UNLOCK_FROM_CONTRACT) with THIS session MetaBot\'s own wallet: pays the ask price to the seller and receives the tokens at the receiver address. Verb-aligned with wallet_nft_buy; TokenSell papers call this operation "take" — same thing.',
      'Pass the listing tuple (sell_txid + sell_output_index + sell_price_sats + seller_address; the price/seller are cross-checked against the on-chain seed lock before signing). Verify the listing first with wallet_token_sell_orders.',
      'Signing runs in a subprocess worker; ordered txs broadcast (checker mint → taker tx). Returns the txids.',
      'The ask price + fees leave the bot\'s wallet irreversibly — confirm the listing with the owner before calling when ambiguous.',
      'wallet_token_take remains registered as a deprecated alias with identical arguments and behavior (the TokenSell papers call this verb \'take\').',
    ].join(' ');
  const tokenBuySchema = {
      sell_txid: z.string().min(1).describe('LIST txid (64 hex) from the listing tuple.'),
      sell_output_index: z.number().int().nonnegative().describe('Token output index in the LIST tx.'),
      sell_price_sats: z.number().int().positive().describe('Ask price in sats from the listing tuple (cross-checked on-chain).'),
      seller_address: z.string().min(1).describe('Seller address from the listing tuple (cross-checked on-chain).'),
      seed_txid: z.string().optional().describe('Seed utxo txid when the seed lives in a different tx than the LIST (optional).'),
      seed_vout: z.number().int().nonnegative().optional().describe('Seed output index (optional, default 0).'),
      receiver_address: z.string().optional().describe('Address receiving the tokens — defaults to this session bot\'s own address.'),
    };
  const tokenBuyHandler = async (args: {
      sell_txid: string;
      sell_output_index: number;
      sell_price_sats: number;
      seller_address: string;
      seed_txid?: string;
      seed_vout?: number;
      receiver_address?: string;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult('wallet_token_buy could not determine which MetaBot owns this session; takes must spend the session bot\'s own wallet.', true);
      }
      const listing = buildTokenListingArg(args);
      if (!listing) {
        return textResult('wallet_token_buy: sell_txid must be 64 hex, sell_output_index a non-negative integer, sell_price_sats a positive integer, seller_address required.', true);
      }
      const receiverAddress = asString(args.receiver_address);
      if (receiverAddress && !looksLikeMvcAddress(receiverAddress)) {
        return textResult('wallet_token_buy: receiver_address must be a raw MVC address (tokens only transfer to addresses, not local bots).', true);
      }
      try {
        const result = await control.takeToken({
          metabotId,
          listing,
          receiverAddress: receiverAddress || (control.getMetabotMvcAddress(metabotId) ?? ''),
        });
        const lines = [
          'TokenSell TAKE broadcast on-chain.',
          `- take txid: ${result.txId}`,
          `- funding txids: ${result.fundingTxIds.join(', ')}`,
          '- Verify the tokens arrived with wallet_token_balance after the txs confirm.',
        ];
        return textResult(lines.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_token_buy failed: ${msg}`, true);
      }
    };
  const walletTokenBuy = tool('wallet_token_buy', tokenBuyDescription, tokenBuySchema, tokenBuyHandler);
  // Alias kept for compatibility with the merged surface: same schema object, same handler.
  const walletTokenTakeAlias = tool(
    'wallet_token_take',
    'Alias of wallet_token_buy (verb alignment with the NFT line) — identical arguments and behavior; see wallet_token_buy.',
    tokenBuySchema,
    tokenBuyHandler
  );

  const walletTokenCancelSell = tool(
    'wallet_token_cancel_sell',
    [
      'Take down YOUR OWN MVC FT TokenSell listing by self-taking it: the session bot (as seller) takes its own order — the price circles back to the same wallet, the tokens return, only fees are spent.',
      'Pass the listing tuple exactly as wallet_token_sell reported it (sell_txid + sell_output_index + sell_price_sats + seller_address). The seed lock is decoded on-chain; cancel requires the session wallet to be the seller.',
      'Signing runs in a subprocess worker; ordered txs broadcast (checker mint → self-take tx). Returns the txids.',
      'Costs the take-leg network fees — confirm with the owner when the listing is high-value.',
    ].join(' '),
    {
      sell_txid: z.string().min(1).describe('LIST txid (64 hex) from your wallet_token_sell output.'),
      sell_output_index: z.number().int().nonnegative().describe('Token output index in the LIST tx.'),
      sell_price_sats: z.number().int().positive().describe('Ask price in sats (cross-checked against the seed lock).'),
      seller_address: z.string().min(1).describe('Seller address (= this bot\'s address).'),
      seed_txid: z.string().optional().describe('Seed utxo txid when the seed lives in a different tx than the LIST (optional).'),
      seed_vout: z.number().int().nonnegative().optional().describe('Seed output index (optional, default 0).'),
    },
    async (args: {
      sell_txid: string;
      sell_output_index: number;
      sell_price_sats: number;
      seller_address: string;
      seed_txid?: string;
      seed_vout?: number;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult('wallet_token_cancel_sell could not determine which MetaBot owns this session; cancels must spend the session bot\'s own wallet.', true);
      }
      const listing = buildTokenListingArg(args);
      if (!listing) {
        return textResult('wallet_token_cancel_sell: sell_txid must be 64 hex, sell_output_index a non-negative integer, sell_price_sats a positive integer, seller_address required.', true);
      }
      try {
        const result = await control.cancelTokenSell({ metabotId, listing });
        const lines = [
          'TokenSell listing cancelled on-chain (self-take).',
          `- self-take txid: ${result.txId}`,
          `- funding txids: ${result.fundingTxIds.join(', ')}`,
          '- Verify the tokens are back with wallet_token_balance; the listing no longer accepts takers.',
        ];
        return textResult(lines.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_token_cancel_sell failed: ${msg}`, true);
      }
    }
  );

  return [
    walletBalance,
    walletTransfer,
    walletNftBalance,
    walletNftTransfer,
    walletNftSellOrders,
    walletNftSell,
    walletNftCancelSell,
    walletNftBuy,
    walletTokenBalance,
    walletTokenSellOrders,
    walletTokenSell,
    walletTokenBuy,
    walletTokenTakeAlias,
    walletTokenCancelSell,
  ];
}
