import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import BuiltinAvatarPickerModal from '../src/renderer/components/metabots/BuiltinAvatarPickerModal';
import { BUILTIN_AVATARS } from '../src/renderer/assets/builtinAvatars';

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
