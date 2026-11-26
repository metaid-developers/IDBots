import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotWalletBalanceModal from '../src/renderer/components/metabots/MetaBotWalletBalanceModal';
import MetaBotNftWalletModal from '../src/renderer/components/metabots/MetaBotNftWalletModal';
import MetaBotBackupMnemonicModal from '../src/renderer/components/metabots/MetaBotBackupMnemonicModal';
import MetaBotDeleteConfirmModal from '../src/renderer/components/metabots/MetaBotDeleteConfirmModal';
import MetaBotRestoreMnemonicModal from '../src/renderer/components/metabots/MetaBotRestoreMnemonicModal';
import MetaBotCreateSuccessModal from '../src/renderer/components/metabots/MetaBotCreateSuccessModal';
import AvatarPickerModal from '../src/renderer/components/avatar/AvatarPickerModal';
import type { Metabot } from '../src/renderer/types/metabot';

const sampleBot: Metabot = {
  id: 42,
  wallet_id: 7,
  mvc_address: '1MvcSampleAddressForTesting123456',
  btc_address: 'bc1qsamplebtcaddressfortesting123456',
  doge_address: 'DSampleDogeAddressForTesting12345',
  public_key: '02abcdef',
  chat_public_key: '03abcdef',
  chat_public_key_pin_id: null,
  name: 'Sunny Bot',
  avatar: null,
  enabled: true,
  metabot_info_pinid: null,
  metabot_type: 'worker',
  created_by: 'user',
  role: 'Designer',
  soul: 'Focused',
  goal: 'Craft',
  background: 'Bio',
  boss_id: null,
  boss_global_metaid: null,
  llm_id: 'codex',
  tools: [],
  skills: [],
  created_at: 1767323040,
  updated_at: 1767323040,
  globalmetaid: 'idq1sampleglobalmetaid',
  metaid: 'samplemetaid',
};

