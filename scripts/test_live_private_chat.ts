#!/usr/bin/env npx ts-node
/**
 * Live E2E test: send encrypted "hello" to chain robot, wait for decrypted reply.
 * SDD Task 14 mandatory self-test. Uses real MVC network.
 *
 * Run from project root: npx ts-node -P tsconfig.json scripts/test_live_private_chat.ts
 * Or: npm run compile:electron && node --loader ts-node/esm scripts/test_live_private_chat.ts
 */

import * as crypto from 'crypto';
import { TxComposer, mvc } from 'meta-contract';
import CryptoJS from 'crypto-js';

const MNEMONIC = 'master burger bread pretty venture public adapt bonus jacket envelope pet increase';
const TARGET_GLOBAL_META_ID = 'idq1zfazvxaq69uw6txe3ewce30ewyhy9a7mzykgv0';
const TARGET_ADDRESS = '1BbhP2uP9gKZ5EEvoNfsYJDwdgLLJfb66K';
const MANAPI_BASE = 'https://manapi.metaid.io';
const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const WAIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

function parseAddressIndexFromPath(pathStr: string): number {
  const m = pathStr.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function getPrivateKeyBuffer(mnemonic: string, pathStr: string): Buffer {
  const network = mvc.Networks.livenet;
  const mneObj = mvc.Mnemonic.fromString(mnemonic);
  const hdpk = mneObj.toHDPrivateKey('', network as unknown as string);
  const addressIndex = parseAddressIndexFromPath(pathStr);
  const derivePath = `m/44'/10001'/0'/0/${addressIndex}`;
  const childPk = hdpk.deriveChild(derivePath);
  const privateKey = childPk.privateKey;
  const privKey = mvc.PrivateKey.fromWIF(privateKey.toWIF());
  return Buffer.from((privKey as { bn: { toArray: (e: string, n: number) => number[] } }).bn.toArray('be', 32));
}

function computeEcdhSharedSecret(privateKey32: Buffer, peerPublicKeyHex: string): string {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey32);
  const secret = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, 'hex'));
  return secret.toString('hex');
}

const ZERO_IV = CryptoJS.enc.Utf8.parse('0000000000000000');

const PRIVATE_CHAT_SALT = (CryptoJS.lib.WordArray as { create: (words: number[], sigBytes?: number) => CryptoJS.lib.WordArray }).create([180470613, 109027952], 8);

/** Passphrase mode with fixed salt (deterministic, matches wallet when ECDH matches). */
function ecdhEncrypt(plaintext: string, sharedSecretHex: string): string {
  const cipherParams = (CryptoJS.lib.PasswordBasedCipher as {
    encrypt: (c: unknown, m: CryptoJS.lib.WordArray, p: string, cfg: { salt: CryptoJS.lib.WordArray; format: unknown }) => CryptoJS.lib.CipherParams;
  }).encrypt(CryptoJS.algo.AES, CryptoJS.enc.Utf8.parse(String(plaintext ?? '')), String(sharedSecretHex ?? ''), {
    salt: PRIVATE_CHAT_SALT,
    format: CryptoJS.format.OpenSSL,
  });
  return cipherParams.toString();
}

function ecdhDecrypt(cipherText: string, sharedSecretHex: string): string {
  const secretStr = String(sharedSecretHex ?? '').trim();
  const isHex64 = secretStr.length === 64 && /^[0-9a-fA-F]+$/.test(secretStr);
  if (isHex64 && cipherText && !cipherText.startsWith('U2FsdGVkX1')) {
    try {
      const key = CryptoJS.enc.Hex.parse(secretStr);
      const bytes = CryptoJS.AES.decrypt(cipherText, key, {
        iv: ZERO_IV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });
      const out = bytes.toString(CryptoJS.enc.Utf8);
      if (out) return out;
    } catch {
      // fall through
    }
  }
  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, secretStr);
    return bytes.toString(CryptoJS.enc.Utf8) || cipherText;
  } catch {
    return cipherText;
  }
}

async function fetchTargetChatPubkey(): Promise<string> {
  const url = `${MANAPI_BASE}/address/pin/list/${encodeURIComponent(TARGET_ADDRESS)}?path=/info/chatpubkey&cursor=0&size=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manapi list failed: ${res.status}`);
  const json = (await res.json()) as { code?: number; data?: { list?: unknown[] } };
  const list = json?.data?.list ?? [];
  const pin = list[0] as Record<string, unknown> | undefined;
  if (!pin) throw new Error('No /info/chatpubkey pin found for target');
  const body = String(pin.contentBody || pin.contentSummary || '').trim();
  if (!body) throw new Error('Empty chatpubkey content');
  return body;
}

