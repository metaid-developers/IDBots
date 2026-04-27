import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildMetafileDeliverySummary,
  resolveServiceDeliveryArtifact,
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
  assert.match(summary, /https:\/\/file\.metaid\.io\/metafile-indexer\/content\/aabbccddeeff00112233445566778899i0/);
});
