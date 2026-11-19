import assert from 'node:assert/strict';
import test from 'node:test';
import * as bitcoin from 'bitcoinjs-lib';
import { AddressType, BtcWallet, CoinType } from '@metalet/utxo-wallet-service';
import {
  buildMultisigPsbt,
  combinePsbts,
  createMultisigAddress,
  finalizePsbt,
  selectMultisigInputIndexes,
  summarizePsbt,
  summarizeRawTx,
} from '../src/main/services/btcMultisigScript';
import {
  openMetabotBtcWallet,
  signBtcPsbtPartial,
} from '../src/main/services/btcPartialSign';
import { buildBtcMultisigAgentTools } from '../src/main/libs/btcMultisigAgentTools';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TXID = '11'.repeat(32);

function wallet(index: number) {
  return openMetabotBtcWallet({ mnemonic: MNEMONIC, path: `m/44'/10001'/0'/0/${index}` });
}

function pubkeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => wallet(index).getPublicKey().toString('hex'));
}

test('multisig address is the same for any pubkey order', () => {
  const keys = pubkeys(3);
  const forward = createMultisigAddress(2, keys);
  const reverse = createMultisigAddress(2, [...keys].reverse());
  assert.equal(forward.address, reverse.address);
  assert.equal(forward.witnessScriptHex, reverse.witnessScriptHex);
  assert.equal(forward.address.startsWith('bc1q'), true);
  assert.deepEqual(forward.pubkeys, reverse.pubkeys);
  assert.equal(forward.m, 2);
  assert.equal(forward.n, 3);
});

test('multisig address rejects an impossible threshold and a bad pubkey', () => {
  const keys = pubkeys(2);
  assert.throws(() => createMultisigAddress(3, keys), /threshold/);
  assert.throws(() => createMultisigAddress(1, ['02abcd']), /pubkey/);
  assert.throws(() => createMultisigAddress(1, [keys[0], keys[0]]), /duplicate/);
});

test('a built PSBT spends the multisig script and reports the fee', () => {
  const descriptor = createMultisigAddress(2, pubkeys(3));
  const destination = wallet(0).getAddress();
  const psbtHex = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 100_000 }],
    outputs: [{ address: destination, value: 90_000 }],
  }).psbtHex;
  const summary = summarizePsbt(psbtHex);
  assert.equal(summary.feeSats, 10_000);
  assert.equal(summary.outputs[0].address, destination);
  assert.equal(summary.outputs[0].value, 90_000);
  assert.deepEqual(selectMultisigInputIndexes(psbtHex), [0]);
  assert.equal(summary.inputs[0].partialSigs, 0);
});

test('two partial signatures combine and finalize, and a personal input is not signed', () => {
  const keys = [wallet(0), wallet(1), wallet(2)];
  const descriptor = createMultisigAddress(2, keys.map((item) => item.getPublicKey().toString('hex')));
  const unsigned = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 1, value: 80_000 }],
    outputs: [{ address: descriptor.address, value: 70_000 }],
  }).psbtHex;
  const first = signBtcPsbtPartial(keys[0], { psbtHex: unsigned });
  const second = signBtcPsbtPartial(keys[1], { psbtHex: unsigned });
  assert.equal(summarizePsbt(first.psbtHex).inputs[0].partialSigs, 1);
  const combined = combinePsbts([first.psbtHex, second.psbtHex]);
  assert.equal(summarizePsbt(combined).inputs[0].partialSigs, 2);
  const finalized = finalizePsbt(combined);
  assert.equal(finalized.txid, summarizeRawTx(finalized.rawTx).txid);
  assert.equal(summarizeRawTx(finalized.rawTx).outputs[0].address, descriptor.address);
  assert.throws(() => finalizePsbt(first.psbtHex), /signature/);

  const personal = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
  const prev = new bitcoin.Transaction();
  prev.addInput(Buffer.alloc(32, 2), 0);
  prev.addOutput(bitcoin.address.toOutputScript(keys[0].getAddress(), bitcoin.networks.bitcoin), 50_000);
  personal.addInput({
    hash: prev.getId(),
    index: 0,
    nonWitnessUtxo: prev.toBuffer(),
  });
  personal.addOutput({ address: keys[0].getAddress(), value: 40_000 });
  let calls = 0;
  assert.throws(
    () => signBtcPsbtPartial({
      signTx() {
        calls += 1;
        return { psbtHex: 'should-not-run', rawTx: '' };
      },
    }, { psbtHex: personal.toHex() }),
    /multisig/,
  );
  assert.equal(calls, 0);
});

