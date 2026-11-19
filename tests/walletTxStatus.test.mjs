import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * walletTxStatusService pulls txTransferVerification (pure), mvcFtService
 * (electron-stubbed) and meta-contract's token proto (works in node).
 * Every network fetch is injected per test — nothing leaves the machine.
 */
function loadWalletTxStatusService() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => '/tmp', getAppPath: () => process.cwd() },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const path = require.resolve('../dist-electron/main/services/walletTxStatusService.js');
    delete require.cache[path];
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

const RECEIVER = '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za';
const RECEIVER_HASH = 'adf6c546544cfe6ae313db3e4fb64d89cd286717';
const OTHER_HASH = '1111111111111111111111111111111111111111';
const METAID_GENESIS = '28a481ecdae9499a599a9457ae70b5cf234ef417';
const TXID = 'aa'.repeat(32);

/** P2PKH script to a hash160 (MVC mainnet: 1… addresses, version 0x00). */
const p2pkh = (hash) => `76a914${hash}88ac`;

/**
 * MVC20 token output script fixture, built with the same meta-contract
 * token proto the verifier reads back (round-trip): the dataPart is the
 * script tail and is parsed at tail-relative offsets, so any base prefix
 * works. Genesis 28a481… (METAID), decimal 6.
 */
const ftProto = require('meta-contract/dist/mcp02/contract-proto/token.proto.js');
const { mvc } = require('meta-contract');

function buildFtScript(receiverHashHex, amountBase, { genesisHex = METAID_GENESIS, decimal = 6, symbol = 'METAID', name = 'META ID' } = {}) {
  const dataPart = ftProto.newDataPart({
    tokenName: name,
    tokenSymbol: symbol,
    decimalNum: decimal,
    tokenAddress: receiverHashHex,
    tokenAmount: new mvc.crypto.BN(amountBase),
    genesisHash: genesisHex,
    protoVersion: 1,
    protoType: 1,
  });
  return Buffer.concat([Buffer.alloc(64, 0x51), dataPart]).toString('hex');
}

const FT_SCRIPT_HEX = buildFtScript(RECEIVER_HASH, 100000);

/** Minimal legacy raw tx with the given outputs (mirrors parseTxOffsets). */
function buildTxHex(outputs) {
  const parts = [
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x01]), // input count
    Buffer.concat([
      Buffer.alloc(32, 0),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x00]), // empty scriptSig
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
    ]),
    Buffer.from([outputs.length]),
  ];
  for (const output of outputs) {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(BigInt(output.sats));
    const script = Buffer.from(output.scriptHex, 'hex');
    assert.ok(script.length < 0xfd, 'fixture scripts must stay in short-varint range');
    parts.push(value, Buffer.from([script.length]), script);
  }
  parts.push(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  return Buffer.concat(parts).toString('hex');
}

const TX_HEX = buildTxHex([
  { sats: 1000, scriptHex: p2pkh(RECEIVER_HASH) },
  { sats: 500, scriptHex: p2pkh(OTHER_HASH) },
  { sats: 600, scriptHex: FT_SCRIPT_HEX },
]);

const TX_TOKEN_ONLY_HEX = buildTxHex([{ sats: 600, scriptHex: FT_SCRIPT_HEX }]);

function deps({ mvcRaw = TX_HEX, utxoRows = [], btcTx, btcTip = null, dogeTx, assets } = {}) {
  return {
    fetchMvcRawTxHex: async () => mvcRaw,
    fetchMvcUtxoList: async () => utxoRows,
    fetchBtcTx: async () => (btcTx === undefined ? null : btcTx),
    fetchBtcTipHeight: async () => btcTip,
    fetchDogeTx: async () => (dogeTx === undefined ? null : dogeTx),
    ...(assets ? { listReceiverFtAssets: async () => assets } : {}),
  };
}

test('mvc status: receiver utxo hit proves confirmation with block height', async () => {
  const { getWalletTxStatus } = loadWalletTxStatusService();
  const status = await getWalletTxStatus(deps({
    utxoRows: [{ txid: TXID, outIndex: 0, height: 976500 }],
  }), { chain: 'mvc', txid: TXID, receiver: RECEIVER });
  assert.equal(status.found, true);
  assert.equal(status.confirmed, true);
  assert.equal(status.blockHeight, 976500);
  assert.equal(status.evidence, 'receiver-utxo-list');
  assert.equal(status.outputs.length, 3);
  assert.equal(status.outputs[0].address, RECEIVER);
  assert.equal(status.outputs[0].sats, 1000);
  assert.equal(status.explorerUrl, `https://www.mvcscan.com/tx/${TXID}`);
});

