import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { SwapStationFulfillDaemon } = await import(
  '../dist-electron/main/services/swapStationFulfillDaemon.js'
);
const { SwapLedger } = await import('../SKILLs/nft-swap/cli/lib/swap-ledger.mjs');
const { formatSwapWireMessage, parseSwapWireMessage } = await import(
  '../dist-electron/main/services/swapWireProtocol.js'
);

const STATION_METABOT_ID = 37;
const SENDER_GMID = 'idq1requester0000000000000000000000000000000';
const RECIPIENT_ADDR = '1RequesterMvcAddress11111111111111';
const DEPOSIT_TXID = 'e5'.repeat(32);

function createPilotAppDb(pilotConfig) {
  return {
    exec(sql, params = []) {
      if (/FROM cowork_config WHERE key = \?/i.test(sql) && params[0] === 'nft_swap_pilot_config') {
        if (!pilotConfig) return [];
        return [{ columns: ['value'], values: [[JSON.stringify(pilotConfig)]] }];
      }
      return [];
    },
    run() {},
  };
}

function makeClaimWire(requestId = 'req-8539') {
  return formatSwapWireMessage({
    type: 'SWAP_CLAIM_V1',
    requestId,
    collectionSlug: 'metabot-avatar',
    codehash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
    genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
    recipientAddress: RECIPIENT_ADDR,
    recipientGlobalMetaId: SENDER_GMID,
    items: [{ tokenIndex: '8539', depositTxId: DEPOSIT_TXID }],
  });
}

function disposeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows CI-tolerant cleanup
  }
}

test('SwapStationFulfillDaemon ignores SWAP_CLAIM_V1 when metabotId is not the configured station', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-station-nonstation-'));
  try {
    const daemon = new SwapStationFulfillDaemon(
      createPilotAppDb({ metabotId: STATION_METABOT_ID, vaultAddress: '1Vault' }),
      () => {},
      {
        getMetabotStore: () => ({
          getMetabotById: (id) => ({ id, enabled: true, name: `Bot ${id}` }),
        }),
        getUserDataPath: () => dir,
        sendSwapWireMessage: async () => {
          throw new Error('must not send for non-station bot');
        },
      },
    );

    const res = await daemon.handleIncomingClaimMessage({
      metabotId: 1,
      fromGlobalMetaId: SENDER_GMID,
      plaintext: makeClaimWire('req-nonstation'),
    });
    assert.equal(res.handled, false);
  } finally {
    disposeDir(dir);
  }
});

test('SwapStationFulfillDaemon defers 0-conf claim with SWAP_STATUS_V1 and auto-completes once 1-conf arrives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-station-pending-'));
  let nowMs = 1_000_000;
  let confirmations = 0;
  const sentMessages = [];
  const a2aRecords = [];

  try {
    const daemon = new SwapStationFulfillDaemon(
      createPilotAppDb({ metabotId: STATION_METABOT_ID, vaultAddress: '1Vault' }),
      () => {},
      {
        now: () => nowMs,
        retryIntervalMs: 30_000,
        getMetabotStore: () => ({
          getMetabotById: (id) => ({ id, enabled: true, name: 'Avatar Station' }),
        }),
        getUserDataPath: () => dir,
        sendSwapWireMessage: async ({ metabotId, toGlobalMetaId, content }) => {
          sentMessages.push({ metabotId, toGlobalMetaId, content });
          return { pinId: `pin-${sentMessages.length}` };
        },
        recordA2AMessage: (entry) => {
          a2aRecords.push(entry);
        },
        createEngineDeps: async () => ({}),
        handleClaimMessageFn: async ({ rawMessage }) => {
          const claim = parseSwapWireMessage(rawMessage);
          if (confirmations < 1) {
            return {
              ok: true,
              pending: true,
              requestId: claim.requestId,
              collectionSlug: claim.collectionSlug,
              replyPayload: {
                type: 'SWAP_STATUS_V1',
                requestId: claim.requestId,
                collectionSlug: claim.collectionSlug,
                status: 'pending_1_conf',
                items: [{ tokenIndex: '8539', status: 'pending_1_conf', confirmations: 0 }],
                note: 'Waiting for 1 confirmation(s) on deposit transaction.',
              },
              replyText: formatSwapWireMessage({
                type: 'SWAP_STATUS_V1',
                requestId: claim.requestId,
                collectionSlug: claim.collectionSlug,
                status: 'pending_1_conf',
                items: [{ tokenIndex: '8539', status: 'pending_1_conf', confirmations: 0 }],
                note: 'Waiting for 1 confirmation(s) on deposit transaction.',
              }),
            };
          }
          const completedPayload = {
            type: 'SWAP_COMPLETED_V1',
            requestId: claim.requestId,
            collectionSlug: claim.collectionSlug,
            collectionPinId: '26'.repeat(32) + 'i0',
            results: [
              {
                tokenIndex: '8539',
                status: 'completed',
                itemPinId: 'ab'.repeat(32) + 'i0',
                deliveryTxId: 'cd'.repeat(32),
                itemName: 'MetaBot Avatar #8539',
              },
            ],
          };
          return {
            ok: true,
            pending: false,
            requestId: claim.requestId,
            collectionSlug: claim.collectionSlug,
            replyPayload: completedPayload,
            replyText: formatSwapWireMessage(completedPayload),
          };
        },
      },
    );

    const first = await daemon.handleIncomingClaimMessage({
      metabotId: STATION_METABOT_ID,
      fromGlobalMetaId: SENDER_GMID,
      plaintext: makeClaimWire('req-8539'),
      pinId: 'claim-pin-1',
    });
    assert.equal(first.handled, true);
    assert.equal(first.outcome, 'pending_1_conf');
    assert.equal(sentMessages.length, 1);
    assert.equal(parseSwapWireMessage(sentMessages[0].content)?.type, 'SWAP_STATUS_V1');
    assert.equal(a2aRecords.length, 2); // incoming claim + outgoing SWAP_STATUS_V1

    // Before retryIntervalMs elapses, polling does not re-run.
    nowMs += 10_000;
    const tooEarly = await daemon.processDueClaimsOnce();
    assert.equal(tooEarly.checked, 0);

    // After retryIntervalMs while still 0-conf, it checks again but does NOT spam duplicate SWAP_STATUS_V1.
    nowMs += 25_000;
    const stillPending = await daemon.processDueClaimsOnce();
    assert.equal(stillPending.checked, 1);
    assert.equal(stillPending.deferred, 1);
    assert.equal(sentMessages.length, 1);

    // Once 1 confirmation lands, next poll automatically completes and sends SWAP_COMPLETED_V1.
    confirmations = 1;
    nowMs += 30_000;
    const completed = await daemon.processDueClaimsOnce();
    assert.equal(completed.checked, 1);
    assert.equal(completed.completed, 1);
    assert.equal(sentMessages.length, 2);
    const secondWire = parseSwapWireMessage(sentMessages[1].content);
    assert.equal(secondWire?.type, 'SWAP_COMPLETED_V1');

    // Verify durable ledger row is completed and no due rows remain.
    const ledger = new SwapLedger(path.join(dir, 'nft-swap-ledger.sqlite'));
    try {
      const row = ledger.pendingClaimById('req-8539');
      assert.equal(row?.status, 'completed');
      assert.equal(ledger.listDuePendingClaims({ stationMetabotId: STATION_METABOT_ID, now: nowMs + 100_000 }).length, 0);
    } finally {
      ledger.close();
    }
  } finally {
    disposeDir(dir);
  }
});

