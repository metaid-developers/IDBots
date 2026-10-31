// tests/mvcTokenSell.test.mjs — FT TokenSell host capability, offline/byte-level only.
//
// Zero network: every vector is a local fixture copied from the live-fire
// evidence dir (bots/2/2026-10-30, public chain data — see fixtures …/meta.json).
// Zero keys: the dry-run signer is deterministically derived in-process and
// never persisted or echoed.
//
// Run: node --test tests/mvcTokenSell.test.mjs   (after compile:electron)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(__dirname, 'fixtures', 'tokenSell');
const readHex = (name) => readFileSync(path.join(FX, name), 'utf8').trim().toLowerCase();

const core = require('../dist-electron/main/libs/mvcTokenSellCore.js');
const assembly = require('../dist-electron/main/libs/mvcTokenSellAssembly.js');
const { mvc } = require('meta-contract');

const META = JSON.parse(readFileSync(path.join(FX, 'meta.json'), 'utf8'));
const tokenSellDesc = require('meta-contract/dist/mcp02/contract-desc/tokenSell_desc.json');
const transferCheckDesc = require('meta-contract/dist/mcp02/contract-desc/tokenTransferCheck_desc.json');

const d256 = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();

// ---------------------------------------------------------------------------
// 1. v10 txid formula — live anchor f518099d… (the 112B header fixture)
// ---------------------------------------------------------------------------
test('v10 header: independent parser reproduces the live 112B header byte-for-byte', () => {
  const raw = readHex('f518099d-raw.hex');
  const header = core.extractV10Header(raw);
  const fixtureHeader = Buffer.from(readHex('f518099d-header-112B.hex'), 'hex');
  assert.equal(header.length, 112);
  assert.ok(header.equals(fixtureHeader), 'header bytes != fixture');
});

test('v10 txid: reverse(hash256(header)) == live txid; wire-order hash anchor holds', () => {
  const raw = readHex('f518099d-raw.hex');
  assert.equal(core.v10TxId(raw), META.token_txid);
  const wireHash = d256(core.extractV10Header(raw)).toString('hex');
  assert.equal(wireHash, META.header_wire_hash, 'wire (non-reversed) hash256 anchor');
});

test('v10 txid: agrees with mvc-lib Transaction.id on the live LIST and seed txs', () => {
  for (const [name, file, expected] of [
    ['seed', 'txa-seed-raw.hex', META.seed_txid],
    ['LIST', 'live-list-txb.hex', META.list_txid],
    ['token merge', 'f518099d-raw.hex', META.token_txid],
  ]) {
    const raw = readHex(file);
    assert.equal(core.v10TxId(raw), expected, `${name}: core v10TxId`);
    assert.equal(new mvc.Transaction(raw).id, expected, `${name}: mvc-lib id`);
  }
});

test('parseRawTx round-trips every input/output of the live LIST tx', () => {
  const raw = readHex('live-list-txb.hex');
  const tx = new mvc.Transaction(raw);
  const parsed = core.parseRawTx(raw);
  assert.equal(parsed.inputs.length, tx.inputs.length);
  assert.equal(parsed.outputs.length, tx.outputs.length);
  parsed.outputs.forEach((o, i) => {
    assert.equal(o.satoshis, BigInt(tx.outputs[i].satoshis));
    assert.ok(o.scriptPubKey.equals(tx.outputs[i].script.toBuffer()), `out${i} script bytes`);
  });
  parsed.inputs.forEach((inp, i) => {
    assert.equal(inp.outputIndex, Number(tx.inputs[i].outputIndex));
    assert.ok(inp.scriptSig.equals(tx.inputs[i].script.toBuffer()), `in${i} scriptSig bytes`);
  });
});

