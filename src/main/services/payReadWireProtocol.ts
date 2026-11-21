/**
 * PayBuzz A2A Key-Grant Wire Protocol (`idbots-payread-v1`)
 *
 * Carried inside `/protocols/simplemsg` ECDH-encrypted private messages as:
 *   ```idbots-payread-v1
 *   { "type": "PAYREAD_VIP_REQ_V1" | "PAYREAD_TOKEN_REQ_V1" | "PAYREAD_KEY_GRANT_V1" | "PAYREAD_REJECTED_V1", ... }
 *   ```
 */

export const PAYREAD_WIRE_FENCE_TAG = 'idbots-payread-v1';

export interface PayreadVipReqMessageV1 {
  type: 'PAYREAD_VIP_REQ_V1';
  paybuzzPinId: string;
  collectionPinId: string;
  holderAddress: string;
  readerGlobalMetaId?: string;
  timestamp: number;
  signatureHex: string;
}

export interface PayreadTokenReqMessageV1 {
  type: 'PAYREAD_TOKEN_REQ_V1';
  paybuzzPinId: string;
  assetKey: string;
  paymentTxId: string;
  readerGlobalMetaId: string;
}

export interface PayreadKeyGrantMessageV1 {
  type: 'PAYREAD_KEY_GRANT_V1';
  paybuzzPinId: string;
  contentKeyHex: string;
  grantedVia: 'vip-nft' | 'token';
}

export interface PayreadRejectedMessageV1 {
  type: 'PAYREAD_REJECTED_V1';
  paybuzzPinId: string;
  code: string;
  reason: string;
}

export type PayReadWireMessageV1 =
  | PayreadVipReqMessageV1
  | PayreadTokenReqMessageV1
  | PayreadKeyGrantMessageV1
  | PayreadRejectedMessageV1;

export function formatPayReadWireMessage(payload: PayReadWireMessageV1): string {
  return `\`\`\`${PAYREAD_WIRE_FENCE_TAG}\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

const FENCE_RE = /```idbots-payread-v1\s*\r?\n([\s\S]*?)```/g;

function pickStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pickFiniteNum(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function parsePayReadWireMessage(
  plaintext: string | null | undefined,
): PayReadWireMessageV1 | null {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const candidates: string[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(plaintext)) !== null) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  if (candidates.length === 0) return null;

  for (const rawJson of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const type = pickStr(obj.type);
    const paybuzzPinId = pickStr(obj.paybuzzPinId ?? obj.paybuzz_pin_id).toLowerCase();
    if (!type || !paybuzzPinId) continue;

    if (type === 'PAYREAD_VIP_REQ_V1') {
      const collectionPinId = pickStr(obj.collectionPinId ?? obj.collection_pin_id).toLowerCase();
      const holderAddress = pickStr(obj.holderAddress ?? obj.holder_address);
      const timestamp = pickFiniteNum(obj.timestamp);
      const signatureHex = pickStr(obj.signatureHex ?? obj.signature_hex ?? obj.signature);
      const readerGlobalMetaId = pickStr(obj.readerGlobalMetaId ?? obj.reader_global_metaid) || undefined;
      if (!collectionPinId || !holderAddress || timestamp == null || timestamp <= 0 || !signatureHex) {
        continue;
      }
      return {
        type: 'PAYREAD_VIP_REQ_V1',
        paybuzzPinId,
        collectionPinId,
        holderAddress,
        ...(readerGlobalMetaId ? { readerGlobalMetaId } : {}),
        timestamp: Math.trunc(timestamp),
        signatureHex,
      };
    }

    if (type === 'PAYREAD_TOKEN_REQ_V1') {
      const assetKey = pickStr(obj.assetKey ?? obj.asset_key).toLowerCase();
      const paymentTxId = pickStr(obj.paymentTxId ?? obj.payment_tx_id).toLowerCase();
      const readerGlobalMetaId = pickStr(obj.readerGlobalMetaId ?? obj.reader_global_metaid);
      if (!assetKey || !paymentTxId || !readerGlobalMetaId) {
        continue;
      }
      return {
        type: 'PAYREAD_TOKEN_REQ_V1',
        paybuzzPinId,
        assetKey,
        paymentTxId,
        readerGlobalMetaId,
      };
    }

    if (type === 'PAYREAD_KEY_GRANT_V1') {
      const contentKeyHex = pickStr(obj.contentKeyHex ?? obj.content_key_hex).toLowerCase();
      const grantedViaRaw = pickStr(obj.grantedVia ?? obj.granted_via).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(contentKeyHex)) continue;
      const grantedVia: 'vip-nft' | 'token' = grantedViaRaw === 'vip-nft' ? 'vip-nft' : 'token';
      return {
        type: 'PAYREAD_KEY_GRANT_V1',
        paybuzzPinId,
        contentKeyHex,
        grantedVia,
      };
    }

    if (type === 'PAYREAD_REJECTED_V1') {
      const code = pickStr(obj.code) || 'UNLOCK_REJECTED';
      const reason = pickStr(obj.reason) || 'Request rejected by author';
      return {
        type: 'PAYREAD_REJECTED_V1',
        paybuzzPinId,
        code,
        reason,
      };
    }
  }

  return null;
}
