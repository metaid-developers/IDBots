'use strict';

const {
  normalizeTokenSymbol,
  normalizeNetwork,
  requireDecimalString,
  decimalToAtomic,
  atomicToDisplay,
  formatBtc,
  multiplyUnitPriceByQuantity,
  clipMiddle,
  sumDisplayValues,
  compareDecimalStrings,
} = require('./helpers.js');
const {
  getRecommendedFee,
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
} = require('./api.js');
const {
  resolveActiveMetabotId,
  getAccountSummary,
  signBtcMessage,
  signBtcPsbt,
} = require('./localRpc.js');
const {
  buildIdCoinMintCommitPsbt,
  getAddressOutputScriptHex,
  buildMrc20TransferCommitPsbt,
  buildMrc20TransferRevealPrePsbt,
  buildBuyTakePsbt,
  buildAskPsbt,
} = require('./btc.js');

function getOrderUnitPriceValue(order) {
  const raw = order?.tokenPriceRateStr ?? order?.tokenPriceRate ?? Number.POSITIVE_INFINITY;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

function getOrderAmountText(order, decimals) {
  return order?.amountStr || atomicToDisplay(order?.amount || 0, decimals);
}

function getOrderUnitPriceText(order) {
  return formatBtc(order?.tokenPriceRateStr ?? order?.tokenPriceRate ?? 0);
}

function sortOrdersByLowestUnitPrice(orders) {
  return [...orders].sort((left, right) => {
    const unitDelta = getOrderUnitPriceValue(left) - getOrderUnitPriceValue(right);
    if (unitDelta !== 0) return unitDelta;
    return Number(left.priceAmount || 0) - Number(right.priceAmount || 0);
  });
}

function buildTransferInputsFromRows(rows, { quantity, tickId, decimals }) {
  const selected = [];
  let totalAtomic = 0n;
  const targetAtomic = decimalToAtomic(quantity, decimals);

  for (const row of rows) {
    for (const entry of row.mrc20s || []) {
      if (tickId && String(entry.mrc20Id || '') !== tickId) continue;
      const amountText = String(entry.amount || '0');
      totalAtomic += decimalToAtomic(amountText, decimals);
      selected.push({
        utxoTxId: row.txId,
        utxoIndex: Number(row.outputIndex),
        utxoOutValue: Number(row.satoshi || row.satoshis || 546),
        tickerId: String(entry.mrc20Id || tickId || ''),
        amount: amountText,
        address: row.address,
        pkScript: row.scriptPk,
      });
      if (totalAtomic >= targetAtomic) {
        return selected;
      }
    }
  }

  return totalAtomic >= targetAtomic ? selected : null;
}

async function getAuthedAccountContext({ env, fetchImpl, request }) {
  const metabotId = await resolveActiveMetabotId({
    env,
    fetchImpl,
    metabotName: request.metabotName,
  });
  const account = await getAccountSummary({ env, fetchImpl, metabotId });
  const authPayload = await signBtcMessage({
    env,
    fetchImpl,
    metabotId,
    message: 'metaid.market',
  });
  return {
    metabotId,
    account,
    authHeaders: {
      'X-Public-Key': authPayload.public_key,
      'X-Signature': authPayload.signature,
    },
  };
}

async function executeSelfTransfer({
  request,
  env,
  fetchImpl,
  context,
  token,
  feeRate,
  transferInputs,
  quantity,
}) {
  const transferPrePayload = await transferMrc20Pre({
    network: request.network,
    fetchImpl,
    body: {
      networkFeeRate: feeRate,
      tickerId: token.mrc20Id,
      changeAddress: context.account.btc_address,
      changeOutValue: 546,
      transfers: transferInputs,
      mrc20Outs: [
        {
          amount: quantity,
          address: context.account.btc_address,
          outValue: 546,
          pkScript: getAddressOutputScriptHex(context.account.btc_address, request.network),
        },
      ],
    },
    headers: context.authHeaders,
  });

  const commitDraft = await buildMrc20TransferCommitPsbt({
    order: transferPrePayload.data,
    feeRate,
    address: context.account.btc_address,
    network: request.network,
    fetchImpl,
  });
  const signedCommit = await signBtcPsbt({
    env,
    fetchImpl,
    metabotId: context.metabotId,
    psbtHex: commitDraft.psbtHex,
    autoFinalized: true,
  });
  const revealDraft = buildMrc20TransferRevealPrePsbt({
    order: transferPrePayload.data,
    commitTxId: signedCommit.txid,
    network: request.network,
  });
  const signedReveal = await signBtcPsbt({
    env,
    fetchImpl,
    metabotId: context.metabotId,
    psbtHex: revealDraft.psbtHex,
    autoFinalized: false,
    toSignInputs: revealDraft.toSignInputs,
  });
  const transferCommitPayload = await transferMrc20Commit({
    network: request.network,
    fetchImpl,
    body: {
      orderId: transferPrePayload.data.orderId,
      commitTxRaw: signedCommit.raw_tx,
      commitTxOutIndex: 0,
      revealPrePsbtRaw: signedReveal.psbt_hex,
    },
    headers: context.authHeaders,
  });

  return {
    orderId: transferPrePayload.data.orderId,
    commitTxId: transferCommitPayload.data.commitTxId,
    revealTxId: transferCommitPayload.data.revealTxId,
  };
}

async function doOverview({ request, fetchImpl }) {
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
  });

  const lines = [
    `${token.tick} (${token.name})`,
    `类型: ${token.kind === 'idcoin' ? 'ID-Coin' : 'MRC-20'}`,
    `Tick ID: ${token.mrc20Id}`,
    `Decimals: ${token.decimals}`,
  ];

  if (token.kind === 'idcoin') {
    const info = token.raw;
    lines.push(`Mintable: ${info.mintable ? 'yes' : 'no'}`);
    lines.push(`Supply: ${info.supply}/${info.totalSupply}`);
    lines.push(`Followers: ${info.followersCount ?? 0}`);
    if (info.marketPrice != null) lines.push(`Market Price: ${formatBtc(info.marketPrice)}`);
    if (info.floorPrice != null) lines.push(`Floor: ${formatBtc(info.floorPrice)}`);
    if (info.ordersPrice != null) lines.push(`Orders Price: ${formatBtc(info.ordersPrice)}`);
    if (info.marketCap != null) lines.push(`Market Cap: ${formatBtc(info.marketCap)}`);
    if (info.totalVolume != null) lines.push(`Total Volume: ${formatBtc(info.totalVolume)}`);
  } else {
    const info = token.raw;
    lines.push(`Mintable: ${info.mintable ? 'yes' : 'no'}`);
    lines.push(`Supply: ${info.supply}/${info.totalSupply}`);
    lines.push(`Holders: ${info.holders ?? 0}`);
    if (info.price != null) lines.push(`Last Price: ${formatBtc(info.price)}`);
    if (info.floorPrice != null) lines.push(`Floor: ${formatBtc(info.floorPrice)}`);
    if (info.marketCap != null) lines.push(`Market Cap: ${formatBtc(info.marketCap)}`);
    if (info.totalVolume != null) lines.push(`Total Volume: ${formatBtc(info.totalVolume)}`);
  }

  return {
    mode: 'overview',
    message: lines.join('\n'),
    data: token,
  };
}