// ---------------------------------------------------------------------------
// 2. checker kill-switch — deployed TransferCheck lock vs desc template
// ---------------------------------------------------------------------------
test('checker kill-switch: lock == 84B code header ‖ desc template (3507 total)', () => {
  const cast = JSON.parse(readFileSync(path.join(FX, 'checker-cast.json'), 'utf8'));
  const lock = Buffer.from(cast.lockingScript, 'hex');
  assert.equal(lock.length, META.checker_total_len);
  const verdict = core.checkerKillSwitch(lock, transferCheckDesc.hex);
  assert.equal(verdict.ok, true, 'lock minus 84B header == desc bytes');
  assert.equal(verdict.descBytesLen, META.checker_desc_len);
  // live sha256(amountCheckScript) anchor (stage2b constraint cell 880)
  assert.equal(createHash('sha256').update(lock).digest('hex'), META.checker_sha256);
  // tamper one byte after the header -> kill-switch trips
  const tampered = Buffer.from(lock);
  tampered[100] ^= 0x01;
  assert.equal(core.checkerKillSwitch(tampered, transferCheckDesc.hex).ok, false);
});

// ---------------------------------------------------------------------------
// 3. seed lock factory — byte-level against the LIVE deployed seed
// ---------------------------------------------------------------------------
test('seed lock: build(desc, seller, 5e8) == live TxA seed output bytes; encodeScryptInt 5e8 -> 0065cd1d (push 04)', () => {
  // 500000000 = 0x1dcd6500 -> sign-magnitude LE bytes 0065cd1d; the builder
  // prefixes the push length 04 (anchor-map #7: the 04 0065cd1d push segment).
  assert.equal(core.encodeScryptInt(500000000n).toString('hex'), '0065cd1d');
  const seedLock = core.buildTokenSellSeedLock(tokenSellDesc, META.seller_address, META.price_sats);
  const txa = new mvc.Transaction(readHex('txa-seed-raw.hex'));
  const live = txa.outputs[0].script.toBuffer();
  assert.equal(seedLock.length, 850);
  assert.ok(seedLock.equals(live), 'built seed lock != live deployed seed');
  assert.equal(BigInt(txa.outputs[0].satoshis), BigInt(META.seed_sats));
});

test('seed lock decode: round-trips (seller hash160, price) and rejects tampered locks', () => {
  const seedLock = core.buildTokenSellSeedLock(tokenSellDesc, META.seller_address, META.price_sats);
  const decoded = core.decodeTokenSellSeedLock(seedLock, tokenSellDesc);
  assert.equal(decoded.sellerHash160Hex, META.seller_h160);
  assert.equal(decoded.priceSats, BigInt(META.price_sats));
  const tampered = Buffer.from(seedLock);
  tampered[9] ^= 0x01; // inside the seller slot -> template mismatch
  assert.throws(() => core.decodeTokenSellSeedLock(tampered, tokenSellDesc));
});

// ---------------------------------------------------------------------------
// 4. amount gates — full-utxo listing, dust floors, sats units
// ---------------------------------------------------------------------------
test('amount gates: partial-quantity listing rejected, full-utxo accepted', () => {
  const gates = core.checkTokenSellAmountGates({
    priceSats: 500000000,
    listedTokenAmount: 40000000n,
    utxoTokenAmount: 100000000n,
  });
  assert.equal(gates.ok, false);
  assert.ok(gates.violations.some((v) => v.includes('partial-fill')), 'partial-fill violation message');

  const ok = core.checkTokenSellAmountGates({
    priceSats: 500000000,
    listedTokenAmount: 100000000n,
    utxoTokenAmount: 100000000n,
    seedSats: 2032,
    checkerSats: 3000,
  });
  assert.equal(ok.ok, true, ok.violations.join('; '));
});

test('amount gates: dust floors and non-positive prices rejected; SPACE conversion exact', () => {
  assert.equal(core.checkTokenSellAmountGates({ priceSats: 599, listedTokenAmount: 1n, utxoTokenAmount: 1n }).ok, false);
  assert.equal(core.checkTokenSellAmountGates({ priceSats: 0, listedTokenAmount: 1n, utxoTokenAmount: 1n }).ok, false);
  assert.equal(
    core.checkTokenSellAmountGates({ priceSats: 1000, listedTokenAmount: 1n, utxoTokenAmount: 1n, seedSats: 599 }).ok,
    false,
    'seed below dust',
  );
  assert.equal(core.spaceToSats('0.005'), 500000n);
  assert.equal(core.spaceToSats(1), 100000000n);
  assert.throws(() => core.spaceToSats(-1));
  assert.throws(() => core.assertTokenSellAmountGates({ priceSats: 1000, listedTokenAmount: 2n, utxoTokenAmount: 1n }));
});