async function fetchMVCUtxos(address: string): Promise<{ txid: string; outIndex: number; value: number; height: number }[]> {
  const all: { txid: string; outIndex: number; value: number; height: number }[] = [];
  let flag: string | undefined;
  while (true) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const res = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const data = (await res.json()) as { data?: { list?: Array<{ txid: string; outIndex: number; value: number; height: number; flag?: string }> } };
    const list = data?.data?.list ?? [];
    if (!list.length) break;
    all.push(...list.filter((u) => u.value >= 600));
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
}

async function broadcastTx(rawTx: string): Promise<string> {
  const res = await fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: NET, rawTx }),
  });
  const json = (await res.json()) as { code?: number; message?: string; data?: string };
  if (json?.code !== 0) throw new Error(json?.message ?? 'Broadcast failed');
  return json.data ?? '';
}

async function buildAndBroadcastSimpleMsg(
  ourAddress: string,
  privateKey: mvc.PrivateKey,
  toGlobalMetaId: string,
  encryptedContent: string
): Promise<string> {
  const body = JSON.stringify({
    to: toGlobalMetaId,
    timestamp: Math.floor(Date.now() / 1000),
    content: encryptedContent,
    contentType: 'text/plain',
    encrypt: 'ecdh',
    replyPin: '',
  });
  const opReturnData = ['metaid', 'create', '/protocols/simplemsg', '0', '1.0.0', 'application/json', Buffer.from(body, 'utf-8')];
  const utxos = await fetchMVCUtxos(ourAddress);
  if (!utxos.length) throw new Error('No UTXOs for sender');
  const feeRate = 1;
  const txComposer = new TxComposer();
  const network = mvc.Networks.livenet;
  txComposer.appendP2PKHOutput({
    address: new mvc.Address(ourAddress, network as unknown as string),
    satoshis: 1,
  });
  txComposer.appendOpReturnOutput(opReturnData);
  const tx = txComposer.tx;
  const totalOut = tx.outputs.reduce((s, o) => s + o.satoshis, 0);
  const needed = totalOut + 34 * 2 * feeRate + 200;
  const picked: typeof utxos = [];
  let sum = 0;
  for (const u of utxos.sort((a, b) => b.height - a.height)) {
    picked.push(u);
    sum += u.value;
    if (sum >= needed) break;
  }
  if (sum < needed) throw new Error('Insufficient balance');
  const addressObj = new mvc.Address(ourAddress, network as unknown as string);
  for (const u of picked) {
    txComposer.appendP2PKHInput({
      address: addressObj,
      txId: u.txid,
      outputIndex: u.outIndex,
      satoshis: u.value,
    });
  }
  txComposer.appendChangeOutput(addressObj, feeRate);
  for (let i = 0; i < tx.inputs.length; i++) {
    txComposer.unlockP2PKHInput(privateKey, i);
  }
  const rawHex = txComposer.getRawHex();
  return broadcastTx(rawHex);
}

async function listSimpleMsgPinsToAddress(address: string): Promise<{ id: string; creator: string; timestamp: number }[]> {
  const url = `${MANAPI_BASE}/address/pin/list/${encodeURIComponent(address)}?path=/protocols/simplemsg&cursor=0&size=100`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: { list?: Array<{ id: string; creator?: string; timestamp?: number }> } };
  const list = json?.data?.list ?? [];
  return list.map((p) => ({ id: p.id, creator: p.creator ?? '', timestamp: p.timestamp ?? 0 }));
}

async function getPinContentBody(pinId: string): Promise<string> {
  const res = await fetch(`${MANAPI_BASE}/pin/${encodeURIComponent(pinId)}`);
  if (!res.ok) throw new Error(`getPin failed: ${res.status}`);
  const json = (await res.json()) as { data?: { contentBody?: string } };
  return (json?.data?.contentBody ?? '').trim();
}

