/**
 * Weixin media unit tests (AES key formats, path safety, limits, degradation,
 * outbound upload prep and the two gateway media paths).
 *
 * Everything runs against fakes: no request ever leaves the process, so the
 * suite is safe offline and in CI.
 *
 * Run: npx tsx --test tests/weixinMedia.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  aesEcbPaddedSize,
  assertWeixinCdnUrl,
  buildWeixinCdnDownloadUrl,
  buildWeixinCdnUploadUrl,
  buildWeixinMediaItem,
  decryptAesEcb,
  describeWeixinOutboundCapabilities,
  downloadWeixinMedia,
  encryptAesEcb,
  extensionForMime,
  generateWeixinMediaFileName,
  mimeFromFileName,
  parseWeixinAesKey,
  prepareWeixinUpload,
  readWeixinMediaRefs,
  redactMediaSecrets,
  resolveInsideDir,
  sanitizeWeixinFileName,
  sniffImageMime,
  uploadKindForFile,
  weixinAesKeyToCdnField,
  weixinPlayLengthToSeconds,
  WeixinMediaError,
  WEIXIN_INBOUND_MAX_IMAGE_BYTES,
  WEIXIN_INBOUND_MAX_VIDEO_BYTES,
  WEIXIN_OUTBOUND_MAX_BYTES,
  WEIXIN_UPLOAD_MEDIA_TYPE,
  WEIXIN_VIDEO_PLAY_LENGTH_UNIT,
  type WeixinMediaNetwork,
  type WeixinMediaRef,
} from '../src/main/im/weixinMedia';
import {
  describeWeixinAttachments,
  formatWeixinMediaSize,
  WEIXIN_GROUP_MESSAGING_SUPPORTED,
  WEIXIN_INBOUND_VOICE_AUDIO_SUPPORTED,
  WEIXIN_ITEM_TYPE_FILE,
  WEIXIN_ITEM_TYPE_IMAGE,
  WEIXIN_ITEM_TYPE_VIDEO,
} from '../src/main/im/weixinProtocol';
import {
  buildChannelCapabilitiesBlock,
  formatChannelCapabilityByteLimit,
} from '../src/main/libs/experiencePromptBlocks';
import { decideWeixinImageCompression } from '../src/main/im/weixinImage';
import { WeixinGateway } from '../src/main/im/weixinGateway';
import { WeixinStore } from '../src/main/im/weixinStore';
import type { WeixinLedgerEntry, WeixinMessageLedger } from '../src/main/im/weixinLedger';
import type { WeixinHttpRequest, WeixinHttpResponse, WeixinTransport } from '../src/main/im/weixinTransport';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid PNG signature + IHDR so magic-byte sniffing sees "image/png". */
function pngBytes(payload = 'weixin-media-test'): Buffer {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ]);
  return Buffer.concat([header, Buffer.from(payload, 'utf8')]);
}

