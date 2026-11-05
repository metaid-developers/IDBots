// NFT-avatar mechanism wiring — structural + contract guards for the REWORKED
// shape (PR #140 rebased onto the NFT branch of upstream/main):
//   1. avatarNormalize metafile:// branch        (tests/avatarNormalize.test.mjs)
//   2. metabot:setNftAvatar IPC                  (tests/metabotNftIpc.test.mjs)
//   3. MetaBotNftAvatarPickerModal — THE single NFT-avatar entry; its save
//      action routes through metabot:setNftAvatar (this file, structural + SSR)
//   4. MetaBotEditTabs only ADOPTS the record the mechanism already persisted
//
// The parallel UI path from the original PR (a per-item action inside
// MetaBotNftWalletModal, an extra editor entry, PR-only i18n keys) must stay
// gone: the assertions below fail if any of it creeps back.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotNftAvatarPickerModal from '../src/renderer/components/metabots/MetaBotNftAvatarPickerModal';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative: string): string => fs.readFileSync(path.join(projectRoot, relative), 'utf8');

const PICKER = 'src/renderer/components/metabots/MetaBotNftAvatarPickerModal.tsx';
const EDIT_TABS = 'src/renderer/components/metabots/MetaBotEditTabs.tsx';
const WALLET_MODAL = 'src/renderer/components/metabots/MetaBotNftWalletModal.tsx';
const I18N = 'src/renderer/services/i18n.ts';
const PRELOAD = 'src/main/preload.ts';
const ELECTRON_D_TS = 'src/renderer/types/electron.d.ts';
const ALLOWLIST = 'src/main/gateway/allowlist.ts';
const CONTRACT = 'src/mobile/generated/ipc-contract.json';

