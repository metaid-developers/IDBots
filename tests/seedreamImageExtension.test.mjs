import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Seedream returns JPEG regardless of the --output extension; the script
// used to save `frame.png` with JPEG bytes (2026-11-08 NFT issue: read_image
// refused the files and the bot had to rename them by hand). The script now
// aligns the extension with the real format and prints the final path.

const require = createRequire(import.meta.url);
const { detectImageExtension, alignImageExtension } = require('../SKILLs/seedream/scripts/generate_image.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

test('detectImageExtension trusts magic bytes', () => {
  assert.equal(detectImageExtension(JPEG), '.jpg');
  assert.equal(detectImageExtension(PNG), '.png');
  assert.equal(detectImageExtension(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary')), '.webp');
  assert.equal(detectImageExtension(Buffer.from('GIF89a', 'ascii')), '.gif');
  assert.equal(detectImageExtension(Buffer.from('not an image')), null);
});

test('alignImageExtension renames mismatched files and keeps matching ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedream-ext-'));
  try {
    const mislabeled = path.join(dir, 'frame_1.png');
    fs.writeFileSync(mislabeled, JPEG);
    const fixed = alignImageExtension(mislabeled);
    assert.equal(fixed, path.join(dir, 'frame_1.jpg'));
    assert.equal(fs.existsSync(mislabeled), false);
    assert.deepEqual(fs.readFileSync(fixed), JPEG);

    const jpeg = path.join(dir, 'photo.jpeg');
    fs.writeFileSync(jpeg, JPEG);
    assert.equal(alignImageExtension(jpeg), jpeg, '.jpeg is accepted for JPEG bytes');

    const png = path.join(dir, 'icon.png');
    fs.writeFileSync(png, PNG);
    assert.equal(alignImageExtension(png), png);

    const unknown = path.join(dir, 'blob.png');
    fs.writeFileSync(unknown, 'plain');
    assert.equal(alignImageExtension(unknown), unknown, 'unrecognized bytes are left alone');

    assert.equal(alignImageExtension(path.join(dir, 'missing.png')), path.join(dir, 'missing.png'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
