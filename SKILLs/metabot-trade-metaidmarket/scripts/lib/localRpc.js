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

async function postJson({ env, fetchImpl, path, body }) {
  const response = await fetchImpl(`${getRpcBase(env)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return readJson(response);
}

function parsePositiveInteger(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(text)) return null;
  const num = Number(text);
  return Number.isInteger(num) && num > 0 ? num : null;
}

async function resolveMetabotIdByName({ env, fetchImpl, name }) {
  const payload = await postJson({
    env,
    fetchImpl,
    path: '/api/idbots/resolve-metabot-id',
    body: { name: String(name || '').trim() },
  });
  return {
    metabot_id: Number(payload.metabot_id),
    display_name: String(payload.display_name || ''),
  };
}

async function resolveActiveMetabotId({ env, fetchImpl, metabotName }) {
  const envMetabotId = parsePositiveInteger(env?.IDBOTS_METABOT_ID);
  if (envMetabotId != null) return envMetabotId;
  const normalizedName = String(metabotName || '').trim();
  if (!normalizedName) {
    throw new Error('MetaBot identity is unavailable. Run inside IDBots Cowork or pass --metabot-name "<current MetaBot name>".');
  }
  const resolved = await resolveMetabotIdByName({ env, fetchImpl, name: normalizedName });
  const metabotId = parsePositiveInteger(resolved.metabot_id);
  if (metabotId == null) {
    throw new Error(`Unable to resolve MetaBot id for "${normalizedName}".`);
  }
  return metabotId;
}

async function getAccountSummary({ env, fetchImpl, metabotId }) {
  return postJson({
    env,
    fetchImpl,
    path: '/api/idbots/metabot/account-summary',
    body: { metabot_id: Number(metabotId) },
  });
}

async function signBtcMessage({ env, fetchImpl, metabotId, message }) {
  return postJson({
    env,
    fetchImpl,
    path: '/api/idbots/wallet/btc/sign-message',
    body: { metabot_id: Number(metabotId), message: String(message || '') },
  });
}

async function signBtcPsbt({ env, fetchImpl, metabotId, psbtHex, autoFinalized, toSignInputs }) {
  return postJson({
    env,
    fetchImpl,
    path: '/api/idbots/wallet/btc/sign-psbt',
    body: {
      metabot_id: Number(metabotId),
      psbt_hex: String(psbtHex || ''),
      auto_finalized: autoFinalized !== false,
      ...(Array.isArray(toSignInputs) && toSignInputs.length > 0
        ? {
            to_sign_inputs: toSignInputs.map((item) => ({
              index: Number(item.index),
              sighash_types: Array.isArray(item.sighashTypes) ? item.sighashTypes.map((value) => Number(value)) : [],
            })),
          }
        : {}),
    },
  });
}

async function executeMrc20Transfer({ env, fetchImpl, body }) {
  return postJson({
    env,
    fetchImpl,
    path: '/api/idbots/wallet/mrc20/transfer',
    body,
  });
}

module.exports = {
  resolveActiveMetabotId,
  resolveMetabotIdByName,
  getAccountSummary,
  signBtcMessage,
  signBtcPsbt,
  executeMrc20Transfer,
};
