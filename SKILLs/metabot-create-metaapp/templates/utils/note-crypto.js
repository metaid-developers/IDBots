export const NOTE_ENCRYPTION_PUBLIC = '0';
export const NOTE_ENCRYPTION_ECIES = '1';
export const NOTE_ENCRYPTION_AES = 'aes';
export const ENCRYPTED_NOTE_PLACEHOLDER = 'This note content is encrypted';

function getMetaIdWallet() {
  return typeof window !== 'undefined' && window && window.metaidwallet
    ? window.metaidwallet
    : null;
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function getLocalStorage() {
  return typeof globalThis !== 'undefined' && globalThis.localStorage
    ? globalThis.localStorage
    : null;
}

function decodeBase64(value) {
  var text = String(value || '');
  if (!text) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(text, 'base64'));
  }

  var binary = atob(text);
  var output = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i += 1) {
    output[i] = binary.charCodeAt(i);
  }
  return output;
}

function hexToBytes(hexValue) {
  var text = String(hexValue || '').trim().replace(/^0x/i, '');
  if (!text || text.length % 2 !== 0) {
    throw new Error('Legacy note decrypt key must be a 32-byte hex string');
  }

  var output = new Uint8Array(text.length / 2);
  for (var i = 0; i < text.length; i += 2) {
    output[i / 2] = Number.parseInt(text.slice(i, i + 2), 16);
  }
  return output;
}

function getCryptoObject(cryptoObject) {
  var root = cryptoObject || globalThis.crypto;
  if (!root || !root.subtle) {
    throw new Error('Web Crypto API is unavailable');
  }
  return root;
}

async function decryptLegacyAesGcm(ciphertext, hexKey, cryptoObject) {
  var cryptoApi = getCryptoObject(cryptoObject);
  var encrypted = decodeBase64(ciphertext);
  var keyBytes = hexToBytes(hexKey);

  if (keyBytes.byteLength !== 32) {
    throw new Error('Legacy note decrypt key must be 32 bytes');
  }
  if (encrypted.byteLength < 28) {
    throw new Error('Legacy encrypted note payload is too short');
  }

  var iv = encrypted.slice(0, 12);
  var payload = encrypted.slice(12);
  var cryptoKey = await cryptoApi.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  var decrypted = await cryptoApi.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: 128,
    },
    cryptoKey,
    payload,
  );

  return new TextDecoder().decode(decrypted);
}

async function resolveLegacyKey(params = {}) {
  if (params.legacyKey) return String(params.legacyKey);
  if (typeof params.getLegacyKey === 'function') {
    return String(await params.getLegacyKey(params));
  }
  if (params.noteData && typeof params.noteData.legacyKey === 'string') {
    return params.noteData.legacyKey;
  }
  var storage = getLocalStorage();
  var walletAddress = normalizeAddress(params.walletAddress);
  if (storage && walletAddress && typeof storage.getItem === 'function') {
    try {
      var raw = storage.getItem('signKeys');
      var list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i += 1) {
          var item = list[i] && typeof list[i] === 'object' ? list[i] : {};
          if (normalizeAddress(item.address) !== walletAddress) continue;
          if (typeof item.sigKey === 'string' && item.sigKey.trim()) {
            return item.sigKey.trim();
          }
        }
      }
    } catch (_) {}
  }
  throw new Error('Legacy encrypted notes require a signature key');
}

function shouldUseEncryptedPlaceholder(walletAddress, noteAddress) {
  var owner = normalizeAddress(noteAddress);
  if (!owner) return true;
  var wallet = normalizeAddress(walletAddress);
  if (!wallet) return true;
  return wallet !== owner;
}

export async function encryptNoteContent({ noteData, isPrivate, walletAddress } = {}) {
  var nextNote = noteData && typeof noteData === 'object' ? { ...noteData } : {};
  if (!isPrivate) {
    return {
      ...nextNote,
      encryption: NOTE_ENCRYPTION_PUBLIC,
    };
  }

  var wallet = getMetaIdWallet();
  if (!wallet || typeof wallet.eciesEncrypt !== 'function') {
    throw new Error('window.metaidwallet.eciesEncrypt is unavailable');
  }

  var response = await wallet.eciesEncrypt({
    message: String(nextNote.content || ''),
    walletAddress: String(walletAddress || ''),
  });
  if (!response || response.status !== 'ok') {
    throw new Error('Failed to encrypt private note content');
  }

  return {
    ...nextNote,
    content: String(response.result || ''),
    encryption: NOTE_ENCRYPTION_ECIES,
  };
}

export async function decryptNoteContent({
  noteData,
  walletAddress,
  noteAddress,
  legacyKey,
  getLegacyKey,
  cryptoObject,
} = {}) {
  var nextNote = noteData && typeof noteData === 'object' ? { ...noteData } : {};
  var mode = String(nextNote.encryption || NOTE_ENCRYPTION_PUBLIC).toLowerCase();
  if (mode === NOTE_ENCRYPTION_PUBLIC) return nextNote;

  if (shouldUseEncryptedPlaceholder(walletAddress, noteAddress)) {
    return {
      ...nextNote,
      content: ENCRYPTED_NOTE_PLACEHOLDER,
    };
  }

  if (mode === NOTE_ENCRYPTION_ECIES) {
    var wallet = getMetaIdWallet();
    if (!wallet || typeof wallet.eciesDecrypt !== 'function') {
      throw new Error('window.metaidwallet.eciesDecrypt is unavailable');
    }

    var response = await wallet.eciesDecrypt({
      encrypted: String(nextNote.content || ''),
      walletAddress: String(walletAddress || ''),
      noteAddress: String(noteAddress || ''),
    });
    if (!response || response.status !== 'ok') {
      throw new Error('Failed to decrypt private note content');
    }

    return {
      ...nextNote,
      content: String(response.result || ''),
    };
  }

  if (mode === NOTE_ENCRYPTION_AES) {
    var key = await resolveLegacyKey({
      noteData: nextNote,
      walletAddress: walletAddress,
      noteAddress: noteAddress,
      legacyKey: legacyKey,
      getLegacyKey: getLegacyKey,
    });
    return {
      ...nextNote,
      content: await decryptLegacyAesGcm(String(nextNote.content || ''), key, cryptoObject),
    };
  }

  return nextNote;
}
