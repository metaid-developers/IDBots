/**
 * Station-side handler for incoming `SWAP_CLAIM_V1` A2A wire messages
 * (Contract C5.1, nft-swap v0.5.0).
 *
 * Parses the `idbots-swap-v1` fenced JSON block (or raw JSON), validates the
 * collectionSlug + (codehash, genesis) against SERIES_REGISTRY, polls the
 * vault at MVP_CONFIRMATIONS = 1, drives verifyAndClaim + mintAndSend for
 * matured deposits, and produces either:
 *   - `SWAP_STATUS_V1` (`pending_1_conf`) when any deposit is at 0-conf, or
 *   - `SWAP_COMPLETED_V1` when all items are processed.
 */

import { SERIES_REGISTRY, albumFromSeries, resolveSeries } from './series-registry.mjs';
import { SwapEngineError, mintAndSend, verifyAndClaim } from './swap-engine.mjs';
import { MVP_CONFIRMATIONS, pollVault } from './vault-poll-lib.mjs';

const FENCE_RE = /```idbots-swap-v1\s*\r?\n([\s\S]*?)```/;

export function parseSwapClaimMessage(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new SwapEngineError('INVALID_CLAIM_MESSAGE', 'claim message is empty');
  }
  const fenceMatch = FENCE_RE.exec(raw);
  const jsonText = (fenceMatch ? fenceMatch[1] : raw).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new SwapEngineError(
      'INVALID_CLAIM_MESSAGE',
      `claim message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'SWAP_CLAIM_V1') {
    throw new SwapEngineError('INVALID_CLAIM_MESSAGE', 'expected payload with type="SWAP_CLAIM_V1"');
  }
  const requestId = String(parsed.requestId ?? '').trim();
  const collectionSlug = String(parsed.collectionSlug ?? '').trim().toLowerCase();
  const codehash = String(parsed.codehash ?? '').trim().toLowerCase();
  const genesis = String(parsed.genesis ?? '').trim().toLowerCase();
  const recipientAddress = String(parsed.recipientAddress ?? '').trim();
  const recipientGlobalMetaId = String(parsed.recipientGlobalMetaId ?? '').trim();
  if (!requestId || !collectionSlug || !codehash || !genesis || !recipientAddress || !Array.isArray(parsed.items)) {
    throw new SwapEngineError('INVALID_CLAIM_MESSAGE', 'SWAP_CLAIM_V1 missing required fields');
  }
  const items = parsed.items
    .map((item) => ({
      tokenIndex: Number(item?.tokenIndex),
      depositTxId: String(item?.depositTxId ?? '').trim(),
    }))
    .filter((item) => Number.isInteger(item.tokenIndex) && item.tokenIndex > 0 && item.depositTxId);

  if (items.length === 0) {
    throw new SwapEngineError('INVALID_CLAIM_MESSAGE', 'SWAP_CLAIM_V1 contains no valid items');
  }

  return {
    type: 'SWAP_CLAIM_V1',
    requestId,
    collectionSlug,
    codehash,
    genesis,
    recipientAddress,
    recipientGlobalMetaId,
    items,
  };
}

export function formatWireReply(payload) {
  return `\`\`\`idbots-swap-v1\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

/**
 * Process one SWAP_CLAIM_V1 payload against the station's ledger + vault.
 */
export async function handleClaimMessage({
  rawMessage,
  ledger,
  deps,
  registry = SERIES_REGISTRY,
  vaultAddressOverride = null,
  broadcast = false,
  cover = null,
  minConfirmations = MVP_CONFIRMATIONS,
  claimChannel = 'metaweb_private',
  feeCeilingSats,
  itemInfoTimeoutMs = 360_000,
}) {
  const claim = parseSwapClaimMessage(rawMessage);
  const series = resolveSeries({ collectionSlug: claim.collectionSlug }, registry);
  if (!series) {
    throw new SwapEngineError('UNKNOWN_COLLECTION', `unsupported collectionSlug: ${claim.collectionSlug}`);
  }
  if (
    series.legacyCodeHash.toLowerCase() !== claim.codehash ||
    series.legacyGenesis.toLowerCase() !== claim.genesis
  ) {
    throw new SwapEngineError(
      'SERIES_MISMATCH',
      `claim (${claim.codehash}, ${claim.genesis}) does not match series ${series.collectionSlug}`,
    );
  }

  const album = albumFromSeries(series, {
    ...(vaultAddressOverride ? { vaultAddress: vaultAddressOverride } : {}),
  });
  const effectiveMinConf = Number.isInteger(minConfirmations) ? minConfirmations : album.minConfirmations ?? MVP_CONFIRMATIONS;

  const poll = await pollVault({
    ledger,
    album,
    vaultAddress: album.vaultAddress,
    minConfirmations: effectiveMinConf,
    fetchImpl: deps.fetchImpl,
    confirmationsResolver: deps.fetchConfirmations,
  });

  const pendingItems = [];
  const results = [];
  const processedDryRun = [];

  for (const item of claim.items) {
    const unconfirmedMatch = poll.unconfirmed.find(
      (u) => Number(u.tokenIndex) === item.tokenIndex || u.txid === item.depositTxId,
    );
    if (unconfirmedMatch) {
      pendingItems.push({
        tokenIndex: String(item.tokenIndex),
        status: 'pending_1_conf',
        depositTxId: item.depositTxId,
        confirmations: unconfirmedMatch.confirmations ?? 0,
      });
      continue;
    }

    let row =
      ledger.activeRowByToken(album.collectionSlug, item.tokenIndex) ??
      ledger.latestRowByToken(album.collectionSlug, item.tokenIndex);

    if (!row) {
      results.push({
        tokenIndex: String(item.tokenIndex),
        status: 'failed',
        error: `deposit ${item.depositTxId} for #${item.tokenIndex} not found in vault`,
      });
      continue;
    }

    if (row.state === 'sent') {
      results.push({
        tokenIndex: String(item.tokenIndex),
        status: 'completed',
        itemPinId: row.mint_pin_id,
        deliveryTxId: row.transfer_txid,
        itemName: `${album.itemTitlePrefix} #${item.tokenIndex}`,
      });
      continue;
    }

    if (!broadcast) {
      processedDryRun.push({
        tokenIndex: String(item.tokenIndex),
        ledgerId: row.id,
        state: row.state,
        wouldProcess: true,
      });
      continue;
    }

    try {
      if (row.state === 'detected') {
        await verifyAndClaim({
          ledger,
          album,
          row,
          claimantAddress: claim.recipientAddress,
          claimChannel,
          claimMessageId: claim.requestId,
          deps,
          dryRun: false,
          minConfirmations: effectiveMinConf,
        });
        row = ledger.rowById(row.id);
      }

      const sent = await mintAndSend({
        ledger,
        album,
        row,
        deps,
        recipientAddress: claim.recipientAddress,
        cover,
        broadcast: true,
        feeCeilingSats: feeCeilingSats ?? album.perSwapFeeCeilingSats,
        itemInfoTimeoutMs,
      });

      if (sent.ok) {
        results.push({
          tokenIndex: String(item.tokenIndex),
          status: 'completed',
          itemPinId: sent.mintPinId,
          deliveryTxId: sent.transferTxid,
          itemName: `${album.itemTitlePrefix} #${item.tokenIndex}`,
        });
      } else {
        results.push({
          tokenIndex: String(item.tokenIndex),
          status: 'failed',
          error: sent.reason || `unexpected state ${sent.state}`,
        });
      }
    } catch (error) {
      results.push({
        tokenIndex: String(item.tokenIndex),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (pendingItems.length > 0) {
    const statusPayload = {
      type: 'SWAP_STATUS_V1',
      requestId: claim.requestId,
      collectionSlug: album.collectionSlug,
      status: 'pending_1_conf',
      items: pendingItems,
      note: `Waiting for ${effectiveMinConf} confirmation(s) on deposit transaction.`,
    };
    return {
      ok: true,
      pending: true,
      requestId: claim.requestId,
      collectionSlug: album.collectionSlug,
      replyPayload: statusPayload,
      replyText: formatWireReply(statusPayload),
      ...(results.length > 0 ? { partialResults: results } : {}),
    };
  }

  if (!broadcast) {
    return {
      ok: true,
      dryRun: true,
      requestId: claim.requestId,
      collectionSlug: album.collectionSlug,
      items: processedDryRun,
      alreadySent: results,
    };
  }

  const completedPayload = {
    type: 'SWAP_COMPLETED_V1',
    requestId: claim.requestId,
    collectionSlug: album.collectionSlug,
    ...(album.collectionPinId ? { collectionPinId: album.collectionPinId } : {}),
    results,
  };

  return {
    ok: results.every((r) => r.status === 'completed'),
    pending: false,
    requestId: claim.requestId,
    collectionSlug: album.collectionSlug,
    replyPayload: completedPayload,
    replyText: formatWireReply(completedPayload),
  };
}
