/**
 * Outbound-IM echo rendering (im_send_message) — the exact contract the owner
 * asked for after reading the first version on a real device:
 *
 *   1. the bubble content IS the sent body — verbatim, newlines intact, full
 *      length, no 方向/目标/摘要/结果/附件/时间 labels;
 *   2. attachments are drawn as their OWN entries (one image thumbnail / one
 *      file entry each), never as a filename list; when the record cannot carry
 *      a drawable path, they degrade to ONE plain note 「（已发送 N 个附件）」;
 *   3. the row stays an outbound `system` record (never a user/assistant row —
 *      so it never enters model history and never gets forwarded back as an
 *      answer), yet renders visually like a normal chat bubble;
 *   4. failures keep the audited card, reason included.
 *
 * Run: npm run test:im-gateway (builds dist-electron first).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildImOutboundConversationRecord,
  IM_OUTBOUND_RECORD_VERSION,
} = await import('../dist-electron/main/im/imOutbound.js');
const {
  readOutboundImReceiptBubble,
  formatOutboundAttachmentNote,
  OUTBOUND_IM_RECEIPT_VERSION,
} = await import('../src/renderer/components/cowork/outboundImReceiptBubble.js');

const makeTempFile = (name, size) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-echo-bubble-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.alloc(size, 7));
  return filePath;
};

const okResult = (overrides = {}) => ({
  ok: true,
  channel: 'weixin',
  label: '微信',
  target: 'wx-direct-1',
  targetIsOwnerDirect: true,
  targetIdentityBasis: 'owner-binding',
  textChars: 0,
  attachments: [],
  warnings: [],
  errors: [],
  ...overrides,
});

test('record → bubble: the content is the sent body, byte for byte, with no metadata fields', () => {
  const text = '下午好～这是来自你链上分身的一条测试消息。现在是 11 月 4 日早上 7 点 24 分。';
  const record = buildImOutboundConversationRecord({
    request: { channel: 'weixin', text },
    result: okResult({ textChars: text.length }),
    timestamp: 1_800_000_000_000,
  });

  assert.equal(record.content, text);
  for (const label of ['方向：', '目标：', '摘要：', '附件：', '结果：', '已发出', '微信（weixin）']) {
    assert.ok(!record.content.includes(label), `bubble leaked the ${label} field`);
  }
  assert.equal(record.metadata.imOutboundRecordVersion, IM_OUTBOUND_RECORD_VERSION);
  assert.equal(record.type, 'system', 'still an outbound system row: no model turn, no forwarded reply');

  const view = readOutboundImReceiptBubble(record);
  assert.ok(view, 'a delivered send renders as a bubble');
  assert.equal(view.body, text);
  assert.deepEqual(view.attachments, []);
  assert.equal(view.fallbackNote, null);
});

test('bubble: line breaks survive exactly as sent', () => {
  const text = '第一段。\n\n第二段。\n第三行。';
  const record = buildImOutboundConversationRecord({
    request: { channel: 'weixin', text },
    result: okResult({ textChars: text.length }),
    timestamp: 1_800_000_000_000,
  });
  const view = readOutboundImReceiptBubble(record);
  assert.equal(view.body, text);
  assert.equal(view.body.split('\n').length, 4);
});

test('bubble: a long body is never cut (the 200-char preview budget is gone from the bubble)', () => {
  const text = '甲'.repeat(900);
  const record = buildImOutboundConversationRecord({
    request: { channel: 'weixin', text },
    result: okResult({ textChars: text.length }),
    timestamp: 1_800_000_000_000,
  });
  assert.equal(record.content.length, 900);
  const view = readOutboundImReceiptBubble(record);
  assert.equal(view.body, text);
  assert.ok(!view.body.includes('…'));
});

test('attachments: one drawable entry per file (image vs file), no filename-list fallback', () => {
  const photo = makeTempFile('photo.png', 512);
  const report = makeTempFile('季度报表.pdf', 4096);
  const text = '两个文件，请看。';
  const record = buildImOutboundConversationRecord({
    request: { channel: 'weixin', text, attachments: [photo, report] },
    result: okResult({
      textChars: text.length,
      attachments: [
        { path: photo, bytes: 512, kind: 'image' },
        { path: report, bytes: 4096, kind: 'file' },
      ],
    }),
    timestamp: 1_800_000_000_000,
  });

  // The bubble text is still ONLY the body — the files are not spelled out in it.
  assert.equal(record.content, text);
  assert.ok(!record.content.includes('photo.png'));
  assert.ok(!record.content.includes('季度报表.pdf'));

  const view = readOutboundImReceiptBubble(record);
  assert.equal(view.body, text);
  assert.deepEqual(view.attachments.map((item) => ({ path: item.path, name: item.name, kind: item.kind })), [
    { path: photo, name: 'photo.png', kind: 'image' },
    { path: report, name: '季度报表.pdf', kind: 'file' },
  ]);
  assert.equal(view.fallbackNote, null, 'with a path per attachment there is nothing to degrade');
});

test('attachments: an attachment-only send is just its bubbles (no invented body text)', () => {
  const photo = makeTempFile('photo.png', 512);
  const record = buildImOutboundConversationRecord({
    request: { channel: 'weixin', attachments: [photo] },
    result: okResult({
      textChars: 0,
      attachments: [{ path: photo, bytes: 512, kind: 'image' }],
    }),
    timestamp: 1_800_000_000_000,
  });
  assert.equal(record.content, '');
  const view = readOutboundImReceiptBubble(record);
  assert.equal(view.body, '');
  assert.equal(view.attachments.length, 1);
  assert.equal(view.attachments[0].kind, 'image');
  assert.equal(view.fallbackNote, null);
});

test('attachments: a record without drawable paths degrades to ONE plain note, never a path list', () => {
  // What a shape that cannot express attachment bubbles looks like: names only.
  const legacyShaped = {
    id: 'imout-test',
    type: 'system',
    content: '下午好',
    metadata: {
      imOutboundSend: true,
      imOutboundDirection: 'outgoing',
      imOutboundOk: true,
      imOutboundChannel: 'weixin',
      imOutboundConversationId: 'wx-direct-1',
      imOutboundAt: 1_800_000_000_000,
      imOutboundRecordVersion: OUTBOUND_IM_RECEIPT_VERSION,
      imOutboundAttachments: ['photo.png', '季度报表.pdf'],
      imOutboundAttachmentItems: [
        { name: 'photo.png', path: 'not-absolute/photo.png' },
      ],
    },
  };
  const view = readOutboundImReceiptBubble(legacyShaped);
  assert.equal(view.body, '下午好');
  assert.deepEqual(view.attachments, [], 'a relative path is not drawable — it must not become an empty bubble');
  assert.equal(view.fallbackNote, '（已发送 2 个附件）');
  assert.equal(formatOutboundAttachmentNote(1), '（已发送 1 个附件）');
  assert.ok(!view.fallbackNote.includes('/'), 'the note is not a path list');

  // A mixed record (one drawable absolute path + one relative) keeps the
  // picture bubble AND counts only the undrawable rest in the note.
  const mixed = {
    ...legacyShaped,
    metadata: {
      ...legacyShaped.metadata,
      imOutboundAttachmentItems: [
        { name: 'photo.png', path: '/tmp/photo.png', kind: 'image', bytes: 512 },
        { name: '笔记.txt', path: 'notes/笔记.txt' },
      ],
    },
  };
  const mixedView = readOutboundImReceiptBubble(mixed);
  assert.equal(mixedView.attachments.length, 1);
  assert.equal(mixedView.attachments[0].path, '/tmp/photo.png');
  assert.equal(mixedView.fallbackNote, '（已发送 1 个附件）');
});

test('legacy v1 rows and failures never take the bubble path', () => {
  const card = {
    id: 'imout-legacy',
    type: 'system',
    content: '📤 方向：已发出 · 微信（weixin）· 2026-11-04 07:24:00\n目标：owner 私聊（wx-direct-1）\n摘要：下午好',
    metadata: {
      imOutboundSend: true,
      imOutboundDirection: 'outgoing',
      imOutboundOk: true,
      imOutboundChannel: 'weixin',
      // no imOutboundRecordVersion on purpose — v1 wrote the card into `content`
    },
  };
  assert.equal(readOutboundImReceiptBubble(card), null, 'v1 card text must never be re-rendered inside a bubble');

  const failed = buildImOutboundConversationRecord({
    request: { channel: 'weixin', text: '发不出去的消息' },
    result: {
      ok: false,
      channel: 'weixin',
      label: '微信',
      target: 'wx-direct-1',
      targetIsOwnerDirect: true,
      targetIdentityBasis: 'owner-binding',
      textChars: 0,
      attachments: [],
      warnings: [],
      errors: ['微信文本发送失败：socket hang up'],
    },
    timestamp: 1_800_000_000_000,
  });
  assert.equal(failed.metadata.imOutboundOk, false);
  assert.equal(readOutboundImReceiptBubble(failed), null, 'a failure keeps the audited card');
  assert.match(failed.content, /结果：失败（未送达）/);
  assert.match(failed.content, /socket hang up/, 'the failure reason stays visible');
});

test('a non-receipt message is left to the existing renderer', () => {
  assert.equal(readOutboundImReceiptBubble({ id: 'x', type: 'system', content: 'hi', metadata: {} }), null);
  assert.equal(readOutboundImReceiptBubble({ id: 'x', type: 'system', content: 'hi' }), null);
  assert.equal(readOutboundImReceiptBubble(null), null);
  // A v2 row with literally nothing to draw renders nothing (no empty box).
  assert.equal(readOutboundImReceiptBubble({
    id: 'x',
    type: 'system',
    content: '   ',
    metadata: {
      imOutboundSend: true,
      imOutboundOk: true,
      imOutboundRecordVersion: OUTBOUND_IM_RECEIPT_VERSION,
      imOutboundAttachments: [],
      imOutboundAttachmentItems: [],
    },
  }), null);
});

test('the transcript draws the receipt through the bubble path and keeps failures on the card', () => {
  const detailSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx'),
    'utf8'
  );
  assert.match(detailSource, /import \{ readOutboundImReceiptBubble \} from '\.\/outboundImReceiptBubble\.js'/);
  assert.match(detailSource, /const outboundReceipt = readOutboundImReceiptBubble\(message\)/);
  assert.match(detailSource, /<OutboundImReceiptMessage[\s\S]{0,120}view=\{outboundReceipt\}/);
  // Attachments: existing image display (thumbnail strip) / existing file display.
  assert.match(detailSource, /<ImagePreviewStrip imagePaths=\{\[attachment\.path\]\} inline \/>/);
  assert.match(detailSource, /<LocalFileLink[\s\S]{0,700}\{attachment\.name\}/);
  // Same bubble geometry as a normal assistant reply — no card, no labels.
  assert.match(detailSource, /assistant-bubble rounded-\[22px\] px-\[16px\] py-\[10px\]/);

  // The row must survive the transcript's visibility filter even with an empty
  // body (attachment-only send): that filter runs before the bubble renderer.
  const visibilitySource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'utils', 'coworkMessageVisibility.ts'),
    'utf8'
  );
  assert.match(visibilitySource, /if \(message\.metadata\?\.imOutboundSend === true\) \{\s*return true;/);
});
