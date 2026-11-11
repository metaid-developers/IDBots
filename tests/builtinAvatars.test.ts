import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUILTIN_AVATARS, getBuiltinAvatarByReference } from '../src/renderer/assets/builtinAvatars';
import { isMetafileAvatarReference } from '../src/renderer/utils/metafileAvatar';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_CODES = [
  'D0', 'T41', 'T45', 'T26', 'T03', 'T04', 'T01', 'T15', 'T12', 'T35',
  'T32', 'T37', 'T40', 'P48', 'P44', 'P31', 'P03', 'P06', 'P12', 'P18',
];

test('built-in avatar library contains the selected 20 in order with unique pins', () => {
  assert.equal(BUILTIN_AVATARS.length, 20);
  assert.deepEqual(BUILTIN_AVATARS.map((avatar) => avatar.code), EXPECTED_CODES);
  assert.deepEqual(BUILTIN_AVATARS.map((avatar) => avatar.id), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(new Set(BUILTIN_AVATARS.map((avatar) => avatar.pinId)).size, 20);
  assert.equal(new Set(BUILTIN_AVATARS.map((avatar) => avatar.metafileUri)).size, 20);
});

test('every built-in avatar has a packaged PNG matching its on-chain reference', () => {
  for (const avatar of BUILTIN_AVATARS) {
    assert.match(avatar.pinId, /^[0-9a-f]{64}i\d+$/);
    assert.equal(avatar.metafileUri, `metafile://${avatar.pinId}.png`);
    assert.equal(isMetafileAvatarReference(avatar.metafileUri), true);
    assert.ok(avatar.shareUrl.includes(avatar.pinId));
    const file = path.join(projectRoot, 'public', avatar.src);
    const png = fs.readFileSync(file);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', avatar.code);
    assert.ok(png.length > 0 && png.length <= 200 * 1024, avatar.code);
  }
});

test('reference lookup trims input and rejects unrelated values', () => {
  const first = BUILTIN_AVATARS[0];
  assert.equal(getBuiltinAvatarByReference(`  ${first.metafileUri}  `), first);
  assert.equal(getBuiltinAvatarByReference('metafile://not-a-pin.png'), undefined);
  assert.equal(getBuiltinAvatarByReference(null), undefined);
  assert.equal(isMetafileAvatarReference('nft://mrc721/item'), false);
});