// ---------------------------------------------------------------------------
// 5. signature wiring dry-run (offline): rebuild the LIST shape from fixtures
//    with a deterministic dry key; the checker leg must fully PASS offline
//    (OCS short-domain preimage — no signature needed), the token leg is at
//    worst CHECKSIG_FAMILY (dry key vs the real seller authorization EQ).
// ---------------------------------------------------------------------------
test('LIST assembly dry-run: checker leg PASS offline, token leg PASS/CHECKSIG_FAMILY, conservation holds', () => {
  const cast = JSON.parse(readFileSync(path.join(FX, 'checker-cast.json'), 'utf8'));
  const checkerTx = new mvc.Transaction(cast.hex);
  const checker = {
    scriptBuf: checkerTx.outputs[cast.outIdx].script.toBuffer(),
    sats: BigInt(checkerTx.outputs[cast.outIdx].satoshis),
    type: cast.type,
    txid: cast.txid,
    vout: cast.outIdx,
    txHex: cast.hex,
  };
  const txa = new mvc.Transaction(readHex('txa-seed-raw.hex'));
  let txaChangeIdx = -1;
  txa.outputs.forEach((o, n) => {
    const b = o.script.toBuffer();
    if (b.length === 25 && b[0] === 0x76) txaChangeIdx = n;
  });
  assert.ok(txaChangeIdx >= 0);

  const dry = assembly.makeDryTokenSellKeypair('mvcTokenSell.test');
  const signer = { mode: 'dry', ...dry };

  // amount gates applied first (construction path contract)
  core.assertTokenSellAmountGates({
    priceSats: META.price_sats,
    listedTokenAmount: BigInt(META.token_amount),
    utxoTokenAmount: BigInt(META.token_amount),
    seedSats: META.seed_sats,
    checkerSats: Number(checker.sats),
  });

  const seedLock = core.buildTokenSellSeedLock(tokenSellDesc, META.seller_address, META.price_sats);
  assert.ok(seedLock.equals(txa.outputs[0].script.toBuffer()), 'fixture TxA seed != rebuilt lock');

  // stage2b dry posture: dry key signs, but the TRUE seller pubkey / change
  // h160 ride the unlock (recovered from the public TxA scriptSig — no keys).
  const sigBuf = txa.inputs[0].script.toBuffer();
  const pushes = [];
  {
    let i = 0;
    while (i < sigBuf.length) {
      const op = sigBuf[i];
      if (op > 0 && op < 0x4c) {
        pushes.push(sigBuf.subarray(i + 1, i + 1 + op));
        i += 1 + op;
      } else break;
    }
  }
  const sellerPub = pushes.find((b) => b.length === 33);
  assert.ok(sellerPub, 'seller pubkey not found in public TxA scriptSig');

  const result = assembly.buildListTxB({
    tokenTxHex: readHex('f518099d-raw.hex'),
    tokenVout: 0,
    tokenTxid: META.token_txid,
    prevTokenTxHex: readHex('g-prev-raw.hex'),
    prevTokenInputIndex: 0,
    tokenAmount: BigInt(META.token_amount),
    checker,
    txaTxid: txa.id,
    txaChangeIdx,
    txaChangeSat: BigInt(txa.outputs[txaChangeIdx].satoshis),
    seedLock,
    sellerSigner: signer,
    feeRate: 1,
    dryRunOverrides: { senderPubKeyHex: sellerPub.toString('hex'), changeH160Hex: META.seller_h160 },
  });

  // verify classification: checker fully PASS offline; token at worst CHECKSIG_FAMILY
  assert.equal(result.verdicts.checker.cls, 'PASS', result.verdicts.checker.detail.slice(0, 160));
  assert.ok(
    result.verdicts.token.cls === 'PASS' || result.verdicts.token.cls === 'CHECKSIG_FAMILY',
    `token leg unexpected: ${result.verdicts.token.cls} ${result.verdicts.token.detail.slice(0, 160)}`,
  );

  // structural ledger (T-shaped invariants from the live scripts)
  const tx = new mvc.Transaction(result.txHex);
  assert.equal(tx.inputs.length, 3, 'token+checker+funding inputs');
  assert.equal(Buffer.from(tx.inputs[0].prevTxId).toString('hex'), META.token_txid, 'token leg at input 0');
  const dpOut = assembly.parseTokenDataPart(result.tokenOutScript);
  assert.equal(String(dpOut.tokenAmount), META.token_amount, 'conservation: listed amount carried in full');
  // out0 token locked to hash160(sha256(seedLock)) — the op=2 redeemable slot
  assert.equal(
    Buffer.from(dpOut.tokenAddress, 'hex').toString('hex'),
    mvc.crypto.Hash.sha256ripemd160(seedLock).toString('hex'),
  );
  // consensus txid convention (scriptSig-committed) == mvc-lib id
  assert.equal(result.txid, tx.id);
  // deterministic fee convergence: fee ≥ vsize estimate
  assert.ok(result.fee >= BigInt(result.size), `fee ${result.fee} < size ${result.size}`);
  // every output ≥ dust
  for (const out of tx.outputs) assert.ok(Number(out.satoshis) >= 600, `output below dust: ${out.satoshis}`);
});

