import { createECDH, createHash } from 'node:crypto';
import CryptoJS, { AES, enc, mode, pad } from 'crypto-js';

export interface PrivateChatIdentity {
  globalMetaId?: string | null;
  privateKeyHex?: string | Buffer | null;
}

export interface SendPrivateChatInput {
  fromIdentity: PrivateChatIdentity;
  toGlobalMetaId: string;
  peerChatPublicKey: string;
  content: string;
  replyPinId?: string | null;
  timestamp?: number;
  secretVariant?: 'sha256' | 'raw';
  sharedSecretOverride?: string | null;
}

export interface SendPrivateChatResult {
  path: '/protocols/simplemsg';
  encryption: '0';
  version: '1.0.0';
  contentType: 'application/json';
  payload: string;
  encryptedContent: string;
  sharedSecret: string;
  secretVariant: 'sha256' | 'raw';
}

export interface ReceivePrivateChatPayload {
  fromGlobalMetaId?: string | null;
  content?: string | null;
  rawData?: string | null;
  replyPinId?: string | null;
}

export interface ReceivePrivateChatInput {
  localIdentity: PrivateChatIdentity;
  peerChatPublicKey: string;
  payload: ReceivePrivateChatPayload;
}

export interface ReceivePrivateChatResult {
  fromGlobalMetaId: string;
  replyPinId: string;
  plaintext: string;
  sharedSecret: string;
  secretVariant: 'sha256' | 'raw';
}

const UTF8 = enc.Utf8;
const PRIVATE_CHAT_IV = UTF8.parse('0000000000000000');
const PRIVATE_CHAT_SALT = (CryptoJS.lib.WordArray as {
  create: (words: number[], sigBytes?: number) => CryptoJS.lib.WordArray;
}).create([180470613, 109027952], 8);

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requirePrivateKeyBuffer(identity: PrivateChatIdentity, fieldName: string): Buffer {
  const value = identity.privateKeyHex;
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) {
      throw new Error(`${fieldName} is required`);
    }
    return value;
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`${fieldName} must be a hex string`);
  }

  return Buffer.from(normalized, 'hex');
}

function requirePeerChatPublicKey(peerChatPublicKey: string): string {
  const normalized = normalizeText(peerChatPublicKey);
  if (!normalized) {
    throw new Error('Peer chat public key is required');
  }
  return normalized;
}

function computeEcdhSharedSecret(privateKey32: Buffer, peerPublicKeyHex: string): string {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey32);
  const secret = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, 'hex'));
  return secret.toString('hex');
}

function computeEcdhSharedSecretSha256(privateKey32: Buffer, peerPublicKeyHex: string): string {
  const rawSecretHex = computeEcdhSharedSecret(privateKey32, peerPublicKeyHex);
  return createHash('sha256').update(Buffer.from(rawSecretHex, 'hex')).digest('hex');
}

function ecdhDecrypt(cipherText: string, sharedSecret: string): string {
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
      const out = bytes.toString(UTF8);
      if (out) return out;
    } catch {
      // Fall through to OpenSSL passphrase mode.
    }
  }

  try {
    const bytes = AES.decrypt(cipherText, secretStr);
    return bytes.toString(UTF8) || cipherText;
  } catch {
    return cipherText;
  }
}

function ecdhEncrypt(plaintext: string, sharedSecretHex: string): string {
  const cipherParams = (CryptoJS.lib.PasswordBasedCipher as {
    encrypt: (
      cipher: unknown,
      message: CryptoJS.lib.WordArray,
      password: string,
      cfg: { salt: CryptoJS.lib.WordArray; format: unknown }
    ) => CryptoJS.lib.CipherParams;
  }).encrypt(
    CryptoJS.algo.AES,
    CryptoJS.enc.Utf8.parse(String(plaintext ?? '')),
    String(sharedSecretHex ?? ''),
    {
      salt: PRIVATE_CHAT_SALT,
      format: CryptoJS.format.OpenSSL,
    }
  );
  return cipherParams.toString();
}

function buildPrivateMsgPayload(
  toGlobalMetaId: string,
  encryptedContent: string,
  replyPinId: string,
  timestamp: number
): string {
  return JSON.stringify({
    to: toGlobalMetaId,
    timestamp,
    content: encryptedContent,
    contentType: 'text/plain',
    encrypt: 'ecdh',
    replyPin: replyPinId,
  });
}

