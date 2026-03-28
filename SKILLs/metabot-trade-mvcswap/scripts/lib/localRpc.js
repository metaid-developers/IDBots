'use strict';

function getRpcBase(env) {
  return String(env?.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
}

async function readJson(response) {
  const json = await response.json();
  if (!response.ok) {
    throw new Error(typeof json?.error === 'string' ? json.error : `HTTP ${response.status}`);
  }
  if (json && json.success === false) {
    throw new Error(typeof json.error === 'string' ? json.error : 'Local RPC request failed');
  }
  return json;
}

async function getFeeRateSummary({ env, fetchImpl }) {
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/fee-rate-summary?chain=mvc`);
  return readJson(response);
}

async function getAccountSummary({ env, fetchImpl, metabotId }) {
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/metabot/account-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metabot_id: Number(metabotId) }),
  });
  return readJson(response);
}

async function getAddressBalance({ env, fetchImpl, metabotId, addresses }) {
  const payload = {};
  if (metabotId != null) {
    payload.metabot_id = Number(metabotId);
  }
  if (addresses && typeof addresses === 'object') {
    payload.addresses = addresses;
  }
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/address/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson(response);
}

async function buildMvcTransferRawTx({ env, fetchImpl, body }) {
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/wallet/mvc/build-transfer-rawtx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

async function buildMvcFtTransferRawTx({ env, fetchImpl, body }) {
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/wallet/mvc-ft/build-transfer-rawtx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

async function buildMvcRawTxBundle({ env, fetchImpl, body }) {
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/wallet/mvc/build-rawtx-bundle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

module.exports = {
  getFeeRateSummary,
  getAccountSummary,
  getAddressBalance,
  buildMvcTransferRawTx,
  buildMvcFtTransferRawTx,
  buildMvcRawTxBundle,
};
