import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  listVerifiedOfficialSwapStations,
  verifyOfficialSwapStation,
} from '../services/officialBotVerifyService';
import type {
  NftSwapClientOrderRecord,
  RegisterNftSwapOrderInput,
} from '../services/swapOrderTrackerService';
import { formatSwapWireMessage, type SwapClaimItemV1 } from '../services/swapWireProtocol';

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>,
) => unknown;

export interface NftSwapBatchConfirmationInfo {
  metabotId: number;
  metabotName?: string;
  collectionSlug: string;
  collectionName?: string;
  stationGlobalMetaId: string;
  badgeLabel: string;
  vaultAddress: string;
  codehash: string;
  genesis: string;
  tokenIndexes: string[];
}

export interface NftSwapToolsControl {
  getMetabotIdentity(metabotId: number): {
    name: string;
    mvcAddress: string;
    globalMetaId: string;
  } | null;
  getMvcNftBalance(address: string): Promise<{
    collections: Array<{
      seriesName?: string;
      codeHash: string;
      genesis: string;
      items: Array<{ tokenIndex: string; name?: string }>;
    }>;
  }>;
  transferMvcNft(input: {
    metabotId: number;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    toAddress: string;
    feeRate?: number;
  }): Promise<{ txId: string; rawTx: string }>;
  sendSwapClaim(input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
  }): Promise<{ txids: string[]; pinId: string }>;
  registerOrder(input: RegisterNftSwapOrderInput): NftSwapClientOrderRecord;
  getOrder?(requestId: string): NftSwapClientOrderRecord | null;
  listOrders?(metabotId?: number): NftSwapClientOrderRecord[];
  verifyOfficialSwapStation?: typeof verifyOfficialSwapStation;
  listVerifiedOfficialSwapStations?: typeof listVerifiedOfficialSwapStations;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function normalizeTokenIndex(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return String(Number(s));
  return s;
}

