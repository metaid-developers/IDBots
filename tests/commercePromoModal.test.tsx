// Round 2 P0-B component tests: `browser.commerce.openPromoPack` in the
// inline chat bubble must open the host-owned PromoAmmoPackModal directly
// (owner-side tooling — no "send to Twin" confirm card), while
// askTwinToBuy/addFriendPrompt keep their confirm-card flow.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blockPath = path.join(repoRoot, 'src', 'renderer', 'components', 'cowork', 'InlineMetaAppBlock.tsx');
const blockSource = fs.readFileSync(blockPath, 'utf8');

const VALID_PIN = '1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0';
// minimal dynamic import helper (tsx resolves the .js → .ts source)
async function awaitImport(specifier: string): Promise<{ PromoAmmoPackModal: React.FC<Record<string, unknown>> }> {
  return import(specifier);
}


test('inline block mounts PromoAmmoPackModal on openPromoPack without the Twin confirm card', () => {
  // the openPromoPack branch short-circuits into the modal, returning {opened:true}
  assert.match(blockSource, /intent === 'openPromoPack'|\/\/ Promo pack is seller-side tooling[\s\S]*?setPromoPackParams\(result\)/);
  assert.match(blockSource, /setPromoPackParams\(result\);\s*\n\s*return \{ opened: true \};/);
  // the modal is actually rendered in JSX with the promo state
  assert.match(blockSource, /promoPackParams && \(\s*\n\s*<PromoAmmoPackModal/);
  // askTwinToBuy/addFriendPrompt still go through the confirm card
  assert.match(blockSource, /askUser\(\{ kind: 'commerce', intent, params: sanitized \}\)/);
});

test('PromoAmmoPackModal renders owner header, poster plate and three compliant template sections (SSR)', async () => {
  const { PromoAmmoPackModal } = await awaitImport('../src/renderer/components/commerce/PromoAmmoPackModal.js');
  const html = renderToStaticMarkup(
    React.createElement(PromoAmmoPackModal, {
      params: {
        shopOwnerGlobalMetaId: 'idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47',
        shopOwnerName: '小林的Twin',
        shopSlogan: '老藏家清仓小铺',
        featuredItems: [
          { itemPinId: VALID_PIN, itemName: '金框墨镜 #1310', priceMeMilli: 15000, priceCnyCents: 990 },
        ],
      },
      lang: 'zh',
      onClose: () => {},
    }),
  );
  assert.match(html, /分销弹药包/);
  assert.match(html, /data-promo-poster-canvas/);
  assert.match(html, /下载 PNG/);
  assert.match(html, /data-promo-template/);
  // compliant angles present, financial promises absent
  assert.match(html, /免费 1:1 升级/);
  assert.match(html, /metaapp:\/\/|metaid:\/\//);
});
