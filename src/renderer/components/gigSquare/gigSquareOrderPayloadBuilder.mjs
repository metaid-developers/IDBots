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
    serviceId: input.serviceId,
    skillName: input.skillName,
    serviceName: input.serviceName,
  });
}
