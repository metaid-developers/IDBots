#!/usr/bin/env npx tsx
/**
 * Local-only self-test for private chat encryption (no broadcast, no wait for reply).
 * 1) Fetch target chat pubkey, compute shared secret.
 * 2) Decrypt known-good ciphertext; if "hello", shared secret is correct.
 * 3) Encrypt "hello" with same salt as known-good; output should match.
 *
 * Run: npx tsx scripts/test_private_chat_encrypt_local.ts
 */

import * as crypto from 'crypto';
import CryptoJS from 'crypto-js';
import { mvc } from 'meta-contract';
import {
  MvcWallet,
  AddressType,
  CoinType,
} from '@metalet/utxo-wallet-service';

const MNEMONIC = 'master burger bread pretty venture public adapt bonus jacket envelope pet increase';
const TARGET_ADDRESS = '1BbhP2uP9gKZ5EEvoNfsYJDwdgLLJfb66K';
const MANAPI_BASE = 'https://manapi.metaid.io';
const PATH_STR = "m/44'/10001'/0'/0/0";
const KNOWN_GOOD_CIPHERTEXT = 'U2FsdGVkX18KwcNVBn+icLFUgbu+iVtrJUxdZSUXi9w=';

function parseAddressIndexFromPath(pathStr: string): number {
  const m = pathStr.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Derive private key using same logic as test (meta-contract mvc HD). */
function getPrivateKeyBufferMvc(mnemonic: string, pathStr: string): Buffer {
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

/** Derive private key using same logic as app (utxo-wallet-service MvcWallet). */
async function getPrivateKeyBufferWallet(mnemonic: string, pathStr: string): Promise<Buffer> {
  const addressIndex = parseAddressIndexFromPath(pathStr);
  const wallet = new MvcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.LegacyMvc,
    addressIndex,
    network: 'livenet',
    mnemonic,
  });
  const privateKeyWIF = wallet.getPrivateKey();
  const privKey = mvc.PrivateKey.fromWIF(privateKeyWIF);
  return Buffer.from((privKey as { bn: { toArray: (e: string, n: number) => number[] } }).bn.toArray('be', 32));
}

function computeEcdhSharedSecret(privateKey32: Buffer, peerPublicKeyHex: string, useCompressed = false): string {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey32);
  let peerBuf = Buffer.from(peerPublicKeyHex, 'hex');
  if (useCompressed && peerBuf.length === 65 && peerBuf[0] === 0x04) {
    const x = peerBuf.slice(1, 33);
    const y = peerBuf.readUInt32BE(60) & 1;
    peerBuf = Buffer.concat([Buffer.from([0x02 + y]), x]);
  }
  const secret = ecdh.computeSecret(peerBuf);
  return secret.toString('hex');
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

function ecdhDecrypt(cipherText: string, sharedSecretHex: string, asLatin1 = false): string {
  try {
    const passphrase = asLatin1
      ? Buffer.from(sharedSecretHex, 'hex').toString('latin1')
      : String(sharedSecretHex ?? '');
    const bytes = CryptoJS.AES.decrypt(cipherText, passphrase);
    return bytes.toString(CryptoJS.enc.Utf8) || cipherText;
  } catch {
    return cipherText;
  }
}

/** Encrypt with fixed salt (same as known-good) so output is deterministic. */
function ecdhEncryptWithSalt(plaintext: string, sharedSecretHex: string, salt: CryptoJS.lib.WordArray): string {
  const cipherParams = (CryptoJS.lib.PasswordBasedCipher as {
    encrypt: (cipher: unknown, message: CryptoJS.lib.WordArray, password: string, cfg: { salt: CryptoJS.lib.WordArray; format: unknown }) => CryptoJS.lib.CipherParams;
  }).encrypt(CryptoJS.algo.AES, CryptoJS.enc.Utf8.parse(String(plaintext)), String(sharedSecretHex), {
    salt,
    format: CryptoJS.format.OpenSSL,
  });
  return cipherParams.toString();
}

