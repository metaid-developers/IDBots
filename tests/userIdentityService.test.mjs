import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { createMetaBotWallet } = await import('../dist-electron/main/services/metabotWalletService.js');
const {
  confirmDeferredUserIdentitySetup,
  createUserIdentity,
  importUserIdentity,
  logoutUserIdentity,
  resumeUserIdentitySetup,
  retryUserIdentitySubsidy,
  syncUserIdentityToChain,
  buildUserInfoSyncSteps,
  updateUserIdentityAvatar,
  updateUserIdentityName,
} = await import('../dist-electron/main/services/userIdentityService.js');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Official BIP39 24-word test vector (256-bit zero entropy).
const TEST_MNEMONIC_24 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const AVATAR_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-user-identity-svc-'));

const makeStores = async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const userStore = new UserIdentityStore(store.getDatabase(), () => store.save());
  return { store, userStore, tempDir };
};

const disposeStores = ({ store, tempDir }) => {
  try { store.close(); } catch { /* best-effort cleanup */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* OS sweeps leftovers */ }
};

const makePinMock = (behavior) => {
  const calls = [];
  let n = 0;
  const fn = async (params) => {
    n += 1;
    calls.push({
      ...params,
      // Record a copy: the service mutates one shared sessionSnapshot across calls.
      excludeOutpointsSnapshot: [...(params.sessionSnapshot?.excludeOutpoints ?? [])],
    });
    const stepKey = params.metaidData.path;
    const failure = behavior?.failOn?.includes(stepKey);
    if (failure) throw new Error(`pin ${stepKey} failed`);
    return {
      txids: [`tx-${n}`],
      pinId: `pin-${n}`,
      totalCost: 100,
      spentOutpoints: [`spent-${n}:0`],
      changeUtxo: null,
    };
  };
  return { fn, calls };
};

const baseDeps = (pinMock) => ({
  createPin: pinMock.fn,
  requestSubsidy: async () => ({ success: true }),
  sleep: async () => {},
});

test('createUserIdentity publishes name/avatar/chatpubkey and stores chat pin id', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const result = await createUserIdentity(userStore, { name: 'Alice', avatar: AVATAR_DATA_URL }, baseDeps(pinMock));

  assert.equal(result.success, true);
  assert.equal(result.mnemonic.split(' ').length, 12);
  assert.equal(result.identity.name, 'Alice');
  assert.ok(result.identity.globalmetaid);

  const paths = pinMock.calls.map((c) => c.metaidData.path);
  assert.deepEqual(paths, ['/info/name', '/info/avatar', '/info/chatpubkey']);
  // Outpoints are threaded between sequential pins to avoid double-spend.
  assert.deepEqual(pinMock.calls[1].excludeOutpointsSnapshot, ['spent-1:0']);

  const saved = userStore.get();
  assert.equal(saved.chat_public_key_pin_id, 'pin-3');
  assert.equal(result.chainSync.success, true);
  store.close();
});

test('createUserIdentity with deferChainSync skips pins and leaves sync pending', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const result = await createUserIdentity(
    userStore,
    { name: 'Alice', avatar: AVATAR_DATA_URL },
    baseDeps(pinMock),
    { deferChainSync: true },
  );

  assert.equal(result.success, true);
  assert.equal(pinMock.calls.length, 0, 'no on-chain pins may be published');
  assert.equal(result.chainSync, undefined);
  const saved = userStore.get();
  assert.equal(saved.subsidy_state, 'claimed');
  assert.equal(saved.sync_state, 'pending');
  store.close();
});

test('createUserIdentity keeps local identity when a pin step fails', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock({ failOn: ['/info/avatar'] });
  const result = await createUserIdentity(userStore, { name: 'Alice', avatar: AVATAR_DATA_URL }, baseDeps(pinMock));

  assert.equal(result.success, true);
  assert.equal(result.chainSync.success, false);
  assert.deepEqual(result.chainSync.failedSteps, ['avatar']);
  assert.ok(userStore.get());
  // Remaining steps still attempted after the failure.
  assert.equal(pinMock.calls.length, 3);
  store.close();
});

