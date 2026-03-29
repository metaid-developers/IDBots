'use strict';

function toBaseUnits(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be a numeric base unit string.`);
  }

  return BigInt(text);
}

function sumOutputsForAddress(txOutputs, expectedReceivingAddress) {
  if (!Array.isArray(txOutputs)) {
    throw new Error('payment proof outputs are not discoverable.');
  }

  return txOutputs.reduce((total, output) => {
    if (output?.address === expectedReceivingAddress) {
      const baseUnits = toBaseUnits(output.baseUnits, 'output base units');
      return total + (baseUnits ?? 0n);
    }
    return total;
  }, 0n);
}

async function verifyPaymentProof({
  expectedBaseUnits,
  paidBaseUnits,
  expectedChain,
  txSourceResult,
  expectedReceivingAddress,
  txOutputs,
} = {}) {
  if (txSourceResult == null) {
    throw new Error('payment proof is not discoverable.');
  }

  if (!expectedChain) {
    throw new Error('expected chain is required.');
  }

  if (!txSourceResult?.chain || txSourceResult.chain !== expectedChain) {
    throw new Error('payment proof chain does not match expected chain.');
  }

  if (expectedBaseUnits === undefined || expectedBaseUnits === null) {
    throw new Error('expected base units are required.');
  }

  if (paidBaseUnits === undefined || paidBaseUnits === null) {
    throw new Error('paid base units are required.');
  }

  if (!expectedReceivingAddress) {
    throw new Error('expected receiving address is required.');
  }

  if (!Array.isArray(txOutputs)) {
    throw new Error('payment proof outputs are not discoverable.');
  }

  const expected = toBaseUnits(expectedBaseUnits, 'expected base units');

  const observed = sumOutputsForAddress(txOutputs, expectedReceivingAddress);
  if (observed !== expected) {
    throw new Error('payment receiving address amount mismatch.');
  }

  const paid = toBaseUnits(paidBaseUnits, 'paid base units');
  if (paid !== expected) {
    throw new Error('paid amount does not exactly match requested amount.');
  }

  return { ok: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyWithRetry(options, txLookup) {
  const { txid, retryDelayMs = 5000, sleep: injectedSleep } = options || {};
  let attempts = 0;
  const wait = typeof injectedSleep === 'function' ? injectedSleep : sleep;

  const lookup = async () => {
    attempts += 1;
    return txLookup ? txLookup(txid, attempts) : null;
  };

  let txSourceResult = await lookup();
  if (!txSourceResult) {
    await wait(retryDelayMs);
    txSourceResult = await lookup();
  }

  if (!txSourceResult) {
    return { mode: 'void', lookupAttempts: attempts, needsOperatorReconciliation: true };
  }

  return { mode: 'found', lookupAttempts: attempts, txSourceResult };
}

function classifyLatePayment({ previousOutcome, txFoundLater }) {
  if (previousOutcome === 'void' && txFoundLater) {
    return 'refund_required';
  }
  return previousOutcome;
}

module.exports = {
  verifyPaymentProof,
  verifyWithRetry,
  classifyLatePayment,
};
