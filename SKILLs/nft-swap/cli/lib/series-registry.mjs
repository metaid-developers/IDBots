/**
 * Multi-collection series registry for nft-swap v0.5.0.
 *
 * Adding a new legacy MetaContract -> MRC-721 series requires only adding a
 * declarative entry to SERIES_REGISTRY (matching Contract C1.2 CA fields)
 * without changing engine or ledger logic.
 */

import { ISSUER_CONFIG } from './issuer-config.mjs';

export const DEFAULT_COLLECTION_SLUG = 'metabot-avatar';

/** @type {Record<string, {
 *   collectionSlug: string;
 *   displayName: string;
 *   itemTitlePrefix: string;
 *   legacyGenesis: string;
 *   legacyCodeHash: string;
 *   sensibleId: string | null;
 *   tokenSupply: number;
 *   issuerAddress: string;
 *   vaultAddress: string;
 *   burnAddress: string;
 *   collectionName: string;
 *   collectionPinId: string | null;
 *   minConfirmations: number;
 *   perSwapFeeCeilingSats: number;
 * }>} */
export const SERIES_REGISTRY = {
  'metabot-avatar': {
    collectionSlug: 'metabot-avatar',
    displayName: 'MetaBot Avatar',
    itemTitlePrefix: 'MetaBot Avatar',
    legacyGenesis: ISSUER_CONFIG.genesis,
    legacyCodeHash: ISSUER_CONFIG.codeHash,
    sensibleId: ISSUER_CONFIG.sensibleId,
    tokenSupply: ISSUER_CONFIG.tokenSupply,
    issuerAddress: ISSUER_CONFIG.issuerAddress,
    vaultAddress: ISSUER_CONFIG.vaultAddress,
    burnAddress: ISSUER_CONFIG.burnAddress,
    collectionName: ISSUER_CONFIG.collectionName,
    collectionPinId: null,
    minConfirmations: 1,
    perSwapFeeCeilingSats: ISSUER_CONFIG.perSwapFeeCeilingSats,
  },
};

export function registerSeries(entry, registry = SERIES_REGISTRY) {
  if (!entry || typeof entry.collectionSlug !== 'string' || !entry.collectionSlug.trim()) {
    throw new Error('registerSeries requires a non-empty collectionSlug');
  }
  const slug = entry.collectionSlug.trim().toLowerCase();
  registry[slug] = {
    ...entry,
    collectionSlug: slug,
    legacyGenesis: String(entry.legacyGenesis ?? '').trim().toLowerCase(),
    legacyCodeHash: String(entry.legacyCodeHash ?? '').trim().toLowerCase(),
    minConfirmations: Number.isInteger(entry.minConfirmations) ? entry.minConfirmations : 1,
    perSwapFeeCeilingSats: entry.perSwapFeeCeilingSats ?? ISSUER_CONFIG.perSwapFeeCeilingSats,
    burnAddress: entry.burnAddress || ISSUER_CONFIG.burnAddress,
    itemTitlePrefix: entry.itemTitlePrefix || entry.displayName || slug,
    collectionName: entry.collectionName || slug,
    collectionPinId: entry.collectionPinId ?? null,
    sensibleId: entry.sensibleId ?? null,
  };
  return registry[slug];
}

export function getSeriesBySlug(slug, registry = SERIES_REGISTRY) {
  if (!slug || typeof slug !== 'string') return null;
  return registry[slug.trim().toLowerCase()] ?? null;
}

export function listSeries(registry = SERIES_REGISTRY) {
  return Object.values(registry);
}

export function resolveSeries({ collectionSlug, genesis, codeHash } = {}, registry = SERIES_REGISTRY) {
  if (collectionSlug && typeof collectionSlug === 'string') {
    const bySlug = getSeriesBySlug(collectionSlug, registry);
    if (bySlug) return bySlug;
    return null;
  }
  if (genesis && codeHash) {
    const g = String(genesis).trim().toLowerCase();
    const c = String(codeHash).trim().toLowerCase();
    const match = Object.values(registry).find(
      (item) => item.legacyGenesis.toLowerCase() === g && item.legacyCodeHash.toLowerCase() === c,
    );
    if (match) return match;
    return null;
  }
  if (genesis) {
    const g = String(genesis).trim().toLowerCase();
    const match = Object.values(registry).find((item) => item.legacyGenesis.toLowerCase() === g);
    if (match) return match;
  }
  return registry[DEFAULT_COLLECTION_SLUG];
}

export function albumFromSeries(series, overrides = {}) {
  return {
    collectionSlug: overrides.collectionSlug ?? series.collectionSlug,
    genesis: overrides.genesis ?? series.legacyGenesis,
    codeHash: overrides.codeHash ?? series.legacyCodeHash,
    sensibleId: overrides.sensibleId !== undefined ? overrides.sensibleId : series.sensibleId,
    tokenSupply: overrides.tokenSupply ?? series.tokenSupply,
    issuerAddress: overrides.issuerAddress ?? series.issuerAddress,
    vaultAddress: overrides.vaultAddress ?? series.vaultAddress,
    collectionName: overrides.collectionName ?? series.collectionName,
    collectionPinId: overrides.collectionPinId ?? series.collectionPinId ?? null,
    itemTitlePrefix: overrides.itemTitlePrefix ?? series.itemTitlePrefix ?? series.displayName ?? series.collectionSlug,
    burnAddress: overrides.burnAddress ?? series.burnAddress,
    perSwapFeeCeilingSats: overrides.perSwapFeeCeilingSats ?? series.perSwapFeeCeilingSats ?? 5000,
    minConfirmations: overrides.minConfirmations ?? series.minConfirmations ?? 1,
  };
}