test('createUserIdentity rejects when an identity already exists', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(pinMock));
  const again = await createUserIdentity(userStore, { name: 'Bob' }, baseDeps(pinMock));
  assert.equal(again.success, false);
  assert.equal(again.error, 'USER_IDENTITY_EXISTS');
  store.close();
});

test('importUserIdentity with on-chain profile reuses it and publishes nothing', async () => {
  const { store, userStore } = await makeStores();
  const wallet = await createMetaBotWallet({ mnemonic: TEST_MNEMONIC });
  const pinMock = makePinMock();
  const result = await importUserIdentity(
    userStore,
    { mnemonic: TEST_MNEMONIC },
    {
      ...baseDeps(pinMock),
      fetchProfile: async () => ({
        name: 'On Chain Alice',
        avatarDataUrl: AVATAR_DATA_URL,
        metabotInfoPinId: null,
        chatpubkeyPinId: 'chat-pin-1',
        bio: {},
        raw: { chatpubkey: wallet.chat_public_key },
      }),
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.profileSource, 'chain');
  assert.equal(result.identity.name, 'On Chain Alice');
  assert.equal(result.identity.chat_public_key_pin_id, 'chat-pin-1');
  assert.equal(pinMock.calls.length, 0);
  store.close();
});

test('importUserIdentity without on-chain profile imports with empty name, publishes only chatpubkey', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const deps = {
    ...baseDeps(pinMock),
    fetchProfile: async () => { throw new Error('CHAIN_INFO_EMPTY'); },
  };

  const result = await importUserIdentity(userStore, { mnemonic: TEST_MNEMONIC }, deps);
  assert.equal(result.success, true);
  assert.equal(result.profileSource, 'local');
  assert.equal(result.identity.name, '');
  assert.equal(result.identity.avatar, null);
  const paths = pinMock.calls.map((c) => c.metaidData.path);
  assert.deepEqual(paths, ['/info/chatpubkey']);
  store.close();
});

