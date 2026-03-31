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

async function getAccountSummaryViaRpc({ env, fetchImpl, metabotId }) {
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/metabot/account-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metabot_id: Number(metabotId) }),
  });
  return readJson(response);
}

async function getAddressBalanceViaRpc({ env, fetchImpl, body }) {
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/address/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return readJson(response);
}

async function executeTransferViaRpc({ env, fetchImpl, body }) {
  const response = await fetchImpl(`${getRpcBase(env)}/api/idbots/wallet/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return readJson(response);
}

module.exports = {
  getRpcBase,
  readJson,
  getAccountSummaryViaRpc,
  getAddressBalanceViaRpc,
  executeTransferViaRpc,
};
