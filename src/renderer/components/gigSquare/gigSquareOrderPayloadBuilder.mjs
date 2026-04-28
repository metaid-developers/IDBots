import {
  buildOrderPayload,
  validateOrderRawRequest,
} from '../../../main/shared/orderMessage.js';

export function validateGigSquareOrderPrompt(prompt) {
  return validateOrderRawRequest(prompt);
}

export function buildGigSquareOrderPayload(input) {
  return buildOrderPayload({
    displayText: input.naturalOrderText,
    rawRequest: input.rawRequest,
    price: input.price,
    currency: input.currency,
    paymentTxid: input.txid,
    paymentCommitTxid: input.paymentCommitTxid,
    orderReference: input.orderReference,
    paymentChain: input.paymentChain,
    settlementKind: input.settlementKind,
    mrc20Ticker: input.mrc20Ticker,
    mrc20Id: input.mrc20Id,
    serviceId: input.serviceId,
    skillName: input.skillName,
    serviceName: input.serviceName,
    outputType: input.outputType,
  });
}
