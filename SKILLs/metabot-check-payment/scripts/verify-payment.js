#!/usr/bin/env node
'use strict';

/**
 * IDBots metabot-check-payment: verify chain payment from Metalet raw tx (MVC/SPACE, BTC, DOGE).
 * Logic aligned with src/main/services/orderPayment.ts; extended with payer hints, full tx parse,
 * and confirmed/unconfirmed via Metalet address UTXO APIs (BTC: `confirmed`, MVC/DOGE: height > 0).
 *
 * Node.js 18+ (global fetch). No dependency on Electron or src/main imports.
 */

const crypto = require('crypto');

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const SATOSHI_PER_UNIT = 100_000_000;

function writeStderr(msg) {
  try {
    process.stderr.write(String(msg) + '\n');
  } catch {
    /* noop */
  }
}

function readVarInt(buf, offset) {
  const first = buf[offset];
  if (first < 0xfd) return { value: first, bytesRead: 1 };
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), bytesRead: 3 };
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), bytesRead: 5 };
  const lo = buf.readUInt32LE(offset + 1);
  const hi = buf.readUInt32LE(offset + 5);
  return { value: hi * 0x100000000 + lo, bytesRead: 9 };
}

function hash160(buf) {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

function pubkeyHashFromBase58Address(address) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt(0);
  for (const char of address) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) return null;
    num = num * BigInt(58) + BigInt(idx);
  }
  let hex = num.toString(16);
  while (hex.length < 50) hex = '0' + hex;
  return hex.slice(2, 42);
}

function pubkeyHashFromBech32Address(address) {
  const lower = address.toLowerCase();
  if (!lower.startsWith('bc1q') && !lower.startsWith('tb1q')) return null;
  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hrpEnd = lower.lastIndexOf('1');
  const dataPart = lower.slice(hrpEnd + 1);
  const values = [];
  for (const c of dataPart) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx < 0) return null;
    values.push(idx);
  }
  const payload5bit = values.slice(1, values.length - 6);
  let acc = 0;
  let bits = 0;
  const bytes = [];
  for (const val of payload5bit) {
    acc = (acc << 5) | val;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 20) return null;
  return Buffer.from(bytes).toString('hex');
}

function pubkeyHashFromAddress(address) {
  if (!address || !String(address).trim()) return null;
  const a = String(address).trim();
  if (a.startsWith('bc1') || a.startsWith('tb1')) return pubkeyHashFromBech32Address(a);
  return pubkeyHashFromBase58Address(a);
}

function extractPubkeyHashFromScript(scriptHex) {
  if (scriptHex.length === 50 && scriptHex.startsWith('76a914') && scriptHex.endsWith('88ac')) {
    return scriptHex.slice(6, 46);
  }
  if (scriptHex.length === 46 && scriptHex.startsWith('a914') && scriptHex.endsWith('87')) {
    return scriptHex.slice(4, 44);
  }
  if (scriptHex.length === 44 && scriptHex.startsWith('0014')) {
    return scriptHex.slice(4, 44);
  }
  return null;
}

