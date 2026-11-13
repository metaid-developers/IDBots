import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import AvatarPickerModal from '../src/renderer/components/avatar/AvatarPickerModal';
import BuiltinAvatarPickerModal from '../src/renderer/components/metabots/BuiltinAvatarPickerModal';
import { BUILTIN_AVATARS } from '../src/renderer/assets/builtinAvatars';
import { i18nService } from '../src/renderer/services/i18n';

test('built-in avatar picker renders all 20 offline previews without labels', () => {
  const html = renderToStaticMarkup(
    <BuiltinAvatarPickerModal onPick={() => undefined} onClose={() => undefined} />,
  );
  assert.equal((html.match(/data-slot="metabot-builtin-avatar-picker-tile"/g) ?? []).length, 20);
  assert.equal((html.match(/<img /g) ?? []).length, 20);
  for (const avatar of BUILTIN_AVATARS) {
    assert.ok(html.includes(`data-pin-id="${avatar.pinId}"`), avatar.code);
    assert.ok(html.includes(avatar.src), avatar.code);
    assert.ok(!html.includes(`>${avatar.code}</`), avatar.code);
    assert.ok(!html.includes(`>${avatar.name}</`), avatar.name);
  }
  assert.doesNotMatch(html, /loading="lazy"[^>]*src="http/);
});

test('built-in avatar picker marks the current reference as selected', () => {
  const current = BUILTIN_AVATARS[0];
  const html = renderToStaticMarkup(
    <BuiltinAvatarPickerModal currentReference={`  ${current.metafileUri}  `} onPick={() => undefined} onClose={() => undefined} />,
  );
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.ok(html.includes(`data-avatar-code="${current.code}" data-pin-id="${current.pinId}" aria-pressed="true"`));
});

test('AvatarPickerModal renders built-in, local, and NFT sources stacked top-to-bottom', () => {
  const html = renderToStaticMarkup(
    <AvatarPickerModal
      ownerAddress="1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
      loadNfts={async () => []}
      onPick={() => undefined}
      onPickLocal={() => undefined}
      onClose={() => undefined}
      onError={() => undefined}
      maxLocalBytes={200 * 1024}
    />,
  );
  assert.match(html, /class="flex flex-col[^"]*"[^>]*data-slot="avatar-source-list"/);
  const builtinAt = html.indexOf('data-slot="avatar-source-builtin"');
  const localAt = html.indexOf('data-slot="avatar-source-local"');
  const nftAt = html.indexOf('data-slot="avatar-source-nft"');
  assert.ok(builtinAt > 0 && localAt > builtinAt && nftAt > localAt);
  assert.ok(html.includes(i18nService.t('avatarPickerBuiltin')));
  assert.ok(html.includes(i18nService.t('avatarPickerLocal')));
  assert.ok(html.includes(i18nService.t('avatarPickerNft')));

  const noBuiltinHtml = renderToStaticMarkup(
    <AvatarPickerModal
      ownerAddress="1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
      allowBuiltin={false}
      loadNfts={async () => []}
      onPick={() => undefined}
      onPickLocal={() => undefined}
      onClose={() => undefined}
      onError={() => undefined}
      maxLocalBytes={200 * 1024}
    />,
  );
  assert.equal(noBuiltinHtml.includes('data-slot="avatar-source-builtin"'), false);
});

test('MetaBotEditTabs and UserSettings wire AvatarPickerModal with currentReference', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const editTabs = fs.readFileSync(path.join(root, 'src/renderer/components/metabots/MetaBotEditTabs.tsx'), 'utf8');
  const userSettings = fs.readFileSync(path.join(root, 'src/renderer/components/user/UserSettings.tsx'), 'utf8');
  assert.doesNotMatch(editTabs, /metabot-avatar-pick-builtin/);
  assert.match(editTabs, /<AvatarPickerModal[\s\S]*currentReference=\{values\.avatar\}/);
  assert.match(userSettings, /<AvatarPickerModal[\s\S]*currentReference=\{identity\.avatar \?\? ''\}/);
});
