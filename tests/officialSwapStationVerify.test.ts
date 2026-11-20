import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listVerifiedOfficialSwapStations,
  verifyOfficialEscrowGuarantor,
  verifyOfficialSwapStation,
} from '../src/main/services/officialBotVerifyService';
import { buildNftSwapAgentTools } from '../src/main/libs/nftSwapAgentTools';
import { OFFICIAL_IDBOTS_METAID, type NftCaRegistry } from '../src/main/services/nftCaService';

const STATION_GMID = 'idq1officialswapstation000000000000000000';
const GUARANTOR_GMID = 'idq1officialescrow00000000000000000000000';
const VAULT_ADDR = '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET';
const CUSTODY_ADDR = '1OfficialCustodyAddress111111111111111';
const CODEHASH = 'e205939ad9956673ce7da9fbd40514b30f66dc35';
const GENESIS = '005d69cba8c80e6978157e146f998c21288a9d49';
const TARGET_PIN = `${'cc'.repeat(32)}i0`;

function makeRegistry(overrides: Partial<NftCaRegistry> = {}): NftCaRegistry {
  return {
    protocol: 'idbots-nft-ca',
    version: 1,
    verified: true,
    status: 'verified',
    pinId: `${'aa'.repeat(32)}i0`,
    creatorMetaId: OFFICIAL_IDBOTS_METAID,
    officialMetaId: OFFICIAL_IDBOTS_METAID,
    collections: [
      {
        collectionPinId: TARGET_PIN,
        collectionName: 'metabot-avatar',
        displayTitle: 'MetaBot Avatar',
      },
    ],
    officialBots: [
      {
        globalMetaId: STATION_GMID,
        mvcAddress: VAULT_ADDR,
        role: 'swap_station',
        badgeType: 'official_swap_station',
        badgeLabel: '官方兑换站',
        swapConfig: {
          vaultAddress: VAULT_ADDR,
          supportedSeries: [
            {
              collectionSlug: 'metabot-avatar',
              targetCollectionPinId: TARGET_PIN,
              codehash: CODEHASH,
              genesis: GENESIS,
              maxTokenIndex: 9559,
              minConfirmations: 1,
            },
          ],
        },
        active: true,
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
          maxOrderCnyCents: 300000,
        },
        active: true,
      },
    ],
    fetchedAt: Date.now(),
    ...overrides,
  };
}

test('verifyOfficialSwapStation succeeds when station, vault, series, and CA signature all match', async () => {
  const res = await verifyOfficialSwapStation(
    {
      stationGlobalMetaId: STATION_GMID,
      vaultAddress: VAULT_ADDR,
      codehash: CODEHASH.toUpperCase(),
      genesis: GENESIS.toUpperCase(),
    },
    { getRegistry: async () => makeRegistry() },
  );
  assert.equal(res.verified, true);
  if (res.verified) {
    assert.equal(res.stationEntry.globalMetaId, STATION_GMID);
    assert.equal(res.seriesConfig.collectionSlug, 'metabot-avatar');
    assert.equal(res.badgeLabel, '官方兑换站');
  }
});

test('verifyOfficialSwapStation blocks spoofed globalMetaId (S-01 anti-phishing)', async () => {
  const res = await verifyOfficialSwapStation(
    {
      stationGlobalMetaId: 'idq1attackerphishingstation0000000000000',
      vaultAddress: VAULT_ADDR,
      codehash: CODEHASH,
      genesis: GENESIS,
    },
    { getRegistry: async () => makeRegistry() },
  );
  assert.equal(res.verified, false);
  if (!res.verified) {
    assert.match(res.reason, /official/i);
  }
});

test('verifyOfficialSwapStation blocks tampered vaultAddress (S-01 anti-phishing)', async () => {
  const res = await verifyOfficialSwapStation(
    {
      stationGlobalMetaId: STATION_GMID,
      vaultAddress: '1AttackerStealVaultAddress111111111111',
      codehash: CODEHASH,
      genesis: GENESIS,
    },
    { getRegistry: async () => makeRegistry() },
  );
  assert.equal(res.verified, false);
  if (!res.verified) {
    assert.match(res.reason, /vaultAddress/i);
  }
});

test('verifyOfficialSwapStation blocks unsupported (codehash, genesis)', async () => {
  const res = await verifyOfficialSwapStation(
    {
      stationGlobalMetaId: STATION_GMID,
      vaultAddress: VAULT_ADDR,
      codehash: 'ff'.repeat(20),
      genesis: GENESIS,
    },
    { getRegistry: async () => makeRegistry() },
  );
  assert.equal(res.verified, false);
  if (!res.verified) {
    assert.match(res.reason, /series/i);
  }
});