async function main(): Promise<void> {
  console.log('[LOCAL] Fetching target chat pubkey...');
  const targetChatPubkey = await fetchTargetChatPubkey();
  console.log('[LOCAL] Target chatpubkey length:', targetChatPubkey.length);

  const privateKeyBufferMvc = getPrivateKeyBufferMvc(MNEMONIC, PATH_STR);
  const privateKeyBufferWallet = await getPrivateKeyBufferWallet(MNEMONIC, PATH_STR);
  const sameKey = privateKeyBufferMvc.equals(privateKeyBufferWallet);
  console.log('[LOCAL] Same private key (mvc vs wallet)?', sameKey);

  const sharedSecretMvc = computeEcdhSharedSecret(privateKeyBufferMvc, targetChatPubkey);
  const sharedSecretWallet = computeEcdhSharedSecret(privateKeyBufferWallet, targetChatPubkey);
  const sharedSecretMvcComp = computeEcdhSharedSecret(privateKeyBufferMvc, targetChatPubkey, true);
  console.log('[LOCAL] Shared secret (mvc, first 20 hex):', sharedSecretMvc.slice(0, 20));
  console.log('[LOCAL] Shared secret (wallet, first 20 hex):', sharedSecretWallet.slice(0, 20));
  console.log('[LOCAL] Shared secret (mvc+compressed peer, first 20 hex):', sharedSecretMvcComp.slice(0, 20));

  const sha256Secret = crypto.createHash('sha256').update(Buffer.from(sharedSecretWallet, 'hex')).digest('hex');
  const candidates = [
    { name: 'wallet', secret: sharedSecretWallet },
    { name: 'mvc', secret: sharedSecretMvc },
    { name: 'mvc+compressed', secret: sharedSecretMvcComp },
    { name: 'sha256(wallet)', secret: sha256Secret },
  ];
  let sharedSecret = sharedSecretWallet;
  let sharedSecretOk = false;
  let decrypted = '';
  for (const { name, secret } of candidates) {
    decrypted = ecdhDecrypt(KNOWN_GOOD_CIPHERTEXT, secret);
    if (decrypted === 'hello') {
      sharedSecretOk = true;
      sharedSecret = secret;
      console.log('[LOCAL] Decrypt OK with', name);
      break;
    }
  }
  if (!sharedSecretOk) {
    decrypted = ecdhDecrypt(KNOWN_GOOD_CIPHERTEXT, sharedSecret, true);
    sharedSecretOk = decrypted === 'hello';
    if (sharedSecretOk) console.log('[LOCAL] Decrypt OK when using shared secret as latin1.');
  }
  console.log('[LOCAL] Decrypt known-good ciphertext ->', JSON.stringify(decrypted), sharedSecretOk ? '(OK)' : '(FAIL: expected "hello")');

  const parsed = CryptoJS.format.OpenSSL.parse(KNOWN_GOOD_CIPHERTEXT);
  const salt = parsed.salt!;
  const ourCiphertext = ecdhEncryptWithSalt('hello', sharedSecret, salt);
  const match = ourCiphertext === KNOWN_GOOD_CIPHERTEXT;
  console.log('[LOCAL] Encrypt "hello" with same salt ->', ourCiphertext);
  console.log('[LOCAL] Matches known-good?', match ? 'YES' : 'NO');

  if (sharedSecretOk && match) {
    console.log('[LOCAL] Self-test PASSED.');
    process.exit(0);
  }
  if (!sharedSecretOk) {
    console.error('[LOCAL] Shared secret does not match wallet (decrypt of known-good failed).');
    console.error('[LOCAL] Wallet may use different key path or chat pubkey source. When ECDH matches, fixed-salt encrypt will yield expected ciphertext.');
  }
  if (!match) {
    console.error('[LOCAL] Ciphertext mismatch (expected when shared secret differs).');
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
