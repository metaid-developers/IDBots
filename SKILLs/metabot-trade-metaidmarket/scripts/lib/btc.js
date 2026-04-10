'use strict';

const {
  Psbt,
  Transaction,
  address: addressLib,
  networks,
} = require('bitcoinjs-lib');

const {
  formatBtc,
} = require('./helpers.js');

const SIGHASH_SINGLE_ANYONECANPAY = 0x83;
const SIGHASH_ALL = 0x01;
const DUST_UTXO_VALUE = 546;
const TX_EMPTY_SIZE = 4 + 1 + 1 + 4;
const TX_INPUT_BASE = 32 + 4 + 1 + 4;
const TX_INPUT_PUBKEYHASH = 107;
const TX_INPUT_SEGWIT = 27;
const TX_OUTPUT_BASE = 8 + 1;
const TX_OUTPUT_PUBKEYHASH = 25;
const TX_OUTPUT_SEGWIT = 22;
const TX_OUTPUT_SEGWIT_SCRIPTHASH = 34;

function determineAddressInfo(address) {
  if (String(address || '').startsWith('bc1q') || String(address || '').startsWith('tb1q')) return 'P2WPKH';
  if (String(address || '').startsWith('1') || String(address || '').startsWith('m') || String(address || '').startsWith('n')) return 'P2PKH';
  throw new Error(`Unsupported BTC address type for ${address}`);
}

function getNetworks(network) {
  return String(network || '').toLowerCase() === 'testnet' ? networks.testnet : networks.bitcoin;
}

function getMetaletNetwork(network) {
  return String(network || '').toLowerCase() === 'testnet' ? 'testnet' : 'livenet';
}

function getAddressOutputScriptHex(address, network) {
  return addressLib.toOutputScript(address, getNetworks(network)).toString('hex');
}

async function fetchRemoteJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(typeof json?.message === 'string' ? json.message : `HTTP ${response.status}`);
  }
  if (json && typeof json.code === 'number' && json.code !== 0) {
    throw new Error(typeof json.message === 'string' ? json.message : 'Wallet API request failed');
  }
  return json.data ?? json;
}

async function fetchBtcUtxos({ address, network, fetchImpl }) {
  const url = `https://www.metalet.space/wallet-api/v3/address/btc-utxo?net=${getMetaletNetwork(network)}&address=${encodeURIComponent(address)}&unconfirmed=1`;
  const list = await fetchRemoteJson(url, fetchImpl);
  return (Array.isArray(list) ? list : []).map((item) => ({
    txId: item.txId,
    vout: Number(item.outputIndex ?? item.vout ?? 0),
    outputIndex: Number(item.outputIndex ?? item.vout ?? 0),
    satoshi: Number(item.satoshis ?? item.satoshi ?? 0),
    satoshis: Number(item.satoshis ?? item.satoshi ?? 0),
    confirmed: item.confirmed !== false,
  }));
}

async function fetchBtcRawTx({ txId, network, fetchImpl }) {
  const url = `https://www.metalet.space/wallet-api/v3/tx/raw?net=${getMetaletNetwork(network)}&txId=${encodeURIComponent(txId)}&chain=btc`;
  const payload = await fetchRemoteJson(url, fetchImpl);
  return String(payload.rawTx || payload.hex || '');
}

function selectUTXOs(utxos, targetAmountSats) {
  let total = 0;
  const selected = [];
  for (const utxo of utxos) {
    selected.push(utxo);
    total += Number(utxo.satoshis || 0);
    if (total >= targetAmountSats) break;
  }
  if (total < targetAmountSats) {
    throw new Error(`Insufficient BTC balance. Need ${formatBtc(targetAmountSats)} to continue.`);
  }
  return selected;
}

function getTotalSats(utxos) {
  return utxos.reduce((total, utxo) => total + Number(utxo.satoshis || 0), 0);
}

function inputBytes(input, addressType) {
  if (addressType === 'P2PKH') return TX_INPUT_BASE + TX_INPUT_PUBKEYHASH;
  return TX_INPUT_BASE + TX_INPUT_SEGWIT;
}

function outputBytes(output) {
  const address = String(output.address || '');
  if (output.script) return TX_OUTPUT_BASE + output.script.length;
  if (address.startsWith('bc1') || address.startsWith('tb1')) {
    return TX_OUTPUT_BASE + (address.length === 42 ? TX_OUTPUT_SEGWIT : TX_OUTPUT_SEGWIT_SCRIPTHASH);
  }
  return TX_OUTPUT_BASE + TX_OUTPUT_PUBKEYHASH;
}

