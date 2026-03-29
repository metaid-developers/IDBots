'use strict';

function getInputUnit(request) {
  return request.direction === 'space_to_token' ? 'SPACE' : request.tokenSymbol;
}

function formatPreview({ request, estimatedOut, minimumReceived, outputSymbol }) {
  return [
    `将用 ${request.amountIn} ${getInputUnit(request)} 兑换 ${outputSymbol}`,
    `预计收到：${estimatedOut} ${outputSymbol}`,
    `最少收到：${minimumReceived} ${outputSymbol}`,
    `滑点：${request.slippagePercent}%`,
    '如确认执行，请回复：确认交易',
  ].join('\n');
}

function formatQuote({ request, estimatedOut, minimumReceived, outputSymbol }) {
  return [
    `${request.amountIn} ${getInputUnit(request)} 的报价如下`,
    `预计收到：${estimatedOut} ${outputSymbol}`,
    `最少收到：${minimumReceived} ${outputSymbol}`,
    `滑点：${request.slippagePercent}%`,
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