test('mvc status: no utxo row reports unconfirmed-or-spent honestly', async () => {
  const { getWalletTxStatus } = loadWalletTxStatusService();
  const status = await getWalletTxStatus(deps({ utxoRows: [] }), { chain: 'mvc', txid: TXID, receiver: RECEIVER });
  assert.equal(status.found, true);
  assert.equal(status.confirmed, false);
  assert.match(status.note, /already spent onward/);
});

test('mvc status: without receiver only raw-tx existence is claimed', async () => {
  const { getWalletTxStatus } = loadWalletTxStatusService();
  const status = await getWalletTxStatus(deps({}), { chain: 'mvc', txid: TXID });
  assert.equal(status.found, true);
  assert.equal(status.confirmed, undefined);
  assert.equal(status.evidence, 'raw-tx-only');
  assert.match(status.note, /pass receiver/);
});

test('mvc status: missing raw tx reports not-found', async () => {
  const { getWalletTxStatus } = loadWalletTxStatusService();
  const status = await getWalletTxStatus(deps({ mvcRaw: '' }), { chain: 'mvc', txid: TXID });
  assert.equal(status.found, false);
  assert.equal(status.evidence, 'not-found');
});

test('btc status: mempool.space shape yields confirmations, fee and output addresses', async () => {
  const { getWalletTxStatus } = loadWalletTxStatusService();
  const status = await getWalletTxStatus(deps({
    btcTx: {
      status: { confirmed: true, block_height: 976000, block_time: 1760860800 },
      fee: 1500,
      vout: [{ scriptpubkey_address: RECEIVER, value: 50000 }],
    },
    btcTip: 976010,
  }), { chain: 'btc', txid: TXID });
  assert.equal(status.found, true);
  assert.equal(status.confirmed, true);
  assert.equal(status.blockHeight, 976000);
  assert.equal(status.confirmations, 11);
  assert.equal(status.feeSats, 1500);
  assert.equal(status.outputs[0].address, RECEIVER);
  assert.equal(status.outputs[0].sats, 50000);
});

test('btc status: mempool tx (unconfirmed) reports found but not confirmed', async () => {
  const { getWalletTxStatus } = loadWalletTxStatusService();
  const status = await getWalletTxStatus(deps({
    btcTx: { status: { confirmed: false }, fee: 900, vout: [] },
  }), { chain: 'btc', txid: TXID });
  assert.equal(status.found, true);
  assert.equal(status.confirmed, false);
  assert.equal(status.confirmations, undefined);
});

test('doge status: blockchair shape yields block id, ISO time and recipients', async () => {
  const { getWalletTxStatus } = loadWalletTxStatusService();
  const status = await getWalletTxStatus(deps({
    dogeTx: {
      transaction: { block_id: 6463569, time: '2026-11-19 03:18:20', fee: 3400000 },
      outputs: [{ recipient: RECEIVER, value: 100000 }],
    },
  }), { chain: 'doge', txid: TXID });
  assert.equal(status.found, true);
  assert.equal(status.confirmed, true);
  assert.equal(status.blockHeight, 6463569);
  assert.equal(status.blockTimeIso, '2026-11-19T03:18:20.000Z');
  assert.equal(status.feeSats, 3400000);
  assert.equal(status.outputs[0].address, RECEIVER);
});

test('verify native MVC: exact expectation verifies with tx-level evidence', async () => {
  const { verifyWalletTx } = loadWalletTxStatusService();
  const result = await verifyWalletTx(deps({ utxoRows: [{ txid: TXID, outIndex: 0, height: 976500 }] }), {
    chain: 'mvc',
    txid: TXID,
    receiver: RECEIVER,
    amountSats: 1000,
  });
  assert.equal(result.verdict, 'VERIFIED');
  assert.equal(result.confirmed, true);
  assert.ok(result.reasons.some((r) => r.includes('1000 sats delivered')));
  assert.ok(result.matched.some((m) => m.index === 0 && m.sats === 1000));
});

test('verify native MVC: wrong amount mismatches', async () => {
  const { verifyWalletTx } = loadWalletTxStatusService();
  const result = await verifyWalletTx(deps({}), {
    chain: 'mvc',
    txid: TXID,
    receiver: RECEIVER,
    amountSats: 99999,
  });
  assert.equal(result.verdict, 'MISMATCH');
  assert.ok(result.reasons.some((r) => /decode FAILED/.test(r)));
});