test('importUserIdentity accepts a valid 24-word mnemonic (Metalet-compatible)', async () => {
  const { store, userStore } = await makeStores();
  const wallet24 = await createMetaBotWallet({ mnemonic: TEST_MNEMONIC_24 });
  const pinMock = makePinMock();
  const result = await importUserIdentity(
    userStore,
    { mnemonic: TEST_MNEMONIC_24 },
    {
      ...baseDeps(pinMock),
      fetchProfile: async () => ({
        name: 'Twenty Four',
        avatarDataUrl: null,
        metabotInfoPinId: null,
        chatpubkeyPinId: 'chat-pin-24',
        bio: {},
        raw: { chatpubkey: wallet24.chat_public_key },
      }),
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.identity.name, 'Twenty Four');
  assert.equal(userStore.get()?.mvc_address, wallet24.mvc_address);
  store.close();
});

test('importUserIdentity rejects chat pubkey mismatch (wrong derivation path)', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const result = await importUserIdentity(
    userStore,
    { mnemonic: TEST_MNEMONIC },
    {
      ...baseDeps(pinMock),
      fetchProfile: async () => ({
        name: 'On Chain Alice',
        avatarDataUrl: null,
        metabotInfoPinId: null,
        chatpubkeyPinId: 'chat-pin-1',
        bio: {},
        raw: { chatpubkey: 'deadbeef' },
      }),
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.error, 'CHAT_PUBKEY_MISMATCH');
  assert.equal(userStore.get(), null);
  store.close();
});

test('importUserIdentity rejects invalid mnemonics and surfaces fetch failures', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();

  const bad = await importUserIdentity(userStore, { mnemonic: 'foo bar baz' }, baseDeps(pinMock));
  assert.equal(bad.error, 'INVALID_MNEMONIC');

  const wrongChecksum = await importUserIdentity(
    userStore,
    { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon' },
    baseDeps(pinMock),
  );
  assert.equal(wrongChecksum.error, 'INVALID_MNEMONIC');

  // 15 words is a valid BIP39 length but intentionally unsupported (12/24 only).
  const fifteenWords = await importUserIdentity(
    userStore,
    { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon admit' },
    baseDeps(pinMock),
  );
  assert.equal(fifteenWords.error, 'INVALID_MNEMONIC');

  const fetchDown = await importUserIdentity(userStore, { mnemonic: TEST_MNEMONIC }, {
    ...baseDeps(pinMock),
    fetchProfile: async () => { throw new Error('network down'); },
  });
  assert.equal(fetchDown.success, false);
  assert.equal(fetchDown.error, 'network down');
  store.close();
});

test('importUserIdentity keeps the empty-name fallback when the remote profile fetch is unreachable', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  process.env.IDBOTS_MAN_P2P_LOCAL_BASE = 'http://127.0.0.1:59994';
  let remoteSignalSeen = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v1/users/info/address/')) {
      // Fresh-machine local stub: identity mapping present, no profile content.
      return new Response(JSON.stringify({
        code: 1,
        message: 'ok',
        data: {
          metaid: '7777775fe18df248b375c3a381401bac84276688b4ce4e8cde12975f9a5922e8',
          name: '',
          nameId: '',
          address: '1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX',
          globalMetaId: 'idq1ncewm6vda5ryqjerwcmsqlty3x89n05k6dp6jv',
          avatar: '',
          chatpubkey: '',
          isInit: false,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/v1/info/address/')) {
      remoteSignalSeen = Boolean(init && init.signal);
      throw new TypeError('fetch failed');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const result = await importUserIdentity(userStore, { mnemonic: TEST_MNEMONIC }, baseDeps(pinMock));
    assert.equal(result.success, true);
    assert.equal(result.profileSource, 'local');
    assert.equal(result.identity.name, '');
    assert.equal(remoteSignalSeen, true, 'the remote fallback must carry a timeout signal');
    // The degraded import must not publish profile steps — only the chat pubkey.
    const paths = pinMock.calls.map((c) => c.metaidData.path);
    assert.deepEqual(paths, ['/info/chatpubkey']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) {
      delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
    } else {
      process.env.IDBOTS_MAN_P2P_LOCAL_BASE = originalBase;
    }
    store.close();
  }
});

test('logout deletes the identity and allows a fresh create', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(pinMock));
  assert.equal(logoutUserIdentity(userStore), true);
  assert.equal(userStore.get(), null);
  assert.equal(logoutUserIdentity(userStore), false);

  const recreated = await createUserIdentity(userStore, { name: 'Alice 2' }, baseDeps(pinMock));
  assert.equal(recreated.success, true);
  store.close();
});

test('buildUserInfoSyncSteps only republishes missing chatpubkey on retry', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock({ failOn: ['/info/chatpubkey'] });
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(pinMock));

  const identity = userStore.get();
  assert.equal(identity.chat_public_key_pin_id, null);
  const steps = buildUserInfoSyncSteps(identity, { includeProfileSteps: false });
  assert.deepEqual(steps.map((s) => s.key), ['chatpubkey']);

  const retryMock = makePinMock();
  const retry = await syncUserIdentityToChain(userStore, { includeProfileSteps: false }, baseDeps(retryMock));
  assert.equal(retry.success, true);
  assert.equal(retryMock.calls.length, 1);
  assert.equal(userStore.get().chat_public_key_pin_id, 'pin-1');
  store.close();
});

test('updateUserIdentityName publishes /info/name first, then updates local', async () => {
  const { store, userStore } = await makeStores();
  const createPinMock = makePinMock();
  await importUserIdentity(userStore, { mnemonic: TEST_MNEMONIC }, {
    ...baseDeps(createPinMock),
    fetchProfile: async () => { throw new Error('CHAIN_INFO_EMPTY'); },
  });
  assert.equal(userStore.get().name, '');

  const renameMock = makePinMock();
  const result = await updateUserIdentityName(userStore, { name: '  Alice Named  ' }, baseDeps(renameMock));
  assert.equal(result.success, true);
  assert.equal(result.identity.name, 'Alice Named');
  assert.equal(renameMock.calls.length, 1);
  assert.equal(renameMock.calls[0].metaidData.path, '/info/name');
  assert.equal(renameMock.calls[0].metaidData.payload, 'Alice Named');
  assert.equal(userStore.get().name, 'Alice Named');
  store.close();
});

