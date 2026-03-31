export function buildTransactionExplorerUrl(chain, txid) {
  const normalizedChain = String(chain || '').trim().toLowerCase();
  const normalizedTxid = String(txid || '').trim();
  if (!normalizedTxid) return null;

  if (normalizedChain === 'btc') {
    return `https://mempool.space/tx/${normalizedTxid}`;
  }
  if (normalizedChain === 'mvc') {
    return `https://www.mvcscan.com/tx/${normalizedTxid}`;
  }
  return null;
}