test('partial sign always asks the wallet not to finalize', () => {
  const descriptor = createMultisigAddress(2, pubkeys(3));
  const unsigned = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 20_000 }],
    outputs: [{ address: descriptor.address, value: 15_000 }],
  }).psbtHex;
  let seen: { autoFinalized?: boolean; toSignInputs?: Array<{ index: number }> } | null = null;
  const signed = signBtcPsbtPartial({
    signTx(_type, params) {
      seen = params;
      return { psbtHex: `${unsigned}aa`, rawTx: '' };
    },
  }, { psbtHex: unsigned });
  assert.equal(seen?.autoFinalized, false);
  assert.deepEqual(seen?.toSignInputs, [{ index: 0, sighashTypes: [1] }]);
  assert.equal(signed.psbtHex.endsWith('aa'), true);
});

test('open wallet rejects a missing mnemonic', () => {
  assert.throws(() => openMetabotBtcWallet({ mnemonic: '  ' }), /mnemonic/);
  const opened = openMetabotBtcWallet({ mnemonic: MNEMONIC });
  assert.equal(opened.getPublicKey().length, 33);
  assert.equal(new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex: 0,
    network: 'livenet',
    mnemonic: MNEMONIC,
  }).getAddress(), opened.getAddress());
});

function toolHarness() {
  const handlers: Record<string, { handler: (args: any) => Promise<any> }> = {};
  const tool = (name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) => {
    handlers[name] = { handler };
    return { name };
  };
  const calls: string[] = [];
  const control = {
    getBtcSignerIdentity(metabotId: number) {
      calls.push(`pubkey:${metabotId}`);
      return { address: '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB', publicKey: pubkeys(1)[0] };
    },
    signBtcPsbtPartial(metabotId: number, input: { psbtHex: string }) {
      calls.push(`sign:${metabotId}:${input.psbtHex.length}`);
      return { psbtHex: 'signed-psbt' };
    },
    broadcastBtcTx(rawTx: string) {
      calls.push(`broadcast:${rawTx.length}`);
      return Promise.resolve('broadcast-txid');
    },
    listBtcUtxos(address: string) {
      calls.push(`utxos:${address}`);
      return Promise.resolve([{ txid: 'ab'.repeat(32), vout: 1, value: 80_000 }]);
    },
  };
  return { tool, handlers, control, calls };
}

test('sign and broadcast wait for the owner and do not run when declined', async () => {
  const { tool, handlers, control, calls } = toolHarness();
  const descriptor = createMultisigAddress(2, pubkeys(3));
  const psbtHex = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 50_000 }],
    outputs: [{ address: descriptor.address, value: 40_000 }],
  }).psbtHex;
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async () => false,
    confirmBroadcast: async () => false,
  });

  const pubkey = await handlers.wallet_btc_pubkey.handler({});
  assert.match(pubkey.content[0].text, /public_key/);
  assert.match(pubkey.content[0].text, new RegExp(pubkeys(1)[0]));

  const declined = await handlers.wallet_btc_sign_psbt.handler({ psbt_hex: psbtHex });
  assert.equal(declined.isError, true);
  assert.match(declined.content[0].text, /declined/);
  assert.equal(calls.some((call) => call.startsWith('sign:')), false);

  const raw = finalizePsbt(combinePsbts([
    signBtcPsbtPartial(wallet(0), { psbtHex }).psbtHex,
    signBtcPsbtPartial(wallet(1), { psbtHex }).psbtHex,
  ])).rawTx;
  const broadcast = await handlers.wallet_btc_broadcast.handler({ raw_tx: raw });
  assert.equal(broadcast.isError, true);
  assert.equal(calls.some((call) => call.startsWith('broadcast:')), false);
});