test('updateUserIdentityName keeps local name when the pin fails', async () => {
  const { store, userStore } = await makeStores();
  const createPinMock = makePinMock();
  await createUserIdentity(userStore, { name: 'Original' }, baseDeps(createPinMock));

  const failMock = { fn: async () => { throw new Error('worker died'); }, calls: [] };
  const result = await updateUserIdentityName(userStore, { name: 'New Name' }, baseDeps(failMock));
  assert.equal(result.success, false);
  assert.equal(result.error, 'worker died');
  assert.equal(userStore.get().name, 'Original');
  store.close();
});

test('updateUserIdentityName validates input and identity presence', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();

  const missing = await updateUserIdentityName(userStore, { name: 'X' }, baseDeps(pinMock));
  assert.equal(missing.error, 'USER_IDENTITY_MISSING');

  await createUserIdentity(userStore, { name: 'Original' }, baseDeps(pinMock));
  const empty = await updateUserIdentityName(userStore, { name: '   ' }, baseDeps(pinMock));
  assert.equal(empty.error, 'NAME_EMPTY');

  const same = await updateUserIdentityName(userStore, { name: 'Original' }, baseDeps(pinMock));
  assert.equal(same.success, true);
  assert.equal(userStore.get().name, 'Original');
  store.close();
});

test('createUserIdentity skips on-chain pins when subsidy fails and keeps identity', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const result = await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.subsidy.success, false);
  assert.equal(result.chainSync, undefined);
  assert.equal(pinMock.calls.length, 0);
  const saved = userStore.get();
  assert.equal(saved.subsidy_state, 'failed');
  assert.equal(saved.subsidy_error, 'not enough balance');
  assert.equal(saved.sync_state, 'failed');
  store.close();
});

test('retryUserIdentitySubsidy re-claims the subsidy and clears the error', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );
  assert.equal(userStore.get().subsidy_state, 'failed');

  const result = await retryUserIdentitySubsidy(userStore, baseDeps(pinMock));
  assert.equal(result.success, true);
  assert.equal(result.subsidy.success, true);
  assert.equal(userStore.get().subsidy_state, 'claimed');
  assert.equal(userStore.get().subsidy_error, null);
  // Retry subsidy alone never writes pins.
  assert.equal(pinMock.calls.length, 0);
  store.close();
});

test('resumeUserIdentitySetup claims subsidy then publishes only missing pins', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );
  assert.equal(userStore.get().subsidy_state, 'failed');
  assert.equal(pinMock.calls.length, 0);

  const resumeMock = makePinMock();
  const resumed = await resumeUserIdentitySetup(userStore, baseDeps(resumeMock));
  assert.equal(resumed.subsidy.success, true);
  assert.equal(resumed.chainSync.success, true);
  assert.equal(userStore.get().subsidy_state, 'claimed');
  assert.equal(userStore.get().chat_public_key_pin_id, 'pin-2');
  assert.equal(userStore.get().name_pin_id, 'pin-1');
  assert.equal(userStore.get().sync_state, 'synced');
  assert.deepEqual(resumeMock.calls.map((c) => c.metaidData.path), ['/info/name', '/info/chatpubkey']);
  store.close();
});

test('resumeUserIdentitySetup only republishes pins that are still missing', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock({ failOn: ['/info/name'] });
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(pinMock));
  // name failed (no avatar supplied); chatpubkey succeeded.
  assert.equal(userStore.get().name_pin_id, null);
  assert.equal(userStore.get().avatar_pin_id, null);
  assert.equal(userStore.get().chat_public_key_pin_id, 'pin-2');

  const retryMock = makePinMock();
  const resumed = await resumeUserIdentitySetup(userStore, baseDeps(retryMock));
  assert.equal(resumed.success, true);
  assert.equal(resumed.chainSync.success, true);
  assert.deepEqual(retryMock.calls.map((c) => c.metaidData.path), ['/info/name']);
  assert.equal(userStore.get().name_pin_id, 'pin-1');
  store.close();
});

test('updateUserIdentityName rejects with SUBSIDY_NOT_CLAIMED when subsidy failed', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );
  assert.equal(userStore.get().subsidy_state, 'failed');

  const result = await updateUserIdentityName(userStore, { name: 'Bob' }, baseDeps(pinMock));
  assert.equal(result.success, false);
  assert.equal(result.error, 'SUBSIDY_NOT_CLAIMED');
  assert.equal(pinMock.calls.length, 0);
  assert.equal(userStore.get().name, 'Alice');
  store.close();
});

