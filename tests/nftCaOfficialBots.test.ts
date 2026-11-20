import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NFT_CA_PINID,
  OFFICIAL_IDBOTS_METAID,
  clearNftCaRegistryCache,
  getNftCaRegistry,
  parseNftCaPinContent,
  parseNftCaPinPayload,
} from '../src/main/services/nftCaService';
import { extractCertifiedLegacySeries } from '../src/renderer/components/metabots/LegacyNftDepositGuideModal';
import type { NftCaRegistry } from '../src/renderer/services/nftCaRegistryService';

const COLLECTION_PIN_1 = `${'11'.repeat(32)}i0`;
const COLLECTION_PIN_2 = `${'22'.repeat(32)}i0`;
const ROOT_CA_PIN = DEFAULT_NFT_CA_PINID;
const MODIFIED_CA_PIN = `${'aa'.repeat(32)}i0`;

const STATION_GMID = 'idq1swapstationtest000000000000000000000000';
const GUARANTOR_GMID = 'idq1escrowguarantortest000000000000000000';
const VAULT_ADDR = '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET';
const CUSTODY_ADDR = '1EscrowCustodyTestAddress111111111111';
const SERIES_CODEHASH = 'e205939ad9956673ce7da9fbd40514b30f66dc35';
const SERIES_GENESIS = '005d69cba8c80e6978157e146f998c21288a9d49';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withFetchStub<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = prev;
  }
}

const V11_PAYLOAD = {
  protocol: 'idbots-nft-ca',
  version: 1,
  collections: [
    {
      collectionPinId: COLLECTION_PIN_1,
      collectionName: 'metabot-avatar',
      displayTitle: 'MetaBot Avatar 数字头像',
      legacySeries: {
        codehash: SERIES_CODEHASH,
        genesis: SERIES_GENESIS,
        swapStationGlobalMetaId: STATION_GMID,
      },
      note: 'Official MetaBot Avatar series',
      certifiedAt: 1793868000,
    },
  ],
  officialBots: [
    {
      globalMetaId: STATION_GMID,
      metaId: 'ab'.repeat(32),
      mvcAddress: VAULT_ADDR,
      role: 'swap_station',
      badgeType: 'official_swap_station',
      badgeLabel: '官方兑换站',
      swapConfig: {
        vaultAddress: VAULT_ADDR,
        supportedSeries: [
          {
            collectionSlug: 'metabot-avatar',
            targetCollectionPinId: COLLECTION_PIN_1,
            codehash: SERIES_CODEHASH,
            genesis: SERIES_GENESIS,
            maxTokenIndex: 9559,
            minConfirmations: 1,
          },
        ],
      },
      active: true,
      certifiedAt: 1793868000,
    },
    {
      globalMetaId: GUARANTOR_GMID,
      mvcAddress: CUSTODY_ADDR,
      role: 'escrow_guarantor',
      badgeType: 'official_escrow_guarantor',
      badgeLabel: '官方担保席',
      escrowConfig: {
        custodyAddress: CUSTODY_ADDR,
        supportedCurrencies: ['CNY'],
        maxOrderCnyCents: 500000,
      },
      active: true,
    },
    // Malformed bot entry should be dropped safely
    {
      globalMetaId: '',
      mvcAddress: VAULT_ADDR,
      role: 'swap_station',
      active: true,
    },
  ],
};

test('parseNftCaPinPayload parses v1.1 collections (displayTitle + legacySeries) and officialBots', () => {
  const parsed = parseNftCaPinPayload(JSON.stringify(V11_PAYLOAD));
  assert.ok(parsed);
  assert.equal(parsed.collections.length, 1);
  assert.equal(parsed.collections[0].displayTitle, 'MetaBot Avatar 数字头像');
  assert.equal(parsed.collections[0].legacySeries?.codehash, SERIES_CODEHASH);
  assert.equal(parsed.collections[0].legacySeries?.genesis, SERIES_GENESIS);
  assert.equal(parsed.collections[0].legacySeries?.swapStationGlobalMetaId, STATION_GMID);

  assert.equal(parsed.officialBots.length, 2);
  const station = parsed.officialBots[0];
  assert.equal(station.role, 'swap_station');
  assert.equal(station.badgeLabel, '官方兑换站');
  assert.equal(station.swapConfig?.vaultAddress, VAULT_ADDR);
  assert.equal(station.swapConfig?.supportedSeries.length, 1);
  assert.equal(station.swapConfig?.supportedSeries[0].minConfirmations, 1);
  assert.equal(station.swapConfig?.supportedSeries[0].maxTokenIndex, 9559);

  const guarantor = parsed.officialBots[1];
  assert.equal(guarantor.role, 'escrow_guarantor');
  assert.equal(guarantor.escrowConfig?.custodyAddress, CUSTODY_ADDR);
  assert.deepEqual(guarantor.escrowConfig?.supportedCurrencies, ['CNY']);
});

test('parseNftCaPinContent remains backward-compatible with v1 collections-only payload', () => {
  const legacyOnly = JSON.stringify({
    collections: [
      { collectionPinId: COLLECTION_PIN_2, collectionName: 'legacy-v1-set', certifiedAt: 1790000000 },
    ],
  });
  const cols = parseNftCaPinContent(legacyOnly);
  assert.ok(Array.isArray(cols));
  assert.equal(cols.length, 1);
  assert.equal(cols[0].collectionPinId, COLLECTION_PIN_2);

  const payload = parseNftCaPinPayload(legacyOnly);
  assert.ok(payload);
  assert.equal(payload.collections.length, 1);
  assert.deepEqual(payload.officialBots, []);
});

