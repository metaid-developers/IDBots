import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildMetafileDeliverySummary,
  resolveServiceDeliveryArtifact,
  resolveServiceDeliveryArtifactForOrder,
  verifyDeliveryArtifactUpload,
} from '../src/main/services/serviceDeliveryArtifacts.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-delivery-artifacts-'));
}

function writeFile(filePath, content = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('resolveServiceDeliveryArtifact finds an image file explicitly mentioned in the service reply', () => {
  const cwd = makeTempDir();
  const imagePath = path.join(cwd, 'rocket_launch.png');
  writeFile(imagePath, 'png');

  const result = resolveServiceDeliveryArtifact({
    outputType: 'image',
    cwd,
    orderStartedAt: Date.now() - 1000,
    messages: [
      {
        type: 'assistant',
        content: '火箭发射图片已生成，保存在 rocket_launch.png。',
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, imagePath);
  assert.equal(result.artifact.contentType, 'image/png');
  assert.equal(result.artifact.deliveryKind, 'image');
});

test('resolveServiceDeliveryArtifact falls back to a newly generated image in cwd for image services', () => {
  const cwd = makeTempDir();
  const orderStartedAt = Date.now() - 1000;
  const imagePath = path.join(cwd, 'new-render.webp');
  writeFile(imagePath, 'webp');

  const result = resolveServiceDeliveryArtifact({
    outputType: 'image',
    cwd,
    orderStartedAt,
    messages: [
      {
        type: 'assistant',
        content: '图片已生成。',
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, imagePath);
  assert.equal(result.artifact.contentType, 'image/webp');
});

test('resolveServiceDeliveryArtifact requires an explicit file mention for other services', () => {
  const cwd = makeTempDir();
  writeFile(path.join(cwd, 'archive.zip'), 'zip');

  const implicit = resolveServiceDeliveryArtifact({
    outputType: 'other',
    cwd,
    orderStartedAt: Date.now() - 1000,
    messages: [{ type: 'assistant', content: '打包完成。' }],
  });

  assert.equal(implicit.status, 'missing');

  const explicit = resolveServiceDeliveryArtifact({
    outputType: 'other',
    cwd,
    orderStartedAt: Date.now() - 1000,
    messages: [{ type: 'tool_result', content: 'Generated file: archive.zip' }],
  });

  assert.equal(explicit.status, 'found');
  assert.equal(explicit.artifact.filePath, path.join(cwd, 'archive.zip'));
  assert.equal(explicit.artifact.deliveryKind, 'other');
});

test('resolveServiceDeliveryArtifact scopes explicit file references to the current order', () => {
  const cwd = makeTempDir();
  const oldImagePath = path.join(cwd, 'rocket_launch.png');
  const currentImagePath = path.join(cwd, 'blackhole_spaceship.png');
  writeFile(oldImagePath, 'old image');
  writeFile(currentImagePath, 'current image');

  const result = resolveServiceDeliveryArtifact({
    outputType: 'image',
    cwd,
    orderStartedAt: Date.now() - 1000,
    orderTxid: 'b'.repeat(64),
    paymentTxid: 'c'.repeat(64),
    messages: [
      {
        type: 'assistant',
        content: '旧订单图片：rocket_launch.png',
        metadata: {
          orderTxid: 'a'.repeat(64),
          paymentTxid: 'old-payment',
        },
      },
      {
        type: 'assistant',
        content: '当前订单图片：blackhole_spaceship.png',
        metadata: {
          orderTxid: 'b'.repeat(64),
          paymentTxid: 'c'.repeat(64),
        },
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, currentImagePath);
});

test('resolveServiceDeliveryArtifact ignores prior delivery summaries when resending an order artifact', () => {
  const cwd = makeTempDir();
  const wrongImagePath = path.join(cwd, 'rocket_launch.png');
  const currentImagePath = path.join(cwd, 'blackhole_spaceship.png');
  writeFile(wrongImagePath, 'wrong image');
  writeFile(currentImagePath, 'current image');

  const orderTxid = 'd'.repeat(64);
  const paymentTxid = 'e'.repeat(64);
  const result = resolveServiceDeliveryArtifact({
    outputType: 'image',
    cwd,
    orderStartedAt: Date.now() - 1000,
    orderTxid,
    paymentTxid,
    messages: [
      {
        type: 'assistant',
        content: `图片生成成功。文件路径: ${currentImagePath}`,
        metadata: {
          orderTxid,
          paymentTxid,
          orderExecutionTrace: true,
        },
        created_at: 100,
      },
      {
        type: 'assistant',
        content: `数字成果已生成并上传链上交付。\n文件名: rocket_launch.png\n格式: image/png`,
        metadata: {
          orderTxid,
          paymentTxid,
          orderDeliveryMessage: true,
        },
        created_at: 200,
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, currentImagePath);
});

test('resolveServiceDeliveryArtifactForOrder applies order scope for resend lookups', () => {
  const cwd = makeTempDir();
  const wrongImagePath = path.join(cwd, 'rocket_launch.png');
  const currentImagePath = path.join(cwd, 'blackhole_spaceship.png');
  writeFile(wrongImagePath, 'wrong image');
  writeFile(currentImagePath, 'current image');

  const orderTxid = 'f'.repeat(64);
  const paymentTxid = '1'.repeat(64);
  const result = resolveServiceDeliveryArtifactForOrder({
    outputType: 'image',
    cwd,
    order: {
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      orderMessageTxid: orderTxid,
      paymentTxid,
    },
    messages: [
      {
        type: 'assistant',
        content: '旧订单图片：rocket_launch.png',
        metadata: {
          orderTxid: 'a'.repeat(64),
          paymentTxid: 'old-payment',
        },
      },
      {
        type: 'assistant',
        content: '当前订单图片：blackhole_spaceship.png',
        metadata: {
          orderTxid,
          paymentTxid,
        },
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, currentImagePath);
});

test('resolveServiceDeliveryArtifactForOrder scans generated files after stale order updatedAt', () => {
  const cwd = makeTempDir();
  const now = Date.now();
  const imagePath = path.join(cwd, 'late-render.png');
  writeFile(imagePath, 'png');

  const result = resolveServiceDeliveryArtifactForOrder({
    outputType: 'image',
    cwd,
    now: now + 1000,
    order: {
      createdAt: now - 60_000,
      updatedAt: now - 50_000,
      orderMessageTxid: '2'.repeat(64),
      paymentTxid: '3'.repeat(64),
    },
    messages: [
      {
        type: 'assistant',
        content: '图片生成成功。',
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, imagePath);
  assert.equal(result.artifact.source, 'generated');
});

test('resolveServiceDeliveryArtifact falls back to order time window when scoped messages are only status notices', () => {
  const cwd = makeTempDir();
  const archivePath = path.join(cwd, 'delivery.zip');
  writeFile(archivePath, 'zip');

  const orderTxid = '4'.repeat(64);
  const paymentTxid = '5'.repeat(64);
  const result = resolveServiceDeliveryArtifact({
    outputType: 'other',
    cwd,
    orderStartedAt: 1000,
    orderCompletedAt: 3000,
    orderTxid,
    paymentTxid,
    messages: [
      {
        type: 'assistant',
        content: `[ORDER_STATUS:${orderTxid}] 数字成果已生成，正在上传。`,
        metadata: {
          orderTxid,
          paymentTxid,
          orderProtocolTag: 'ORDER_STATUS',
          orderDeliveryUploadNotice: true,
        },
        created_at: 1200,
      },
      {
        type: 'tool_result',
        content: 'Generated file: delivery.zip',
        created_at: 1500,
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, archivePath);
});

test('resolveServiceDeliveryArtifact falls back to time window when scoped messages have no artifact path', () => {
  const cwd = makeTempDir();
  const archivePath = path.join(cwd, 'handoff.zip');
  writeFile(archivePath, 'zip');

  const orderTxid = '6'.repeat(64);
  const paymentTxid = '7'.repeat(64);
  const result = resolveServiceDeliveryArtifact({
    outputType: 'other',
    cwd,
    orderStartedAt: 1000,
    orderCompletedAt: 3000,
    orderTxid,
    paymentTxid,
    messages: [
      {
        type: 'assistant',
        content: '当前订单正在整理文件。',
        metadata: {
          orderTxid,
          paymentTxid,
          orderExecutionTrace: true,
        },
        created_at: 1200,
      },
      {
        type: 'tool_result',
        content: 'Generated file: handoff.zip',
        created_at: 1500,
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, archivePath);
});

test('resolveServiceDeliveryArtifact rejects delivery files larger than 20 MiB', () => {
  const cwd = makeTempDir();
  const filePath = path.join(cwd, 'huge.mp4');
  fs.closeSync(fs.openSync(filePath, 'w'));
  fs.truncateSync(filePath, 20 * 1024 * 1024 + 1);

  const result = resolveServiceDeliveryArtifact({
    outputType: 'video',
    cwd,
    orderStartedAt: Date.now() - 1000,
    messages: [{ type: 'assistant', content: '视频文件：huge.mp4' }],
  });

  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'file_too_large');
});

test('resolveServiceDeliveryArtifact finds audio output artifacts', () => {
  const cwd = makeTempDir();
  const orderStartedAt = Date.now() - 1000;
  const audioPath = path.join(cwd, 'narration.mp3');
  writeFile(audioPath, 'mp3');

  const result = resolveServiceDeliveryArtifact({
    outputType: 'audio',
    cwd,
    orderStartedAt,
    messages: [
      {
        type: 'assistant',
        content: '旁白音频已生成。',
      },
    ],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.artifact.filePath, audioPath);
  assert.equal(result.artifact.contentType, 'audio/mpeg');
  assert.equal(result.artifact.deliveryKind, 'audio');
});

test('buildMetafileDeliverySummary includes metafile URI, pin ID, and download URL', () => {
  const summary = buildMetafileDeliverySummary({
    artifact: {
      filePath: '/tmp/rocket_launch.png',
      fileName: 'rocket_launch.png',
      size: 1024,
      contentType: 'image/png',
      deliveryKind: 'image',
      source: 'explicit',
    },
    upload: {
      pinId: 'aabbccddeeff00112233445566778899i0',
      previewUrl: 'https://file.metaid.io/metafile-indexer/api/v1/files/content/aabbccddeeff00112233445566778899i0',
      uploadMode: 'direct',
    },
  });

  assert.match(summary, /metafile:\/\/aabbccddeeff00112233445566778899i0\.png/);
  assert.match(summary, /PINID:\s*aabbccddeeff00112233445566778899i0/);
  assert.match(summary, /https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/accelerate\/content\/aabbccddeeff00112233445566778899i0/);
  assert.doesNotMatch(summary, /https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\/aabbccddeeff00112233445566778899i0/);
  assert.doesNotMatch(summary, /metafile-indexer\/content\/aabbccddeeff00112233445566778899i0/);
});

test('verifyDeliveryArtifactUpload rejects an empty PINID without fetching', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true };
  };
  try {
    assert.equal(await verifyDeliveryArtifactUpload({ pinId: '' }), false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifyDeliveryArtifactUpload accepts HEAD success', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    return { ok: true };
  };
  try {
    assert.equal(await verifyDeliveryArtifactUpload({ pinId: 'abc123i0' }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'HEAD');
    assert.match(calls[0].url, /accelerate\/content\/abc123i0$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifyDeliveryArtifactUpload falls back to ranged GET when HEAD fails', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method, range: options?.headers?.Range });
    return { ok: calls.length === 2 };
  };
  try {
    assert.equal(await verifyDeliveryArtifactUpload({ pinId: 'abc123i0' }), true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'HEAD');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].range, 'bytes=0-0');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifyDeliveryArtifactUpload returns false on network failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    assert.equal(await verifyDeliveryArtifactUpload({ pinId: 'abc123i0' }), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