function calcFee({ inputCount, outputCount, addressType, changeAddress }) {
  const inputsSize = new Array(inputCount).fill(0).reduce((total) => total + inputBytes({}, addressType), 0);
  const outputsSize = new Array(outputCount).fill(0).reduce((total) => total + outputBytes({ address: changeAddress }), 0);
  return TX_EMPTY_SIZE + inputsSize + outputsSize;
}

async function createPsbtInput({ utxo, addressType, script, network, fetchImpl }) {
  if (addressType === 'P2PKH') {
    const rawTx = await fetchBtcRawTx({ txId: utxo.txId, network, fetchImpl });
    if (!rawTx) throw new Error(`Unable to fetch raw tx for ${utxo.txId}`);
    return {
      hash: utxo.txId,
      index: utxo.outputIndex,
      nonWitnessUtxo: Transaction.fromHex(rawTx).toBuffer(),
      sequence: 0xffffffff,
    };
  }

  if (addressType === 'P2WPKH') {
    return {
      hash: utxo.txId,
      index: utxo.outputIndex,
      witnessUtxo: {
        value: Number(utxo.satoshis || utxo.satoshi || 0),
        script,
      },
      sequence: 0xffffffff,
    };
  }

  throw new Error(`Unsupported BTC address type: ${addressType}`);
}

async function buildTx({
  utxos,
  amountSats,
  feeRate,
  address,
  network,
  fetchImpl,
  builder,
}) {
  const addressType = determineAddressInfo(address);
  const script = addressLib.toOutputScript(address, getNetworks(network));
  const sorted = [...utxos].filter((utxo) => Number(utxo.satoshis || 0) >= DUST_UTXO_VALUE).sort((left, right) => Number(right.satoshis || 0) - Number(left.satoshis || 0));
  let selected = selectUTXOs(sorted, amountSats);
  let total = getTotalSats(selected);

  while (true) {
    const draft = await builder({
      selectedUtxos: selected,
      changeSats: total - amountSats,
      includeChange: true,
      addressType,
      script,
      network,
      fetchImpl,
    });
    const feeSats = Math.ceil(calcFee({
      inputCount: draft.inputCount,
      outputCount: draft.outputCount + 1,
      addressType,
      changeAddress: address,
    }) * feeRate);
    if (total >= amountSats + feeSats) {
      const finalDraft = await builder({
        selectedUtxos: selected,
        changeSats: total - amountSats - feeSats,
        includeChange: total - amountSats - feeSats >= DUST_UTXO_VALUE,
        addressType,
        script,
        network,
        fetchImpl,
      });
      return {
        psbtHex: finalDraft.psbt.toHex(),
        feeSats,
        toSignInputs: finalDraft.toSignInputs || [],
      };
    }
    selected = selectUTXOs(sorted, amountSats + feeSats);
    total = getTotalSats(selected);
  }
}

async function buildIdCoinMintCommitPsbt({ order, feeRate, address, network, fetchImpl }) {
  const utxos = await fetchBtcUtxos({ address, network, fetchImpl });
  const amountSats = Number(order.revealInscribeFee || 0) + Number(order.revealMintFee || 0);
  return buildTx({
    utxos,
    amountSats,
    feeRate,
    address,
    network,
    fetchImpl,
    builder: async ({ selectedUtxos, changeSats, includeChange, addressType, script, network, fetchImpl }) => {
      const psbt = new Psbt({ network: getNetworks(network) });
      for (const utxo of selectedUtxos) {
        psbt.addInput(await createPsbtInput({ utxo, addressType, script, network, fetchImpl }));
      }
      psbt.addOutput({ address: order.revealInscribeAddress, value: Number(order.revealInscribeFee) });
      psbt.addOutput({ address: order.revealMintAddress, value: Number(order.revealMintFee) });
      if (includeChange) {
        psbt.addOutput({ address, value: changeSats });
      }
      return {
        psbt,
        inputCount: selectedUtxos.length,
        outputCount: psbt.txOutputs.length,
      };
    },
  });
}

async function buildMrc20TransferCommitPsbt({ order, feeRate, address, network, fetchImpl }) {
  const utxos = await fetchBtcUtxos({ address, network, fetchImpl });
  const amountSats = Number(order.revealFee || 0);
  return buildTx({
    utxos,
    amountSats,
    feeRate,
    address,
    network,
    fetchImpl,
    builder: async ({ selectedUtxos, changeSats, includeChange, addressType, script, network, fetchImpl }) => {
      const psbt = new Psbt({ network: getNetworks(network) });
      for (const utxo of selectedUtxos) {
        psbt.addInput(await createPsbtInput({ utxo, addressType, script, network, fetchImpl }));
      }
      psbt.addOutput({ address: order.revealAddress, value: Number(order.revealFee) });
      if (includeChange) {
        psbt.addOutput({ address, value: changeSats });
      }
      return {
        psbt,
        inputCount: selectedUtxos.length,
        outputCount: psbt.txOutputs.length,
      };
    },
  });
}