test('getNftCaRegistry reads latest modified CA pin via MetaSo endpoint and verifies Bob creatorMetaId', async () => {
  delete process.env.IDBOTS_NFT_CA_PINID;
  delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  clearNftCaRegistryCache();

  const registry = await withFetchStub(async (input) => {
    const url = String(input);
    if (url.includes('/api/mrc721/ca/registry')) {
      return jsonResponse({
        code: 0,
        data: {
          pinId: MODIFIED_CA_PIN,
          content: JSON.stringify(V11_PAYLOAD),
        },
      });
    }
    if (url.includes(`/content/${MODIFIED_CA_PIN}`)) {
      return jsonResponse(V11_PAYLOAD);
    }
    if (url.includes(`/pin/${MODIFIED_CA_PIN}`)) {
      return jsonResponse({
        code: 1,
        data: {
          id: MODIFIED_CA_PIN,
          creator: OFFICIAL_IDBOTS_METAID,
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, () => getNftCaRegistry({ refresh: true }));

  assert.equal(registry.verified, true);
  assert.equal(registry.status, 'verified');
  assert.equal(registry.pinId, MODIFIED_CA_PIN);
  assert.equal(registry.officialBots.length, 2);
});

test('getNftCaRegistry falls back to modify_history when MetaSo registry endpoint is unavailable', async () => {
  delete process.env.IDBOTS_NFT_CA_PINID;
  delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  clearNftCaRegistryCache();

  const registry = await withFetchStub(async (input) => {
    const url = String(input);
    if (url.includes('/api/mrc721/ca/registry')) {
      return jsonResponse({ code: 404 }, 404);
    }
    if (url.includes(`/pin/${ROOT_CA_PIN}`) || url.includes(`/pin/${MODIFIED_CA_PIN}`)) {
      const id = url.includes(MODIFIED_CA_PIN) ? MODIFIED_CA_PIN : ROOT_CA_PIN;
      return jsonResponse({
        code: 1,
        data: {
          id,
          creator: OFFICIAL_IDBOTS_METAID,
          modify_history: [ROOT_CA_PIN, MODIFIED_CA_PIN],
        },
      });
    }
    if (url.includes(`/content/${MODIFIED_CA_PIN}`)) {
      return jsonResponse(V11_PAYLOAD);
    }
    throw new Error(`unexpected fetch ${url}`);
  }, () => getNftCaRegistry({ refresh: true }));

  assert.equal(registry.verified, true);
  assert.equal(registry.pinId, MODIFIED_CA_PIN);
  assert.equal(registry.officialBots.length, 2);
});

test('getNftCaRegistry marks non-official creatorMetaId as verified: false (fail-closed)', async () => {
  const prevOverride = process.env.IDBOTS_NFT_CA_PINID;
  process.env.IDBOTS_NFT_CA_PINID = MODIFIED_CA_PIN;
  clearNftCaRegistryCache();

  try {
    const registry = await withFetchStub(async (input) => {
      const url = String(input);
      if (url.includes(`/content/${MODIFIED_CA_PIN}`)) {
        return jsonResponse(V11_PAYLOAD);
      }
      if (url.includes(`/pin/${MODIFIED_CA_PIN}`)) {
        return jsonResponse({
          code: 1,
          data: {
            id: MODIFIED_CA_PIN,
            creator: 'ff'.repeat(32), // attacker creatorMetaId
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, () => getNftCaRegistry({ refresh: true }));

    assert.equal(registry.verified, false);
    assert.equal(registry.status, 'unverified');
    assert.equal(registry.creatorMetaId, 'ff'.repeat(32));
  } finally {
    if (prevOverride) process.env.IDBOTS_NFT_CA_PINID = prevOverride;
    else delete process.env.IDBOTS_NFT_CA_PINID;
  }
});

test('extractCertifiedLegacySeries enforces registry.verified and active swap_station', () => {
  const baseRegistry: NftCaRegistry = {
    protocol: 'idbots-nft-ca',
    version: 1,
    verified: true,
    status: 'verified',
    pinId: MODIFIED_CA_PIN,
    creatorMetaId: OFFICIAL_IDBOTS_METAID,
    officialMetaId: OFFICIAL_IDBOTS_METAID,
    collections: V11_PAYLOAD.collections,
    officialBots: V11_PAYLOAD.officialBots as NftCaRegistry['officialBots'],
    fetchedAt: Date.now(),
  };

  const verifiedItems = extractCertifiedLegacySeries(baseRegistry);
  assert.equal(verifiedItems.length, 1);
  assert.equal(verifiedItems[0].title, 'MetaBot Avatar 数字头像');
  assert.equal(verifiedItems[0].stationGlobalMetaId, STATION_GMID);

  // Unverified registry -> empty list (fail-closed)
  assert.deepEqual(extractCertifiedLegacySeries({ ...baseRegistry, verified: false }), []);

  // Revoked swap station (active: false) -> excluded
  const revokedRegistry: NftCaRegistry = {
    ...baseRegistry,
    officialBots: (baseRegistry.officialBots || []).map((b) =>
      b.role === 'swap_station' ? { ...b, active: false } : b,
    ),
  };
  assert.deepEqual(extractCertifiedLegacySeries(revokedRegistry), []);
});