async function doOrders({ request, fetchImpl }) {
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
  });
  const payload = await getMrc20Orders({
    network: request.network,
    fetchImpl,
    params: {
      assetType: 'mrc20',
      orderState: 1,
      tickId: token.mrc20Id,
      sortKey: 'tokenPriceRate',
      sortType: 1,
      cursor: 0,
      size: request.limit,
    },
  });
  const list = payload?.data?.list || [];
  if (list.length === 0) {
    return {
      mode: 'orders',
      message: `${token.tick} 当前没有有效挂单。`,
      data: { token, orders: [] },
    };
  }

  const lines = [`${token.tick} 当前挂单（最多 ${request.limit} 条）:`];
  list.forEach((order, index) => {
    lines.push(
      `${index + 1}. amount=${getOrderAmountText(order, token.decimals)} | unit=${getOrderUnitPriceText(order)} | total=${formatBtc(order.priceAmount || 0)} | orderId=${clipMiddle(order.orderId)}`,
    );
  });
  return {
    mode: 'orders',
    message: lines.join('\n'),
    data: { token, orders: list },
  };
}

async function doTrades({ request, fetchImpl }) {
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
  });
  const payload = await getMrc20Orders({
    network: request.network,
    fetchImpl,
    params: {
      assetType: 'mrc20',
      orderState: 3,
      tickId: token.mrc20Id,
      sortKey: 'timestamp',
      sortType: -1,
      cursor: 0,
      size: request.limit,
    },
  });
  const list = payload?.data?.list || [];
  if (list.length === 0) {
    return {
      mode: 'trades',
      message: `${token.tick} 还没有可用的最新成交记录。`,
      data: { token, trades: [] },
    };
  }

  const lines = [`${token.tick} 最新成交（最多 ${request.limit} 条）:`];
  list.forEach((order, index) => {
    lines.push(
      `${index + 1}. amount=${getOrderAmountText(order, token.decimals)} | unit=${getOrderUnitPriceText(order)} | total=${formatBtc(order.priceAmount || 0)} | txid=${clipMiddle(order.txId || order.orderId)}`,
    );
  });
  return {
    mode: 'trades',
    message: lines.join('\n'),
    data: { token, trades: list },
  };
}

