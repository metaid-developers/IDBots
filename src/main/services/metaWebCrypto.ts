/**
 * Crypto helpers for MetaWeb listener: group AES decrypt, private ECDH decrypt.
 * Group key: first 16 chars of groupId; private uses shared secret (from ECDH).
 */

import { enc, AES, mode, pad } from 'crypto-js';

const Utf8 = enc.Utf8;
const iv = Utf8.parse('0000000000000000');

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
