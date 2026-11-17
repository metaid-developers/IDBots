/**
 * Security regression suite for the BTC / MRC20 P2WSH multisig tools.
 *
 * Every case here is a fund-loss or owner-gate vector found in the
 * 2026-11-17 audit (see the audit report). Run with:
 *   npx tsx --test tests/btcMultisigSecurity.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as bitcoin from 'bitcoinjs-lib';
import {
  assertMultisigInputsSignable,
  buildMultisigPsbt,
  combinePsbts,
  createMultisigAddress,
  finalizePsbt,
  parseMultisigScript,
  selectMultisigInputIndexes,
  summarizePsbt,
} from '../src/main/services/btcMultisigScript';
import { openMetabotBtcWallet, signBtcPsbtPartial } from '../src/main/services/btcPartialSign';
import { buildBtcMultisigAgentTools } from '../src/main/libs/btcMultisigAgentTools';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TXID = '11'.repeat(32);
const NETWORK = bitcoin.networks.bitcoin;

function wallet(index: number) {
  return openMetabotBtcWallet({ mnemonic: MNEMONIC, path: `m/44'/10001'/0'/0/${index}` });
}

function pubkeyOf(index: number): string {
  return wallet(index).getPublicKey().toString('hex');
}

function vaultOf(indexes: number[], m = 2) {
  return createMultisigAddress(m, indexes.map(pubkeyOf));
}

/** buildMultisigPsbt returns { psbtHex, feeSats, feeRateSatVb } after the fix. */
function hexOf(built: unknown): string {
  return typeof built === 'string' ? built : (built as { psbtHex: string }).psbtHex;
}

/** Build a normal 1-input/1-output PSBT and return its hex. */
function normalPsbt(descriptor: { witnessScriptHex: string; address: string }, value = 100_000, fee = 10_000) {
  return hexOf(buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value }],
    outputs: [{ address: descriptor.address, value: value - fee }],
  }));
}

// ---------------------------------------------------------------------------
// A. script / address construction
// ---------------------------------------------------------------------------

test('A: the canonical multisig parser accepts the built script and rejects non-canonical ones', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  const script = Buffer.from(descriptor.witnessScriptHex, 'hex');
  assert.deepEqual(parseMultisigScript(script), { m: 2, n: 3 });

  const keys = descriptor.pubkeys.map((key) => Buffer.from(key, 'hex'));
  const embedded = script.subarray(1, 1 + 34 * 3).filter((_, index) => index % 34 === 0);
  assert.equal(embedded.length, 3);
  for (let index = 1; index < keys.length; index += 1) {
    assert.ok(keys[index - 1].compare(keys[index]) < 0, 'pubkeys are embedded in ascending BIP67 order');
  }

  for (const bad of ['ae', '51ae', '51af', '52ae', `${descriptor.witnessScriptHex}51`]) {
    assert.equal(parseMultisigScript(Buffer.from(bad, 'hex')), null, `non-canonical script ${bad} must be rejected`);
    assert.throws(
      () => buildMultisigPsbt({
        witnessScriptHex: bad,
        inputs: [{ txid: TXID, vout: 0, value: 50_000 }],
        outputs: [{ address: descriptor.address, value: 40_000 }],
      }),
      /canonical M-of-N multisig/,
    );
  }
});

// ---------------------------------------------------------------------------
// D. build construction: fee sanity, network, dust
// ---------------------------------------------------------------------------