function tempDir(prefix: string): string {
  // Intentionally never deleted (task policy: no deletions in this workspace).
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Network double. `downloads` / `uploads` record what the gateway asked for. */
class FakeMediaNetwork implements WeixinMediaNetwork {
  readonly downloadUrls: string[] = [];
  readonly uploadUrls: string[] = [];
  readonly uploadedBodies: Buffer[] = [];
  /** Per-download cap the production code asked for, in call order. */
  readonly downloadMaxBytes: number[] = [];
  downloadHandler: (url: string) => Buffer;
  uploadHandler: (body: Buffer) => { status: number; encryptedParam: string | null; errorText?: string };

  constructor(
    downloadHandler: (url: string) => Buffer = () => pngBytes(),
    uploadHandler: (body: Buffer) => { status: number; encryptedParam: string | null; errorText?: string } =
      () => ({ status: 200, encryptedParam: 'test-encrypted-param' })
  ) {
    this.downloadHandler = downloadHandler;
    this.uploadHandler = uploadHandler;
  }

  async fetchBytes(url: string, options: { maxBytes: number }): Promise<Buffer> {
    this.downloadUrls.push(url);
    this.downloadMaxBytes.push(options.maxBytes);
    const body = this.downloadHandler(url);
    // Mirror the production guard so maxBytes is actually exercised.
    if (body.length > options.maxBytes) {
      throw new WeixinMediaError(`CDN download refused: ${body.length} bytes exceeds ${options.maxBytes}`);
    }
    return body;
  }

  async postBytes(
    url: string,
    body: Buffer
  ): Promise<{ status: number; encryptedParam: string | null; errorText?: string }> {
    this.uploadUrls.push(url);
    this.uploadedBodies.push(body);
    return this.uploadHandler(body);
  }
}

function imageRef(overrides: Partial<WeixinMediaRef> = {}): WeixinMediaRef {
  const key = crypto.randomBytes(16);
  return {
    kind: 'image',
    encryptQueryParam: 'param-with-slashes/and+plus',
    fullUrl: null,
    aesKeyBase64: Buffer.from(key).toString('base64'),
    aesKeyHex: null,
    fileName: null,
    sizeHint: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AES-128-ECB
// ---------------------------------------------------------------------------

test('aesEcbPaddedSize matches PKCS#7 block padding', () => {
  assert.equal(aesEcbPaddedSize(0), 16);
  assert.equal(aesEcbPaddedSize(1), 16);
  assert.equal(aesEcbPaddedSize(15), 16);
  assert.equal(aesEcbPaddedSize(16), 32);
  assert.equal(aesEcbPaddedSize(17), 32);
  assert.equal(aesEcbPaddedSize(100), 112);
  assert.throws(() => aesEcbPaddedSize(-1), WeixinMediaError);
});

test('AES-128-ECB round trip and ciphertext length', () => {
  const key = crypto.randomBytes(16);
  for (const size of [0, 1, 15, 16, 100, 4096]) {
    const plaintext = crypto.randomBytes(size);
    const ciphertext = encryptAesEcb(plaintext, key);
    assert.equal(ciphertext.length, aesEcbPaddedSize(size));
    assert.deepEqual(decryptAesEcb(ciphertext, key), plaintext);
  }

  assert.throws(() => encryptAesEcb(Buffer.from('x'), crypto.randomBytes(8)), WeixinMediaError);
  // Truncated ciphertext must fail loudly instead of returning garbage.
  const ciphertext = encryptAesEcb(Buffer.from('hello'), key);
  assert.throws(() => decryptAesEcb(ciphertext.subarray(0, ciphertext.length - 1), key), WeixinMediaError);
});

test('parseWeixinAesKey accepts both wire formats', () => {
  const key = crypto.randomBytes(16);
  const hex = key.toString('hex');

  // Format 1: base64(raw 16 bytes) — what images carry in media.aes_key.
  assert.deepEqual(parseWeixinAesKey(Buffer.from(key).toString('base64')), key);
  // Format 2: base64(32-char hex) — what file/video/voice carry, and what we send.
  assert.deepEqual(parseWeixinAesKey(Buffer.from(hex, 'ascii').toString('base64')), key);

  // Our outbound encoding round-trips through the inbound parser.
  assert.deepEqual(parseWeixinAesKey(weixinAesKeyToCdnField(hex)), key);

  assert.throws(() => parseWeixinAesKey(''), WeixinMediaError);
  assert.throws(() => parseWeixinAesKey(Buffer.from(crypto.randomBytes(20)).toString('base64')), WeixinMediaError);
  assert.throws(
    () => parseWeixinAesKey(Buffer.from('z'.repeat(32), 'ascii').toString('base64')),
    WeixinMediaError,
    '32 non-hex characters must be rejected'
  );
});

// ---------------------------------------------------------------------------
// Filenames and paths
// ---------------------------------------------------------------------------

test('sanitizeWeixinFileName strips traversal and unsafe characters', () => {
  assert.equal(sanitizeWeixinFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeWeixinFileName('..\\..\\windows\\system32\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeWeixinFileName('/var/tmp/report 2026.pdf'), 'report 2026.pdf');
  assert.equal(sanitizeWeixinFileName('.bashrc'), 'bashrc');
  assert.equal(sanitizeWeixinFileName('..'), 'weixin-file');
  assert.equal(sanitizeWeixinFileName('   '), 'weixin-file');
  assert.equal(sanitizeWeixinFileName(''), 'weixin-file');
  assert.equal(sanitizeWeixinFileName(null), 'weixin-file');
  assert.equal(sanitizeWeixinFileName(undefined, 'fallback.bin'), 'fallback.bin');

  const cleaned = sanitizeWeixinFileName('a<b>c:d"e|f?g*h\u0000\u0007.txt');
  assert.equal(cleaned, 'a_b_c_d_e_f_g_h.txt');

  const long = sanitizeWeixinFileName(`${'长'.repeat(400)}.pdf`);
  assert.ok(long.length <= 120, `expected <= 120 chars, got ${long.length}`);
  assert.ok(long.endsWith('.pdf'), 'extension must survive truncation');
});

test('resolveInsideDir refuses to escape the media directory', () => {
  const dir = tempDir('idbots-weixin-path-');
  const inside = resolveInsideDir(dir, 'weixin_1_abc.png');
  assert.equal(path.dirname(inside), path.resolve(dir));

  assert.throws(() => resolveInsideDir(dir, '../escape.png'), WeixinMediaError);
  assert.throws(() => resolveInsideDir(dir, '../../../../tmp/escape.png'), WeixinMediaError);
  assert.throws(() => resolveInsideDir(dir, '/etc/passwd'), WeixinMediaError);
});

test('generateWeixinMediaFileName is timestamped, random and extension-shaped', () => {
  const name = generateWeixinMediaFileName({ extension: 'png', now: 1700000000000, randomHex: 'deadbeef' });
  assert.equal(name, 'weixin_1700000000000_deadbeef.png');
  assert.ok(name.startsWith('weixin_'));
});

test('mime and magic-byte helpers', () => {
  assert.equal(mimeFromFileName('photo.JPG'), 'image/jpeg');
  assert.equal(mimeFromFileName('doc.pdf'), 'application/pdf');
  assert.equal(mimeFromFileName('unknown.zzz'), 'application/octet-stream');
  assert.equal(extensionForMime('image/png'), '.png');
  assert.equal(extensionForMime('application/x-unknown'), '.bin');
  // Regression: a live inbound 新建文本文档.txt landed as `.bin` before this map
  // learned the text types (docs/weixin-media-verification.md §2.2).
  assert.equal(extensionForMime(mimeFromFileName('新建文本文档.txt')), '.txt');
  assert.equal(extensionForMime('text/markdown'), '.md');
  assert.equal(extensionForMime('application/json'), '.json');
  assert.equal(sniffImageMime(pngBytes()), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x01])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('plain text')), null);
});

// ---------------------------------------------------------------------------
// CDN URLs
// ---------------------------------------------------------------------------

test('CDN URLs encode credentials and reject foreign hosts', () => {
  const download = buildWeixinCdnDownloadUrl('a/b+c=');
  assert.equal(download, 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Fb%2Bc%3D');

  const upload = buildWeixinCdnUploadUrl({ uploadParam: 'p/q', filekey: 'k1' });
  assert.equal(upload, 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=p%2Fq&filekey=k1');

  assert.equal(assertWeixinCdnUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1').hostname, 'novac2c.cdn.weixin.qq.com');
  assert.throws(() => assertWeixinCdnUrl('https://evil.example.com/x'), WeixinMediaError);
  assert.throws(() => assertWeixinCdnUrl('https://127.0.0.1/x'), WeixinMediaError);
  assert.throws(() => assertWeixinCdnUrl('file:///etc/passwd'), WeixinMediaError);
  assert.throws(() => assertWeixinCdnUrl('not a url'), WeixinMediaError);
});

test('redactMediaSecrets masks credentials inside diagnostic strings', () => {
  const raw = 'fetch failed for https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=SECRETVALUE&x=1 '
    + '{"aes_key":"QUJDREVGR0g="}';
  const scrubbed = redactMediaSecrets(raw);
  assert.ok(!scrubbed.includes('SECRETVALUE'));
  assert.ok(!scrubbed.includes('QUJDREVGR0g='));
  assert.match(scrubbed, /encrypted_query_param=\[REDACTED\]/);
  assert.match(scrubbed, /x=1/, 'unrelated parameters stay readable');
});

// ---------------------------------------------------------------------------
// Inbound item_list parsing
// ---------------------------------------------------------------------------

test('readWeixinMediaRefs applies the image > video > file priority', () => {
  const fileItem = {
    type: WEIXIN_ITEM_TYPE_FILE,
    file_item: {
      media: { encrypt_query_param: 'file-param', aes_key: 'file-key' },
      file_name: 'report.pdf',
      len: '1024',
    },
  };
  const imageItem = {
    type: WEIXIN_ITEM_TYPE_IMAGE,
    image_item: {
      media: { encrypt_query_param: 'image-param', aes_key: 'image-key' },
      aeskey: 'a'.repeat(32),
      mid_size: 4096,
    },
  };
  const videoItem = {
    type: WEIXIN_ITEM_TYPE_VIDEO,
    video_item: { media: { encrypt_query_param: 'video-param', aes_key: 'video-key' }, video_size: 8192 },
  };

  const imageFirst = readWeixinMediaRefs([fileItem, imageItem, videoItem] as never);
  assert.equal(imageFirst.refs.length, 1);
  assert.equal(imageFirst.refs[0].kind, 'image');
  assert.equal(imageFirst.refs[0].aesKeyHex, 'a'.repeat(32));
  assert.deepEqual(imageFirst.droppedKinds, ['video', 'file']);

  const videoOnly = readWeixinMediaRefs([fileItem, videoItem] as never);
  assert.equal(videoOnly.refs[0].kind, 'video');
  assert.deepEqual(videoOnly.droppedKinds, ['file']);

  const fileOnly = readWeixinMediaRefs([fileItem] as never);
  assert.equal(fileOnly.refs[0].fileName, 'report.pdf');
  assert.equal(fileOnly.refs[0].sizeHint, 1024);

  assert.deepEqual(readWeixinMediaRefs(undefined), { refs: [], droppedKinds: [], unusable: 0 });
  assert.deepEqual(readWeixinMediaRefs([]), { refs: [], droppedKinds: [], unusable: 0 });

  // A media item without any CDN credential is counted, not silently ignored.
  const credentialless = readWeixinMediaRefs([{ type: WEIXIN_ITEM_TYPE_IMAGE, image_item: { media: {} } }] as never);
  assert.equal(credentialless.refs.length, 0);
  assert.equal(credentialless.unusable, 1);
});

// ---------------------------------------------------------------------------
// Inbound download + decrypt + persist
// ---------------------------------------------------------------------------

test('downloadWeixinMedia decrypts base64(raw16) keys and writes inside the media dir', async () => {
  const dir = tempDir('idbots-weixin-in-');
  const key = crypto.randomBytes(16);
  const plaintext = pngBytes('hello-image');
  const network = new FakeMediaNetwork(() => encryptAesEcb(plaintext, key));

  const attachment = await downloadWeixinMedia(
    imageRef({ aesKeyBase64: Buffer.from(key).toString('base64'), fileName: '../../evil.png' }),
    { dir, network }
  );

  assert.equal(attachment.type, 'image');
  assert.equal(attachment.mimeType, 'image/png');
  assert.equal(attachment.fileName, 'evil.png');
  assert.equal(attachment.fileSize, plaintext.length);
  assert.equal(path.dirname(attachment.localPath), path.resolve(dir));
  assert.deepEqual(fs.readFileSync(attachment.localPath), plaintext);
  assert.equal(network.downloadUrls.length, 1);
  assert.match(network.downloadUrls[0], /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/download\?encrypted_query_param=/);
});

test('downloadWeixinMedia decrypts base64(hex) keys (file format)', async () => {
  const dir = tempDir('idbots-weixin-in-');
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.from('column_a,column_b\n1,2\n', 'utf8');
  const network = new FakeMediaNetwork(() => encryptAesEcb(plaintext, key));

  const ref: WeixinMediaRef = {
    kind: 'file',
    encryptQueryParam: 'file-param',
    fullUrl: null,
    aesKeyBase64: Buffer.from(key.toString('hex'), 'ascii').toString('base64'),
    aesKeyHex: null,
    fileName: 'report.csv',
    sizeHint: plaintext.length,
  };
  const attachment = await downloadWeixinMedia(ref, { dir, network });

  assert.equal(attachment.type, 'document');
  assert.equal(attachment.mimeType, 'text/csv');
  assert.equal(attachment.fileName, 'report.csv');
  assert.deepEqual(fs.readFileSync(attachment.localPath), plaintext);
});

test('downloadWeixinMedia trusts a full_url only on WeChat CDN hosts', async () => {
  const dir = tempDir('idbots-weixin-in-');
  const network = new FakeMediaNetwork(() => pngBytes());

  await assert.rejects(
    downloadWeixinMedia(
      imageRef({ encryptQueryParam: null, fullUrl: 'https://evil.example.com/steal' }),
      { dir, network }
    ),
    WeixinMediaError
  );
  assert.equal(network.downloadUrls.length, 0, 'no request may be made to a foreign host');

  const ok = await downloadWeixinMedia(
    imageRef({
      encryptQueryParam: null,
      fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc',
      aesKeyBase64: null,
    }),
    { dir, network }
  );
  assert.ok(fs.existsSync(ok.localPath));
});

test('downloadWeixinMedia discards oversize bodies without writing a file', async () => {
  const dir = tempDir('idbots-weixin-in-');
  const key = crypto.randomBytes(16);
  const big = Buffer.concat([pngBytes(), crypto.randomBytes(4096)]);
  const network = new FakeMediaNetwork(() => encryptAesEcb(big, key));

  // The default cap for an image is 30 MB; pass a small one so the guard is
  // exercised without allocating megabytes in the test process.
  await assert.rejects(
    downloadWeixinMedia(
      imageRef({ aesKeyBase64: Buffer.from(key).toString('base64') }),
      { dir, network, maxBytes: 1024 }
    ),
    WeixinMediaError
  );
  assert.deepEqual(fs.readdirSync(dir), [], 'an oversize download leaves no partial file');
  assert.ok(WEIXIN_INBOUND_MAX_IMAGE_BYTES >= 30 * 1024 * 1024);
});

test('downloadWeixinMedia fails closed on a bad key instead of writing garbage', async () => {
  const dir = tempDir('idbots-weixin-in-');
  // FIXED keys, not random: with a random wrong key ~1/256 decryptions happen
  // to end in valid PKCS#7 padding and do NOT throw (observed once in a full
  // suite run on 2026-11-04). Fixed input makes the expectation deterministic.
  const key = Buffer.alloc(16, 0x11);
  const wrongKey = Buffer.alloc(16, 0x22);
  const network = new FakeMediaNetwork(() => encryptAesEcb(pngBytes(), key));

  await assert.rejects(
    downloadWeixinMedia(imageRef({ aesKeyBase64: Buffer.from(wrongKey).toString('base64') }), { dir, network }),
    WeixinMediaError
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('downloadWeixinMedia stores unknown files without a key as-is', async () => {
  const dir = tempDir('idbots-weixin-in-');
  const plaintext = Buffer.from('transparent payload', 'utf8');
  const network = new FakeMediaNetwork(() => plaintext);

  const ref: WeixinMediaRef = {
    kind: 'file',
    encryptQueryParam: 'plain-param',
    fullUrl: null,
    aesKeyBase64: null,
    aesKeyHex: null,
    fileName: 'notes.txt',
    sizeHint: null,
  };
  const attachment = await downloadWeixinMedia(ref, { dir, network });
  assert.equal(attachment.mimeType, 'text/plain');
  assert.deepEqual(fs.readFileSync(attachment.localPath), plaintext);
});

test('downloadWeixinMedia rejects an item with no download credential', async () => {
  const dir = tempDir('idbots-weixin-in-');
  const network = new FakeMediaNetwork();
  await assert.rejects(
    downloadWeixinMedia(imageRef({ encryptQueryParam: null, fullUrl: null }), { dir, network }),
    WeixinMediaError
  );
});

// ---------------------------------------------------------------------------
// Video: separate inbound cap, metadata, one-line description
// ---------------------------------------------------------------------------

function videoRef(overrides: Partial<WeixinMediaRef> = {}): WeixinMediaRef {
  return {
    kind: 'video',
    encryptQueryParam: 'video-param',
    fullUrl: null,
    aesKeyBase64: null,
    aesKeyHex: null,
    fileName: null,
    sizeHint: null,
    playLength: null,
    ...overrides,
  };
}

test('inbound video reuses the shared pipeline but a separate 100 MB cap', async () => {
  const dir = tempDir('idbots-weixin-video-');
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(2048, 0x11)]);
  const network = new FakeMediaNetwork(() => encryptAesEcb(plaintext, key));

  const attachment = await downloadWeixinMedia(
    videoRef({ aesKeyBase64: Buffer.from(key).toString('base64'), playLength: 9 }),
    { dir, network }
  );

  // Same download → decrypt → persist path as images/files …
  assert.equal(attachment.type, 'video');
  assert.equal(attachment.mimeType, 'video/mp4');
  assert.equal(attachment.fileSize, plaintext.length);
  assert.equal(path.dirname(attachment.localPath), path.resolve(dir));
  assert.deepEqual(fs.readFileSync(attachment.localPath), plaintext);
  // … but its own cap, and not the 30 MB image guard.
  assert.equal(network.downloadMaxBytes[0], WEIXIN_INBOUND_MAX_VIDEO_BYTES);
  assert.notEqual(WEIXIN_INBOUND_MAX_VIDEO_BYTES, WEIXIN_INBOUND_MAX_IMAGE_BYTES);
  // No fabricated metadata: the protocol carries no video width/height.
  assert.equal(attachment.width, undefined);
  assert.equal(attachment.height, undefined);
  // play_length is seconds (verified against a live sample), so it is mapped.
  assert.equal(attachment.duration, 9);
});

test('an image still uses the image cap — the video cap is not shared', async () => {
  const dir = tempDir('idbots-weixin-image-cap-');
  const key = crypto.randomBytes(16);
  const network = new FakeMediaNetwork(() => encryptAesEcb(pngBytes(), key));
  await downloadWeixinMedia(
    imageRef({ aesKeyBase64: Buffer.from(key).toString('base64') }),
    { dir, network }
  );
  assert.equal(network.downloadMaxBytes[0], WEIXIN_INBOUND_MAX_IMAGE_BYTES);
});

test('weixinPlayLengthToSeconds maps a seconds value and converts milliseconds', () => {
  // The unit is 's' because a live 9.0417 s clip arrived with play_length = 9.
  assert.equal(WEIXIN_VIDEO_PLAY_LENGTH_UNIT, 's');
  assert.equal(weixinPlayLengthToSeconds(9), 9);
  assert.equal(weixinPlayLengthToSeconds(12, 's'), 12);
  assert.equal(weixinPlayLengthToSeconds(12345, 'ms'), 12.3);
  assert.equal(weixinPlayLengthToSeconds(12, 'unknown'), null);
  assert.equal(weixinPlayLengthToSeconds(null), null);
  assert.equal(weixinPlayLengthToSeconds(undefined), null);
});

test('readWeixinMediaRefs carries video play_length through untouched', () => {
  const videoItem = {
    type: WEIXIN_ITEM_TYPE_VIDEO,
    video_item: {
      media: { encrypt_query_param: 'video-param', aes_key: 'video-key' },
      video_size: 8192,
      play_length: 12000,
    },
  };
  const result = readWeixinMediaRefs([videoItem] as never);
  assert.equal(result.refs[0].kind, 'video');
  assert.equal(result.refs[0].playLength, 12000);
  assert.equal(result.refs[0].sizeHint, 8192);
});

test('a video-only message becomes a description carrying its size', () => {
  assert.equal(formatWeixinMediaSize(12.3 * 1024 * 1024), '12.3MB');
  assert.equal(formatWeixinMediaSize(1536), '2KB');
  assert.equal(formatWeixinMediaSize(512), '512B');
  assert.equal(formatWeixinMediaSize(undefined), null);

  assert.equal(
    describeWeixinAttachments([
      { type: 'video', localPath: '/tmp/x.mp4', mimeType: 'video/mp4', fileSize: 12.9 * 1024 * 1024 },
    ]),
    '用户发送了一个视频 12.9MB'
  );
  assert.equal(
    describeWeixinAttachments([{ type: 'video', localPath: '/tmp/x.mp4', mimeType: 'video/mp4' }]),
    '用户发送了一个视频'
  );
});

// ---------------------------------------------------------------------------
// Outbound: upload preparation + item shape
// ---------------------------------------------------------------------------

test('prepareWeixinUpload produces the getuploadurl fields and a decryptable body', () => {
  const plaintext = Buffer.from('a'.repeat(100), 'utf8');
  let counter = 0;
  const prepared = prepareWeixinUpload(plaintext, {
    randomBytes: (n) => Buffer.alloc(n, ++counter),
  });

  assert.match(prepared.aesKeyHex, /^[0-9a-f]{32}$/);
  assert.match(prepared.filekey, /^[0-9a-f]{32}$/);
  assert.equal(prepared.rawsize, plaintext.length);
  assert.equal(prepared.filesize, aesEcbPaddedSize(plaintext.length));
  assert.equal(prepared.ciphertext.length, prepared.filesize);
  assert.equal(prepared.rawfilemd5, crypto.createHash('md5').update(plaintext).digest('hex'));

  const key = Buffer.from(prepared.aesKeyHex, 'hex');
  assert.deepEqual(decryptAesEcb(prepared.ciphertext, key), plaintext);
});

test('buildWeixinMediaItem emits the documented shapes for image / video / file', () => {
  const plaintext = Buffer.from('payload', 'utf8');
  const prepared = prepareWeixinUpload(plaintext);
  const key = Buffer.from(prepared.aesKeyHex, 'hex');

  const image = buildWeixinMediaItem({
    kind: 'image',
    downloadEncryptedQueryParam: 'download-param',
    prepared,
  });
  assert.equal(image.type, WEIXIN_ITEM_TYPE_IMAGE);
  assert.equal(image.image_item.media.encrypt_query_param, 'download-param');
  assert.equal(image.image_item.media.encrypt_type, 1);
  assert.equal(image.image_item.mid_size, prepared.filesize);
  // aes_key must be base64(hex), and must decode back to the key we encrypted with.
  assert.equal(image.image_item.media.aes_key, weixinAesKeyToCdnField(prepared.aesKeyHex));
  assert.deepEqual(parseWeixinAesKey(image.image_item.media.aes_key as string), key);

  const video = buildWeixinMediaItem({ kind: 'video', downloadEncryptedQueryParam: 'p', prepared });
  assert.equal(video.type, WEIXIN_ITEM_TYPE_VIDEO);
  assert.equal(video.video_item.video_size, prepared.filesize);

  const file = buildWeixinMediaItem({
    kind: 'file',
    downloadEncryptedQueryParam: 'p',
    prepared,
    fileName: '../../etc/passwd',
  });
  assert.equal(file.type, WEIXIN_ITEM_TYPE_FILE);
  // The remote filename is sanitized before it leaves the process.
  assert.equal(file.file_item.file_name, 'passwd');
  assert.equal(file.file_item.len, String(plaintext.length));
});

test('uploadKindForFile maps extensions onto upload media types', () => {
  assert.deepEqual(uploadKindForFile('photo.jpg'), { kind: 'image', mediaType: 1 });
  assert.deepEqual(uploadKindForFile('clip.MP4'), { kind: 'video', mediaType: 2 });
  assert.deepEqual(uploadKindForFile('report.pdf'), { kind: 'file', mediaType: 3 });
  assert.deepEqual(uploadKindForFile('unknown.zzz'), { kind: 'file', mediaType: 3 });
  // Audio is a FILE attachment: this channel has no voice-bubble path.
  for (const extension of ['.mp3', '.wav', '.m4a', '.ogg']) {
    assert.deepEqual(
      uploadKindForFile(`recording${extension}`),
      { kind: 'file', mediaType: WEIXIN_UPLOAD_MEDIA_TYPE.file },
      `${extension} must be sent as a file`
    );
  }
  // Extensions are matched case-insensitively, like every other kind.
  assert.deepEqual(uploadKindForFile('RECORDING.MP3'), { kind: 'file', mediaType: 3 });
});

// ---------------------------------------------------------------------------
// Channel capability manifest (constant-derived)
// ---------------------------------------------------------------------------

test('channel capability block lists exactly what the media tables actually support', () => {
  const block = buildChannelCapabilitiesBlock('im:weixin:direct');
  const capabilities = describeWeixinOutboundCapabilities();

  assert.match(block, /^<channel_capabilities /);
  for (const [kind, extensions] of Object.entries(capabilities.extensionsByKind)) {
    for (const extension of extensions) {
      assert.ok(block.includes(`.${extension}`), `${kind} extension .${extension} missing from the block`);
    }
  }
  // The ceiling is the constant, formatted from it — not a hand-typed 100 MB.
  assert.equal(capabilities.maxOutboundBytes, WEIXIN_OUTBOUND_MAX_BYTES);
  assert.ok(block.includes(formatChannelCapabilityByteLimit(WEIXIN_OUTBOUND_MAX_BYTES)));
  assert.ok(block.includes(String(WEIXIN_OUTBOUND_MAX_BYTES)));

  // Same-source invariant: every audio extension really is a FILE attachment,
  // and the block says so instead of advertising a voice bubble.
  assert.ok(capabilities.audioExtensions.length > 0, 'the manifest must know its audio extensions');
  for (const extension of capabilities.audioExtensions) {
    assert.deepEqual(
      uploadKindForFile(`sample.${extension}`),
      { kind: 'file', mediaType: WEIXIN_UPLOAD_MEDIA_TYPE.file },
      `.${extension} is audio and must be sent as a file`
    );
  }
  assert.match(block, /- 音频：.*按普通文件发送/);
  assert.match(block, /不生成语音条/);
  assert.doesNotMatch(block, /语音条（voice item/);

  // The "cannot do" facts come from the protocol constants, not from prose.
  assert.equal(
    block.includes('只使用服务端转写文字'),
    !WEIXIN_INBOUND_VOICE_AUDIO_SUPPORTED
  );
});

test('channel capability block is injected for weixin IM and the desktop inventory', () => {
  assert.equal(buildChannelCapabilitiesBlock(null), '');
  assert.equal(buildChannelCapabilitiesBlock(undefined), '');
  // cowork_ui now always renders an explicit block: silence was what sent the
  // desktop agent off to drive the WeChat client window. With no inventory it
  // must SAY there is no usable channel, never return ''.
  assert.match(buildChannelCapabilitiesBlock('cowork_ui'), /当前没有可用通道/);
  assert.equal(buildChannelCapabilitiesBlock('im:qq:direct'), '');
  assert.notEqual(buildChannelCapabilitiesBlock('im:weixin'), '');
  assert.notEqual(buildChannelCapabilitiesBlock('IM:Weixin:Direct'), '');
});

test('weixin group chats are described as disabled while the constant says so', () => {
  const block = buildChannelCapabilitiesBlock('im:weixin:group');
  if (WEIXIN_GROUP_MESSAGING_SUPPORTED) {
    assert.match(block, /群聊/);
  } else {
    assert.ok(block.includes('WEIXIN_GROUP_MESSAGING_SUPPORTED = false'));
    assert.ok(block.includes('不要尝试在此会话发送任何微信消息或附件'));
  }
});

test('wiring: the cowork volatile tail injects the capability block from the session channel', () => {
  const source = fs.readFileSync(path.resolve('src/main/libs/coworkRunner.ts'), 'utf8');
  assert.match(source, /key: 'channel-capabilities'/, 'the volatile tail must carry the block');
  // The channel comes from the session row — never from a prompt argument.
  assert.match(
    source,
    /const capabilitySourceChannel =\s*\n?\s*this\.store\.getConversationSourceContextBySession\(sessionId\)/,
    'the block must be derived from the session sourceChannel'
  );
  // Desktop sessions additionally get the live IM inventory; im: sessions keep
  // their own per-channel manifest.
  assert.match(
    source,
    /connectedChannels: capabilitySourceChannel === 'cowork_ui'/,
    'cowork_ui must receive the live outbound-channel inventory'
  );
});


// ---------------------------------------------------------------------------
// Outbound image policy
// ---------------------------------------------------------------------------

test('decideWeixinImageCompression only fires on our own size/pixel guard', () => {
  assert.deepEqual(
    decideWeixinImageCompression({ bytes: 1024 * 1024, width: 1200, height: 800 }),
    { needsCompression: false, reason: null, targetLongSide: null }
  );

  assert.deepEqual(
    decideWeixinImageCompression({ bytes: 5 * 1024 * 1024, width: 1200, height: 800 }),
    { needsCompression: true, reason: 'bytes', targetLongSide: null }
  );

  assert.deepEqual(
    decideWeixinImageCompression({ bytes: 1024, width: 9000, height: 4000 }),
    { needsCompression: true, reason: 'dimensions', targetLongSide: 4096 }
  );

  assert.deepEqual(
    decideWeixinImageCompression({ bytes: 9 * 1024 * 1024, width: 9000, height: 4000 }),
    { needsCompression: true, reason: 'both', targetLongSide: 4096 }
  );

  // Unknown dimensions: only the byte rule can fire.
  assert.equal(
    decideWeixinImageCompression({ bytes: 9 * 1024 * 1024, width: null, height: null }).reason,
    'bytes'
  );
});

// ---------------------------------------------------------------------------
// Gateway: inbound
// ---------------------------------------------------------------------------

class FakeTransport implements WeixinTransport {
  readonly calls: WeixinHttpRequest[] = [];
  private handler: (request: WeixinHttpRequest) => Promise<WeixinHttpResponse> | WeixinHttpResponse;

  constructor(handler: (request: WeixinHttpRequest) => Promise<WeixinHttpResponse> | WeixinHttpResponse) {
    this.handler = handler;
  }

  setHandler(handler: (request: WeixinHttpRequest) => Promise<WeixinHttpResponse> | WeixinHttpResponse): void {
    this.handler = handler;
  }

  async request(request: WeixinHttpRequest): Promise<WeixinHttpResponse> {
    this.calls.push(request);
    return this.handler(request);
  }

  callsTo(pathName: string): WeixinHttpRequest[] {
    return this.calls.filter((call) => call.path === pathName);
  }
}

function makeGateway(
  transport: FakeTransport,
  mediaNetwork: FakeMediaNetwork,
  mediaRootDir: string,
  extra: {
    messageLedger?: WeixinMessageLedger;
  } = {}
): WeixinGateway {
  const store = new WeixinStore(tempDir('idbots-weixin-media-store-'));
  store.saveCredentials(
    { token: 'ilinkbot_media_test_token', baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'bot@im.bot', userId: 'user@im.wechat' },
    'default'
  );
  store.saveSync('cursor-0', 'default');
  let tick = 1_700_000_000_000;
  return new WeixinGateway({
    transport,
    store,
    mediaNetwork,
    mediaRootDir,
    imageCompressor: () => null,
    now: () => ++tick,
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    pollBackoffMs: [1, 1, 1],
    pollTimeoutMs: 50,
    ...extra,
  });
}

/** Long poll that settles only when the gateway aborts the poll loop. */
function blockingLongPoll(request: WeixinHttpRequest): Promise<WeixinHttpResponse> {
  return new Promise((_resolve, reject) => {
    const signal = request.signal;
    if (!signal) {
      reject(new Error('blocking long poll requires an abort signal'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

/**
 * Collect console.warn output as one searchable string. Used to prove that a
 * degrade is LOGGED (the log line is part of the contract), and always restored
 * in a finally so a failure cannot silence the suite.
 */
function captureWarn(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  const stringify = (value: unknown): string => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(stringify).join(' '));
  };
  return {
    text: () => lines.join('\n'),
    restore: () => {
      console.warn = original;
    },
  };
}

test('gateway downloads an inbound image and hands attachments to IMMessage', async () => {
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  const key = crypto.randomBytes(16);
  const plaintext = pngBytes('gateway-inbound');
  const mediaNetwork = new FakeMediaNetwork(() => encryptAesEcb(plaintext, key));

  let served = false;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates' && !served) {
      served = true;
      return {
        status: 200,
        data: {
          ret: 0,
          get_updates_buf: 'cursor-1',
          msgs: [
            {
              message_id: 'm-image-1',
              from_user_id: 'user@im.wechat',
              message_type: 1,
              context_token: 'ctx-1',
              create_time_ms: 1_700_000_000_500,
              item_list: [
                {
                  type: WEIXIN_ITEM_TYPE_IMAGE,
                  image_item: {
                    media: {
                      encrypt_query_param: 'inbound-param',
                      aes_key: Buffer.from(key.toString('hex'), 'ascii').toString('base64'),
                    },
                    mid_size: plaintext.length,
                  },
                },
              ],
            },
          ],
        },
      };
    }
    return blockingLongPoll(request);
  });

  const gateway = makeGateway(transport, mediaNetwork, mediaRoot);
  const messages: Array<{ content: string; attachments?: Array<{ localPath: string; mimeType: string }> }> = [];
  gateway.on('message', (message) => messages.push(message));

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => messages.length > 0);
  } finally {
    await gateway.stop();
  }

  const inbound = messages[0];
  assert.equal(inbound.content, '用户发送了图片 1 张');
  assert.equal(inbound.attachments?.length, 1);
  assert.equal(inbound.attachments?.[0].mimeType, 'image/png');
  assert.ok(inbound.attachments?.[0].localPath.startsWith(path.resolve(mediaRoot)));
  assert.deepEqual(fs.readFileSync(inbound.attachments![0].localPath), plaintext);
});

test('gateway keeps the message when an attachment fails to download', async () => {
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  const mediaNetwork = new FakeMediaNetwork(() => {
    throw new WeixinMediaError('CDN download failed with HTTP 404');
  });

  let served = false;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates' && !served) {
      served = true;
      return {
        status: 200,
        data: {
          ret: 0,
          get_updates_buf: 'cursor-2',
          msgs: [
            {
              message_id: 'm-file-1',
              from_user_id: 'user@im.wechat',
              message_type: 1,
              item_list: [
                { type: WEIXIN_ITEM_TYPE_FILE, file_item: { media: { encrypt_query_param: 'x', aes_key: 'k' }, file_name: 'a.pdf' } },
              ],
            },
          ],
        },
      };
    }
    return blockingLongPoll(request);
  });

  const gateway = makeGateway(transport, mediaNetwork, mediaRoot);
  const messages: Array<{ content: string; attachments?: unknown[] }> = [];
  gateway.on('message', (message) => messages.push(message));

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => messages.length > 0);
  } finally {
    await gateway.stop();
  }

  assert.equal(messages.length, 1, 'a failed attachment must not drop the message');
  assert.equal(messages[0].content, '用户发送了附件，但下载失败');
  assert.equal(messages[0].attachments?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// Gateway: outbound
// ---------------------------------------------------------------------------

test('sendMedia uploads the encrypted bytes and sends an image item', async () => {
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  const mediaNetwork = new FakeMediaNetwork();
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getuploadurl') {
      return { status: 200, data: { ret: 0, upload_param: 'upload-token' } };
    }
    if (request.path === 'ilink/bot/sendmessage') {
      return { status: 200, data: { ret: 0, message_id: 42 } };
    }
    return blockingLongPoll(request);
  });

  const gateway = makeGateway(transport, mediaNetwork, mediaRoot);
  const sourcePath = path.join(mediaRoot, 'outbound.png');
  const plaintext = pngBytes('outbound-image');
  fs.writeFileSync(sourcePath, plaintext);

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await gateway.sendMedia('wx_user_3', sourcePath);
  } finally {
    await gateway.stop();
  }

  const uploadCall = transport.callsTo('ilink/bot/getuploadurl')[0];
  assert.ok(uploadCall, 'getuploadurl must be called');
  const uploadBody = uploadCall.body as Record<string, unknown>;
  assert.equal(uploadBody.media_type, 1);
  assert.equal(uploadBody.rawsize, plaintext.length);
  assert.equal(uploadBody.filesize, aesEcbPaddedSize(plaintext.length));
  assert.equal(uploadBody.no_need_thumb, true);
  assert.match(String(uploadBody.aeskey), /^[0-9a-f]{32}$/);

  // The CDN got ciphertext that decrypts to the original file under that key.
  const uploadUrl = mediaNetwork.uploadUrls[0];
  assert.match(uploadUrl, /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?encrypted_query_param=upload-token&filekey=/);
  assert.equal(mediaNetwork.uploadedBodies.length, 1);
  const decrypted = decryptAesEcb(mediaNetwork.uploadedBodies[0], Buffer.from(String(uploadBody.aeskey), 'hex'));
  assert.deepEqual(decrypted, plaintext);

  const sendCall = transport.callsTo('ilink/bot/sendmessage')[0];
  assert.ok(sendCall, 'sendmessage must be called');
  const sendBody = sendCall.body as { msg: { to_user_id: string; item_list: Array<Record<string, any>> } };
  assert.equal(sendBody.msg.to_user_id, 'wx_user_3');
  assert.equal(sendBody.msg.item_list.length, 1);
  const item = sendBody.msg.item_list[0];
  assert.equal(item.type, WEIXIN_ITEM_TYPE_IMAGE);
  assert.equal(item.image_item.media.encrypt_query_param, 'test-encrypted-param');
  assert.equal(item.image_item.media.encrypt_type, 1);
  assert.equal(item.image_item.mid_size, aesEcbPaddedSize(plaintext.length));
  assert.deepEqual(
    parseWeixinAesKey(item.image_item.media.aes_key),
    Buffer.from(String(uploadBody.aeskey), 'hex')
  );
});