test('retryChainSync (resume) still reports failure when subsidy cannot be claimed', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );

  const resumed = await resumeUserIdentitySetup(userStore, {
    ...baseDeps(pinMock),
    requestSubsidy: async () => ({ success: false, error: 'still not enough balance' }),
  });
  assert.equal(resumed.subsidy.success, false);
  assert.equal(resumed.chainSync.success, false);
  assert.equal(userStore.get().subsidy_state, 'failed');
  assert.equal(pinMock.calls.length, 0);
  store.close();
});

// ---------------------------------------------------------------------------
// Deferred subsidy (silent first-run provisioning) + adoption confirmation
// ---------------------------------------------------------------------------

const countingSubsidy = () => {
  const counter = { calls: 0 };
  const requestSubsidy = async () => {
    counter.calls += 1;
    return { success: true };
  };
  return { counter, requestSubsidy };
};

const createDeferredIdentity = async (userStore) =>
  createUserIdentity(userStore, { name: 'User' }, baseDeps(makePinMock()), { deferChainSync: true, deferSubsidy: true });

test('createUserIdentity with deferSubsidy claims nothing and publishes nothing', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const { counter, requestSubsidy } = countingSubsidy();
  const result = await createUserIdentity(
    userStore,
    { name: 'User' },
    { ...baseDeps(pinMock), requestSubsidy },
    { deferChainSync: true, deferSubsidy: true },
  );
  assert.equal(result.success, true);
  assert.equal(result.subsidy, undefined);
  assert.equal(result.chainSync, undefined);
  assert.equal(counter.calls, 0, 'no gas subsidy for an identity the user may discard');
  assert.equal(pinMock.calls.length, 0, 'no on-chain pins');
  const saved = userStore.get();
  assert.equal(saved.subsidy_state, 'pending');
  assert.equal(saved.subsidy_error, null);
  assert.equal(saved.sync_state, 'pending');
  assert.equal(saved.sync_error, null);
  assert.ok(saved.mnemonic && saved.mvc_address && saved.globalmetaid, 'fully signable immediately');
  store.close();
});

test('confirmDeferredUserIdentitySetup funds and publishes a deferred identity exactly once', async () => {
  const { store, userStore } = await makeStores();
  await createDeferredIdentity(userStore);
  const pinMock = makePinMock();
  const { counter, requestSubsidy } = countingSubsidy();
  const deps = { ...baseDeps(pinMock), requestSubsidy };

  const confirmed = await confirmDeferredUserIdentitySetup(userStore, deps);
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.subsidy.success, true);
  assert.equal(confirmed.chainSync.success, true);
  assert.equal(counter.calls, 1);
  assert.deepEqual(pinMock.calls.map((c) => c.metaidData.path), ['/info/name', '/info/chatpubkey']);
  assert.equal(userStore.get().subsidy_state, 'claimed');
  assert.equal(userStore.get().sync_state, 'synced');

  // Every later adoption signal is a no-op.
  assert.equal(await confirmDeferredUserIdentitySetup(userStore, deps), null);
  assert.equal(counter.calls, 1);
  assert.equal(pinMock.calls.length, 2);
  store.close();
});

test('confirmDeferredUserIdentitySetup is a no-op without an identity or for regularly created ones', async () => {
  const { store, userStore } = await makeStores();
  assert.equal(await confirmDeferredUserIdentitySetup(userStore, baseDeps(makePinMock())), null, 'logged out');
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(makePinMock()));
  assert.equal(userStore.get().subsidy_state, 'claimed');
  const { counter, requestSubsidy } = countingSubsidy();
  assert.equal(await confirmDeferredUserIdentitySetup(userStore, { ...baseDeps(makePinMock()), requestSubsidy }), null);
  assert.equal(counter.calls, 0);
  store.close();
});

