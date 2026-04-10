'use strict';

const { normalizeNetwork, normalizeTokenSymbol } = require('./helpers.js');

function getHost(network) {
  return normalizeNetwork(network) === 'testnet'
    ? 'https://api.metaid.market/api-market-testnet'
    : 'https://api.metaid.market/api-market';
}

async function readApiJson(response) {
  const json = await response.json();
  if (!response.ok) {
    throw new Error(typeof json?.message === 'string' ? json.message : `HTTP ${response.status}`);
  }
  if (json && typeof json.code === 'number' && json.code !== 0) {
    throw new Error(typeof json.message === 'string' ? json.message : 'Market API request failed');
  }
  return json;
}

async function apiGet({ network, fetchImpl, path, params, headers }) {
  const url = new URL(`${getHost(network)}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value == null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: headers || {},
  });
  return readApiJson(response);
}

async function apiPost({ network, fetchImpl, path, body, headers }) {
  const response = await fetchImpl(`${getHost(network)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers || {}),
    },
    body: JSON.stringify(body || {}),
  });
  return readApiJson(response);
}

async function getRecommendedFee(network, fetchImpl) {
  const payload = await apiGet({
    network,
    fetchImpl,
    path: '/api/v1/common/fee/recommended',
  });
  const data = payload?.data || {};
  return Number(data.halfHourFee || data.hourFee || data.fastestFee || data.minimumFee || 1) || 1;
}

async function getMrc20Info({ network, fetchImpl, tick, tickId }) {
  return apiGet({
    network,
    fetchImpl,
    path: '/api/v1/common/mrc20/tick/info',
    params: {
      ...(tick ? { tick: normalizeTokenSymbol(tick) } : {}),
      ...(tickId ? { tickId } : {}),
    },
  });
}

async function getIdCoinInfo({ network, fetchImpl, tick, tickId, address }) {
  return apiGet({
    network,
    fetchImpl,
    path: '/api/v1/id-coins/coins-info',
    params: {
      ...(tick ? { tick: normalizeTokenSymbol(tick) } : {}),
      ...(tickId ? { tickId } : {}),
      ...(address ? { address } : {}),
    },
  });
}

async function getMrc20Orders({ network, fetchImpl, params, headers }) {
  return apiGet({
    network,
    fetchImpl,
    path: '/api/v1/market/mrc20/orders',
    params,
    headers,
  });
}

async function getMrc20OrderPsbt({ network, fetchImpl, params, headers }) {
  return apiGet({
    network,
    fetchImpl,
    path: '/api/v1/market/mrc20/order/psbt',
    params,
    headers,
  });
}

async function getMrc20OrderDetail({ network, fetchImpl, params, headers }) {
  return apiGet({
    network,
    fetchImpl,
    path: '/api/v1/market/mrc20/order/detail',
    params,
    headers,
  });
}

async function buyMrc20OrderTake({ network, fetchImpl, body, headers }) {
  return apiPost({
    network,
    fetchImpl,
    path: '/api/v1/market/mrc20/order/take',
    body,
    headers,
  });
}

async function sellMrc20Order({ network, fetchImpl, body, headers }) {
  return apiPost({
    network,
    fetchImpl,
    path: '/api/v1/market/mrc20/order/push',
    body,
    headers,
  });
}

async function transferMrc20Pre({ network, fetchImpl, body, headers }) {
  return apiPost({
    network,
    fetchImpl,
    path: '/api/v1/inscribe/mrc20/transfer/pre',
    body,
    headers,
  });
}

async function transferMrc20Commit({ network, fetchImpl, body, headers }) {
  return apiPost({
    network,
    fetchImpl,
    path: '/api/v1/inscribe/mrc20/transfer/commit',
    body,
    headers,
  });
}

async function cancelMrc20Order({ network, fetchImpl, body, headers }) {
  return apiPost({
    network,
    fetchImpl,
    path: '/api/v1/market/mrc20/order/cancel',
    body,
    headers,
  });
}

async function mintIdCoinPre({ network, fetchImpl, body, headers }) {
  return apiPost({
    network,
    fetchImpl,
    path: '/api/v1/id-coins/mint/pre',
    body,
    headers,
  });
}

async function mintIdCoinCommit({ network, fetchImpl, body, headers }) {
  return apiPost({
    network,
    fetchImpl,
    path: '/api/v1/id-coins/mint/commit',
    body,
    headers,
  });
}

async function getIdCoinMintOrder({ network, fetchImpl, params, headers }) {
  return apiGet({
    network,
    fetchImpl,
    path: '/api/v1/id-coins/address/mint/order',
    params,
    headers,
  });
}

async function getUserMrc20List({ network, fetchImpl, params }) {
  return apiGet({
    network,
    fetchImpl,
    path: '/api/v1/common/mrc20/address/balance-list',
    params,
  });
}

async function getMrc20AddressUtxo({ network, fetchImpl, params, headers }) {
  return apiGet({
    network,
    fetchImpl,
    path: '/api/v1/common/mrc20/address/utxo',
    params,
    headers,
  });
}

async function resolveToken({ network, fetchImpl, tick, address }) {
  const normalizedTick = normalizeTokenSymbol(tick);
  try {
    const idCoinPayload = await getIdCoinInfo({ network, fetchImpl, tick: normalizedTick, address });
    if (idCoinPayload?.data?.mrc20Id) {
      const data = idCoinPayload.data;
      return {
        kind: 'idcoin',
        tick: String(data.tick || normalizedTick).toUpperCase(),
        name: String(data.tokenName || data.tick || normalizedTick),
        mrc20Id: String(data.mrc20Id || ''),
        decimals: Number(data.decimals || 8),
        mintable: Boolean(data.mintable),
        followersCount: Number(data.followersCount || 0),
        raw: data,
      };
    }
  } catch {
    // Fall through to generic MRC20 lookup.
  }

  const mrc20Payload = await getMrc20Info({ network, fetchImpl, tick: normalizedTick });
  if (!mrc20Payload?.data?.mrc20Id) {
    throw new Error(`Token ${normalizedTick} was not found on metaid.market.`);
  }
  const data = mrc20Payload.data;
  return {
    kind: 'mrc20',
    tick: String(data.tick || normalizedTick).toUpperCase(),
    name: String(data.tokenName || data.tick || normalizedTick),
    mrc20Id: String(data.mrc20Id || ''),
    decimals: Number(data.decimals || 8),
    mintable: Boolean(data.mintable),
    raw: data,
  };
}

module.exports = {
  getHost,
  getRecommendedFee,
  getMrc20Info,
  getIdCoinInfo,
  getMrc20Orders,
  getMrc20OrderPsbt,
  getMrc20OrderDetail,
  buyMrc20OrderTake,
  sellMrc20Order,
  transferMrc20Pre,
  transferMrc20Commit,
  cancelMrc20Order,
  mintIdCoinPre,
  mintIdCoinCommit,
  getIdCoinMintOrder,
  getUserMrc20List,
  getMrc20AddressUtxo,
  resolveToken,
};
