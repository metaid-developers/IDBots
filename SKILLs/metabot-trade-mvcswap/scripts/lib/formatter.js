'use strict';

function formatPreview({ intent, estimatedOut, minimumReceived, outputSymbol }) {
  return [
    `将用 ${intent.amount} ${intent.amountUnit} 兑换 ${outputSymbol}`,
    `预计收到：${estimatedOut} ${outputSymbol}`,
    `最少收到：${minimumReceived} ${outputSymbol}`,
    `滑点：${intent.slippagePercent}%`,
    '如确认执行，请回复：确认交易',
  ].join('\n');
}

function formatQuote({ intent, estimatedOut, minimumReceived, outputSymbol }) {
  return [
    `${intent.amount} ${intent.amountUnit} 的报价如下`,
    `预计收到：${estimatedOut} ${outputSymbol}`,
    `最少收到：${minimumReceived} ${outputSymbol}`,
    `滑点：${intent.slippagePercent}%`,
  ].join('\n');
}

function formatExecuted({ directionLabel, inputAmount, inputUnit, outputAmount, outputUnit, txid }) {
  return [
    '交易已提交',
    `成交方向：${directionLabel}`,
    `输入：${inputAmount} ${inputUnit}`,
    `预计成交：${outputAmount} ${outputUnit}`,
    `TxID：${txid}`,
  ].join('\n');
}

module.exports = {
  formatPreview,
  formatQuote,
  formatExecuted,
};