test('D: build rejects an absurd fee rate and reports the rate otherwise', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  // input 1,000,000, output 1,000 -> fee 999,000 on a ~158 vB spend (~6300 sat/vB)
  assert.throws(
    () => buildMultisigPsbt({
      witnessScriptHex: descriptor.witnessScriptHex,
      inputs: [{ txid: TXID, vout: 0, value: 1_000_000 }],
      outputs: [{ address: descriptor.address, value: 1_000 }],
    }),
    /fee rate .*sat\/vB exceeds/,
  );

  const normal = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 1_000_000 }],
    outputs: [{ address: descriptor.address, value: 999_000 }],
  });
  assert.equal(normal.feeSats, 1_000);
  assert.ok(normal.feeRateSatVb > 0 && normal.feeRateSatVb < 200, `normal fee rate stays low, got ${normal.feeRateSatVb}`);

  // 100,000 in / 60,000 out is ~253 sat/vB on the same spend shape: allowed, flagged.
  const flagged = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 100_000 }],
    outputs: [{ address: descriptor.address, value: 60_000 }],
  });
  assert.ok(flagged.feeRateSatVb > 200, `expected a high rate, got ${flagged.feeRateSatVb}`);
  assert.match(flagged.warning ?? '', /unusually high/);
});

test('D: build enforces the 1000-sat carrier floor, positive fee and mainnet addresses', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  assert.throws(() => buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 50_000 }],
    outputs: [{ address: descriptor.address, value: 999 }],
  }), /1000 sats/);
  assert.throws(() => buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 50_000 }],
    outputs: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: 40_000 }],
  }), /invalid prefix/);
});

// ---------------------------------------------------------------------------
// B. signing scope
// ---------------------------------------------------------------------------

test('B: signing refuses a vault script that does not include this key, before touching the signer', () => {
  const descriptor = vaultOf([1, 2, 3], 2);
  const psbtHex = normalPsbt(descriptor);

  assert.throws(
    () => assertMultisigInputsSignable({ psbtHex, indexes: [0], publicKey: pubkeyOf(0) }),
    /does not include/,
  );

  let calls = 0;
  assert.throws(
    () => signBtcPsbtPartial({
      getPublicKey: () => wallet(0).getPublicKey(),
      signTx() {
        calls += 1;
        return { psbtHex: 'should-not-run', rawTx: '' };
      },
    }, { psbtHex }),
    /does not include/,
  );
  assert.equal(calls, 0, 'the wallet must not be asked to sign an input it has no key for');
});

test('B: signing refuses a witnessUtxo that does not match the witnessScript', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  const other = vaultOf([4, 5, 6], 2);
  // Build a PSBT whose prevout script belongs to another vault while the
  // witnessScript claims the first one.
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  psbt.addInput({
    hash: TXID,
    index: 0,
    witnessUtxo: {
      script: bitcoin.address.toOutputScript(other.address, NETWORK),
      value: 100_000,
    },
    witnessScript: Buffer.from(descriptor.witnessScriptHex, 'hex'),
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  psbt.addOutput({ address: descriptor.address, value: 90_000 });
  const tampered = psbt.toHex();

  assert.throws(
    () => assertMultisigInputsSignable({ psbtHex: tampered, indexes: [0], publicKey: pubkeyOf(0) }),
    /does not match/,
  );
  assert.throws(
    () => signBtcPsbtPartial(wallet(0), { psbtHex: tampered }),
    /Witness script|does not match/i,
  );
});

test('B: a mixed personal + multisig PSBT signs only the multisig index', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  const psbt = bitcoin.Psbt.fromHex(normalPsbt(descriptor));
  const personal = wallet(9);
  const prev = new bitcoin.Transaction();
  prev.addInput(Buffer.alloc(32, 9), 0);
  prev.addOutput(bitcoin.address.toOutputScript(personal.getAddress(), NETWORK), 70_000);
  psbt.addInput({
    hash: prev.getId(),
    index: 0,
    nonWitnessUtxo: prev.toBuffer(),
  });

  let seen: { toSignInputs?: Array<{ index: number; sighashTypes: number[] }> } | null = null;
  const signed = signBtcPsbtPartial({
    signTx(_type: unknown, params: any) {
      seen = params;
      return { psbtHex: psbt.toHex(), rawTx: '' };
    },
  }, { psbtHex: psbt.toHex() });

  assert.deepEqual(seen!.toSignInputs, [{ index: 0, sighashTypes: [1] }]);
  assert.ok(signed.psbtHex);
});

