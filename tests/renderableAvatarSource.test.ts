import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pickRenderableAvatarSource, toRenderableAvatarSource } from '../src/renderer/utils/avatarSource';
import { BUILTIN_AVATARS } from '../src/renderer/assets/builtinAvatarCatalog';

// 2026-11-13 dev:fresh: the first-run Twin stores its built-in avatar as
// `metafile://<pinId>.png`; the activity row, the BotWorks by-Bot list and the
// A2A transcript only rendered data:/http(s) sources and showed blanks.
test('built-in metafile avatars map to the bundled file', () => {
  for (const avatar of BUILTIN_AVATARS) {
    assert.equal(toRenderableAvatarSource(avatar.metafileUri), `./${avatar.src}`);
  }
  assert.equal(pickRenderableAvatarSource(null, BUILTIN_AVATARS[3].metafileUri), `./${BUILTIN_AVATARS[3].src}`);
});

test('other avatar values keep their previous rendering rules', () => {
  assert.equal(toRenderableAvatarSource('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(toRenderableAvatarSource(' https://file.metaid.io/x.png '), 'https://file.metaid.io/x.png');
  assert.equal(toRenderableAvatarSource('metafile://' + 'a'.repeat(64) + 'i0.png'), null, 'unknown metafile refs still resolve elsewhere');
  assert.equal(toRenderableAvatarSource('/content/'), null);
  assert.equal(toRenderableAvatarSource(null), null);
});

test('static: every bot-avatar surface renders through toRenderableAvatarSource', () => {
  for (const file of [
    'src/renderer/components/cowork/AssistantActivityIndicator.tsx',
    'src/renderer/components/cowork/CoworkSessionItem.tsx',
    'src/renderer/components/cowork/CoworkSessionDetail.tsx',
    'src/renderer/components/cowork/MetaBotSelector.tsx',
    'src/renderer/components/groupTasks/GroupTaskListMeta.tsx',
    'src/renderer/components/groupTasks/GroupTaskMessageItem.tsx',
    'src/renderer/features/botBrowser/PanelDelegationStatusRow.tsx',
    'src/renderer/components/metaapps/myApps/MyAppsTab.tsx',
  ]) {
    assert.match(readFileSync(file, 'utf8'), /toRenderableAvatarSource\(/, file);
  }
  assert.match(readFileSync('src/renderer/components/cowork/A2AMessageItem.tsx', 'utf8'), /pickSharedRenderableAvatarSource/);
});