test('utxo tool returns outpoints for the vault address', async () => {
  const { tool, handlers, control, calls } = toolHarness();
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async () => false,
    confirmBroadcast: async () => false,
  });
  const result = await handlers.wallet_btc_utxos.handler({ address: 'bc1qvault' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, new RegExp(`${'ab'.repeat(32)}:1`));
  assert.match(result.content[0].text, /80000 sats/);
  assert.deepEqual(calls.filter((call) => call.startsWith('utxos:')), ['utxos:bc1qvault']);
});

test('address and finalize tools use the same script helpers', async () => {
  const { tool, handlers, control } = toolHarness();
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async () => false,
    confirmBroadcast: async () => false,
  });
  const keys = pubkeys(3);
  const expected = createMultisigAddress(2, keys);
  const created = await handlers.wallet_btc_multisig_address.handler({ m: 2, pubkeys: [...keys].reverse() });
  assert.match(created.content[0].text, new RegExp(expected.address));
  assert.match(created.content[0].text, /witness_script/);
});

test('approved sign returns the partial PSBT and approved broadcast returns the txid', async () => {
  const { tool, handlers, control, calls } = toolHarness();
  const descriptor = createMultisigAddress(2, pubkeys(3));
  const psbtHex = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 50_000 }],
    outputs: [{ address: descriptor.address, value: 40_000 }],
  }).psbtHex;
  const questions: string[] = [];
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async (question) => {
      questions.push(question);
      return true;
    },
    confirmBroadcast: async (question) => {
      questions.push(question);
      return true;
    },
  });
  const signed = await handlers.wallet_btc_sign_psbt.handler({ psbt_hex: psbtHex });
  assert.equal(signed.isError, undefined);
  assert.match(signed.content[0].text, /signed-psbt/);
  assert.match(questions[0], /40,000|40000/);
  assert.match(questions[0], /does not broadcast/);
  const raw = finalizePsbt(combinePsbts([
    signBtcPsbtPartial(wallet(0), { psbtHex }).psbtHex,
    signBtcPsbtPartial(wallet(1), { psbtHex }).psbtHex,
  ])).rawTx;
  const broadcast = await handlers.wallet_btc_broadcast.handler({ raw_tx: raw });
  assert.match(broadcast.content[0].text, /broadcast-txid/);
  assert.match(questions[1], /irreversible/);
  assert.equal(calls.filter((call) => call.startsWith('sign:')).length, 1);
});

/**
 * An EXTERNAL PSBT — the shape a Metalet co-signer can hand back: built with
 * bitcoinjs directly, bypassing buildMultisigPsbt's own floors. This is the
 * hole the 2026-11-19 release review flagged: everything inside IDBots is
 * floored, but finalize/broadcast previously accepted outside-built PSBTs
 * unchecked. (Our own signer refuses sub-floor inputs at selection time, so
 * the 546-sat cases stay unsigned here — exactly how an external PSBT arrives
 * before some OTHER party's signatures would be collected.)
 */
function externallyBuiltPsbt(value: number): string {
  const descriptor = createMultisigAddress(2, pubkeys(2));
  const witnessScript = Buffer.from(descriptor.witnessScriptHex, 'hex');
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
  // The prevout of a P2WSH output is the P2WSH lockscript; the multisig
  // witness script rides separately (exactly how an external tool sees it).
  psbt.addInput({
    hash: TXID,
    index: 0,
    witnessUtxo: { script: bitcoin.address.toOutputScript(descriptor.address, bitcoin.networks.bitcoin), value },
    witnessScript,
  });
  psbt.addOutput({ address: descriptor.address, value: value - 46 });
  return psbt.toHex();
}