function buildMrc20TransferRevealPrePsbt({ order, commitTxId, network }) {
  const psbt = Psbt.fromHex(order.revealPrePsbtRaw, { network: getNetworks(network) });
  const revealInputIndex = Number(order.revealInputIndex || 0);
  if (!Number.isInteger(revealInputIndex) || revealInputIndex < 0) {
    throw new Error('Invalid revealInputIndex from transfer order');
  }
  if (revealInputIndex >= psbt.inputCount) {
    throw new Error('revealInputIndex exceeds reveal pre-PSBT input count');
  }

  psbt.data.globalMap.unsignedTx.tx.ins[revealInputIndex].hash = Buffer.from(commitTxId, 'hex').reverse();
  psbt.data.globalMap.unsignedTx.tx.ins[revealInputIndex].index = 0;

  const toSignInputs = [];
  for (let index = 0; index < revealInputIndex; index += 1) {
    toSignInputs.push({ index, sighashTypes: [SIGHASH_ALL] });
  }

  return {
    psbtHex: psbt.toHex(),
    toSignInputs,
  };
}

async function buildBuyTakePsbt({ order, feeRate, address, network, fetchImpl }) {
  const utxos = await fetchBtcUtxos({ address, network, fetchImpl });
  const amountSats = Number(order.priceAmount || 0) + Number(order.fee || 0);
  return buildTx({
    utxos,
    amountSats,
    feeRate,
    address,
    network,
    fetchImpl,
    builder: async ({ selectedUtxos, changeSats, includeChange, addressType, script, network, fetchImpl }) => {
      const psbt = Psbt.fromHex(order.takePsbt, { network: getNetworks(network) });
      const toSignInputs = [];
      let nextIndex = psbt.inputCount;
      for (const utxo of selectedUtxos) {
        const input = await createPsbtInput({ utxo, addressType, script, network, fetchImpl });
        input.sighashType = SIGHASH_ALL;
        psbt.addInput(input);
        toSignInputs.push({ index: nextIndex, sighashTypes: [SIGHASH_ALL] });
        nextIndex += 1;
      }
      if (includeChange) {
        psbt.addOutput({ address, value: changeSats });
      }
      return {
        psbt,
        toSignInputs,
        inputCount: psbt.inputCount,
        outputCount: psbt.txOutputs.length,
      };
    },
  });
}

async function buildAskPsbt({ utxo, totalPriceSats, address, network, fetchImpl }) {
  const addressType = determineAddressInfo(address);
  const rawTx = await fetchBtcRawTx({ txId: utxo.txId, network, fetchImpl });
  const prevTx = Transaction.fromHex(rawTx);
  const psbt = new Psbt({ network: getNetworks(network) });

  if (addressType === 'P2PKH') {
    const actualInput = {
      hash: utxo.txId,
      index: utxo.outputIndex,
      nonWitnessUtxo: prevTx.toBuffer(),
      sighashType: SIGHASH_SINGLE_ANYONECANPAY,
    };
    const fakeTxid = '0'.repeat(64);
    const fakeScript = Buffer.from('76a914000000000000000000000000000000000000000088ac', 'hex');
    psbt.addInput({
      hash: fakeTxid,
      index: 0,
      witnessUtxo: { script: fakeScript, value: 0 },
      sighashType: SIGHASH_SINGLE_ANYONECANPAY,
    });
    psbt.addInput({
      hash: fakeTxid,
      index: 1,
      witnessUtxo: { script: fakeScript, value: 0 },
      sighashType: SIGHASH_SINGLE_ANYONECANPAY,
    });
    psbt.addInput(actualInput);
    psbt.addOutput({ script: fakeScript, value: 0 });
    psbt.addOutput({ script: fakeScript, value: 0 });
  } else {
    const script = addressLib.toOutputScript(address, getNetworks(network));
    psbt.addInput({
      hash: utxo.txId,
      index: utxo.outputIndex,
      witnessUtxo: {
        script,
        value: Number(utxo.satoshis || utxo.satoshi || DUST_UTXO_VALUE),
      },
      sighashType: SIGHASH_SINGLE_ANYONECANPAY,
    });
  }

  psbt.addOutput({
    address,
    value: Number(totalPriceSats),
  });
  return { psbtHex: psbt.toHex() };
}

module.exports = {
  determineAddressInfo,
  getAddressOutputScriptHex,
  fetchBtcUtxos,
  fetchBtcRawTx,
  buildIdCoinMintCommitPsbt,
  buildMrc20TransferCommitPsbt,
  buildMrc20TransferRevealPrePsbt,
  buildBuyTakePsbt,
  buildAskPsbt,
};
