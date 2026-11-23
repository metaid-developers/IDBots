import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { resolveIncomingPrivateChatContent } = await import(
  '../dist-electron/main/services/privateChatDaemon.js'
);
const { getPrivateKeyBufferForEcdh } = await import(
  '../dist-electron/main/services/metabotWalletService.js'
);
const { computeEcdhSharedSecretSha256, ecdhEncrypt } = await import(
  '../dist-electron/main/services/metaWebCrypto.js'
);

const RECIPIENT_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT_PATH = "m/44'/10001'/0'/0/0";

function generateChatKeyPair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    publicKeyHex: ecdh.getPublicKey('hex', 'uncompressed'),
  };
}

function makeCiphertext(recipientPubKeyHex, senderPrivKey, plaintext) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(senderPrivKey);
  const rawSecret = ecdh.computeSecret(Buffer.from(recipientPubKeyHex, 'hex'));
  const sha256Secret = crypto.createHash('sha256').update(rawSecret).digest('hex');
  return ecdhEncrypt(plaintext, sha256Secret);
}

test('resolveIncomingPrivateChatContent preserves already-decrypted DB plaintext when raw_data ciphertext uses a rotated/mismatched key', async () => {
  const recipientPriv = await getPrivateKeyBufferForEcdh(RECIPIENT_MNEMONIC, RECIPIENT_PATH);
  const oldPeerKey = generateChatKeyPair();
  const mismatchSecret = 'f'.repeat(64);
  const rawCiphertext = ecdhEncrypt('unrecoverable ciphertext from rotated key', mismatchSecret);
  const swapStatusPlaintext = '```idbots-swap-v1\n{"type":"SWAP_STATUS_V1","requestId":"req-8539","collectionSlug":"metabot-avatar","status":"pending_1_conf"}\n```';

  const result = await resolveIncomingPrivateChatContent({
    row: {
      id: 250602,
      content: swapStatusPlaintext,
      raw_data: JSON.stringify({ content: rawCiphertext }),
      protocol: '/protocols/simplemsg',
      content_type: 'application/json',
      from_chat_pubkey: oldPeerKey.publicKeyHex,
      from_global_metaid: 'idq1station000000000000000000000000000000000',
      from_metaid: null,
    },
    privateKeyBuffer: recipientPriv,
    localPeerChatPubkey: oldPeerKey.publicKeyHex,
    fetchChainPeerChatPubkey: async () => '',
    emitLog: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.plaintext, swapStatusPlaintext);
  assert.equal(result.usedDbPlaintextFallback, true);
});

test('resolveIncomingPrivateChatContent falls back to rotated local/chain peer chatPubkey when row.from_chat_pubkey is stale', async () => {
  const recipientPriv = await getPrivateKeyBufferForEcdh(RECIPIENT_MNEMONIC, RECIPIENT_PATH);
  const recipientEcdh = crypto.createECDH('prime256v1');
  recipientEcdh.setPrivateKey(recipientPriv);
  const recipientPubHex = recipientEcdh.getPublicKey('hex', 'uncompressed');

  const stalePeerKey = generateChatKeyPair();
  const rotatedPeerKey = generateChatKeyPair();
  const secretMessage = '```idbots-swap-v1\n{"type":"SWAP_COMPLETED_V1","requestId":"req-8539","collectionSlug":"metabot-avatar","results":[]}\n```';
  const ciphertext = makeCiphertext(recipientPubHex, rotatedPeerKey.privateKey, secretMessage);

  // Case A: localPeerChatPubkey carries the rotated key
  const viaLocal = await resolveIncomingPrivateChatContent({
    row: {
      id: 250603,
      content: ciphertext,
      raw_data: JSON.stringify({ content: ciphertext }),
      protocol: '/protocols/simplemsg',
      content_type: 'application/json',
      from_chat_pubkey: stalePeerKey.publicKeyHex,
      from_global_metaid: 'idq1station000000000000000000000000000000000',
      from_metaid: null,
    },
    privateKeyBuffer: recipientPriv,
    localPeerChatPubkey: rotatedPeerKey.publicKeyHex,
    fetchChainPeerChatPubkey: async () => '',
    emitLog: () => {},
  });
  assert.equal(viaLocal.ok, true);
  assert.equal(viaLocal.plaintext, secretMessage);
  assert.equal(viaLocal.resolvedFromChatPubkey, rotatedPeerKey.publicKeyHex);
  assert.equal(
    viaLocal.sharedSecretForReply,
    computeEcdhSharedSecretSha256(recipientPriv, rotatedPeerKey.publicKeyHex),
  );

  // Case B: only chain API carries the rotated key
  let chainCalls = 0;
  const viaChain = await resolveIncomingPrivateChatContent({
    row: {
      id: 250604,
      content: ciphertext,
      raw_data: JSON.stringify({ content: ciphertext }),
      protocol: '/protocols/simplemsg',
      content_type: 'application/json',
      from_chat_pubkey: stalePeerKey.publicKeyHex,
      from_global_metaid: 'idq1station000000000000000000000000000000000',
      from_metaid: null,
    },
    privateKeyBuffer: recipientPriv,
    localPeerChatPubkey: null,
    fetchChainPeerChatPubkey: async () => {
      chainCalls += 1;
      return rotatedPeerKey.publicKeyHex;
    },
    emitLog: () => {},
  });
  assert.equal(chainCalls, 1);
  assert.equal(viaChain.ok, true);
  assert.equal(viaChain.plaintext, secretMessage);
  assert.equal(viaChain.resolvedFromChatPubkey, rotatedPeerKey.publicKeyHex);
});

test('resolveIncomingPrivateChatContent still fails closed when both raw_data and content are undecryptable ciphertext', async () => {
  const recipientPriv = await getPrivateKeyBufferForEcdh(RECIPIENT_MNEMONIC, RECIPIENT_PATH);
  const peerKey = generateChatKeyPair();
  const badCiphertext = ecdhEncrypt('secret payload', 'd'.repeat(64));

  const result = await resolveIncomingPrivateChatContent({
    row: {
      id: 250605,
      content: badCiphertext,
      raw_data: JSON.stringify({ content: badCiphertext }),
      protocol: '/protocols/simplemsg',
      content_type: 'application/json',
      from_chat_pubkey: peerKey.publicKeyHex,
      from_global_metaid: 'idq1peer',
      from_metaid: null,
    },
    privateKeyBuffer: recipientPriv,
    localPeerChatPubkey: null,
    fetchChainPeerChatPubkey: async () => '',
    emitLog: () => {},
  });

  assert.equal(result.ok, false);
});
