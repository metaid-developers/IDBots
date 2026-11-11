import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import AvatarPickerModal from '../src/renderer/components/avatar/AvatarPickerModal';
import { resolveNftAvatarBadgeKind } from '../src/renderer/components/metabots/nftAvatarPresentation.js';
import { ProfilePage } from '../src/mobile/app/screens/me/ProfilePage';
import type { MobileUserIdentity } from '../src/mobile/app/hooks/useIdentity';

const ITEM_PIN = `${'aa'.repeat(32)}i0`;

test('avatar source modal exposes one source-choice step with local and NFT options', () => {
  const html = renderToStaticMarkup(React.createElement(AvatarPickerModal, {
    ownerAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    ownerGlobalMetaId: 'idq1example',
    loadNfts: async () => [],
    onPick: () => undefined,
    onPickLocal: () => undefined,
    onClose: () => undefined,
    onError: () => undefined,
    maxLocalBytes: 200 * 1024,
  }));
  assert.match(html, /data-slot="avatar-source-local"/);
  assert.match(html, /data-slot="avatar-source-nft"/);
  assert.doesNotMatch(html, /data-slot="avatar-picker-nft-tile"/);
  assert.doesNotMatch(html, /data-slot="metabot-avatar-pick-nft"/);
});

test('NFT badge presentation: plain when unverified, subtle NFT normally, rainbow only when certified', () => {
  assert.equal(resolveNftAvatarBadgeKind({ src: null, ownershipVerified: false, certified: false }), 'fallback');
  assert.equal(resolveNftAvatarBadgeKind({ src: 'data:image/png;base64,AA', ownershipVerified: false, certified: false }), 'plain');
  assert.equal(resolveNftAvatarBadgeKind({ src: 'data:image/png;base64,AA', ownershipVerified: false, certified: true }), 'plain', 'CA never substitutes for ownership');
  assert.equal(resolveNftAvatarBadgeKind({ src: 'data:image/png;base64,AA', ownershipVerified: true, certified: false }), 'nft');
  assert.equal(resolveNftAvatarBadgeKind({ src: 'data:image/png;base64,AA', ownershipVerified: true, certified: true }), 'certified');
});

test('desktop MetaBot and user profile each expose a single avatar-setting entry', () => {
  const botSource = readFileSync('src/renderer/components/metabots/MetaBotEditTabs.tsx', 'utf8');
  const userSource = readFileSync('src/renderer/components/user/UserSettings.tsx', 'utf8');
  assert.equal(botSource.match(/data-slot="metabot-avatar-set"/g)?.length, 1);
  assert.equal(botSource.includes('data-slot="metabot-avatar-pick-nft"'), false);
  assert.equal(userSource.match(/data-slot="user-avatar-set"/g)?.length, 1);
  assert.equal(botSource.includes('<AvatarPickerModal'), true);
  assert.equal(userSource.includes('<AvatarPickerModal'), true);
});

test('mobile profile enables the same avatar-setting entry and no longer shows coming soon', () => {
  const identity = {
    id: 1,
    path: "m/44'/10001'/0'/0/0",
    mvc_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    btc_address: 'btc-user',
    doge_address: 'doge-user',
    public_key: 'public-key',
    chat_public_key: 'chat-key',
    chat_public_key_pin_id: 'chat-pin',
    metaid: 'metaid-user',
    globalmetaid: 'idq1mobileuser',
    name: 'Mobile User',
    avatar: `nft://mrc721/${ITEM_PIN}`,
    avatar_fallback: 'data:image/png;base64,AAAA',
    subsidy_state: 'claimed',
    subsidy_error: null,
    name_pin_id: 'name-pin',
    avatar_pin_id: 'avatar-pin',
    sync_state: 'synced',
    sync_error: null,
    created_at: 1,
    updated_at: 1,
  } as unknown as MobileUserIdentity;
  const html = renderToStaticMarkup(React.createElement(ProfilePage, { identity, onBack: () => undefined }));
  assert.match(html, /data-testid="profile-avatar-change"/);
  assert.doesNotMatch(html, /Coming soon|即将支持/);
  assert.match(html, /Set avatar|设置头像/);
});