// ---------------------------------------------------------------------------
// 6. service read path (offline via DI): listing verification against the
//    LIVE listing e281d9a2 + seed 3663e0f3, including a misquote negative.
// ---------------------------------------------------------------------------
test('verifyMvcTokenSellListing: live listing verifies; price misquote is caught', async () => {
  const service = require('../dist-electron/main/services/mvcTokenSellService.js');
  const raws = new Map([
    [META.list_txid, readHex('live-list-txb.hex')],
    [META.seed_txid, readHex('txa-seed-raw.hex')],
  ]);
  const deps = { fetchRawTx: async (txid) => {
    if (!raws.has(txid)) throw new Error(`unexpected fetch: ${txid}`);
    return raws.get(txid);
  } };

  const verified = await service.verifyMvcTokenSellListing({
    sell_txid: META.list_txid,
    sell_output_index: 0,
    sell_price_sats: META.price_sats,
    seller_address: META.seller_address,
    seed_txid: META.seed_txid,
    seed_vout: 0,
  }, deps);
  assert.equal(verified.verified, true, verified.problems.join('; '));
  assert.equal(verified.decoded.priceSats, String(META.price_sats));
  assert.equal(verified.decoded.sellerHash160Hex, META.seller_h160);
  assert.equal(verified.tokenAmount, META.token_amount);
  assert.equal(verified.txid, META.list_txid);

  const misquote = await service.verifyMvcTokenSellListing({
    sell_txid: META.list_txid,
    sell_output_index: 0,
    sell_price_sats: META.price_sats + 1,
    seller_address: META.seller_address,
    seed_txid: META.seed_txid,
    seed_vout: 0,
  }, deps);
  assert.equal(misquote.verified, false);
  assert.ok(misquote.problems.some((p) => p.includes('price mismatch')), misquote.problems.join('; '));

  const getMvcFtTokenBalance = service.getMvcFtTokenBalance;
  const balance = await getMvcFtTokenBalance('1EwGrbMCpfPSpcJi9ixPwLMme5NCAiQAVr', {
    fetchFtBalance: async () => [
      { symbol: 'SPACE-X', genesis: 'ab'.repeat(32), codehash: 'cd'.repeat(20), balance: '12345678901234567890', decimal: 8, count: 2 },
      { symbol: '', genesis: '', balance: 1 }, // skipped row
    ],
  });
  assert.equal(balance.count, 1);
  assert.equal(balance.tokens[0].balance, '12345678901234567890');
});

