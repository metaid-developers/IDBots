/**
 * First-run Twin avatar: a random built-in avatar, stored as its on-chain
 * metafile reference, and rendered locally by main-process surfaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickTwinBotAvatar } = require('../dist-electron/renderer/assets/twinBotAvatar.js');
const { BUILTIN_AVATARS } = require('../dist-electron/renderer/assets/builtinAvatarCatalog.js');
const { resolveBuiltinAvatarDataUri } = require('../dist-electron/main/libs/builtinAvatarAssets.js');
const { normalizeMetafileAvatarReference } = require('../dist-electron/main/services/metaidCore.js');

const repoRoot = path.resolve(import.meta.dirname, '..');
const publicRoot = path.join(repoRoot, 'public');

test('pickTwinBotAvatar picks from all 20 built-ins and returns a pinnable metafile reference', () => {
  assert.equal(BUILTIN_AVATARS.length, 20);
  const seen = new Set();
  for (let index = 0; index < BUILTIN_AVATARS.length; index += 1) {
    const avatar = pickTwinBotAvatar(() => (index + 0.5) / BUILTIN_AVATARS.length);
    assert.equal(avatar, BUILTIN_AVATARS[index].metafileUri);
    assert.equal(normalizeMetafileAvatarReference(avatar), avatar, 'publishes as a tiny /info/avatar reference');
    seen.add(avatar);
  }
  assert.equal(seen.size, 20);
  assert.equal(pickTwinBotAvatar(() => 0.999999), BUILTIN_AVATARS[19].metafileUri);
  assert.equal(pickTwinBotAvatar(() => 1), BUILTIN_AVATARS[19].metafileUri, 'clamped at the top');
});

test('every built-in avatar file ships and resolves to a local data URI', () => {
  for (const avatar of BUILTIN_AVATARS) {
    assert.ok(fs.existsSync(path.join(publicRoot, avatar.src)), `${avatar.src} exists`);
    const uri = resolveBuiltinAvatarDataUri(avatar.metafileUri, publicRoot);
    assert.ok(uri?.startsWith('data:image/png;base64,'), `${avatar.code} resolves`);
  }
  assert.equal(resolveBuiltinAvatarDataUri('metafile://' + 'a'.repeat(64) + 'i0.png', publicRoot), undefined);
  assert.equal(resolveBuiltinAvatarDataUri('data:image/png;base64,AAAA', publicRoot), undefined);
  assert.equal(resolveBuiltinAvatarDataUri(null, publicRoot), undefined);
});

test('both first-run creation paths use the random built-in avatar', () => {
  const welcome = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/onboarding/WelcomeFlow.tsx'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(repoRoot, 'src/main/server/bootstrapSteps.ts'), 'utf8');
  assert.match(welcome, /avatar: pickTwinBotAvatar\(\),/);
  assert.match(bootstrap, /avatar: pickTwinBotAvatar\(\),/);
});