test('W1 MetaBotWalletBalanceModal renders 3-tab single-axis sheet, official chain SVGs, NFT quick-jump, and no legacy deposit guide', () => {
  const markup = renderToStaticMarkup(
    <MetaBotWalletBalanceModal
      isOpen
      metabot={sampleBot}
      onClose={() => {}}
      onOpenNftWallet={() => {}}
    />,
  );

  // Three top-level tabs: native / mrc20 / mvc-ft
  assert.match(markup, /data-slot="metabot-wallet-tab-native"/);
  assert.match(markup, /data-slot="metabot-wallet-tab-mrc20"/);
  assert.match(markup, /data-slot="metabot-wallet-tab-mvc-ft"/);

  // Native chain rows + official vector chain icons (MVC gradient, BTC #F7931A, DOGE #C2A633)
  assert.match(markup, /data-slot="metabot-wallet-chain-mvc"/);
  assert.match(markup, /data-slot="metabot-wallet-chain-btc"/);
  assert.match(markup, /data-slot="metabot-wallet-chain-doge"/);
  assert.match(markup, /mvc-space-grad-/);
  assert.match(markup, /#F7931A/);
  assert.match(markup, /#C2A633/);

  // Quick-jump to NFT Vault when wired
  assert.match(markup, /data-slot="metabot-wallet-open-nft"/);

  // Legacy deposit guide and secondary token modal must not exist in source
  const source = readFileSync(
    new URL('../src/renderer/components/metabots/MetaBotWalletBalanceModal.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /LegacyNftDepositGuideModal/);
  assert.doesNotMatch(source, /metabotWalletViewMoreTokens/);
});

test('N2 MetaBotNftWalletModal renders protocol tabs, album/all view toggles, toolbar, and no legacy deposit guide', () => {
  const markup = renderToStaticMarkup(
    <MetaBotNftWalletModal
      isOpen
      metabot={sampleBot}
      onClose={() => {}}
      onSetBotAvatar={async () => {}}
    />,
  );

  assert.match(markup, /data-slot="metabot-nft-wallet-modal"/);
  assert.match(markup, /data-slot="metabot-nft-tab-mrc721"/);
  assert.match(markup, /data-slot="metabot-nft-tab-metacontract"/);
  assert.match(markup, /data-slot="metabot-nft-view-albums"/);
  assert.match(markup, /data-slot="metabot-nft-view-all"/);
  assert.match(markup, /data-slot="metabot-nft-search"/);
  assert.match(markup, /data-slot="metabot-nft-open-buy"/);
  assert.match(markup, /data-slot="metabot-nft-open-my-listings"/);

  const source = readFileSync(
    new URL('../src/renderer/components/metabots/MetaBotNftWalletModal.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /LegacyNftDepositGuideModal/);
  assert.match(source, /data-slot="metabot-nft-filter-verified"/);
  assert.match(source, /data-slot="metabot-nft-sort"/);
  assert.match(source, /data-slot="metabot-nft-detail"/);
  assert.match(source, /data-slot="metabot-nft-send-to-chat"/);
  assert.match(source, /data-slot="metabot-nft-set-avatar"/);
  assert.match(source, /data-slot="metabot-nft-pagination"/);
});

test('M1 MetaBotBackupMnemonicModal defaults to frosted privacy shield (revealed=false) with HD path', () => {
  const markup = renderToStaticMarkup(
    <MetaBotBackupMnemonicModal metabot={sampleBot} onClose={() => {}} />,
  );

  assert.match(markup, /data-slot="metabot-mnemonic-path"/);
  assert.match(markup, /m\/44&#x27;\/10001&#x27;\/0&#x27;\/0\/0|m\/44'\/10001'\/0'\/0\/0/);

  const source = readFileSync(
    new URL('../src/renderer/components/metabots/MetaBotBackupMnemonicModal.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /useState<boolean>\(false\)/);
  assert.match(source, /data-slot="metabot-mnemonic-shield"/);
  assert.match(source, /data-revealed=\{revealed \? 'true' : 'false'\}/);
});

test('S1 secondary lifecycle modals render cleanly in Studio Linear layout', () => {
  const deleteMarkup = renderToStaticMarkup(
    <MetaBotDeleteConfirmModal
      metabot={sampleBot}
      onClose={() => {}}
      onConfirm={() => {}}
    />,
  );
  assert.match(deleteMarkup, /data-slot="metabot-delete-confirm-modal"/);
  assert.match(deleteMarkup, /data-slot="metabot-delete-confirm-action"/);
  assert.match(deleteMarkup, /Sunny Bot/);
  assert.match(deleteMarkup, /5s/);

  const restoreMarkup = renderToStaticMarkup(
    <MetaBotRestoreMnemonicModal onClose={() => {}} onRestored={() => {}} />,
  );
  assert.match(restoreMarkup, /data-slot="metabot-restore-mnemonic-modal"/);
  assert.match(restoreMarkup, /data-slot="metabot-restore-paste"/);
  assert.match(restoreMarkup, /data-slot="metabot-restore-submit"/);
  // 12 numbered mnemonic input slots + derivation path input
  const inputMatches = restoreMarkup.match(/<input[^>]*type="text"/g) || [];
  assert.ok(inputMatches.length >= 12, 'expected at least 12 word inputs in restore modal');

  const createPendingMarkup = renderToStaticMarkup(
    <MetaBotCreateSuccessModal
      metabot={sampleBot}
      subsidySuccess={false}
      subsidyError="quota reached"
      chainSetupPending
      onClose={() => {}}
      onSyncToChain={() => {}}
      onRetrySubsidy={() => {}}
      onSelfFundBroadcast={() => {}}
    />,
  );
  assert.match(createPendingMarkup, /data-slot="metabot-create-success-modal"/);
  assert.match(createPendingMarkup, /mvc-space-grad-/);
  assert.match(createPendingMarkup, /#F7931A/);
  assert.match(createPendingMarkup, /#C2A633/);
  // Preserves chainSetupPending fallback copy & address transfer box
  assert.match(createPendingMarkup, /1MvcSampleAddressForTesting123456/);
  assert.match(createPendingMarkup, /quota reached/);
});

test('A1 AvatarPickerModal renders fixed-width 3-source segmented picker and preview footer', () => {
  const markup = renderToStaticMarkup(
    <AvatarPickerModal
      isOpen
      currentAvatar={null}
      onSelect={() => {}}
      onClose={() => {}}
      nftSource={{
        listOwnedMrc721: async () => [],
        ownerAddress: sampleBot.mvc_address,
        ownerGlobalMetaId: sampleBot.globalmetaid || undefined,
      }}
    />,
  );

  assert.match(markup, /max-w-\[540px\]/);
  assert.match(markup, /data-slot="avatar-source-builtin"/);
  assert.match(markup, /data-slot="avatar-source-local"/);
  assert.match(markup, /data-slot="avatar-source-nft"/);
});
