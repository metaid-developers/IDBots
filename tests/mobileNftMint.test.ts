import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMobileNftMintPrompt, validateMobileNftMintRequest } from '../src/mobile/app/me/nftMint.ts';

const base = {
  botId: 1,
  collectionName: 'founder-pass',
  collectionDisplayName: 'Founder Pass',
  createCollection: true,
  itemName: 'Founder #1',
  description: 'The first founder pass.',
  artworkPath: '/data/workspace/uploads/founder.png',
};

test('mint validation mirrors the MRC-721 collection identifier contract', () => {
  assert.equal(validateMobileNftMintRequest(base), null);
  assert.equal(validateMobileNftMintRequest({ ...base, collectionName: 'Invalid Name' }), 'mobile.nfts.mint.collectionInvalid');
  assert.equal(validateMobileNftMintRequest({ ...base, itemName: ' ' }), 'mobile.nfts.mint.itemNameRequired');
  assert.equal(validateMobileNftMintRequest({ ...base, collectionDisplayName: '' }), 'mobile.nfts.mint.collectionNameRequired');
  assert.equal(validateMobileNftMintRequest({ ...base, botId: 0 }), 'mobile.nfts.mint.botRequired');
});

test('new-collection mint prompt estimates cost before creation and preserves the uploaded cover', () => {
  const prompt = buildMobileNftMintPrompt(base);
  assert.ok(prompt.indexOf('mrc721_issue_estimate') < prompt.indexOf('mrc721_collection_create'));
  assert.ok(prompt.includes('metabot-upload-file'));
  assert.ok(prompt.includes('"artwork_path": "/data/workspace/uploads/founder.png"'));
  assert.ok(prompt.includes('"collection_name": "founder-pass"'));
  assert.ok(prompt.includes('Use mrc721_mint exactly once'));
});

test('existing-collection mint never asks the agent to create or borrow another issuer collection', () => {
  const prompt = buildMobileNftMintPrompt({ ...base, createCollection: false, artworkPath: undefined });
  assert.ok(prompt.includes('mrc721_collection_list'));
  assert.ok(!prompt.includes('mrc721_collection_create'));
  assert.ok(prompt.includes('mint without a cover'));
  assert.ok(prompt.includes('Do not mint into another issuer'));
});