test('SwapStationFulfillDaemon retries transient engine failures and fails closed on permanent claim errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-station-errors-'));
  let nowMs = 2_000_000;
  let mode = 'transient';
  const sentMessages = [];

  try {
    const daemon = new SwapStationFulfillDaemon(
      createPilotAppDb({ metabotId: STATION_METABOT_ID, vaultAddress: '1Vault' }),
      () => {},
      {
        now: () => nowMs,
        transientRetryMs: 15_000,
        getMetabotStore: () => ({
          getMetabotById: (id) => ({ id, enabled: true, name: 'Avatar Station' }),
        }),
        getUserDataPath: () => dir,
        sendSwapWireMessage: async ({ metabotId, toGlobalMetaId, content }) => {
          sentMessages.push({ metabotId, toGlobalMetaId, content });
          return { pinId: `pin-${sentMessages.length}` };
        },
        createEngineDeps: async () => ({}),
        handleClaimMessageFn: async ({ rawMessage }) => {
          const claim = parseSwapWireMessage(rawMessage);
          if (mode === 'transient') {
            return {
              ok: false,
              pending: false,
              requestId: claim.requestId,
              collectionSlug: claim.collectionSlug,
              replyPayload: {
                type: 'SWAP_COMPLETED_V1',
                results: [{ tokenIndex: '8539', status: 'failed', code: 'COVER_FETCH_FAILED', error: 'timeout' }],
              },
              replyText: 'should not send yet',
            };
          }
          const err = new Error('sender mismatch');
          err.code = 'SENDER_IDENTITY_MISMATCH';
          throw err;
        },
      },
    );

    const transientRes = await daemon.handleIncomingClaimMessage({
      metabotId: STATION_METABOT_ID,
      fromGlobalMetaId: SENDER_GMID,
      plaintext: makeClaimWire('req-transient'),
    });
    assert.equal(transientRes.outcome, 'retrying');
    assert.equal(sentMessages.length, 0);

    mode = 'permanent';
    const permRes = await daemon.handleIncomingClaimMessage({
      metabotId: STATION_METABOT_ID,
      fromGlobalMetaId: SENDER_GMID,
      plaintext: makeClaimWire('req-perm'),
    });
    assert.equal(permRes.outcome, 'failed');
    assert.equal(sentMessages.length, 1);
    const wire = parseSwapWireMessage(sentMessages[0].content);
    assert.equal(wire?.type, 'SWAP_STATUS_V1');
    assert.equal(wire?.status, 'failed');
  } finally {
    disposeDir(dir);
  }
});
