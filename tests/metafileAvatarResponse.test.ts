import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBotProfileInfo } from '@openagentinternet/agent-browser-core';
import { withMetafileAvatarResponse as withMainMetafileAvatarResponse } from '../src/main/services/botBrowserHostService';
import { withMetafileAvatarResponse as withRendererMetafileAvatarResponse } from '../src/renderer/utils/metafileAvatar';

const PIN_ID = '940862def1adbc1532e7cd5445beab647d9ebc3d787d16dc795c5ab7d0f3e8f8i0';
const REFERENCE = `metafile://${PIN_ID}.png`;

function profileFetch() {
  return async () => new Response(JSON.stringify({
    code: 1,
    data: {
      globalMetaId: 'idq1test',
      name: 'Test Bot',
      avatar: REFERENCE,
      avatarId: 'text-avatar-pin',
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('main and browser profile adapters normalize MetaFile references for the upstream resolver', async () => {
  for (const wrap of [withMainMetafileAvatarResponse, withRendererMetafileAvatarResponse]) {
    const profile = await fetchBotProfileInfo({
      baseUrl: 'https://so.metaid.io',
      globalMetaId: 'idq1test',
      fetch: wrap(profileFetch()),
      metafileContentBaseUrl: 'https://file.metaid.io/metafile-indexer/content',
    });
    assert.equal(profile?.name, 'Test Bot');
    assert.equal(profile?.avatar, `https://file.metaid.io/metafile-indexer/content/${PIN_ID}`);
  }
});

test('profile adapter leaves other avatar values and non-JSON responses unchanged', async () => {
  const jsonResponse = new Response(JSON.stringify({ data: { avatar: 'data:image/png;base64,abc' } }), {
    headers: { 'content-type': 'application/json' },
  });
  const binaryResponse = new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'content-type': 'image/png' },
  });
  assert.equal(await withRendererMetafileAvatarResponse(async () => jsonResponse)('https://example.test'), jsonResponse);
  assert.equal(await withRendererMetafileAvatarResponse(async () => binaryResponse)('https://example.test'), binaryResponse);
});