function extractCipherTextFromRawData(rawData: string | null | undefined): string {
  const raw = normalizeText(rawData);
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw) as {
      content?: unknown;
      data?: { content?: unknown };
    };
    const direct = typeof parsed.content === 'string' ? parsed.content.trim() : '';
    if (direct) return direct;
    const nested = parsed.data && typeof parsed.data.content === 'string'
      ? parsed.data.content.trim()
      : '';
    return nested;
  } catch {
    return '';
  }
}

function looksLikeEncryptedPrivateContent(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  if (normalized.startsWith('U2FsdGVkX1')) return true;
  return /^[0-9a-fA-F]{32,}$/.test(normalized) && normalized.length % 2 === 0;
}

function tryDecryptWithSecret(cipherText: string, secret: string): string | null {
  if (!cipherText || !secret) return null;
  const plain = ecdhDecrypt(cipherText, secret);
  if (!plain || plain === cipherText) return null;
  return plain;
}

export function sendPrivateChat(input: SendPrivateChatInput): SendPrivateChatResult {
  const peerPublicKey = requirePeerChatPublicKey(input.peerChatPublicKey);
  const toGlobalMetaId = normalizeText(input.toGlobalMetaId);
  if (!toGlobalMetaId) {
    throw new Error('Target globalMetaId is required');
  }

  const secretVariant = input.secretVariant === 'raw' ? 'raw' : 'sha256';
  let sharedSecret = normalizeText(input.sharedSecretOverride);
  if (!sharedSecret) {
    const localPrivateKey = requirePrivateKeyBuffer(input.fromIdentity, 'Local private key');
    try {
      sharedSecret = secretVariant === 'raw'
        ? computeEcdhSharedSecret(localPrivateKey, peerPublicKey)
        : computeEcdhSharedSecretSha256(localPrivateKey, peerPublicKey);
    } catch (error) {
      throw new Error(
        `Peer chat public key is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const encryptedContent = ecdhEncrypt(String(input.content ?? ''), sharedSecret);
  const payload = buildPrivateMsgPayload(
    toGlobalMetaId,
    encryptedContent,
    normalizeText(input.replyPinId),
    Number.isFinite(input.timestamp) ? Number(input.timestamp) : Math.floor(Date.now() / 1000)
  );

  return {
    path: '/protocols/simplemsg',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload,
    encryptedContent,
    sharedSecret,
    secretVariant,
  };
}

export function receivePrivateChat(input: ReceivePrivateChatInput): ReceivePrivateChatResult {
  const localPrivateKey = requirePrivateKeyBuffer(input.localIdentity, 'Local private key');
  const peerPublicKey = requirePeerChatPublicKey(input.peerChatPublicKey);

  const rawCipherText = extractCipherTextFromRawData(input.payload.rawData);
  const directContent = normalizeText(input.payload.content);
  const cipherText = rawCipherText || directContent;
  if (!cipherText) {
    throw new Error('Encrypted private chat payload is required');
  }

  const shouldDecrypt = Boolean(rawCipherText) || looksLikeEncryptedPrivateContent(directContent);
  if (!shouldDecrypt) {
    return {
      fromGlobalMetaId: normalizeText(input.payload.fromGlobalMetaId),
      replyPinId: normalizeText(input.payload.replyPinId),
      plaintext: directContent,
      sharedSecret: '',
      secretVariant: 'sha256',
    };
  }

  let sharedSecretSha256: string;
  let sharedSecretRaw: string;
  try {
    sharedSecretSha256 = computeEcdhSharedSecretSha256(localPrivateKey, peerPublicKey);
    sharedSecretRaw = computeEcdhSharedSecret(localPrivateKey, peerPublicKey);
  } catch (error) {
    throw new Error(
      `Peer chat public key is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const plainBySha256 = tryDecryptWithSecret(cipherText, sharedSecretSha256);
  if (plainBySha256 != null) {
    return {
      fromGlobalMetaId: normalizeText(input.payload.fromGlobalMetaId),
      replyPinId: normalizeText(input.payload.replyPinId),
      plaintext: plainBySha256,
      sharedSecret: sharedSecretSha256,
      secretVariant: 'sha256',
    };
  }

  const plainByRaw = tryDecryptWithSecret(cipherText, sharedSecretRaw);
  if (plainByRaw != null) {
    return {
      fromGlobalMetaId: normalizeText(input.payload.fromGlobalMetaId),
      replyPinId: normalizeText(input.payload.replyPinId),
      plaintext: plainByRaw,
      sharedSecret: sharedSecretRaw,
      secretVariant: 'raw',
    };
  }

  throw new Error('Failed to decrypt private chat payload');
}