export function buildNftSwapAgentTools(deps: {
  tool: SdkToolFactory;
  control: NftSwapToolsControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  confirmBatchSwap: (info: NftSwapBatchConfirmationInfo) => Promise<boolean>;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId, confirmBatchSwap } = deps;
  const verifyStation = control.verifyOfficialSwapStation ?? verifyOfficialSwapStation;
  const listStations = control.listVerifiedOfficialSwapStations ?? listVerifiedOfficialSwapStations;

  const verifyTool = tool(
    'nft_swap_verify_official_station',
    [
      'Hard-verify an official collectible swap station against the IDBots on-chain CA trust root (/protocols/idbots-nft-ca).',
      'Pass stationGlobalMetaId + vaultAddress + codehash + genesis to verify one specific swap station and vault address (fail-closed),',
      'or omit those fields to list all currently active CA-certified official swap stations and their supported legacy series.',
    ].join(' '),
    {
      stationGlobalMetaId: z.string().optional().describe('Target swap station globalMetaId'),
      station_global_metaid: z.string().optional().describe('Alias for stationGlobalMetaId'),
      vaultAddress: z.string().optional().describe('Claimed MVC vault deposit address'),
      vault_address: z.string().optional().describe('Alias for vaultAddress'),
      codehash: z.string().optional().describe('Legacy MetaContract codehash'),
      genesis: z.string().optional().describe('Legacy MetaContract genesis'),
      refresh: z.boolean().optional().describe('Force refresh CA registry from chain before verifying'),
    },
    async (args: {
      stationGlobalMetaId?: string;
      station_global_metaid?: string;
      vaultAddress?: string;
      vault_address?: string;
      codehash?: string;
      genesis?: string;
      refresh?: boolean;
    }) => {
      const stationGlobalMetaId = (args.stationGlobalMetaId ?? args.station_global_metaid ?? '').trim();
      const vaultAddress = (args.vaultAddress ?? args.vault_address ?? '').trim();
      const hasSpecificTarget =
        Boolean(stationGlobalMetaId) ||
        Boolean(vaultAddress) ||
        Boolean(args.codehash?.trim()) ||
        Boolean(args.genesis?.trim());

      if (hasSpecificTarget) {
        const result = await verifyStation({
          stationGlobalMetaId,
          vaultAddress,
          codehash: args.codehash ?? '',
          genesis: args.genesis ?? '',
          refresh: args.refresh,
        });
        return textResult(JSON.stringify(result, null, 2), !result.verified);
      }

      const listed = await listStations(args.refresh === true ? { refresh: true } : undefined);
      return textResult(JSON.stringify(listed, null, 2), !listed.verified);
    },
  );

  const submitBatchTool = tool(
    'nft_swap_submit_batch',
    [
      'Execute an authenticated batch swap of legacy MetaContract collectibles held by this MetaBot (Twin) through a CA-certified official swap station.',
      'This tool hard-verifies the swap station and vaultAddress via the IDBots CA registry, checks the MetaBot\'s actual MetaContract balance,',
      'prompts the owner ONCE for batch confirmation, transfers each selected legacy item to the official vaultAddress,',
      'records the batch in local SQLite (nft_swap_client_orders), and sends the SWAP_CLAIM_V1 private message to the swap station.',
      'Never transfer legacy collectibles manually with wallet tools before calling this.',
    ].join(' '),
    {
      collectionSlug: z.string().optional().describe('Target collection slug in CA officialBots.swapConfig.supportedSeries (e.g. metabot-avatar)'),
      collection_slug: z.string().optional().describe('Alias for collectionSlug'),
      stationGlobalMetaId: z.string().optional().describe('Official swap station globalMetaId (resolved from CA if omitted)'),
      station_global_metaid: z.string().optional().describe('Alias for stationGlobalMetaId'),
      vaultAddress: z.string().optional().describe('Expected vault deposit address (must match CA swapConfig.vaultAddress when supplied)'),
      vault_address: z.string().optional().describe('Alias for vaultAddress'),
      codehash: z.string().optional().describe('Legacy MetaContract codehash (resolved from CA when collectionSlug is given)'),
      genesis: z.string().optional().describe('Legacy MetaContract genesis (resolved from CA when collectionSlug is given)'),
      tokenIndexes: z.array(z.string()).optional().describe('Specific tokenIndex list to swap; omit to swap all held tokens of this series'),
      token_indices: z.array(z.string()).optional().describe('Alias for tokenIndexes'),
      feeRate: z.number().int().positive().optional().describe('Optional MVC fee rate in sat/vB'),
      fee_rate: z.number().int().positive().optional().describe('Alias for feeRate'),
    },
    async (args: {
      collectionSlug?: string;
      collection_slug?: string;
      stationGlobalMetaId?: string;
      station_global_metaid?: string;
      vaultAddress?: string;
      vault_address?: string;
      codehash?: string;
      genesis?: string;
      tokenIndexes?: string[];
      token_indices?: string[];
      feeRate?: number;
      fee_rate?: number;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (!metabotId) {
        return textResult('Failed: no active MetaBot is bound to this session.', true);
      }
      const identity = control.getMetabotIdentity(metabotId);
      if (!identity || !identity.mvcAddress || !identity.globalMetaId) {
        return textResult(`Failed: MetaBot #${metabotId} is missing an MVC address or globalMetaId.`, true);
      }

      const listed = await listStations();
      if (!listed.verified) {
        return textResult(
          'CA verification failed: official IDBots CA registry could not be verified on-chain. Refusing swap.',
          true,
        );
      }

      const wantSlug = (args.collectionSlug ?? args.collection_slug)?.trim().toLowerCase() ?? '';
      const wantStation = (args.stationGlobalMetaId ?? args.station_global_metaid)?.trim() ?? '';
      const wantVault = (args.vaultAddress ?? args.vault_address)?.trim() ?? '';
      const wantCodehash = args.codehash?.trim().toLowerCase() ?? '';
      const wantGenesis = args.genesis?.trim().toLowerCase() ?? '';
      const requestedTokenList = args.tokenIndexes ?? args.token_indices;
      const effectiveFeeRate = args.feeRate ?? args.fee_rate;

      let matchedStation: (typeof listed.stations)[number] | undefined;
      let matchedSeries: NonNullable<(typeof listed.stations)[number]['swapConfig']>['supportedSeries'][number] | undefined;

      for (const station of listed.stations) {
        if (wantStation && station.globalMetaId.trim() !== wantStation) continue;
        const seriesList = station.swapConfig?.supportedSeries ?? [];
        for (const series of seriesList) {
          if (wantSlug && series.collectionSlug.trim().toLowerCase() !== wantSlug) continue;
          if (wantCodehash && series.codehash.trim().toLowerCase() !== wantCodehash) continue;
          if (wantGenesis && series.genesis.trim().toLowerCase() !== wantGenesis) continue;
          matchedStation = station;
          matchedSeries = series;
          break;
        }
        if (matchedSeries) break;
      }

      if (!matchedStation || !matchedSeries || !matchedStation.swapConfig) {
        return textResult(
          'No active CA-certified official swap station matched the requested collection/series.',
          true,
        );
      }

      const candidateVaultAddress = wantVault || matchedStation.swapConfig.vaultAddress.trim();
      const verified = await verifyStation({
        stationGlobalMetaId: matchedStation.globalMetaId,
        vaultAddress: candidateVaultAddress,
        codehash: matchedSeries.codehash,
        genesis: matchedSeries.genesis,
      });
      if (verified.verified !== true) {
        const failure = verified as { verified: false; reason: string };
        return textResult(`CA verification refused swap: ${failure.reason}`, true);
      }

      const nftBalance = await control.getMvcNftBalance(identity.mvcAddress);
      const matchingCollections = (nftBalance.collections ?? []).filter(
        (col) =>
          col.codeHash?.trim().toLowerCase() === verified.seriesConfig.codehash.toLowerCase() &&
          col.genesis?.trim().toLowerCase() === verified.seriesConfig.genesis.toLowerCase(),
      );

      const heldByIndex = new Map<string, { tokenIndex: string; name?: string }>();
      let seriesName: string | undefined;
      for (const col of matchingCollections) {
        if (!seriesName && col.seriesName) seriesName = col.seriesName;
        for (const item of col.items ?? []) {
          const norm = normalizeTokenIndex(item.tokenIndex);
          if (norm) {
            heldByIndex.set(norm, { tokenIndex: String(item.tokenIndex).trim(), name: item.name });
          }
        }
      }

      if (heldByIndex.size === 0) {
        return textResult(
          `No held legacy MetaContract NFTs found for ${verified.seriesConfig.collectionSlug} (${verified.seriesConfig.codehash}/${verified.seriesConfig.genesis}) at ${identity.mvcAddress}.`,
          true,
        );
      }

      let selectedTokens: string[];
      if (Array.isArray(requestedTokenList) && requestedTokenList.length > 0) {
        const deduped: string[] = [];
        const seen = new Set<string>();
        const missing: string[] = [];
        for (const rawIdx of requestedTokenList) {
          const norm = normalizeTokenIndex(rawIdx);
          if (!norm || seen.has(norm)) continue;
          seen.add(norm);
          const held = heldByIndex.get(norm);
          if (!held) {
            missing.push(String(rawIdx).trim());
          } else {
            deduped.push(held.tokenIndex);
          }
        }
        if (missing.length > 0) {
          return textResult(
            `Requested tokenIndex(es) not held by ${identity.mvcAddress}: ${missing.join(', ')}. Held: ${Array.from(heldByIndex.keys()).join(', ')}.`,
            true,
          );
        }
        if (deduped.length > 20) {
          return textResult(
            `Batch limit exceeded: requested ${deduped.length} items, maximum 20 items per batch.`,
            true,
          );
        }
        selectedTokens = deduped;
      } else {
        selectedTokens = Array.from(heldByIndex.values())
          .map((item) => item.tokenIndex)
          .sort((a, b) => Number(a) - Number(b))
          .slice(0, 20);
      }

      if (typeof verified.seriesConfig.maxTokenIndex === 'number') {
        const outOfRange = selectedTokens.filter((t) => Number(t) > verified.seriesConfig.maxTokenIndex!);
        if (outOfRange.length > 0) {
          return textResult(
            `TokenIndex(es) exceed CA maxTokenIndex (${verified.seriesConfig.maxTokenIndex}): ${outOfRange.join(', ')}.`,
            true,
          );
        }
      }

      const confirmed = await confirmBatchSwap({
        metabotId,
        metabotName: identity.name,
        collectionSlug: verified.seriesConfig.collectionSlug,
        collectionName: seriesName,
        stationGlobalMetaId: verified.stationEntry.globalMetaId,
        badgeLabel: verified.badgeLabel,
        vaultAddress: verified.stationEntry.swapConfig!.vaultAddress,
        codehash: verified.seriesConfig.codehash,
        genesis: verified.seriesConfig.genesis,
        tokenIndexes: selectedTokens,
      });

      if (!confirmed) {
        return textResult('Batch swap cancelled: owner denied or confirmation timed out.', true);
      }

      const depositedItems: SwapClaimItemV1[] = [];
      const failedTransfers: Array<{ tokenIndex: string; error: string }> = [];
      const vaultAddress = verified.stationEntry.swapConfig!.vaultAddress;

      for (const tokenIndex of selectedTokens) {
        try {
          const tx = await control.transferMvcNft({
            metabotId,
            genesis: verified.seriesConfig.genesis,
            codehash: verified.seriesConfig.codehash,
            tokenIndex,
            toAddress: vaultAddress,
            feeRate: effectiveFeeRate,
          });
          depositedItems.push({ tokenIndex, depositTxId: tx.txId });
        } catch (err) {
          failedTransfers.push({
            tokenIndex,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (depositedItems.length === 0) {
        return textResult(
          JSON.stringify(
            {
              ok: false,
              error: 'All legacy NFT transfers failed before sending claim.',
              failedTransfers,
            },
            null,
            2,
          ),
          true,
        );
      }

      const requestId = randomUUID();
      const order = control.registerOrder({
        requestId,
        metabotId,
        stationGlobalMetaId: verified.stationEntry.globalMetaId,
        collectionSlug: verified.seriesConfig.collectionSlug,
        targetCollectionPinId: verified.seriesConfig.targetCollectionPinId,
        sessionId,
        recipientAddress: identity.mvcAddress,
        items: depositedItems,
      });

      const claimMessage = formatSwapWireMessage({
        type: 'SWAP_CLAIM_V1',
        requestId,
        collectionSlug: verified.seriesConfig.collectionSlug,
        codehash: verified.seriesConfig.codehash,
        genesis: verified.seriesConfig.genesis,
        recipientAddress: identity.mvcAddress,
        recipientGlobalMetaId: identity.globalMetaId,
        items: depositedItems,
      });

      let claimPinId: string | null = null;
      let claimTxIds: string[] = [];
      let claimSendError: string | null = null;

      try {
        const sent = await control.sendSwapClaim({
          metabotId,
          toGlobalMetaId: verified.stationEntry.globalMetaId,
          content: claimMessage,
        });
        claimPinId = sent.pinId;
        claimTxIds = sent.txids;
      } catch (err) {
        claimSendError = err instanceof Error ? err.message : String(err);
      }

      return textResult(
        JSON.stringify(
          {
            ok: !claimSendError && failedTransfers.length === 0,
            requestId: order.requestId,
            collectionSlug: verified.seriesConfig.collectionSlug,
            targetCollectionPinId: verified.seriesConfig.targetCollectionPinId,
            stationGlobalMetaId: verified.stationEntry.globalMetaId,
            badgeLabel: verified.badgeLabel,
            vaultAddress,
            depositedItems,
            ...(failedTransfers.length > 0 ? { failedTransfers } : {}),
            claimPinId,
            claimTxIds,
            ...(claimSendError ? { claimSendError } : {}),
            trackingNote:
              'Order registered in SwapOrderTrackerService. Completion will be detected automatically via SWAP_COMPLETED_V1 or 45s MetaSo polling.',
          },
          null,
          2,
        ),
        Boolean(claimSendError && depositedItems.length === 0),
      );
    },
  );

  const statusTool = tool(
    'nft_swap_order_status',
    'Inspect locally tracked legacy-to-MRC721 swap orders (nft_swap_client_orders) for this MetaBot or a specific requestId.',
    {
      requestId: z.string().optional().describe('Specific swap batch requestId'),
    },
    async (args: { requestId?: string }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (args.requestId?.trim() && control.getOrder) {
        const order = control.getOrder(args.requestId.trim());
        return textResult(JSON.stringify(order, null, 2), !order);
      }
      if (control.listOrders) {
        const orders = control.listOrders(metabotId);
        return textResult(JSON.stringify({ metabotId: metabotId ?? null, orders }, null, 2));
      }
      return textResult('Swap order query is unavailable.', true);
    },
  );

  return [verifyTool, submitBatchTool, statusTool];
}