/** A hand-built raw tx (no witness — txid never covers witness data) whose
 *  single input/output mirror a PSBT's unsigned transaction, for broadcast
 *  dialog cross-check cases without going through our finalize. */
function handBuiltRawTx(address: string, outputValue: number): string {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(TXID, 'hex'), 0);
  tx.addOutput(bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin), outputValue);
  return tx.toHex();
}

function signedCombined(psbtHex: string): string {
  return combinePsbts([
    signBtcPsbtPartial(wallet(0), { psbtHex }).psbtHex,
    signBtcPsbtPartial(wallet(1), { psbtHex }).psbtHex,
  ]);
}

test('finalize refuses an externally co-signed PSBT that spends a sub-floor carrier input', () => {
  assert.throws(() => finalizePsbt(externallyBuiltPsbt(546)), /inscription-carrier floor/);
});

test('1000 sats exactly passes the carrier floor at finalize (owner ruling)', () => {
  const finalized = finalizePsbt(signedCombined(externallyBuiltPsbt(1000)));
  assert.equal(finalized.txid, summarizeRawTx(finalized.rawTx).txid);
});

test('broadcast shows inputs and fee from psbt_hex and refuses mismatch or carrier-floor inputs', async () => {
  const { tool, handlers, control, calls } = toolHarness();
  const questions: string[] = [];
  buildBtcMultisigAgentTools({
    tool: tool as any,
    control,
    sessionId: 's1',
    resolveMetabotId: () => 7,
    confirmSign: async () => true,
    confirmBroadcast: async (question) => {
      questions.push(question);
      return true;
    },
  });

  const descriptor = createMultisigAddress(2, pubkeys(3));
  const psbtHex = buildMultisigPsbt({
    witnessScriptHex: descriptor.witnessScriptHex,
    inputs: [{ txid: TXID, vout: 0, value: 50_000 }],
    outputs: [{ address: descriptor.address, value: 40_000 }],
  }).psbtHex;
  const combined = signedCombined(psbtHex);
  const raw = finalizePsbt(combined).rawTx;

  const ok = await handlers.wallet_btc_broadcast.handler({ raw_tx: raw, psbt_hex: combined });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /broadcast-txid/);
  assert.match(questions[0], /inputs:/);
  assert.match(questions[0], /50000 sats/);
  assert.match(questions[0], /fee: 10000 sats/);
  assert.equal(calls.filter((call) => call.startsWith('broadcast:')).length, 1);

  // A psbt_hex that is NOT the raw_tx's transaction refuses: the dialog would
  // describe one transaction while broadcasting another.
  const mismatch = await handlers.wallet_btc_broadcast.handler({ raw_tx: handBuiltRawTx(descriptor.address, 12_345), psbt_hex: combined });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /commits to/);

  // A 546-sat carrier input refuses at the dialog too (defense in depth
  // behind finalize — an external PSBT paired with its matching raw tx).
  const floorDescriptor = createMultisigAddress(2, pubkeys(2));
  const floorPsbt = externallyBuiltPsbt(546);
  const floorRaw = handBuiltRawTx(floorDescriptor.address, 500);
  const floored = await handlers.wallet_btc_broadcast.handler({ raw_tx: floorRaw, psbt_hex: floorPsbt });
  assert.equal(floored.isError, true);
  assert.match(floored.content[0].text, /inscription-carrier floor/);

  // Without psbt_hex the card says inputs/fee are unknown — and still works.
  const before = calls.filter((call) => call.startsWith('broadcast:')).length;
  const blind = await handlers.wallet_btc_broadcast.handler({ raw_tx: raw });
  assert.equal(blind.isError, undefined);
  assert.match(questions[questions.length - 1], /unknown/);
  assert.equal(calls.filter((call) => call.startsWith('broadcast:')).length, before + 1);
});
