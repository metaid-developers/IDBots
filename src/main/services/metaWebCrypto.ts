/**
 * Crypto helpers for MetaWeb listener: group AES decrypt/encrypt, private ECDH decrypt.
 * Group encrypt/decrypt must match reference: Dev-docs/reference_scripts/metabot-chat/scripts/crypto.ts
 * Key = first 16 characters of groupId; AES-CBC, iv 0000000000000000, PKCS7; output hex (base64-decoded cipher as hex).
 */

import { enc, AES, mode, pad } from 'crypto-js';

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
 * Decrypt private chat message (AES with ECDH shared secret).
 * @param cipherText - Base64 cipher text
 * @param sharedSecret - Hex shared secret from ECDH
 * @returns Decrypted plain text
 */
export function ecdhDecrypt(cipherText: string, sharedSecret: string): string {
  try {
    const bytes = AES.decrypt(cipherText, sharedSecret);
    return bytes.toString(Utf8) || cipherText;
  } catch {
    return cipherText;
  }
}