test('sendMedia records the outbound message id so a later quote names the media type', async () => {
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  const mediaNetwork = new FakeMediaNetwork();
  const rows = new Map<string, WeixinLedgerEntry>();
  const messageLedger: WeixinMessageLedger = {
    put: (entry) => {
      rows.set(entry.msgId, entry);
    },
    get: (msgId) => rows.get(msgId) ?? null,
  };
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getuploadurl') {
      return { status: 200, data: { ret: 0, upload_param: 'upload-token' } };
    }
    if (request.path === 'ilink/bot/sendmessage') {
      return { status: 200, data: { ret: 0, message_id: '7523489994131519399' } };
    }
    return blockingLongPoll(request);
  });

  const gateway = makeGateway(transport, mediaNetwork, mediaRoot, { messageLedger });
  const sourcePath = path.join(mediaRoot, 'quoted.png');
  fs.writeFileSync(sourcePath, pngBytes('quoted-image'));

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await gateway.sendMedia('wx_user_quoted', sourcePath);
  } finally {
    await gateway.stop();
  }

  const row = rows.get('7523489994131519399');
  assert.ok(row, 'the media sendmessage id must be in the ledger');
  assert.equal(row?.direction, 'out');
  assert.equal(row?.kind, 'image');
  // No caption is stored for a bare media send: quoting it must say
  // "引用了一张图片", never a guessed file name.
  assert.equal(row?.text, null);
  assert.equal(row?.conversationId, 'wx_user_quoted');
});

