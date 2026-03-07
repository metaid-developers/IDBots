/**
 * Crypto helpers for MetaWeb listener: group AES decrypt/encrypt, private ECDH decrypt/encrypt.
 * Group encrypt/decrypt must match reference: Dev-docs/reference_scripts/metabot-chat/scripts/crypto.ts
 * Key = first 16 characters of groupId; AES-CBC, iv 0000000000000000, PKCS7; output hex (base64-decoded cipher as hex).
 * Private chat: ECDH P-256 shared secret + AES (same as SendChatMessageCommand _privateEncrypt).
 */

import * as nodeCrypto from 'crypto';
import CryptoJS, { enc, AES, mode, pad } from 'crypto-js';

const Utf8 = enc.Utf8;
const iv = Utf8.parse('0000000000000000');

const KEY_CHAR_LEN = 16;

/**
 * Secret key for group: first 16 characters of groupId, padded with '0' if shorter.
 * Protocol: "直接取该群聊 groupId 的前 16 个字符".
 */
function groupIdToSecretKey(groupId: string): string {
  const s = (groupId ?? '').trim();
  if (s.length >= KEY_CHAR_LEN) return s.slice(0, KEY_CHAR_LEN);
  return s.padEnd(KEY_CHAR_LEN, '0');
}

/**
 * Encrypt group chat message for broadcast. Matches reference crypto.ts encrypt():
 * AES-CBC, iv 0000000000000000, PKCS7; cipher base64 -> decode -> hex.
 */
export function encryptGroupMessageECB(message: string, groupId: string): string {
  const secretKeyStr = groupIdToSecretKey(groupId);
  const messageWordArray = Utf8.parse(message);
  const secretKey = Utf8.parse(secretKeyStr);

  const encrypted = AES.encrypt(messageWordArray, secretKey, {
    iv,
    mode: mode.CBC,
    padding: pad.Pkcs7,
  });
  const encryptedBuf = Buffer.from(encrypted.toString(), 'base64');
  const hexOut = encryptedBuf.toString('hex');

  console.log('[GroupChat Encrypt] plaintext:', JSON.stringify(message));
  console.log('[GroupChat Encrypt] key (first 16 chars of groupId):', JSON.stringify(secretKeyStr));
  console.log('[GroupChat Encrypt] ciphertext (hex):', hexOut.slice(0, 80) + (hexOut.length > 80 ? '...' : ''));

  return hexOut;
}

/**
 * Decrypt group chat message (AES-CBC, key = first 16 chars of groupId).
 * @param message - Encrypted message (hex string)
 * @param secretKeyStr - Secret key string (16 characters)
 * @returns Decrypted plain text
 */
export function decryptGroupMessage(message: string, secretKeyStr: string): string {
  const secretKey = Utf8.parse(secretKeyStr);
  try {
    const messageBuffer = Buffer.from(message, 'hex');
    const messageBase64 = messageBuffer.toString('base64');
    const messageBytes = AES.decrypt(messageBase64, secretKey, {
      iv,
      mode: mode.CBC,
      padding: pad.Pkcs7,
    });
    return messageBytes.toString(Utf8) || message;
  } catch {
    return message;
  }
}

/**
 * Encrypt group chat message (AES-CBC, key = first 16 chars of groupId).
 * @param message - Plain text
 * @param secretKeyStr - Secret key string (16 characters)
 * @returns Encrypted hex string
 */
export function encryptGroupMessage(message: string, secretKeyStr: string): string {
  const secretKey = Utf8.parse(secretKeyStr);
  const messageWordArray = Utf8.parse(message);
  const encrypted = AES.encrypt(messageWordArray, secretKey, {
    iv,
    mode: mode.CBC,
    padding: pad.Pkcs7,
  });
  const buf = Buffer.from(encrypted.toString(), 'base64');
  return buf.toString('hex');
}

/**
 * Compute ECDH shared secret (P-256) for private chat. Same curve as chat key derivation.
 * @param privateKey32 - 32-byte private key (from getPrivateKeyBufferForEcdh)
 * @param peerPublicKeyHex - Peer's chat public key, uncompressed hex (04 + x + y)
 * @returns Shared secret as hex string
 */
export function computeEcdhSharedSecret(privateKey32: Buffer, peerPublicKeyHex: string): string {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey32);
  const secret = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, 'hex'));
  return secret.toString('hex');
}

/**
 * Private chat: match SendChatMessageCommand _privateEncrypt / simple-talk _privateDecrypt.
 * _privateEncrypt(message, sharedSecret) = AES.encrypt(String(message), String(sharedSecret)).toString() -> Base64 Salted__.
 * _privateDecrypt(message, secretKey) = AES.decrypt(String(message), String(secretKey)).
 * Alternative (file path): _privateEncryptHexFile uses enc.Hex.parse(sharedSecretHex), CBC, iv '0000000000000000'.
 */
const PRIVATE_CHAT_IV = Utf8.parse('0000000000000000');

export function ecdhDecrypt(cipherText: string, sharedSecret: string): string {
  const secretStr = String(sharedSecret ?? '').trim();
  const isHex64 = secretStr.length === 64 && /^[0-9a-fA-F]+$/.test(secretStr);

  if (isHex64 && cipherText && !cipherText.startsWith('U2FsdGVkX1')) {
    try {
      const key = enc.Hex.parse(secretStr);
      const bytes = AES.decrypt(cipherText, key, {
        iv: PRIVATE_CHAT_IV,
        mode: mode.CBC,
        padding: pad.Pkcs7,
      });
      const out = bytes.toString(Utf8);
      if (out) return out;
    } catch {
      // fall through
    }
  }

  try {
    const bytes = AES.decrypt(cipherText, secretStr);
    return bytes.toString(Utf8) || cipherText;
  } catch {
    return cipherText;
  }
}

/**
 * Fixed salt so that encrypt("hello", sharedSecret) is deterministic and matches wallet output
 * when the same ECDH shared secret is used (same mnemonic path and peer chat pubkey).
 * Salt from known-good OpenSSL ciphertext for compatibility.
 */
const PRIVATE_CHAT_SALT = (CryptoJS.lib.WordArray as { create: (words: number[], sigBytes?: number) => CryptoJS.lib.WordArray }).create(
  [180470613, 109027952],
  8
);

/**
 * Encrypt: OpenSSL passphrase mode with fixed salt (deterministic). Same as SendChatMessageCommand
 * _privateEncrypt but with fixed salt so output matches wallet for same shared secret.
 */
export function ecdhEncrypt(plaintext: string, sharedSecretHex: string): string {
  const cipherParams = (CryptoJS.lib.PasswordBasedCipher as {
    encrypt: (cipher: unknown, message: CryptoJS.lib.WordArray, password: string, cfg: { salt: CryptoJS.lib.WordArray; format: unknown }) => CryptoJS.lib.CipherParams;
  }).encrypt(CryptoJS.algo.AES, CryptoJS.enc.Utf8.parse(String(plaintext ?? '')), String(sharedSecretHex ?? ''), {
    salt: PRIVATE_CHAT_SALT,
    format: CryptoJS.format.OpenSSL,
  });
  return cipherParams.toString();
}