async function doWallet({ request, env, fetchImpl }) {
  const context = await getAuthedAccountContext({ env, fetchImpl, request });
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
    address: context.account.btc_address,
  });
  const balancePayload = await getUserMrc20List({
    network: request.network,
    fetchImpl,
    params: {
      address: context.account.btc_address,
      cursor: 0,
      size: 100,
    },
  });
  const row = (balancePayload?.data?.list || []).find((item) => String(item.mrc20Id || '') === token.mrc20Id);
  const utxoPayload = await getMrc20AddressUtxo({
    network: request.network,
    fetchImpl,
    params: {
      address: context.account.btc_address,
      tickId: token.mrc20Id,
      cursor: 0,
      size: 200,
    },
    headers: context.authHeaders,
  });
  const utxos = utxoPayload?.data?.list || [];
  const available = sumDisplayValues(
    utxos.flatMap((item) => (item.orderId === '' && item.blockHeight !== -1 ? item.mrc20s.map((entry) => entry.amount) : [])),
    token.decimals,
  );
  const unconfirmed = sumDisplayValues(
    utxos.flatMap((item) => (item.orderId === '' && item.blockHeight === -1 ? item.mrc20s.map((entry) => entry.amount) : [])),
    token.decimals,
  );
  const listed = sumDisplayValues(
    utxos.flatMap((item) => (item.orderId !== '' ? item.mrc20s.map((entry) => entry.amount) : [])),
    token.decimals,
  );

  return {
    mode: 'wallet',
    message: [
      `${token.tick} 钱包持仓`,
      `地址: ${context.account.btc_address}`,
      `总余额: ${row?.balance || '0'}`,
      `可用: ${atomicToDisplay(available, token.decimals)}`,
      `未确认: ${atomicToDisplay(unconfirmed, token.decimals)}`,
      `已挂单: ${atomicToDisplay(listed, token.decimals)}`,
    ].join('\n'),
    data: {
      token,
      address: context.account.btc_address,
      totalBalance: row?.balance || '0',
      available: atomicToDisplay(available, token.decimals),
      unconfirmed: atomicToDisplay(unconfirmed, token.decimals),
      listed: atomicToDisplay(listed, token.decimals),
    },
  };
}