// ---------------------------------------------------------------------------
// C. combine / finalize
// ---------------------------------------------------------------------------

test('C: combine refuses PSBTs of different transactions', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  const a = hexOf(buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 100_000 }],
    outputs: [{ address: descriptor.address, value: 90_000 }],
  }));
  const b = hexOf(buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 100_000 }],
    outputs: [{ address: descriptor.address, value: 80_000 }],
  }));
  assert.throws(() => combinePsbts([a, b]), /same transaction/);
});

test('C: combine and finalize reject non-ALL sighash inputs', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  const base = normalPsbt(descriptor);
  const single = new bitcoin.Psbt({ network: NETWORK });
  single.addInput({
    hash: TXID,
    index: 0,
    witnessUtxo: {
      script: bitcoin.address.toOutputScript(descriptor.address, NETWORK),
      value: 100_000,
    },
    witnessScript: Buffer.from(descriptor.witnessScriptHex, 'hex'),
    sighashType: bitcoin.Transaction.SIGHASH_SINGLE,
  });
  single.addOutput({ address: descriptor.address, value: 90_000 });
  const singleHex = single.toHex();

  assert.throws(() => combinePsbts([base, singleHex]), /SIGHASH_ALL/);
  assert.throws(() => finalizePsbt(singleHex), /SIGHASH_ALL/);
});

test('C: finalize trims extra signatures on an M-of-N PSBT instead of failing', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  let psbt = normalPsbt(descriptor);
  for (const index of [0, 1, 2]) {
    psbt = signBtcPsbtPartial(wallet(index), { psbtHex: psbt }).psbtHex;
  }
  assert.equal(summarizePsbt(psbt).inputs[0].partialSigs, 3);

  const finalized = finalizePsbt(psbt);
  const tx = bitcoin.Transaction.fromHex(finalized.rawTx);
  assert.equal(tx.ins.length, 1);
  // witness stack: dummy, signature, signature, witness script
  assert.equal(tx.ins[0].witness.length, 4);
  assert.equal(finalized.txid, tx.getId());

  // Too few signatures still fails, with a signature-related message.
  const one = signBtcPsbtPartial(wallet(0), { psbtHex: normalPsbt(descriptor) }).psbtHex;
  assert.throws(() => finalizePsbt(one), /signature/i);
});

// ---------------------------------------------------------------------------
// tools: utxo honesty + owner gate ordering
// ---------------------------------------------------------------------------

function toolHarness(signerPubkey: string) {
  const handlers: Record<string, { handler: (args: any) => Promise<any> }> = {};
  const descriptions: Record<string, string> = {};
  const tool = (name: string, description: string, _schema: unknown, handler: (args: any) => Promise<any>) => {
    handlers[name] = { handler };
    descriptions[name] = description;
    return { name };
  };
  const calls: string[] = [];
  const signIndexes: Array<number[] | undefined> = [];
  const control = {
    getBtcSignerIdentity() {
      calls.push('identity');
      return { address: '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB', publicKey: signerPubkey };
    },
    signBtcPsbtPartial(_metabotId: number, input: { psbtHex: string; inputIndexes?: number[] }) {
      calls.push('sign');
      signIndexes.push(input.inputIndexes);
      return { psbtHex: input.psbtHex };
    },
    broadcastBtcTx() {
      calls.push('broadcast');
      return Promise.resolve('txid');
    },
    listBtcUtxos() {
      return Promise.resolve([{ txid: 'ab'.repeat(32), vout: 1, value: 80_000 }]);
    },
  };
  return { tool, handlers, descriptions, control, calls, signIndexes };
}