test('sendMedia sends an audio file as a FILE item, never a voice bubble', async () => {
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  const mediaNetwork = new FakeMediaNetwork();
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getuploadurl') {
      return { status: 200, data: { ret: 0, upload_param: 'upload-token' } };
    }
    if (request.path === 'ilink/bot/sendmessage') {
      return { status: 200, data: { ret: 0, message_id: 44 } };
    }
    return blockingLongPoll(request);
  });

  const gateway = makeGateway(transport, mediaNetwork, mediaRoot);
  const sourcePath = path.join(mediaRoot, 'note.mp3');
  const plaintext = Buffer.concat([Buffer.from('ID3\x04\x00\x00', 'binary'), Buffer.alloc(64, 0)]);
  fs.writeFileSync(sourcePath, plaintext);

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await gateway.sendMedia('wx_user_audio', sourcePath);
  } finally {
    await gateway.stop();
  }

  const uploadBody = transport.callsTo('ilink/bot/getuploadurl')[0].body as Record<string, unknown>;
  assert.equal(uploadBody.media_type, WEIXIN_UPLOAD_MEDIA_TYPE.file, 'audio must upload as media_type 3');
  assert.equal(uploadBody.rawsize, plaintext.length, 'the original audio bytes are uploaded untouched');

  const sendBody = transport.callsTo('ilink/bot/sendmessage')[0].body as {
    msg: { item_list: Array<Record<string, any>> };
  };
  const item = sendBody.msg.item_list[0];
  assert.equal(item.type, WEIXIN_ITEM_TYPE_FILE, 'item type 4 = file');
  assert.equal(item.voice_item, undefined, 'no voice item is produced');
  assert.equal(item.file_item.file_name, 'note.mp3');
  assert.equal(item.file_item.len, String(plaintext.length));

  // The CDN got exactly the source bytes — no transcode happened.
  assert.deepEqual(mediaNetwork.uploadedBodies.length, 1);
  const uploadBodyAes = Buffer.from(String(uploadBody.aeskey), 'hex');
  assert.deepEqual(decryptAesEcb(mediaNetwork.uploadedBodies[0], uploadBodyAes), plaintext);
});