async function doBuyLowest({ request, env, fetchImpl }) {
  const context = await getAuthedAccountContext({ env, fetchImpl, request });
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
    address: context.account.btc_address,
  });
  const payload = await getMrc20Orders({
    network: request.network,
    fetchImpl,
    params: {
      assetType: 'mrc20',
      orderState: 1,
      tickId: token.mrc20Id,
      sortKey: 'tokenPriceRate',
      sortType: 1,
      cursor: 0,
      size: 50,
    },
  });
  const orders = sortOrdersByLowestUnitPrice(payload?.data?.list || []);
  if (orders.length === 0) {
    throw new Error(`${token.tick} 当前没有可买的挂单。`);
  }

  const desiredQuantity = request.quantity ? requireDecimalString(request.quantity, 'quantity') : '';
  const selectedOrder = desiredQuantity
    ? orders.find((order) => compareDecimalStrings(String(order.amountStr || order.amount || ''), desiredQuantity, token.decimals))
    : orders[0];
  if (!selectedOrder) {
    throw new Error(`${token.tick} 当前没有数量恰好为 ${desiredQuantity} 的整笔挂单。metaid.market 目前不支持对单笔挂单做部分成交拆分。`);
  }

  const feeRate = request.networkFeeRate || await getRecommendedFee(request.network, fetchImpl);
  const psbtPayload = await getMrc20OrderPsbt({
    network: request.network,
    fetchImpl,
    params: {
      orderId: selectedOrder.orderId,
      buyerAddress: context.account.btc_address,
    },
    headers: context.authHeaders,
  });
  const orderWithPsbt = psbtPayload.data;
  const draft = await buildBuyTakePsbt({
    order: orderWithPsbt,
    feeRate,
    address: context.account.btc_address,
    network: request.network,
    fetchImpl,
  });
  const signed = await signBtcPsbt({
    env,
    fetchImpl,
    metabotId: context.metabotId,
    psbtHex: draft.psbtHex,
    autoFinalized: false,
    toSignInputs: draft.toSignInputs,
  });
  const takePayload = await buyMrc20OrderTake({
    network: request.network,
    fetchImpl,
    body: {
      orderId: selectedOrder.orderId,
      takerPsbtRaw: signed.psbt_hex,
      networkFeeRate: feeRate,
    },
    headers: context.authHeaders,
  });

  return {
    mode: 'bought',
    message: [
      `已提交 ${token.tick} 买单。`,
      `数量: ${getOrderAmountText(selectedOrder, token.decimals)}`,
      `单价: ${getOrderUnitPriceText(selectedOrder)}`,
      `总价: ${formatBtc(selectedOrder.priceAmount || 0)}`,
      `订单: ${selectedOrder.orderId}`,
      `TxID: ${takePayload.data.txId}`,
    ].join('\n'),
    data: {
      token,
      order: selectedOrder,
      txId: takePayload.data.txId,
      feeRate,
    },
  };
}