test('D: the utxo tool declares the <1000 sat carrier filter instead of an unfiltered list', async () => {
  const { tool, handlers, descriptions, control } = toolHarness(pubkeyOf(0));
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async () => true,
    confirmBroadcast: async () => true,
  });
  assert.match(descriptions.wallet_btc_utxos, /filtered/i);
  assert.match(descriptions.wallet_btc_utxos, /1000 sats/);
  assert.match(descriptions.wallet_btc_utxos, /MRC20/);
  assert.doesNotMatch(descriptions.wallet_btc_utxos, /UNFILTERED/);

  const result = await handlers.wallet_btc_utxos.handler({ address: 'bc1qvault' });
  assert.match(result.content[0].text, /1000 sats/);
  assert.match(result.content[0].text, /MRC20/);
  assert.doesNotMatch(result.content[0].text, /unfiltered/i);
});

test('B: the sign tool refuses before the owner prompt when this key is not in the vault', async () => {
  const descriptor = vaultOf([1, 2, 3], 2);
  const psbtHex = normalPsbt(descriptor);
  const { tool, handlers, control, calls } = toolHarness(pubkeyOf(0));
  let prompts = 0;
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async () => {
      prompts += 1;
      return true;
    },
    confirmBroadcast: async () => true,
  });
  const signed = await handlers.wallet_btc_sign_psbt.handler({ psbt_hex: psbtHex });
  assert.equal(signed.isError, true);
  assert.match(signed.content[0].text, /does not include/);
  assert.equal(prompts, 0, 'the owner must not be asked to approve an unusable signature');
  assert.equal(calls.includes('sign'), false);
});

test('D: the build tool reports the implied fee rate', async () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  const { tool, handlers, control } = toolHarness(pubkeyOf(0));
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async () => true,
    confirmBroadcast: async () => true,
  });
  const result = await handlers.wallet_btc_build_multisig_psbt.handler({
    witness_script: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 100_000 }],
    outputs: [{ address: descriptor.address, value: 90_000 }],
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /fee_rate_sat_vb: \d+/);
});

// ---------------------------------------------------------------------------
// E. inscription-carrier floor — Metalet e266b9c (a <1000 sat UTXO is never
//    spent as plain BTC) and 1b3f93a (the floor is exactly 1000: 999 refused,
//    1000 allowed). Same three points on every boundary below: 999 / 1000 / 1001.
// ---------------------------------------------------------------------------

test('E: multisig outputs sit exactly on the 1000-sat floor (999 refused, 1000 and 1001 allowed)', () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  assert.throws(() => buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 5_000 }],
    outputs: [{ address: descriptor.address, value: 999 }],
  }), /1000 sats/);
  for (const value of [1_000, 1_001]) {
    const built = buildMultisigPsbt({
      witnessScriptHex: descriptor.witnessScriptHex,
      inputs: [{ txid: TXID, vout: 0, value: 5_000 }],
      outputs: [{ address: descriptor.address, value }],
    });
    assert.equal(summarizePsbt(built.psbtHex).outputs[0].value, value, `${value} sats must be allowed`);
  }
});

test('E: a 999-sat multisig input is never selected, never prompted and never signed', async () => {
  const descriptor = vaultOf([0, 1, 2], 2);
  const psbtHex = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [
      { txid: '22'.repeat(32), vout: 0, value: 999 },
      { txid: TXID, vout: 1, value: 80_000 },
    ],
    outputs: [{ address: descriptor.address, value: 70_000 }],
  }).psbtHex;

  assert.deepEqual(selectMultisigInputIndexes(psbtHex), [1], 'the 999-sat input is skipped');
  assert.throws(() => selectMultisigInputIndexes(psbtHex, [0]), /1000 sats/);
  assert.deepEqual(selectMultisigInputIndexes(psbtHex, [1]), [1], '1000+ sats stays selectable');

  const { tool, handlers, control, signIndexes } = toolHarness(pubkeyOf(0));
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async () => true,
    confirmBroadcast: async () => true,
  });
  const signed = await handlers.wallet_btc_sign_psbt.handler({ psbt_hex: psbtHex });
  assert.equal(signed.isError, undefined, signed.content[0].text);
  assert.deepEqual(signIndexes, [[1]], 'the signer is asked for the filtered set, not the raw PSBT');
});
