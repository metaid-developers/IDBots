'use strict';

const CANONICAL_LIFECYCLE_STATES = new Set([
  'pending_payment_proof',
  'validated',
  'executed',
  'refund_required',
  'refunded',
  'void',
]);

function buildIdempotencyKey({
  serviceOrderPinId,
  payTxid,
  pair,
  direction,
  payerGlobalmetaid,
}) {
  if (!payTxid) {
    throw new Error('payTxid is required.');
  }

  if (serviceOrderPinId) {
    return `${serviceOrderPinId}:${payTxid}`;
  }

  if (!pair || !direction || !payerGlobalmetaid) {
    throw new Error('payTxid, pair, direction, and payerGlobalmetaid are required.');
  }

  return `${payTxid}:${pair}:${direction}:${payerGlobalmetaid}`;
}

function createInMemoryTerminalState() {
  return {
    terminalOutcomes: new Map(),
  };
}

async function recordTerminalOutcome(state, key, outcome) {
  if (!state?.terminalOutcomes) {
    throw new Error('terminal state is required.');
  }

  if (state.terminalOutcomes.has(key)) {
    return state.terminalOutcomes.get(key);
  }

  state.terminalOutcomes.set(key, outcome);
  return outcome;
}

async function getTerminalOutcome(state, key) {
  if (!state?.terminalOutcomes) {
    throw new Error('terminal state is required.');
  }

  return state.terminalOutcomes.get(key) || null;
}

function createLifecycleTrace() {
  const trace = {
    states: [],
    async mark(state) {
      if (!CANONICAL_LIFECYCLE_STATES.has(state)) {
        throw new Error(`invalid lifecycle state: ${state}`);
      }
      trace.states.push(state);
    },
  };

  return trace;
}

module.exports = {
  CANONICAL_LIFECYCLE_STATES,
  buildIdempotencyKey,
  createInMemoryTerminalState,
  recordTerminalOutcome,
  getTerminalOutcome,
  createLifecycleTrace,
};