async function doMint({ request, env, fetchImpl }) {
  const context = await getAuthedAccountContext({ env, fetchImpl, request });
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
    address: context.account.btc_address,
  });
  if (token.kind !== 'idcoin') {
    throw new Error(`${token.tick} 不是 ID-Coin，当前 mint 流程只支持 metaid.market 的 ID-Coin。`);
  }
  if (!token.raw.mintable) {
    throw new Error(`${token.tick} 当前不可 mint。`);
  }

  const mintStatePayload = await getIdCoinMintOrder({
    network: request.network,
    fetchImpl,
    params: {
      tickId: token.mrc20Id,
      address: context.account.btc_address,
    },
    headers: context.authHeaders,
  });
  if (Number(mintStatePayload?.data?.addressMintState || 0) === 1) {
    throw new Error(`${token.tick} 这个地址已经 mint 过了。`);
  }

  const feeRate = request.networkFeeRate || await getRecommendedFee(request.network, fetchImpl);
  const prePayload = await mintIdCoinPre({
    network: request.network,
    fetchImpl,
    body: {
      networkFeeRate: feeRate,
      tickId: token.mrc20Id,
      outAddress: context.account.btc_address,
      outValue: 546,
    },
    headers: context.authHeaders,
  });
  const draft = await buildIdCoinMintCommitPsbt({
    order: prePayload.data,
    feeRate,
    address: context.account.btc_address,
    network: request.network,
    fetchImpl,
  });
  const signedCommit = await signBtcPsbt({
    env,
    fetchImpl,
    metabotId: context.metabotId,
    psbtHex: draft.psbtHex,
    autoFinalized: true,
  });
  const commitPayload = await mintIdCoinCommit({
    network: request.network,
    fetchImpl,
    body: {
      orderId: prePayload.data.orderId,
      commitTxRaw: signedCommit.raw_tx,
      commitTxOutInscribeIndex: 0,
      commitTxOutMintIndex: 1,
    },
    headers: context.authHeaders,
  });

  return {
    mode: 'minted',
    message: [
      `已提交 ${token.tick} mint。`,
      `Commit TxID: ${commitPayload.data.commitTxId}`,
      `Reveal Mint TxID: ${commitPayload.data.revealMintTxId}`,
      `Reveal Inscribe TxID: ${commitPayload.data.revealInscribeTxId}`,
    ].join('\n'),
    data: {
      token,
      orderId: prePayload.data.orderId,
      commit: commitPayload.data,
      feeRate,
    },
  };
}

async function doList({ request, env, fetchImpl }) {
  const context = await getAuthedAccountContext({ env, fetchImpl, request });
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
    address: context.account.btc_address,
  });
  const quantity = requireDecimalString(request.quantity, 'quantity');
  const unitPriceBtc = requireDecimalString(request.unitPriceBtc, 'unit price');
  const feeRate = request.networkFeeRate || await getRecommendedFee(request.network, fetchImpl);
  const utxoPayload = await getMrc20AddressUtxo({
    network: request.network,
    fetchImpl,
    params: {
      address: context.account.btc_address,
      tickId: token.mrc20Id,
      cursor: 0,
      size: 200,
    },
    headers: context.authHeaders,
  });
  const rows = utxoPayload?.data?.list || [];

  let orderUtxo = null;
  let splitResult = null;
  for (const row of rows) {
    if (row.orderId !== '' || row.blockHeight === -1) continue;
    const exact = (row.mrc20s || []).find((entry) => compareDecimalStrings(String(entry.amount || '0'), quantity, token.decimals));
    if (!exact) continue;
    orderUtxo = {
      txId: String(exact.txPoint || '').split(':')[0],
      outputIndex: Number(String(exact.txPoint || '').split(':')[1]),
      vout: Number(String(exact.txPoint || '').split(':')[1]),
      satoshis: 546,
      satoshi: 546,
    };
    break;
  }

  if (!orderUtxo) {
    const transferInputs = buildTransferInputsFromRows(
      rows.filter((row) => row.orderId === '' && row.blockHeight !== -1),
      { quantity, tickId: token.mrc20Id, decimals: token.decimals },
    );
    if (!transferInputs || transferInputs.length === 0) {
      throw new Error(`可用的 ${token.tick} UTXO 不足，无法拆分出 ${quantity} 份用于挂单。`);
    }
    splitResult = await executeSelfTransfer({
      request,
      env,
      fetchImpl,
      context,
      token,
      feeRate,
      transferInputs,
      quantity,
    });
    orderUtxo = {
      txId: splitResult.revealTxId,
      outputIndex: 1,
      vout: 1,
      satoshis: 546,
      satoshi: 546,
    };
  }

  const totalPriceSats = multiplyUnitPriceByQuantity(unitPriceBtc, quantity, token.decimals);
  const askDraft = await buildAskPsbt({
    utxo: orderUtxo,
    totalPriceSats,
    address: context.account.btc_address,
    network: request.network,
    fetchImpl,
  });
  const signedAsk = await signBtcPsbt({
    env,
    fetchImpl,
    metabotId: context.metabotId,
    psbtHex: askDraft.psbtHex,
    autoFinalized: true,
  });
  const pushPayload = await sellMrc20Order({
    network: request.network,
    fetchImpl,
    body: {
      assetType: 'mrc20',
      tickId: token.mrc20Id,
      address: context.account.btc_address,
      psbtRaw: signedAsk.psbt_hex,
      ...(splitResult
        ? {
            askType: 1,
            coinAmountStr: quantity,
            utxoOutValue: 546,
          }
        : {}),
    },
    headers: context.authHeaders,
  });

  return {
    mode: 'listed',
    message: [
      `已挂单 ${token.tick}。`,
      `数量: ${quantity}`,
      `单价: ${unitPriceBtc} BTC`,
      `总价: ${formatBtc(totalPriceSats)}`,
      `订单: ${pushPayload.data.orderId}`,
      splitResult ? `挂单前已先做自转拆分。Commit TxID: ${splitResult.commitTxId} | Reveal TxID: ${splitResult.revealTxId}` : '直接使用现有 UTXO 挂单。',
    ].join('\n'),
    data: {
      token,
      quantity,
      unitPriceBtc,
      totalPriceSats: totalPriceSats.toString(),
      orderId: pushPayload.data.orderId,
      splitResult,
      feeRate,
    },
  };
}