test('confirmDeferredUserIdentitySetup leaves the usual retryable failed state when the claim fails', async () => {
  const { store, userStore } = await makeStores();
  await createDeferredIdentity(userStore);
  const pinMock = makePinMock();
  const confirmed = await confirmDeferredUserIdentitySetup(userStore, {
    ...baseDeps(pinMock),
    requestSubsidy: async () => ({ success: false, error: 'faucet dry' }),
  });
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.subsidy.success, false);
  assert.equal(pinMock.calls.length, 0);
  assert.equal(userStore.get().subsidy_state, 'failed');
  assert.equal(userStore.get().sync_state, 'failed');
  // The Settings retry recovers it like any failed claim.
  const retried = await retryUserIdentitySubsidy(userStore, baseDeps(makePinMock()));
  assert.equal(retried.subsidy.success, true);
  assert.equal(userStore.get().subsidy_state, 'claimed');
  store.close();
});

test('updateUserIdentityName on a deferred identity funds it, pins the chat key, then publishes only the NEW name', async () => {
  const { store, userStore } = await makeStores();
  await createDeferredIdentity(userStore);
  const pinMock = makePinMock();
  const { counter, requestSubsidy } = countingSubsidy();
  const result = await updateUserIdentityName(userStore, { name: 'Alice' }, { ...baseDeps(pinMock), requestSubsidy });
  assert.equal(result.success, true);
  assert.equal(counter.calls, 1);
  const pins = pinMock.calls.map((c) => ({ path: c.metaidData.path, payload: c.metaidData.payload }));
  assert.deepEqual(pins.map((p) => p.path), ['/info/chatpubkey', '/info/name']);
  assert.equal(pins[1].payload, 'Alice', 'the placeholder name is never published');
  const saved = userStore.get();
  assert.equal(saved.name, 'Alice');
  assert.equal(saved.subsidy_state, 'claimed');
  assert.equal(saved.sync_state, 'synced');
  assert.equal(saved.chat_public_key_pin_id, 'pin-1');
  assert.equal(saved.name_pin_id, 'pin-2');
  store.close();
});

