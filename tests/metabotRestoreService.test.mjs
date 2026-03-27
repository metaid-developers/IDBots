import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let metabotRestoreService;
try {
  metabotRestoreService = require('../dist-electron/services/metabotRestoreService.js');
} catch {
  metabotRestoreService = null;
}

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

test('fetchMetaidInfoByMetaid() falls back when local user info is semantically empty', async () => {
  if (!metabotRestoreService) {
    console.log('SKIP: dist-electron not found, run npm run compile:electron first');
    return;
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(String(url));
    if (String(url).includes('localhost:7281')) {
      return new Response(JSON.stringify({
        code: 1,
        message: 'ok',
        data: {
          chainName: '',
          number: 0,
          pinId: '',
          metaid: '',
          name: '',
          nameId: '',
          address: '',
          avatar: '',
          avatarId: '',
          nftAvatar: '',
          nftAvatarId: '',
          bio: '',
          bioId: '',
          soulbondToken: '',
          isInit: false,
          followCount: 0,
          pdv: 0,
          fdv: 0,
          background: '',
          chatpubkey: '',
          unconfirmed: '',
          blocked: false,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      code: 1,
      message: 'ok',
      data: {
        metaid: 'metaid-123',
        address: '1RemoteAddr',
        name: 'Remote Name',
        avatar: 'metafile://avatar-pin',
        avatarId: 'avatar-pin',
        chatpubkey: 'remote-chat-key',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const result = await metabotRestoreService.fetchMetaidInfoByMetaid('metaid-123');
    assert.equal(calls.length, 2, 'empty local user info should trigger remote fallback');
    assert.equal(result?.metaid, 'metaid-123');
    assert.equal(result?.address, '1RemoteAddr');
    assert.equal(result?.name, 'Remote Name');
  } finally {
    restore();
  }
});

test('fetchMetaidRestoreProfile() keeps a chain sync marker when bioId is missing', async () => {
  if (!metabotRestoreService) {
    console.log('SKIP: dist-electron not found, run npm run compile:electron first');
    return;
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(String(url));

    if (String(url).includes('/content/avatar-pin-1')) {
      return new Response(Buffer.from('avatar-bytes'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    return new Response(JSON.stringify({
      code: 1,
      message: 'ok',
      data: {
        metaid: 'metaid-restore-1',
        address: '1RestoreAddr',
        pinId: 'profile-root-pin-1',
        name: 'Restored Bot',
        nameId: 'name-pin-1',
        avatar: '/content/avatar-pin-1',
        avatarId: 'avatar-pin-1',
        bio: JSON.stringify({
          role: 'assistant',
          soul: 'helpful',
          createdBy: 'creator-1',
        }),
        bioId: '',
        chatpubkey: '02abcdef',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const result = await metabotRestoreService.fetchMetaidRestoreProfile('1RestoreAddr');
    assert.equal(result.name, 'Restored Bot');
    assert.equal(result.metabotInfoPinId, 'name-pin-1');
    assert.match(result.avatarDataUrl, /^data:image\/png;base64,/);
    assert.equal(result.bio.role, 'assistant');
    assert.equal(calls.length, 2, 'should fetch profile then avatar content');
  } finally {
    restore();
  }
});