async function main(): Promise<void> {
  const pathStr = "m/44'/10001'/0'/0/0";
  const network = mvc.Networks.livenet;
  const mneObj = mvc.Mnemonic.fromString(MNEMONIC);
  const hdpk = mneObj.toHDPrivateKey('', network as unknown as string);
  const addressIndex = parseAddressIndexFromPath(pathStr);
  const derivePath = `m/44'/10001'/0'/0/${addressIndex}`;
  const childPk = hdpk.deriveChild(derivePath);
  const ourAddress = childPk.publicKey.toAddress(network as unknown as string).toString();
  const privateKey = childPk.privateKey;

  console.log('[TEST] Fetching target robot chat public key...');
  const targetChatPubkey = await fetchTargetChatPubkey();
  console.log('[TEST] Target chatpubkey length:', targetChatPubkey.length);
  console.log('[TEST] Target chatpubkey (first 20 hex):', targetChatPubkey.slice(0, 20));
  console.log('[TEST] Target chatpubkey (last 20 hex):', targetChatPubkey.slice(-20));

  const privateKeyBuffer = getPrivateKeyBuffer(MNEMONIC, pathStr);
  const sharedSecret = computeEcdhSharedSecret(privateKeyBuffer, targetChatPubkey);
  console.log('[TEST] Shared secret length (hex chars):', sharedSecret.length);
  console.log('[TEST] Shared secret (first 20 hex):', sharedSecret.slice(0, 20));
  console.log('[TEST] Shared secret (last 20 hex):', sharedSecret.slice(-20));

  const plaintext = 'hello';
  console.log('[TEST] --- Encryption parameters ---');
  console.log('[TEST] peer chatpubkey (hex, first 20 / last 20):', targetChatPubkey.slice(0, 20), '...', targetChatPubkey.slice(-20));
  console.log('[TEST] sharedSecret (hex, first 20 / last 20):', sharedSecret.slice(0, 20), '...', sharedSecret.slice(-20));
  console.log('[TEST] encrypt: AES.encrypt(String(plaintext), String(sharedSecret)).toString() -> Salted__ base64');
  const encryptedHello = ecdhEncrypt(plaintext, sharedSecret);
  console.log('[TEST] encrypted content (base64) length:', encryptedHello.length);
  console.log('[TEST] encrypted content (full):', encryptedHello);
  console.log('[TEST] Salted__ prefix?', encryptedHello.startsWith('U2FsdGVkX1') ? 'yes' : 'no');

  const roundtrip = ecdhDecrypt(encryptedHello, sharedSecret);
  if (roundtrip !== 'hello') {
    throw new Error(`Encrypt/decrypt roundtrip failed: got "${roundtrip}"`);
  }
  console.log('[TEST] Encrypt/decrypt roundtrip OK');

  console.log('[TEST] Sending encrypted "hello" to', TARGET_GLOBAL_META_ID, '...');
  const txid = await buildAndBroadcastSimpleMsg(
    ourAddress,
    privateKey,
    TARGET_GLOBAL_META_ID,
    encryptedHello
  );
  console.log(`[TEST] Sent 'hello' to idq1zfazvxaq69uw6txe3ewce30ewyhy9a7mzykgv0. TxID: ${txid}`);
  console.log('[TEST] Waiting 12s for chain/indexer propagation...');
  await new Promise((r) => setTimeout(r, 12_000));

  const beforePins = await listSimpleMsgPinsToAddress(TARGET_ADDRESS);
  const beforeIds = new Set(beforePins.map((p) => p.id));
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pins = await listSimpleMsgPinsToAddress(TARGET_ADDRESS);
    const newPin = pins.find((p) => !beforeIds.has(p.id));
    if (newPin) {
      beforeIds.add(newPin.id);
      const contentBody = await getPinContentBody(newPin.id);
      if (!contentBody) continue;
      let body: { to?: string; content?: string };
      try {
        body = JSON.parse(contentBody) as { to?: string; content?: string };
      } catch {
        continue;
      }
      const cipher = (body.content ?? '').trim();
      if (!cipher) continue;
      const decrypted = ecdhDecrypt(cipher, sharedSecret);
      console.log('[TEST] SUCCESS! Received decrypted reply:', decrypted);
      process.exit(0);
    }
  }

  console.error('[TEST] Timeout: no reply from robot within', WAIT_TIMEOUT_MS / 1000, 's');
  console.error('[TEST] Send succeeded (TxID above). If the target robot is offline or slow, run again or check network.');
  process.exit(1);
}

main().catch((e) => {
  console.error('[TEST] Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