test('verify MVC20: token output decodes to the exact expected amount and attributes the receiver', async () => {
  const { verifyWalletTx } = loadWalletTxStatusService();
  const result = await verifyWalletTx(deps({
    mvcRaw: TX_TOKEN_ONLY_HEX,
    assets: [{
      kind: 'mvc-ft', chain: 'mvc', symbol: 'METAID', tokenName: 'META ID',
      genesis: METAID_GENESIS, codeHash: 'aa872f5a781e1e93c2a29fc49d09e3571a3b6b4f',
      address: RECEIVER, decimal: 6, balance: { confirmed: '5', unconfirmed: '0', display: '5' },
    }],
  }), {
    chain: 'mvc',
    txid: TXID,
    receiver: RECEIVER,
    tokenGenesis: METAID_GENESIS,
    tokenAmount: '0.1',
  });
  assert.equal(result.verdict, 'VERIFIED');
  assert.equal(result.actual.tokenBaseUnits, '100000');
  assert.equal(result.actual.tokenDisplay, '0.100000');
  assert.equal(result.token.symbol, 'METAID');
  assert.equal(result.token.decimal, 6);
  assert.equal(result.token.receiverBalance, '5');
  assert.ok(result.reasons.some((r) => r.includes('0.100000 METAID moved')));
  assert.ok(result.reasons.some((r) => r.includes('attribute to ' + RECEIVER)));
  assert.ok(result.reasons.some((r) => r.includes('holds 5')));
  assert.ok(result.matched.some((m) => m.tokenAmount === '100000'));
});

test('verify MVC20: amount mismatch is a MISMATCH with actual decoded amount', async () => {
  const { verifyWalletTx } = loadWalletTxStatusService();
  const result = await verifyWalletTx(deps({
    mvcRaw: TX_TOKEN_ONLY_HEX,
    assets: [{
      kind: 'mvc-ft', chain: 'mvc', symbol: 'METAID', tokenName: 'META ID',
      genesis: METAID_GENESIS, codeHash: 'aa872f5a781e1e93c2a29fc49d09e3571a3b6b4f',
      address: RECEIVER, decimal: 6, balance: { confirmed: '5', unconfirmed: '0', display: '5' },
    }],
  }), {
    chain: 'mvc',
    txid: TXID,
    receiver: RECEIVER,
    tokenGenesis: METAID_GENESIS,
    tokenAmount: '1',
  });
  assert.equal(result.verdict, 'MISMATCH');
  assert.ok(result.reasons.some((r) => /amount mismatch: tx moves 0.100000 \(expected 1\)/.test(r)));
});

test('verify MVC20: attribution shortfall to the receiver is a MISMATCH even when the total matches', async () => {
  const { verifyWalletTx } = loadWalletTxStatusService();
  // Total moved (100000) matches the expectation, but only 40000 attributes
  // to the receiver — the payment did NOT deliver 0.1 to THEM.
  const mixedHex = buildTxHex([
    { sats: 600, scriptHex: buildFtScript(RECEIVER_HASH, 40000) },
    { sats: 600, scriptHex: buildFtScript(OTHER_HASH, 60000) },
  ]);
  const result = await verifyWalletTx(deps({
    mvcRaw: mixedHex,
    assets: [{
      kind: 'mvc-ft', chain: 'mvc', symbol: 'METAID', tokenName: 'META ID',
      genesis: METAID_GENESIS, codeHash: 'aa872f5a781e1e93c2a29fc49d09e3571a3b6b4f',
      address: RECEIVER, decimal: 6, balance: { confirmed: '5', unconfirmed: '0', display: '5' },
    }],
  }), {
    chain: 'mvc',
    txid: TXID,
    receiver: RECEIVER,
    tokenGenesis: METAID_GENESIS,
    tokenAmount: '0.1',
  });
  assert.equal(result.verdict, 'MISMATCH');
  assert.ok(result.reasons.some((r) => /attribution mismatch: only 40000 of 100000/.test(r)));
});

test('verify MVC20: token_amount without receiver is insufficient evidence, not a mismatch', async () => {
  const { verifyWalletTx } = loadWalletTxStatusService();
  const result = await verifyWalletTx(deps({ mvcRaw: TX_TOKEN_ONLY_HEX }), {
    chain: 'mvc',
    txid: TXID,
    tokenGenesis: METAID_GENESIS,
    tokenAmount: '0.1',
  });
  assert.equal(result.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.reasons.some((r) => r.startsWith('insufficient-evidence')));
});

test('verify with no expectation asks for one; unknown txid is NOT_FOUND', async () => {
  const { verifyWalletTx } = loadWalletTxStatusService();
  const noExpectation = await verifyWalletTx(deps({}), { chain: 'mvc', txid: TXID });
  assert.equal(noExpectation.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.ok(noExpectation.reasons.some((r) => r.includes('no expectation provided')));
  const notFound = await verifyWalletTx(deps({ mvcRaw: '' }), {
    chain: 'mvc',
    txid: TXID,
    receiver: RECEIVER,
    amountSats: 1000,
  });
  assert.equal(notFound.verdict, 'NOT_FOUND');
});