async function doMyOrders({ request, env, fetchImpl }) {
  const context = await getAuthedAccountContext({ env, fetchImpl, request });
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
    address: context.account.btc_address,
  });
  const payload = await getMrc20Orders({
    network: request.network,
    fetchImpl,
    params: {
      assetType: 'mrc20',
      orderState: 1,
      tickId: token.mrc20Id,
      address: context.account.btc_address,
      sortKey: 'tokenPriceRate',
      sortType: 1,
      cursor: 0,
      size: request.limit,
    },
  });
  const list = payload?.data?.list || [];
  if (list.length === 0) {
    return {
      mode: 'my-orders',
      message: `你当前没有 ${token.tick} 的有效挂单。`,
      data: { token, orders: [] },
    };
  }

  const lines = [`你当前的 ${token.tick} 挂单（最多 ${request.limit} 条）:`];
  list.forEach((order, index) => {
    lines.push(
      `${index + 1}. amount=${getOrderAmountText(order, token.decimals)} | unit=${getOrderUnitPriceText(order)} | total=${formatBtc(order.priceAmount || 0)} | orderId=${order.orderId}`,
    );
  });
  return {
    mode: 'my-orders',
    message: lines.join('\n'),
    data: { token, orders: list, address: context.account.btc_address },
  };
}

async function doMyTrades({ request, env, fetchImpl }) {
  const context = await getAuthedAccountContext({ env, fetchImpl, request });
  const token = await resolveToken({
    network: request.network,
    fetchImpl,
    tick: request.tokenSymbol,
    address: context.account.btc_address,
  });
  const payload = await getMrc20Orders({
    network: request.network,
    fetchImpl,
    params: {
      assetType: 'mrc20',
      orderState: 3,
      tickId: token.mrc20Id,
      address: context.account.btc_address,
      sortKey: 'timestamp',
      sortType: -1,
      cursor: 0,
      size: request.limit,
    },
  });
  const list = payload?.data?.list || [];
  if (list.length === 0) {
    return {
      mode: 'my-trades',
      message: `你当前还没有 ${token.tick} 的成交历史。`,
      data: { token, trades: [] },
    };
  }

  const lines = [`你的 ${token.tick} 成交历史（最多 ${request.limit} 条）:`];
  list.forEach((order, index) => {
    const side = order.buyerAddress === context.account.btc_address ? 'buy' : 'sell';
    lines.push(
      `${index + 1}. side=${side} | amount=${getOrderAmountText(order, token.decimals)} | unit=${getOrderUnitPriceText(order)} | total=${formatBtc(order.priceAmount || 0)} | txid=${clipMiddle(order.txId || order.orderId)}`,
    );
  });
  return {
    mode: 'my-trades',
    message: lines.join('\n'),
    data: { token, trades: list, address: context.account.btc_address },
  };
}

