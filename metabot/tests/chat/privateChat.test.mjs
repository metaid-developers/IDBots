import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  sendPrivateChat,
  receivePrivateChat,
} = require('../../dist/core/chat/privateChat.js');

function createIdentityPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKeyHex: ecdh.getPrivateKey('hex'),
    publicKeyHex: ecdh.getPublicKey('hex', 'uncompressed'),
  };
}

test('sendPrivateChat builds an encrypted simplemsg payload that receivePrivateChat can decrypt', () => {
  const alice = createIdentityPair();
  const bob = createIdentityPair();

  const outbound = sendPrivateChat({
    fromIdentity: {
      globalMetaId: 'alice-global-metaid',
      privateKeyHex: alice.privateKeyHex,
    },
    toGlobalMetaId: 'bob-global-metaid',
    peerChatPublicKey: bob.publicKeyHex,
    content: 'hello from alice',
    replyPinId: 'reply-pin-1',
    timestamp: 1_744_444_444,
  });

  assert.equal(outbound.path, '/protocols/simplemsg');
  assert.equal(outbound.encryption, '0');
  assert.equal(outbound.version, '1.0.0');
  assert.equal(outbound.contentType, 'application/json');

  const payload = JSON.parse(outbound.payload);
  assert.equal(payload.to, 'bob-global-metaid');
  assert.equal(payload.replyPin, 'reply-pin-1');
  assert.equal(payload.encrypt, 'ecdh');
  assert.equal(payload.contentType, 'text/plain');
  assert.notEqual(payload.content, 'hello from alice');

  const inbound = receivePrivateChat({
    localIdentity: {
      globalMetaId: 'bob-global-metaid',
      privateKeyHex: bob.privateKeyHex,
    },
    peerChatPublicKey: alice.publicKeyHex,
    payload: {
      fromGlobalMetaId: 'alice-global-metaid',
      content: null,
      rawData: JSON.stringify({ content: payload.content }),
      replyPinId: payload.replyPin,
    },
  });

  assert.equal(inbound.fromGlobalMetaId, 'alice-global-metaid');
  assert.equal(inbound.replyPinId, 'reply-pin-1');
  assert.equal(inbound.plaintext, 'hello from alice');
  assert.equal(inbound.secretVariant, 'sha256');
});

test('sendPrivateChat rejects requests without a peer chat public key', () => {
  const alice = createIdentityPair();

  assert.throws(
    () => sendPrivateChat({
      fromIdentity: {
        globalMetaId: 'alice-global-metaid',
        privateKeyHex: alice.privateKeyHex,
      },
      toGlobalMetaId: 'bob-global-metaid',
      peerChatPublicKey: '',
      content: 'hello',
    }),
    /peer chat public key/i
  );
});

test('receivePrivateChat rejects requests without a local private key', () => {
  const alice = createIdentityPair();
  const bob = createIdentityPair();

  const outbound = sendPrivateChat({
    fromIdentity: {
      globalMetaId: 'alice-global-metaid',
      privateKeyHex: alice.privateKeyHex,
    },
    toGlobalMetaId: 'bob-global-metaid',
    peerChatPublicKey: bob.publicKeyHex,
    content: 'hello from alice',
  });

  const payload = JSON.parse(outbound.payload);

  assert.throws(
    () => receivePrivateChat({
      localIdentity: {
        globalMetaId: 'bob-global-metaid',
        privateKeyHex: '',
      },
      peerChatPublicKey: alice.publicKeyHex,
      payload: {
        fromGlobalMetaId: 'alice-global-metaid',
        content: payload.content,
      },
    }),
    /local private key/i
  );
});
