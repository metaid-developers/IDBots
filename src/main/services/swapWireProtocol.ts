/**
 * Contract C5.1 — Swap A2A Wire Protocol (`idbots-swap-v1`)
 *
 * Uses `/protocols/simplemsg` private messages carrying a fenced JSON block:
 *   ```idbots-swap-v1
 *   { "type": "SWAP_CLAIM_V1" | "SWAP_STATUS_V1" | "SWAP_COMPLETED_V1", ... }
 *   ```
 */

export const SWAP_WIRE_FENCE_TAG = 'idbots-swap-v1';

export interface SwapClaimItemV1 {
  tokenIndex: string;
  depositTxId: string;
}

export interface SwapClaimMessageV1 {
  type: 'SWAP_CLAIM_V1';
  requestId: string;
  collectionSlug: string;
  codehash: string;
  genesis: string;
  recipientAddress: string;
  recipientGlobalMetaId: string;
  items: SwapClaimItemV1[];
}

export interface SwapStatusItemV1 {
  tokenIndex: string;
  status: string;
  depositTxId?: string;
  confirmations?: number;
  note?: string;
}

export interface SwapStatusMessageV1 {
  type: 'SWAP_STATUS_V1';
  requestId: string;
  collectionSlug: string;
  status: 'pending_1_conf' | 'minting' | 'delivering' | 'failed';
  items?: SwapStatusItemV1[];
  note?: string;
}

export interface SwapCompletedResultItemV1 {
  tokenIndex: string;
  status: 'completed' | 'failed';
  itemPinId?: string;
  deliveryTxId?: string;
  itemName?: string;
  cover?: string;
  error?: string;
}

export interface SwapCompletedMessageV1 {
  type: 'SWAP_COMPLETED_V1';
  requestId: string;
  collectionSlug: string;
  collectionPinId?: string;
  results: SwapCompletedResultItemV1[];
}

export type SwapWireMessageV1 =
  | SwapClaimMessageV1
  | SwapStatusMessageV1
  | SwapCompletedMessageV1;

export function formatSwapWireMessage(payload: SwapWireMessageV1): string {
  return `\`\`\`${SWAP_WIRE_FENCE_TAG}\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

const FENCE_RE = /```idbots-swap-v1\s*\r?\n([\s\S]*?)```/g;

export function parseSwapWireMessage(plaintext: string | null | undefined): SwapWireMessageV1 | null {
  if (!plaintext || typeof plaintext !== 'string') {
    return null;
  }

  const candidates: string[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(plaintext)) !== null) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  for (const rawJson of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type.trim() : '';
    const requestId = typeof obj.requestId === 'string' ? obj.requestId.trim() : '';
    const collectionSlug = typeof obj.collectionSlug === 'string' ? obj.collectionSlug.trim() : '';
    if (!requestId || !collectionSlug) {
      continue;
    }

    if (type === 'SWAP_CLAIM_V1') {
      const codehash = typeof obj.codehash === 'string' ? obj.codehash.trim().toLowerCase() : '';
      const genesis = typeof obj.genesis === 'string' ? obj.genesis.trim().toLowerCase() : '';
      const recipientAddress = typeof obj.recipientAddress === 'string' ? obj.recipientAddress.trim() : '';
      const recipientGlobalMetaId =
        typeof obj.recipientGlobalMetaId === 'string' ? obj.recipientGlobalMetaId.trim() : '';
      if (!codehash || !genesis || !recipientAddress || !Array.isArray(obj.items)) {
        continue;
      }
      const items: SwapClaimItemV1[] = [];
      for (const item of obj.items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        const tokenIndex = String(row.tokenIndex ?? '').trim();
        const depositTxId = String(row.depositTxId ?? '').trim();
        if (tokenIndex && depositTxId) {
          items.push({ tokenIndex, depositTxId });
        }
      }
      if (items.length === 0) continue;
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

    if (type === 'SWAP_STATUS_V1') {
      const status = typeof obj.status === 'string' ? obj.status.trim() : '';
      if (!['pending_1_conf', 'minting', 'delivering', 'failed'].includes(status)) {
        continue;
      }
      const items: SwapStatusItemV1[] = [];
      if (Array.isArray(obj.items)) {
        for (const item of obj.items) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const row = item as Record<string, unknown>;
          const tokenIndex = String(row.tokenIndex ?? '').trim();
          const itemStatus = String(row.status ?? '').trim();
          if (!tokenIndex || !itemStatus) continue;
          items.push({
            tokenIndex,
            status: itemStatus,
            ...(typeof row.depositTxId === 'string' && row.depositTxId.trim()
              ? { depositTxId: row.depositTxId.trim() }
              : {}),
            ...(Number.isFinite(Number(row.confirmations))
              ? { confirmations: Number(row.confirmations) }
              : {}),
            ...(typeof row.note === 'string' && row.note.trim() ? { note: row.note.trim() } : {}),
          });
        }
      }
      return {
        type: 'SWAP_STATUS_V1',
        requestId,
        collectionSlug,
        status: status as SwapStatusMessageV1['status'],
        ...(items.length > 0 ? { items } : {}),
        ...(typeof obj.note === 'string' && obj.note.trim() ? { note: obj.note.trim() } : {}),
      };
    }

    if (type === 'SWAP_COMPLETED_V1') {
      if (!Array.isArray(obj.results)) continue;
      const results: SwapCompletedResultItemV1[] = [];
      for (const item of obj.results) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        const tokenIndex = String(row.tokenIndex ?? '').trim();
        const rawStatus = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
        if (!tokenIndex) continue;
        let itemStatus: 'completed' | 'failed' | null = null;
        if (rawStatus === 'sent' || rawStatus === 'completed') {
          itemStatus = 'completed';
        } else if (rawStatus === 'failed') {
          itemStatus = 'failed';
        }
        if (!itemStatus) continue;
        results.push({
          tokenIndex,
          status: itemStatus,
          ...(typeof row.itemPinId === 'string' && row.itemPinId.trim()
            ? { itemPinId: row.itemPinId.trim().toLowerCase() }
            : {}),
          ...(typeof row.deliveryTxId === 'string' && row.deliveryTxId.trim()
            ? { deliveryTxId: row.deliveryTxId.trim() }
            : {}),
          ...(typeof row.itemName === 'string' && row.itemName.trim()
            ? { itemName: row.itemName.trim() }
            : {}),
          ...(typeof row.cover === 'string' && row.cover.trim() ? { cover: row.cover.trim() } : {}),
          ...(typeof row.error === 'string' && row.error.trim() ? { error: row.error.trim() } : {}),
        });
      }
      if (results.length === 0) continue;
      return {
        type: 'SWAP_COMPLETED_V1',
        requestId,
        collectionSlug,
        ...(typeof obj.collectionPinId === 'string' && obj.collectionPinId.trim()
          ? { collectionPinId: obj.collectionPinId.trim().toLowerCase() }
          : {}),
        results,
      };
    }
  }

  return null;
}
