import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const {
  PRIVATE_CHAT_FILE_MESSAGE_PROTOCOL,
  isPrivateChatFileMessageProtocol,
  parsePrivateChatFileMessagePayload,
  metafilePinIdFromUri,
  classifyFileType,
  mimeTypeForFileType,
  buildPrivateChatFileMessageContent,
  materializePrivateChatFileMessage,
} = await import('../dist-electron/main/services/privateChatFileMessage.js');
const { decryptPrivateFileBuffer } = await import('../dist-electron/main/services/metaWebCrypto.js');

// A real-shaped pinId: 64 hex chars + output index.
const PIN_ID = '45c3560bdd7002ffd134ef8c109264405697aad0b652ec1e49605f2f705bf59ei0';
const ATTACHMENT_URI = `metafile://${PIN_ID}`;
// 64 hex chars = the ECDH shared secret's raw 32 bytes.
const SHARED_SECRET_HEX = 'ab'.repeat(32);

/** Encrypt the way the reference client (IDChat) encrypts a private file body. */
const encryptFileBody = (plain, sharedSecretHex) => {
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(sharedSecretHex, 'hex'),
    Buffer.from('0000000000000000', 'utf8'),
  );
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};

test('isPrivateChatFileMessageProtocol accepts the protocol spellings the indexer hands us', () => {
  assert.equal(isPrivateChatFileMessageProtocol(PRIVATE_CHAT_FILE_MESSAGE_PROTOCOL), true);
  assert.equal(isPrivateChatFileMessageProtocol('/protocols/simplefilemsg'), true);
  assert.equal(isPrivateChatFileMessageProtocol('simplefilemsg'), true);
  assert.equal(isPrivateChatFileMessageProtocol('/Protocols/SimpleFileMsg/'), true);
  assert.equal(isPrivateChatFileMessageProtocol('/protocols/simplemsg'), false);
  assert.equal(isPrivateChatFileMessageProtocol(null), false);
  assert.equal(isPrivateChatFileMessageProtocol(''), false);
});

test('metafilePinIdFromUri keeps the pinId and drops any extension suffix', () => {
  assert.equal(metafilePinIdFromUri(ATTACHMENT_URI), PIN_ID);
  assert.equal(metafilePinIdFromUri(`${ATTACHMENT_URI}.jpg`), PIN_ID);
  assert.equal(metafilePinIdFromUri('https://example.com/x.jpg'), '');
});

test('parsePrivateChatFileMessagePayload reads the chain payload verbatim', () => {
  // The exact body of pin 235273dc…i0 (idchat → IDBots, 2026-11-16).
  const chainBody = JSON.stringify({
    timestamp: 1794817825,
    encrypt: 'aes',
    fileType: 'jpeg',
    to: 'idq1p0zzdyaedg8xsuczqe4vkljdmu07rna7tf278z',
    nickName: '波动超人',
    attachment: ATTACHMENT_URI,
    replyPin: '',
  });
  const parsed = parsePrivateChatFileMessagePayload(chainBody);
  assert.ok(parsed);
  assert.equal(parsed.attachment, ATTACHMENT_URI);
  assert.equal(parsed.fileType, 'jpeg');
  assert.equal(parsed.encrypt, 'aes');
});

test('parsePrivateChatFileMessagePayload handles the normalized row content and the {content} wrapper', () => {
  const fromRowContent = parsePrivateChatFileMessagePayload(ATTACHMENT_URI, 'jpeg');
  assert.ok(fromRowContent);
  assert.equal(fromRowContent.attachment, ATTACHMENT_URI);
  assert.equal(fromRowContent.fileType, 'jpeg');

  const wrapped = parsePrivateChatFileMessagePayload(JSON.stringify({
    content: JSON.stringify({ attachment: ATTACHMENT_URI, fileType: 'image/png', encrypt: 'aes' }),
  }));
  assert.ok(wrapped);
  assert.equal(wrapped.fileType, 'png');
  assert.equal(classifyFileType(wrapped.fileType), 'image');
});

test('parsePrivateChatFileMessagePayload reads the indexer raw_data row shape', () => {
  // What private_chat_messages.raw_data actually holds: the whole indexer
  // message, whose `content` is the normalized attachment URI.
  const rawData = JSON.stringify({
    protocol: '/protocols/simplefilemsg',
    content: ATTACHMENT_URI,
    contentType: 'jpeg',
    encryption: 'aes',
    txId: PIN_ID.slice(0, 64),
    pinId: PIN_ID,
  });
  const parsed = parsePrivateChatFileMessagePayload(rawData, 'jpeg');
  assert.ok(parsed);
  assert.equal(parsed.attachment, ATTACHMENT_URI);
  assert.equal(parsed.fileType, 'jpeg');
  assert.equal(classifyFileType(parsed.fileType), 'image');
});

test('parsePrivateChatFileMessagePayload rejects payloads without a metafile attachment', () => {
  assert.equal(parsePrivateChatFileMessagePayload(''), null);
  assert.equal(parsePrivateChatFileMessagePayload('hello'), null);
  assert.equal(parsePrivateChatFileMessagePayload(JSON.stringify({ to: 'idq1x' })), null);
  assert.equal(parsePrivateChatFileMessagePayload('metafile://not-a-pin'), null);
});