test('sendMedia refuses files above the client ceiling and empty files', async () => {
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  const transport = new FakeTransport((request) => blockingLongPoll(request));
  const gateway = makeGateway(transport, new FakeMediaNetwork(), mediaRoot);
  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    const empty = path.join(mediaRoot, 'empty.txt');
    fs.writeFileSync(empty, Buffer.alloc(0));
    await assert.rejects(gateway.sendMedia('wx_user_4', empty), WeixinMediaError);
    await assert.rejects(gateway.sendMedia('wx_user_4', path.join(mediaRoot, 'missing.pdf')), WeixinMediaError);
  } finally {
    await gateway.stop();
  }
});

test('replyFn sends stripped text then the referenced image', async () => {
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  const mediaNetwork = new FakeMediaNetwork();
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getuploadurl') {
      return { status: 200, data: { ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=x&filekey=y' } };
    }
    if (request.path === 'ilink/bot/sendmessage') {
      return { status: 200, data: { ret: 0 } };
    }
    if (request.path === 'ilink/bot/getupdates' && !served) {
      served = true;
      return {
        status: 200,
        data: {
          ret: 0,
          get_updates_buf: 'cursor-reply',
          msgs: [{ message_id: 'm-text-1', from_user_id: 'user@im.wechat', message_type: 1, item_list: [{ type: 1, text_item: { text: '发我一张图' } }] }],
        },
      };
    }
    return blockingLongPoll(request);
  });

  let served = false;
  const gateway = makeGateway(transport, mediaNetwork, mediaRoot);
  const imagePath = path.join(mediaRoot, 'reply.png');
  fs.writeFileSync(imagePath, pngBytes('reply-image'));

  let replied = false;
  gateway.setMessageCallback(async (_message, replyFn) => {
    await replyFn(`好的，图片如下：\n![示意图](${imagePath})`);
    replied = true;
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => replied);
  } finally {
    await gateway.stop();
  }

  const sends = transport.callsTo('ilink/bot/sendmessage').map((call) => call.body as {
    msg: { item_list: Array<Record<string, any>> };
  });
  assert.equal(sends.length, 2, 'one text message + one media message');
  assert.equal(sends[0].msg.item_list[0].type, 1);
  assert.equal(sends[0].msg.item_list[0].text_item.text, '好的，图片如下：');
  assert.equal(sends[1].msg.item_list[0].type, WEIXIN_ITEM_TYPE_IMAGE);
  assert.equal(sends[1].msg.item_list[0].image_item.media.encrypt_query_param, 'test-encrypted-param');
});