async function doCancel({ request, env, fetchImpl }) {
  const context = await getAuthedAccountContext({ env, fetchImpl, request });
  const feeRate = request.networkFeeRate || await getRecommendedFee(request.network, fetchImpl);
  const orderDetailPayload = await getMrc20OrderDetail({
    network: request.network,
    fetchImpl,
    params: {
      orderId: request.orderId,
    },
    headers: context.authHeaders,
  });
  const orderDetail = orderDetailPayload.data;
  const payload = await cancelMrc20Order({
    network: request.network,
    fetchImpl,
    body: {
      orderId: request.orderId,
    },
    headers: context.authHeaders,
  });

  const utxoPayload = await getMrc20AddressUtxo({
    network: request.network,
    fetchImpl,
    params: {
      address: context.account.btc_address,
      tickId: orderDetail.tickId,
      cursor: 0,
      size: 200,
    },
    headers: context.authHeaders,
  });
  const lockedRows = (utxoPayload?.data?.list || []).filter((row) => row.orderId === request.orderId);

  let unlockResult = null;
  if (lockedRows.length > 0) {
    const transferInputs = buildTransferInputsFromRows(lockedRows, {
      quantity: String(orderDetail.amountStr || orderDetail.amount || '0'),
      tickId: orderDetail.tickId,
      decimals: Number(orderDetail.decimals || 0),
    });
    if (!transferInputs || transferInputs.length === 0) {
      throw new Error(`挂单 ${request.orderId} 已取消，但未找到可用于解锁的 ${orderDetail.tick} UTXO。`);
    }
    unlockResult = await executeSelfTransfer({
      request,
      env,
      fetchImpl,
      context,
      token: {
        tick: orderDetail.tick,
        mrc20Id: orderDetail.tickId,
      },
      feeRate,
      transferInputs,
      quantity: String(orderDetail.amountStr || orderDetail.amount || '0'),
    });
  }

  return {
    mode: 'cancelled',
    message: [
      `已取消挂单。`,
      `订单: ${payload.data.orderId}`,
      `状态: ${payload.data.orderState}`,
      unlockResult ? `已将挂单中的 ${orderDetail.tick} 解锁回钱包。Commit TxID: ${unlockResult.commitTxId} | Reveal TxID: ${unlockResult.revealTxId}` : '未检测到额外的解锁转出步骤。',
    ].join('\n'),
    data: {
      ...payload.data,
      unlock: unlockResult,
      order: orderDetail,
      feeRate,
    },
  };
}

async function handleTradeRequest({ request, env, fetchImpl }) {
  const normalizedRequest = {
    ...request,
    network: normalizeNetwork(request.network),
    tokenSymbol: normalizeTokenSymbol(request.tokenSymbol),
  };

  switch (normalizedRequest.action) {
    case 'overview':
      return doOverview({ request: normalizedRequest, fetchImpl });
    case 'orders':
      return doOrders({ request: normalizedRequest, fetchImpl });
    case 'trades':
      return doTrades({ request: normalizedRequest, fetchImpl });
    case 'wallet':
      return doWallet({ request: normalizedRequest, env, fetchImpl });
    case 'my-orders':
      return doMyOrders({ request: normalizedRequest, env, fetchImpl });
    case 'my-trades':
      return doMyTrades({ request: normalizedRequest, env, fetchImpl });
    case 'buy-lowest':
      return doBuyLowest({ request: normalizedRequest, env, fetchImpl });
    case 'mint':
      return doMint({ request: normalizedRequest, env, fetchImpl });
    case 'list':
      return doList({ request: normalizedRequest, env, fetchImpl });
    case 'cancel':
      return doCancel({ request: normalizedRequest, env, fetchImpl });
    default:
      return {
        mode: 'unsupported',
        message: `Unsupported action: ${normalizedRequest.action}`,
      };
  }
}

module.exports = {
  handleTradeRequest,
};