test('file types map to the right kind and MIME', () => {
  assert.equal(classifyFileType('jpeg'), 'image');
  assert.equal(classifyFileType('PNG'), 'image');
  assert.equal(classifyFileType('mp4'), 'video');
  assert.equal(classifyFileType('mp3'), 'audio');
  assert.equal(classifyFileType('pdf'), 'file');
  assert.equal(mimeTypeForFileType('jpeg'), 'image/jpeg');
  assert.equal(mimeTypeForFileType('pdf'), 'application/pdf');
  assert.equal(mimeTypeForFileType('weird'), 'application/octet-stream');
});

test('decryptPrivateFileBuffer decrypts a reference-client AES-256-CBC file body', () => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const cipherBody = encryptFileBody(plain, SHARED_SECRET_HEX);
  assert.equal(cipherBody.length % 16, 0);

  const decrypted = decryptPrivateFileBuffer(cipherBody, SHARED_SECRET_HEX);
  assert.ok(decrypted);
  assert.deepEqual(decrypted, plain);

  // A wrong secret must fail closed rather than emit garbage.
  assert.equal(decryptPrivateFileBuffer(cipherBody, 'cd'.repeat(32)), null);
  // A malformed secret is refused before any crypto runs.
  assert.equal(decryptPrivateFileBuffer(cipherBody, 'not-hex'), null);
  assert.equal(decryptPrivateFileBuffer(Buffer.alloc(0), SHARED_SECRET_HEX), null);
});

test('buildPrivateChatFileMessageContent emits the app-wide attachment marker line', () => {
  const localPath = 'C:\\Users\\tester\\AppData\\Roaming\\IDBots\\private-chat-inbound\\image.jpg';
  const content = buildPrivateChatFileMessageContent({
    payload: { attachment: ATTACHMENT_URI, fileType: 'jpeg', encrypt: 'aes' },
    attachment: {
      kind: 'image',
      localPath,
      mimeType: 'image/jpeg',
      fileName: 'image.jpg',
      metafileUri: ATTACHMENT_URI,
      size: 1234,
    },
  });
  assert.equal(content, `[Image]\nAttachment path: ${localPath}`);

  // Without a materialized body the message must stay visible, never silent.
  const fallback = buildPrivateChatFileMessageContent({
    payload: { attachment: ATTACHMENT_URI, fileType: 'jpeg', encrypt: 'aes' },
    attachment: null,
  });
  assert.match(fallback, /^\[Image\]/);
  assert.ok(fallback.includes(ATTACHMENT_URI));
});

test('materializePrivateChatFileMessage refuses an attachment with no usable pinId', async () => {
  const logs = [];
  const result = await materializePrivateChatFileMessage({
    payload: { attachment: 'metafile://broken', fileType: 'jpeg', encrypt: 'aes' },
    sharedSecretCandidates: [SHARED_SECRET_HEX],
    emitLog: (message) => logs.push(message),
  });
  assert.equal(result, null);
  assert.equal(logs.length, 1);
});

test('isPeerAttachmentReadablePath scopes peer thumbnails to the private-chat inbound directory', async () => {
  const { isPeerAttachmentReadablePath, PRIVATE_CHAT_INBOUND_DIR_NAME } = await import(
    '../dist-electron/main/services/privateChatFileMessage.js'
  );
  const path = (await import('node:path')).default;
  const os = (await import('node:os')).default;
  const userData = path.join(os.tmpdir(), 'idbots-peer-scope-test');
  const inbound = path.join(userData, PRIVATE_CHAT_INBOUND_DIR_NAME);

  // A daemon-written marker (materializePrivateChatFileMessage writes only
  // here): always readable. Prefix semantics — anything whose resolved form
  // stays inside the root passes; only the file existing on disk could make
  // it readable anyway, and the daemon never writes subdirectories.
  assert.equal(isPeerAttachmentReadablePath(path.join(inbound, 'abc.png'), userData), true);
  assert.equal(isPeerAttachmentReadablePath(path.join(inbound, 'sub', 'x.png'), userData), true);

  // Attacker-crafted markers naming arbitrary local files refuse.
  assert.equal(isPeerAttachmentReadablePath(path.join(userData, 'secret.png'), userData), false);
  assert.equal(isPeerAttachmentReadablePath(path.join(userData, 'private-chat-inbound-evil', 'x.png'), userData), false,
    'sibling directory whose name shares the prefix must not pass');
  assert.equal(isPeerAttachmentReadablePath(path.join(inbound, '..', '..', 'etc', 'passwd'), userData), false,
    '.. escape resolves outside the root and must not pass');
  assert.equal(isPeerAttachmentReadablePath('', userData), false);
  assert.equal(isPeerAttachmentReadablePath('/etc/passwd', userData), false);

  // The tmpdir fallback is the headless shape: same rules, different base.
  const tmpBase = '';
  assert.equal(isPeerAttachmentReadablePath(path.join(os.tmpdir(), PRIVATE_CHAT_INBOUND_DIR_NAME, 'abc.png'), tmpBase), true);
});