test('verifyOfficialSwapStation blocks revoked (active: false) and unverified CA registry', async () => {
  const regRevoked = makeRegistry({
    officialBots: makeRegistry().officialBots.map((b) =>
      b.role === 'swap_station' ? { ...b, active: false } : b,
    ),
  });
  const resRevoked = await verifyOfficialSwapStation(
    {
      stationGlobalMetaId: STATION_GMID,
      vaultAddress: VAULT_ADDR,
      codehash: CODEHASH,
      genesis: GENESIS,
    },
    { getRegistry: async () => regRevoked },
  );
  assert.equal(resRevoked.verified, false);
  if (!resRevoked.verified) {
    assert.match(resRevoked.reason, /revoked|inactive/i);
  }

  const resUnverified = await verifyOfficialSwapStation(
    {
      stationGlobalMetaId: STATION_GMID,
      vaultAddress: VAULT_ADDR,
      codehash: CODEHASH,
      genesis: GENESIS,
    },
    { getRegistry: async () => makeRegistry({ verified: false, status: 'unverified' }) },
  );
  assert.equal(resUnverified.verified, false);
});

test('verifyOfficialEscrowGuarantor verifies active guarantor and blocks mismatched custody address', async () => {
  const ok = await verifyOfficialEscrowGuarantor(
    { guarantorGlobalMetaId: GUARANTOR_GMID, custodyAddress: CUSTODY_ADDR },
    { getRegistry: async () => makeRegistry() },
  );
  assert.equal(ok.verified, true);

  const badCustody = await verifyOfficialEscrowGuarantor(
    { guarantorGlobalMetaId: GUARANTOR_GMID, custodyAddress: '1WrongCustodyAddr11111111111111111' },
    { getRegistry: async () => makeRegistry() },
  );
  assert.equal(badCustody.verified, false);
});

test('listVerifiedOfficialSwapStations returns empty when CA is unverified and active stations when verified', async () => {
  const empty = await listVerifiedOfficialSwapStations(undefined, {
    getRegistry: async () => makeRegistry({ verified: false }),
  });
  assert.equal(empty.verified, false);
  assert.deepEqual(empty.stations, []);

  const list = await listVerifiedOfficialSwapStations(undefined, {
    getRegistry: async () => makeRegistry(),
  });
  assert.equal(list.verified, true);
  assert.equal(list.stations.length, 1);
  assert.equal(list.stations[0].globalMetaId, STATION_GMID);
});

test('S-01: nft_swap_submit_batch blocks forged station/vault with zero confirmations and zero transfers', async () => {
  let confirmCalls = 0;
  let transferCalls = 0;
  let privateMsgCalls = 0;
  const toolsByName = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();

  buildNftSwapAgentTools({
    tool: (name, _desc, _schema, handler) => {
      toolsByName.set(name, handler as (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>);
      return { name };
    },
    sessionId: 'sess-s01',
    resolveMetabotId: () => 1,
    confirmBatchSwap: async () => {
      confirmCalls += 1;
      return true;
    },
    control: {
      getMetabotIdentity: () => ({
        name: 'Twin',
        mvcAddress: '1TwinAddr11111111111111111111111111',
        globalMetaId: 'idq1twin00000000000000000000000000000000',
      }),
      getMvcNftBalance: async () => ({
        collections: [
          {
            seriesName: 'MetaBot Avatar',
            codeHash: CODEHASH,
            genesis: GENESIS,
            items: [{ tokenIndex: '101', name: 'MetaBot Avatar #101' }],
          },
        ],
      }),
      transferMvcNft: async () => {
        transferCalls += 1;
        return { txId: 'aa'.repeat(32) };
      },
      sendSwapClaim: async () => {
        privateMsgCalls += 1;
        return { pinId: `${'bb'.repeat(32)}i0`, txids: ['bb'.repeat(32)] };
      },
      registerOrder: () => {
        throw new Error('should not register order on failed CA check');
      },
      verifyOfficialSwapStation: async (params) =>
        verifyOfficialSwapStation(params, { getRegistry: async () => makeRegistry() }),
      listVerifiedOfficialSwapStations: async (opts) =>
        listVerifiedOfficialSwapStations(opts, { getRegistry: async () => makeRegistry() }),
    },
  });

  const submitTool = toolsByName.get('nft_swap_submit_batch')!;
  assert.ok(submitTool);

  const res = await submitTool({
    station_global_metaid: STATION_GMID,
    vault_address: '1PhishingVaultAddress1111111111111111',
    codehash: CODEHASH,
    genesis: GENESIS,
    token_indices: ['101'],
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /CA verification refused swap/i);
  assert.equal(confirmCalls, 0);
  assert.equal(transferCalls, 0);
  assert.equal(privateMsgCalls, 0);
});