// ---------------------------------------------------------------------------
// 7. agent tool registration — wallet_token_* next to wallet_nft_*
// ---------------------------------------------------------------------------
test('wallet_token_* tools registered in the same factory as wallet_nft_*', async () => {
  const { buildWalletAgentTools } = require('../dist-electron/main/libs/walletAgentTools.js');
  const names = [];
  const calls = [];
  const tool = (name, description, schema, handler) => {
    names.push(name);
    calls.push({ name, description, schema, handler });
    return { name };
  };
  const control = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'resolveMetabotIdByName') return () => null;
      if (prop === 'getMetabotMvcAddress') return () => null;
      return async () => { throw new Error(`unexpected control call in registration test: ${String(prop)}`); };
    },
  });
  const tools = buildWalletAgentTools({
    tool,
    control,
    sessionId: 'test-session',
    resolveMetabotId: () => undefined,
  });
  const expected = [
    'wallet_token_balance',
    'wallet_token_sell_orders',
    'wallet_token_sell',
    'wallet_token_buy',
    'wallet_token_take', // deprecated alias of wallet_token_buy (same schema object + handler)
    'wallet_token_cancel_sell',
  ];
  for (const name of expected) {
    assert.ok(names.includes(name), `${name} not registered`);
    assert.ok(tools.some((t) => t && t.name === name), `${name} not returned`);
  }
  for (const nftTool of ['wallet_nft_balance', 'wallet_nft_sell', 'wallet_nft_buy']) {
    assert.ok(names.includes(nftTool), `${nftTool} disappeared`);
  }
  // schema sanity: sell requires genesis+codehash+price; take requires the listing tuple
  const sell = calls.find((c) => c.name === 'wallet_token_sell');
  assert.ok(sell.schema.genesis && sell.schema.codehash);
  const take = calls.find((c) => c.name === 'wallet_token_buy');
  assert.ok(take.schema.sell_txid && take.schema.sell_output_index && take.schema.sell_price_sats && take.schema.seller_address);

  // alias contract: wallet_token_take is an EXACT alias — same schema object, same handler function
  const alias = calls.find((c) => c.name === 'wallet_token_take');
  assert.ok(alias, 'wallet_token_take alias not registered');
  assert.equal(alias.schema, take.schema, 'alias schema must be the same object as wallet_token_buy');
  assert.equal(alias.handler, take.handler, 'alias handler must be the same function as wallet_token_buy');

  // handler behavior: session-less sell fails closed with the own-wallet message
  const sellNoSession = await sell.handler({ genesis: 'ab'.repeat(32), codehash: 'cd'.repeat(20), price_sats: 1000 });
  assert.equal(sellNoSession.isError, true);
  assert.match(sellNoSession.content[0].text, /own wallet/);

  // partial-fill amount error is surfaced from the gates (no control call needed)
  const controlCalls = [];
  const control2 = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'resolveMetabotIdByName') return () => null;
      if (prop === 'getMetabotMvcAddress') return () => '1AGo1uNPZ7Fti4n8XxKdjA2GNwnXna6oTM';
      controlCalls.push(String(prop));
      return async () => ({ txId: 'x' });
    },
  });
  const tools2 = buildWalletAgentTools({
    tool: (name, description, schema, handler) => ({ name, handler }),
    control: control2,
    sessionId: 'test-session',
    resolveMetabotId: () => 7,
  });
  // partial-fill rejection lives in the CONSTRUCTION path (assembly), offline:
  const cast = JSON.parse(readFileSync(path.join(FX, 'checker-cast.json'), 'utf8'));
  const checkerTx2 = new mvc.Transaction(cast.hex);
  const txa2 = new mvc.Transaction(readHex('txa-seed-raw.hex'));
  let changeIdx2 = -1;
  txa2.outputs.forEach((o, n) => { const b = o.script.toBuffer(); if (b.length === 25 && b[0] === 0x76) changeIdx2 = n; });
  const dry2 = assembly.makeDryTokenSellKeypair('partial-fill-negative');
  const seedLock2 = core.buildTokenSellSeedLock(tokenSellDesc, META.seller_address, META.price_sats);
  assert.throws(
    () => assembly.buildListTxB({
      tokenTxHex: readHex('f518099d-raw.hex'),
      tokenVout: 0,
      tokenTxid: META.token_txid,
      prevTokenTxHex: readHex('g-prev-raw.hex'),
      prevTokenInputIndex: 0,
      tokenAmount: BigInt('40000000'), // partial!
      checker: {
        scriptBuf: checkerTx2.outputs[cast.outIdx].script.toBuffer(),
        sats: BigInt(checkerTx2.outputs[cast.outIdx].satoshis),
        type: cast.type, txid: cast.txid, vout: cast.outIdx, txHex: cast.hex,
      },
      txaTxid: txa2.id,
      txaChangeIdx: changeIdx2,
      txaChangeSat: BigInt(txa2.outputs[changeIdx2].satoshis),
      seedLock: seedLock2,
      sellerSigner: { mode: 'dry', ...dry2 },
      feeRate: 1,
    }),
    /partial-fill/,
  );
  void controlCalls; void tools2;
});
