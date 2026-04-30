export interface A2AChainMetadataInput {
  txId?: unknown;
  txids?: unknown;
  pinId?: unknown;
}

export interface A2AChainMetadata {
  txid?: string;
  txids?: string[];
  pinId?: string;
  [key: string]: unknown;
}

const CHAIN_TXID_RE = /^[0-9a-f]{64}$/i;
const CHAIN_PIN_ID_RE = /^([0-9a-f]{64})i\d+$/i;

export const normalizeA2AChainTxid = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CHAIN_TXID_RE.test(normalized) ? normalized : '';
};

export const normalizeA2AChainPinId = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export const extractTxidFromA2AChainPinId = (value: unknown): string => {
  const normalized = normalizeA2AChainPinId(value).toLowerCase();
  return normalized.match(CHAIN_PIN_ID_RE)?.[1] ?? '';
};

export function buildA2AChainMetadata(input: A2AChainMetadataInput): A2AChainMetadata {
  const explicitTxid = normalizeA2AChainTxid(input.txId);
  const txids = Array.isArray(input.txids)
    ? input.txids.map(normalizeA2AChainTxid).filter(Boolean)
    : [];
  const pinId = normalizeA2AChainPinId(input.pinId);
  const txid = explicitTxid || txids[0] || extractTxidFromA2AChainPinId(pinId);
  const allTxids = Array.from(new Set([txid, ...txids].filter(Boolean)));
  const metadata: A2AChainMetadata = {};
  if (txid) metadata.txid = txid;
  if (allTxids.length > 0) metadata.txids = allTxids;
  if (pinId) metadata.pinId = pinId;
  return metadata;
}

export function hasA2AChainMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false;
  return Boolean(
    normalizeA2AChainTxid(metadata.txid)
      || (Array.isArray(metadata.txids) && metadata.txids.map(normalizeA2AChainTxid).find(Boolean))
      || extractTxidFromA2AChainPinId(metadata.pinId)
  );
}