test('updateUserIdentityName on a deferred identity reports SUBSIDY_NOT_CLAIMED when funding fails', async () => {
  const { store, userStore } = await makeStores();
  await createDeferredIdentity(userStore);
  const pinMock = makePinMock();
  const result = await updateUserIdentityName(userStore, { name: 'Alice' }, {
    ...baseDeps(pinMock),
    requestSubsidy: async () => ({ success: false, error: 'faucet dry' }),
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'SUBSIDY_NOT_CLAIMED');
  assert.equal(pinMock.calls.length, 0);
  assert.equal(userStore.get().name, 'User');
  assert.equal(userStore.get().subsidy_state, 'failed');
  store.close();
});

test('updateUserIdentityName stays partial when the chat-key pin of a deferred identity fails', async () => {
  const { store, userStore } = await makeStores();
  await createDeferredIdentity(userStore);
  const pinMock = makePinMock({ failOn: ['/info/chatpubkey'] });
  const result = await updateUserIdentityName(userStore, { name: 'Alice' }, baseDeps(pinMock));
  assert.equal(result.success, true, 'the rename itself still lands');
  const saved = userStore.get();
  assert.equal(saved.name, 'Alice');
  assert.equal(saved.chat_public_key_pin_id, null);
  assert.equal(saved.sync_state, 'partial', 'Settings keeps the retry path for the missing chat-key pin');
  store.close();
});


const USER_NFT_ITEM = `${'cd'.repeat(32)}i0`;
const USER_NFT_OWNER = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const USER_NFT_REFERENCE = `nft://mrc721/${USER_NFT_ITEM}?owner=${encodeURIComponent(USER_NFT_OWNER)}&metaid=idq1usernft0example`;

function insertIdentityForAvatar(userStore) {
  return userStore.insert({
    mnemonic: TEST_MNEMONIC,
    mvc_address: USER_NFT_OWNER,
    btc_address: 'btc-user',
    doge_address: 'doge-user',
    public_key: 'public-key',
    chat_public_key: 'chat-key',
    chat_public_key_pin_id: 'chat-pin',
    metaid: 'metaid-user',
    globalmetaid: 'idq1usernft0example',
    name: 'NFT User',
    avatar: null,
    subsidy_state: 'claimed',
    name_pin_id: 'name-pin',
    avatar_pin_id: null,
    sync_state: 'synced',
  });
}

test('user NFT avatar publishes cover + declaration once, then clears the declaration for a plain avatar', async () => {
  const context = await makeStores();
  const { userStore } = context;
  try {
    insertIdentityForAvatar(userStore);
    const pinMock = makePinMock();
    const prepared = {
      reference: USER_NFT_REFERENCE,
      avatarUrl: AVATAR_DATA_URL,
      declarationPayload: JSON.stringify({ protocol: 'mrc721', itemPinId: USER_NFT_ITEM, ownerAddress: USER_NFT_OWNER }),
      nft: { itemPinId: USER_NFT_ITEM, ownerAddress: USER_NFT_OWNER, ownershipVerified: true },
    };
    const deps = { ...baseDeps(pinMock), prepareNftAvatar: async () => prepared };

    const result = await updateUserIdentityAvatar(userStore, { avatar: USER_NFT_REFERENCE }, deps);
    assert.equal(result.success, true);
    assert.deepEqual(pinMock.calls.map((call) => call.metaidData.path), ['/info/avatar', '/info/nftAvatar']);
    assert.equal(userStore.get().avatar, USER_NFT_REFERENCE);
    assert.equal(userStore.get().avatar_fallback, AVATAR_DATA_URL);
    assert.equal(userStore.get().nft_avatar_synced_reference, USER_NFT_REFERENCE);
    assert.equal(userStore.get().nft_avatar_pin_id, 'pin-2');

    const noOp = await updateUserIdentityAvatar(userStore, { avatar: USER_NFT_REFERENCE }, deps);
    assert.equal(noOp.success, true);
    assert.equal(pinMock.calls.length, 2, 'an already synced NFT avatar must not republish');

    const plain = await updateUserIdentityAvatar(userStore, { avatar: AVATAR_DATA_URL }, deps);
    assert.equal(plain.success, true);
    assert.deepEqual(pinMock.calls.slice(2).map((call) => call.metaidData.path), ['/info/avatar', '/info/nftAvatar']);
    assert.equal(pinMock.calls[3].metaidData.payload, '');
    assert.equal(userStore.get().avatar, AVATAR_DATA_URL);
    assert.equal(userStore.get().nft_avatar_synced_reference, '');
  } finally {
    disposeStores(context);
  }
});

test('user NFT avatar rejects a failed ownership check before staging or publishing', async () => {
  const context = await makeStores();
  const { userStore } = context;
  try {
    const before = insertIdentityForAvatar(userStore);
    const pinMock = makePinMock();
    const result = await updateUserIdentityAvatar(
      userStore,
      { avatar: USER_NFT_REFERENCE },
      {
        ...baseDeps(pinMock),
        prepareNftAvatar: async () => { throw new Error('NFT_AVATAR_NOT_OWNED'); },
      },
    );
    assert.equal(result.success, false);
    assert.equal(result.error, 'NFT_AVATAR_NOT_OWNED');
    assert.equal(pinMock.calls.length, 0);
    assert.equal(userStore.get().avatar, before.avatar);
  } finally {
    disposeStores(context);
  }
});

test('user identity import restores NFT reference, cover fallback, and declaration sync state', async () => {
  const context = await makeStores();
  const { userStore } = context;
  try {
    const wallet = await createMetaBotWallet({ mnemonic: TEST_MNEMONIC });
    const pinMock = makePinMock();
    const result = await importUserIdentity(
      userStore,
      { mnemonic: TEST_MNEMONIC },
      {
        ...baseDeps(pinMock),
        fetchProfile: async () => ({
          name: 'NFT User',
          avatarDataUrl: AVATAR_DATA_URL,
          nftAvatarReference: USER_NFT_REFERENCE,
          nftAvatarPinId: 'nft-declaration-pin',
          metabotInfoPinId: null,
          chatpubkeyPinId: 'chat-pin',
          bio: {},
          raw: { chatpubkey: wallet.chat_public_key },
        }),
      },
    );
    assert.equal(result.success, true);
    assert.equal(result.identity.avatar, USER_NFT_REFERENCE);
    assert.equal(result.identity.avatar_fallback, AVATAR_DATA_URL);
    assert.equal(result.identity.nft_avatar_pin_id, 'nft-declaration-pin');
    assert.equal(result.identity.nft_avatar_synced_reference, USER_NFT_REFERENCE);
    assert.equal(pinMock.calls.length, 0);
  } finally {
    disposeStores(context);
  }
});