test('the picker is the single NFT-avatar entry and its save action routes metabot:setNftAvatar', () => {
  const source = read(PICKER);

  // The save action resolves the item's artwork reference and hands it to the
  // IPC that normalizes + publishes (never a local nft:// decoration).
  assert.match(source, /buildNftAvatarImageRef/, 'the picker resolves the item artwork reference');
  assert.match(source, /window\.electron\.metabot\.setNftAvatar\(\{/);
  assert.match(source, /imageRef: buildNftAvatarImageRef\(item\)/);
  assert.doesNotMatch(source, /nft:\/\/mrc721/, 'the picker no longer emits a local-only nft:// reference');

  // Tiles ARE the action; one apply at a time.
  assert.match(source, /data-slot="metabot-nft-avatar-picker-tile"/);
  assert.match(source, /disabled=\{Boolean\(applyingKey\)\}/);

  // A structured failure is rendered in place (role=alert) and the modal stays
  // open: the failure branch returns before onApplied/onClose.
  assert.match(source, /data-slot="metabot-nft-avatar-picker-apply-error"/);
  assert.match(source, /role="alert"/);
  const applyBody = source.slice(source.indexOf('const applyAsAvatar'), source.indexOf('const tiles ='));
  const failAt = applyBody.indexOf('if (!response?.success)');
  const closeAt = applyBody.indexOf('onClose();');
  assert.ok(failAt >= 0 && closeAt > failAt, 'the success path closes the modal after the failure branch');
  assert.match(applyBody.slice(failAt, closeAt), /return;/, 'a failed apply must not close the modal');

  // Success hands the persisted record back (the editor adopts it) and closes.
  assert.match(applyBody, /onApplied\?\.\(response\.metabot\);\s*\n\s*onClose\(\);/);
});

test('the editor mounts the picker and only adopts the avatar the mechanism already persisted', () => {
  const source = read(EDIT_TABS);

  // main's own entry point stays the only one.
  assert.match(source, /data-slot="metabot-avatar-pick-nft"/);
  assert.match(source, /i18nService\.t\('metabotAvatarPickNft'\)/);
  assert.match(source, /setNftAvatarPickerOpen\(true\)/);

  // Wiring: the picker apply already wrote the avatar (local row + on-chain
  // sync) in the main process, so the editor adopts it into BOTH the live
  // values and the baseline — an applied avatar never re-publishes on save.
  assert.match(source, /<MetaBotNftAvatarPickerModal/);
  assert.match(source, /onApplied=\{\(updated\) => adoptPersistedAvatar\(updated\)\}/);
  assert.match(source, /const adoptPersistedAvatar = \(updated: unknown\) => \{/);
  assert.match(source, /setValues\(\(prev\) => \(\{ \.\.\.prev, avatar \}\)\)/);
  assert.match(source, /setBaseline\(\(prev\) => \(\{ \.\.\.prev, avatar \}\)\)/);

  // The original PR's second UI road stays dismantled.
  assert.doesNotMatch(source, /MetaBotNftWalletModal/, 'no second avatar entry through the NFT Wallet modal');
});

test('the original PR parallel UI path is fully removed', () => {
  const picker = read(PICKER);
  const wallet = read(WALLET_MODAL);
  const i18n = read(I18N);

  // No per-item / detail-pane avatar buttons in the wallet modal.
  assert.doesNotMatch(wallet, /metabot-nft-use-avatar/);
  assert.doesNotMatch(wallet, /metabot-nft-detail-use-avatar/);
  assert.doesNotMatch(wallet, /setNftAvatar/);
  assert.doesNotMatch(wallet, /buildNftAvatarImageRef/);

  // The mechanism is not re-implemented in the renderer either.
  assert.doesNotMatch(picker, /onAvatarUpdated/);

  // PR-only i18n keys are gone; main's own NFT-avatar keys survive.
  for (const key of [
    'metabotNftUseAsAvatar',
    'metabotNftAvatarWorking',
    'metabotNftAvatarApplied',
    'metabotNftAvatarFailed',
    'metabotNftAvatarNoArtwork',
    'metabotNftAvatarSyncPending',
  ]) {
    assert.equal(i18n.includes(key), false, `${key} belongs to the removed parallel UI path`);
  }
  // `metabotAvatarPickNft` is main's key (zh + en) — exactly one per dictionary.
  assert.equal((i18n.match(/metabotAvatarPickNft:/g) || []).length, 2);
  assert.match(i18n, /metabotNftAvatarPickerTitle:/);
  assert.match(i18n, /metabotNftAvatarPickerHint:/);
});

test('metabot:setNftAvatar is wired through preload, the renderer types, the P1 allowlist and the contract', () => {
  const preload = read(PRELOAD);
  assert.match(preload, /setNftAvatar: \(input: \{ metabotId: number; imageRef: string \}\) =>/);
  assert.match(preload, /ipcRenderer\.invoke\('metabot:setNftAvatar', input\)/);

  const types = read(ELECTRON_D_TS);
  assert.match(types, /setNftAvatar: \(input: \{ metabotId: number; imageRef: string \}\) => Promise<\{/);
  assert.match(types, /reason\?: string;\s*\n\s*detail\?: string;/);

  const allowlist = read(ALLOWLIST);
  assert.match(allowlist, /'metabot:setNftAvatar': \{ tier: 'P1' \},/);

  const contract = JSON.parse(read(CONTRACT)) as {
    methods?: Array<{ path: string; kind: string; channel: string }>;
  };
  const methods = contract.methods || [];
  const entry = methods.find((method) => method.path === 'metabot.setNftAvatar');
  assert.ok(entry, 'the generated IPC contract must list metabot.setNftAvatar');
  assert.equal(entry?.channel, 'metabot:setNftAvatar');
  assert.equal(entry?.kind, 'invoke');
});

test('the picker renders in its loading state without a live electron bridge', () => {
  const html = renderToStaticMarkup(
    React.createElement(MetaBotNftAvatarPickerModal, { metabotId: 7, onClose: () => {} }),
  );
  assert.match(html, /data-slot="metabot-nft-avatar-picker"/);
  assert.match(html, /Choose an NFT Avatar/);
});
