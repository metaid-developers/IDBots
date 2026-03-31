'use strict';

function formatSupportedPairsMessage(entries) {
  const pairs = entries.map((entry) => `${entry.pair} bid ${entry.bid} / ask ${entry.ask}`).join('; ');
  return `Supported pairs: ${pairs}. Execution always settles at the latest price.`;
}

function formatQuoteMessage({ pair, direction, outputAmount, assetOut }) {
  return `Quote for ${pair} ${direction}: estimated ${outputAmount} ${assetOut}. Final settlement uses the latest price at payment verification.`;
}

function formatExecutedMessage({ assetIn, amountIn, assetOut, outputAmount, pricingSide, txid }) {
  return `Executed ${amountIn} ${assetIn} -> ${outputAmount} ${assetOut} at the latest ${pricingSide} price. Payout txid: ${txid}.`;
}

function formatRefundMessage({ reason, feeBearer, refundAmountMode, assetIn, amountIn, txid }) {
  const feeMessage =
    feeBearer === 'payer'
      ? 'The payer (Bot A) bore the refund fee.'
      : 'The maker (Bot B) absorbed the refund fee.';
  const refundModeMessage =
    refundAmountMode === 'net_of_fee'
      ? 'Refund is net of the refund-chain fee.'
      : 'Refund targets the full principal.';
  const reasonMessage =
    reason === 'amount_mismatch'
      ? 'Paid amount did not exactly match the requested amount.'
      : reason === 'inventory_shortage'
        ? 'Maker inventory was insufficient at settlement.'
        : reason === 'trade_limit'
          ? 'Trade amount is outside the configured minimum or maximum.'
          : reason === 'slippage_exceeded'
            ? 'Latest executable output exceeded the confirmed slippage limit.'
            : reason === 'dust_output'
              ? 'Rounded settlement output fell below the minimum transferable amount.'
              : 'Settlement could not proceed, so the payment was refunded.';
  return `${reasonMessage} Refunded ${amountIn} ${assetIn}. ${refundModeMessage} ${feeMessage} Refund txid: ${txid}.`;
}

function formatRefundedMessage({ reason, feeBearer, refundAmountMode, assetIn, amountIn, txid }) {
  return formatRefundMessage({
    reason,
    feeBearer,
    refundAmountMode,
    assetIn,
    amountIn,
    txid,
  });
}

function formatVoidMessage() {
  return 'Payment proof could not be found after retry. The attempt was marked void and needs operator reconciliation.';
}

function formatPayoutFailedMessage(error) {
  return `Payout failed after payment verification: ${error}. Operator action may be required.`;
}

function formatRefundFailedMessage(error) {
  return `Refund failed after settlement rejected the trade: ${error}. Operator should handle this manually.`;
}

function formatTransferFailureMessage({ kind, detail }) {
  if (kind === 'refund') {
    return formatRefundFailedMessage(detail || 'unknown');
  }
  return formatPayoutFailedMessage(detail || 'unknown');
}

module.exports = {
  formatSupportedPairsMessage,
  formatQuoteMessage,
  formatExecutedMessage,
  formatRefundMessage,
  formatRefundedMessage,
  formatVoidMessage,
  formatPayoutFailedMessage,
  formatRefundFailedMessage,
  formatTransferFailureMessage,
};