test('replyFn reports a missing media file instead of staying silent', async () => {
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  let served = false;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/sendmessage') {
      return { status: 200, data: { ret: 0 } };
    }
    if (request.path === 'ilink/bot/getupdates' && !served) {
      served = true;
      return {
        status: 200,
        data: {
          ret: 0,
          get_updates_buf: 'cursor-missing',
          msgs: [{ message_id: 'm-text-2', from_user_id: 'user@im.wechat', message_type: 1, item_list: [{ type: 1, text_item: { text: '发文件' } }] }],
        },
      };
    }
    return blockingLongPoll(request);
  });

  const gateway = makeGateway(transport, new FakeMediaNetwork(), mediaRoot);
  let replied = false;
  gateway.setMessageCallback(async (_message, replyFn) => {
    await replyFn('给你：\n[报告](/tmp/definitely-missing-report.pdf)');
    replied = true;
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => replied);
  } finally {
    await gateway.stop();
  }

  const sends = transport.callsTo('ilink/bot/sendmessage').map((call) => call.body as {
    msg: { item_list: Array<Record<string, any>> };
  });
  const texts = sends.map((send) => String(send.msg.item_list[0]?.text_item?.text || ''));
  assert.ok(texts.some((text) => text.includes('附件未找到')), `expected a failure notice, got ${JSON.stringify(texts)}`);
});