function parsePushes(scriptBuf) {
  const out = [];
  let i = 0;
  while (i < scriptBuf.length) {
    const op = scriptBuf[i];
    if (op >= 0x01 && op <= 0x4b) {
      const len = op;
      const end = i + 1 + len;
      if (end > scriptBuf.length) break;
      out.push(scriptBuf.subarray(i + 1, end));
      i = end;
      continue;
    }
    if (op === 0x4c) {
      const len = scriptBuf[i + 1];
      const end = i + 2 + len;
      if (end > scriptBuf.length) break;
      out.push(scriptBuf.subarray(i + 2, end));
      i = end;
      continue;
    }
    if (op === 0x4d) {
      const len = scriptBuf.readUInt16LE(i + 1);
      const end = i + 3 + len;
      if (end > scriptBuf.length) break;
      out.push(scriptBuf.subarray(i + 3, end));
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

function extractPubkeysFromPushData(data) {
  const pubs = [];
  if (!data || data.length < 33) return pubs;
  if (data.length === 33 && (data[0] === 0x02 || data[0] === 0x03)) pubs.push(data);
  if (data.length === 65 && data[0] === 0x04) pubs.push(data);
  return pubs;
}

function collectInputSignerHashes(input) {
  const hashes = new Set();
  const sigScript = Buffer.from(input.scriptSigHex || '', 'hex');
  for (const push of parsePushes(sigScript)) {
    for (const pk of extractPubkeysFromPushData(push)) {
      hashes.add(hash160(pk).toString('hex'));
    }
  }
  if (input.witnessStacks && input.witnessStacks.length) {
    for (const stack of input.witnessStacks) {
      for (const item of stack) {
        for (const pk of extractPubkeysFromPushData(item)) {
          hashes.add(hash160(pk).toString('hex'));
        }
      }
    }
  }
  return Array.from(hashes);
}

function parseFullTx(rawHex) {
  const buf = Buffer.from(rawHex, 'hex');
  let o = 4;
  let segwit = false;
  if (buf[o] === 0x00 && buf[o + 1] !== 0x00) {
    segwit = true;
    o += 2;
  }
  const ic = readVarInt(buf, o);
  o += ic.bytesRead;
  const inputs = [];
  for (let i = 0; i < ic.value; i++) {
    o += 32;
    o += 4;
    const sl = readVarInt(buf, o);
    o += sl.bytesRead;
    const scriptLen = sl.value;
    const scriptSig = buf.subarray(o, o + scriptLen);
    o += scriptLen;
    o += 4;
    inputs.push({ scriptSigHex: scriptSig.toString('hex'), witnessStacks: [] });
  }
  const oc = readVarInt(buf, o);
  o += oc.bytesRead;
  const outputs = [];
  for (let i = 0; i < oc.value; i++) {
    const valueSats = Number(buf.readBigUInt64LE(o));
    o += 8;
    const sl = readVarInt(buf, o);
    o += sl.bytesRead;
    const scriptLen = sl.value;
    const scriptPubKeyHex = buf.subarray(o, o + scriptLen).toString('hex');
    o += scriptLen;
    outputs.push({ valueSats, scriptPubKeyHex });
  }
  if (segwit) {
    for (let i = 0; i < ic.value; i++) {
      const wic = readVarInt(buf, o);
      o += wic.bytesRead;
      const stack = [];
      for (let w = 0; w < wic.value; w++) {
        const wl = readVarInt(buf, o);
        o += wl.bytesRead;
        const item = buf.subarray(o, o + wl.value);
        o += wl.value;
        stack.push(item);
      }
      inputs[i].witnessStacks.push(stack);
    }
  }
  return { inputs, outputs, segwit };
}

async function fetchRawTxHex(chain, txId) {
  let url;
  if (chain === 'btc') {
    url = `${METALET_HOST}/wallet-api/v3/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}&chain=btc`;
  } else if (chain === 'doge') {
    url = `${METALET_HOST}/wallet-api/v4/doge/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}`;
  } else {
    url = `${METALET_HOST}/wallet-api/v4/mvc/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}`;
  }
  const res = await fetch(url);
  const json = await res.json();
  return { json, okHttp: res.ok };
}

/**
 * Paginated UTXO list (MVC / DOGE) — same shape as IDBots metaidApi / doge helpers.
 */
async function fetchV4UtxoListAll(chainSegment, address) {
  const all = [];
  let flag;
  for (let guard = 0; guard < 250; guard++) {
    const params = new URLSearchParams({ address, net: NET });
    if (flag) params.set('flag', flag);
    const url = `${METALET_HOST}/wallet-api/v4/${chainSegment}/address/utxo-list?${params}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.code !== 0) {
      return { error: json.message || `${chainSegment}_utxo_list_failed`, list: all };
    }
    const list = json.data?.list ?? [];
    if (list.length === 0) break;
    all.push(...list);
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return { list: all };
}

async function fetchBtcUtxosForAddress(address) {
  const url = `${METALET_HOST}/wallet-api/v3/address/btc-utxo?net=${NET}&address=${encodeURIComponent(address)}&unconfirmed=1`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== 0) {
    return { error: json.message || 'btc_utxo_failed', list: [] };
  }
  const data = json.data;
  const list = Array.isArray(data) ? data : [];
  return { list };
}

/**
 * Uses Metalet address-UTXO endpoints: BTC exposes `confirmed`; MVC/DOGE use `height` (>0 = confirmed).
 * If no matching UTXO is found, the tx may still be confirmed but outputs already spent — report unknown.
 */
async function resolvePaymentConfirmation(chain, recipientAddress, txid, recipientVoutSet) {
  const txLower = txid.toLowerCase();
  if (recipientVoutSet.size === 0) {
    return {
      confirmationStatus: 'unknown',
      confirmationReason: 'no_outputs_to_recipient_in_parsed_tx',
    };
  }
  try {
    if (chain === 'btc') {
      const { list, error } = await fetchBtcUtxosForAddress(recipientAddress);
      if (error) {
        return { confirmationStatus: 'unknown', confirmationReason: `btc_utxo: ${error}` };
      }
      const matches = list.filter((u) => {
        const tid = String(u.txId || '').toLowerCase();
        const outIdx = u.outputIndex ?? u.vout;
        return tid === txLower && recipientVoutSet.has(outIdx);
      });
      if (matches.length === 0) {
        return {
          confirmationStatus: 'unknown',
          confirmationReason:
            'no_matching_utxo_on_recipient_address_outputs_may_be_spent_or_indexer_lag',
        };
      }
      const allConfirmed = matches.every((m) => m.confirmed !== false);
      return { confirmationStatus: allConfirmed ? 'confirmed' : 'unconfirmed' };
    }

    const segment = chain === 'doge' ? 'doge' : 'mvc';
    const { list, error } = await fetchV4UtxoListAll(segment, recipientAddress);
    if (error) {
      return { confirmationStatus: 'unknown', confirmationReason: `${segment}_utxo: ${error}` };
    }
    const matches = list.filter((u) => {
      const tid = String(u.txid || '').toLowerCase();
      const outIdx = u.outIndex;
      return tid === txLower && recipientVoutSet.has(outIdx);
    });
    if (matches.length === 0) {
      return {
        confirmationStatus: 'unknown',
        confirmationReason:
          'no_matching_utxo_on_recipient_address_outputs_may_be_spent_or_indexer_lag',
      };
    }
    const allConfirmed = matches.every((m) => Number(m.height) > 0);
    return { confirmationStatus: allConfirmed ? 'confirmed' : 'unconfirmed' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { confirmationStatus: 'unknown', confirmationReason: msg };
  }
}

function normalizeCurrency(c) {
  const u = String(c || '').trim().toUpperCase();
  if (u === 'SPACE' || u === 'MVC' || u === 'BSV') return { currency: 'SPACE', chain: 'mvc' };
  if (u === 'BTC') return { currency: 'BTC', chain: 'btc' };
  if (u === 'DOGE') return { currency: 'DOGE', chain: 'doge' };
  return null;
}

function parseArgs(argv) {
  const out = {
    txid: '',
    currency: '',
    expectedAmount: '',
    recipientAddress: '',
    payerAddress: '',
    tolerancePercent: '1',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--txid' && next) {
      out.txid = next;
      i++;
    } else if (a === '--currency' && next) {
      out.currency = next;
      i++;
    } else if (a === '--expected-amount' && next) {
      out.expectedAmount = next;
      i++;
    } else if (a === '--recipient-address' && next) {
      out.recipientAddress = next;
      i++;
    } else if (a === '--payer-address' && next) {
      out.payerAddress = next;
      i++;
    } else if (a === '--tolerance-percent' && next) {
      out.tolerancePercent = next;
      i++;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function printHelp() {
  writeStderr(`Usage:
  node verify-payment.js \\
    --txid <64-char hex> \\
    --currency SPACE|BTC|DOGE|MVC \\
    --expected-amount <decimal> \\
    --recipient-address <address> \\
    [--payer-address <address>] \\
    [--tolerance-percent 1]

Stdout: one JSON object.`);
}

function buildResult(base) {
  return JSON.stringify(base, null, 0);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const txid = (args.txid || '').trim();
  const cur = normalizeCurrency(args.currency);
  const expectedAmountStr = (args.expectedAmount || '').trim();
  const recipientAddress = (args.recipientAddress || '').trim();
  const payerAddress = (args.payerAddress || '').trim();
  const tolPct = Math.max(0, parseFloat(args.tolerancePercent) || 1);

  const fail = (obj, code = 1) => {
    process.stdout.write(buildResult({ success: false, ...obj }) + '\n');
    process.exit(code);
  };

  if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    fail({ error: 'invalid_or_missing_txid', txid: txid || null });
  }
  if (!cur) {
    fail({ error: 'invalid_currency', txid });
  }
  const amount = parseFloat(expectedAmountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    fail({ error: 'invalid_expected_amount', txid, chain: cur.chain });
  }
  const expectedSats = Math.floor(amount * SATOSHI_PER_UNIT);
  if (expectedSats <= 0) {
    fail({ error: 'expected_sats_zero', txid, chain: cur.chain });
  }
  const recipientHash = pubkeyHashFromAddress(recipientAddress);
  if (!recipientAddress || !recipientHash) {
    fail({ error: 'invalid_recipient_address', txid, chain: cur.chain });
  }

  const payerHash = payerAddress ? pubkeyHashFromAddress(payerAddress) : null;
  if (payerAddress && !payerHash) {
    fail({ error: 'invalid_payer_address', txid, chain: cur.chain });
  }

  let fetchResult;
  try {
    fetchResult = await fetchRawTxHex(cur.chain, txid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail({
      txid,
      chain: cur.chain,
      txFound: false,
      confirmationStatus: 'fetch_error',
      payerMatch: payerHash ? 'inconclusive' : 'no_payer_info',
      amountMatch: 'tx_not_found',
      error: msg,
    });
  }

  const { json, okHttp } = fetchResult;
  const code = json && typeof json.code === 'number' ? json.code : null;
  const data = json && json.data;
  let rawHex = '';
  if (typeof data === 'string') rawHex = data;
  else if (data && typeof data === 'object') rawHex = data.rawTx || data.hex || '';

  if (!okHttp || (code !== null && code !== 0) || !rawHex) {
    const msg = (json && json.message) || 'tx_not_found';
    process.stdout.write(
      buildResult({
        success: true,
        txid,
        chain: cur.chain,
        txFound: false,
        confirmationStatus: 'not_found',
        payerMatch: payerHash ? 'inconclusive' : 'no_payer_info',
        amountMatch: 'tx_not_found',
        expectedAmount: amount,
        expectedCurrency: cur.currency,
        expectedSats,
        recipientAddress,
        recipientReceivedSats: 0,
        message: msg,
      }) + '\n'
    );
    process.exit(0);
  }

  let parsed;
  try {
    parsed = parseFullTx(rawHex);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail({
      txFound: true,
      confirmationStatus: 'unknown',
      confirmationReason: 'raw_tx_parse_failed',
      payerMatch: payerHash ? 'inconclusive' : 'no_payer_info',
      amountMatch: 'parse_error',
      error: msg,
    });
  }

  const toleranceSats = Math.max(Math.floor(expectedSats * (tolPct / 100)), 1);
  const minAcceptableSats = expectedSats - toleranceSats;
  let totalReceivedSats = 0;
  const outputDetails = [];
  const recipientVoutSet = new Set();
  for (let vout = 0; vout < parsed.outputs.length; vout++) {
    const output = parsed.outputs[vout];
    const oh = extractPubkeyHashFromScript(output.scriptPubKeyHex);
    const row = { vout, valueSats: output.valueSats, scriptPubKeyHash: oh };
    if (oh && oh === recipientHash) {
      totalReceivedSats += output.valueSats;
      row.paysRecipient = true;
      recipientVoutSet.add(vout);
    }
    outputDetails.push(row);
  }

  const amountMatch =
    totalReceivedSats <= 0
      ? 'no'
      : totalReceivedSats >= minAcceptableSats
        ? 'yes'
        : 'no';

  const allSignerHashes = new Set();
  for (const input of parsed.inputs) {
    for (const h of collectInputSignerHashes(input)) {
      allSignerHashes.add(h);
    }
  }

  let payerMatch = 'no_payer_info';
  if (payerHash) {
    if (allSignerHashes.size === 0) {
      payerMatch = 'inconclusive';
    } else if (allSignerHashes.has(payerHash)) {
      payerMatch = 'yes';
    } else {
      payerMatch = 'no';
    }
  }

  const conf = await resolvePaymentConfirmation(cur.chain, recipientAddress, txid, recipientVoutSet);
  const outPayload = {
    success: true,
    txid,
    chain: cur.chain,
    txFound: true,
    confirmationStatus: conf.confirmationStatus,
    payerMatch,
    amountMatch,
    expectedAmount: amount,
    expectedCurrency: cur.currency,
    expectedSats,
    minAcceptableSats,
    recipientAddress,
    recipientReceivedSats: totalReceivedSats,
    recipientOutputVouts: Array.from(recipientVoutSet).sort((a, b) => a - b),
    inputSignerPubkeyHashCount: allSignerHashes.size,
    outputsSummary: outputDetails,
  };
  if (conf.confirmationReason) {
    outPayload.confirmationReason = conf.confirmationReason;
  }
  outPayload.confirmationNote =
    'Derived from Metalet address UTXO APIs: BTC uses list item `confirmed`; MVC/DOGE use `height`>0. If outputs were already spent, status may be unknown.';

  process.stdout.write(buildResult(outPayload) + '\n');
  process.exit(0);
}

main().catch((e) => {
  writeStderr(e instanceof Error ? e.message : String(e));
  process.stdout.write(
    buildResult({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }) + '\n'
  );
  process.exit(1);
});
