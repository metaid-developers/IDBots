export type OrderSource = 'metaweb_private' | 'metaweb_group';

export interface OrderPaymentCheckResult {
  paid: boolean;
  txid: string | null;
  reason: string;
}

const TXID_RE = /txid\s*[:：=]?\s*([0-9a-fA-F]{32,})/i;

export function extractOrderTxid(plaintext: string): string | null {
  const match = plaintext.match(TXID_RE);
  if (!match) return null;
  return match[1] || null;
}

export async function checkOrderPaymentStatus(params: {
  txid: string | null;
  plaintext: string;
  source: OrderSource;
  metabotId: number;
}): Promise<OrderPaymentCheckResult> {
  // TODO: replace with on-chain payment verification.
  return {
    paid: true,
    txid: params.txid,
    reason: 'mock_paid',
  };
}