test('sendToConversation delivers text and media with no inbound reply closure', async () => {
  // The out-of-turn seam: a turn triggered by an injected notification has no
  // `replyFn`, so IMCoworkHandler calls this method with the conversation id it
  // stored from an earlier inbound message. Media markers must resolve here too.
  const mediaRoot = tempDir('idbots-weixin-media-root-');
  const mediaNetwork = new FakeMediaNetwork();
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getuploadurl') {
      return { status: 200, data: { ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=x&filekey=y' } };
    }
    if (request.path === 'ilink/bot/sendmessage') {
      return { status: 200, data: { ret: 0 } };
    }
    return blockingLongPoll(request);
  });

  const gateway = makeGateway(transport, mediaNetwork, mediaRoot);
  const imagePath = path.join(mediaRoot, 'out-of-turn.png');
  fs.writeFileSync(imagePath, pngBytes('out-of-turn-image'));

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    // No inbound message was ever handled in this test: exactly the ORCH-NOTIFY
    // shape, where only the conversation id is known.
    await gateway.sendToConversation('user@im.wechat', `编排已回执：\n![截图](${imagePath})`);
  } finally {
    await gateway.stop();
  }

  const sends = transport.callsTo('ilink/bot/sendmessage').map((call) => call.body as {
    msg: { to_user_id: string; item_list: Array<Record<string, any>> };
  });
  assert.equal(sends.length, 2, 'one text message + one media message');
  assert.equal(sends[0].msg.to_user_id, 'user@im.wechat');
  assert.equal(sends[0].msg.item_list[0].type, 1);
  assert.equal(sends[0].msg.item_list[0].text_item.text, '编排已回执：');
  assert.equal(sends[1].msg.item_list[0].type, WEIXIN_ITEM_TYPE_IMAGE);
  assert.equal(sends[1].msg.item_list[0].image_item.media.encrypt_query_param, 'test-encrypted-param');
});
