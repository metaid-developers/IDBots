/**
 * Regression suite for Batch 2 wallet & credential security hardening:
 * 1. No IDBOTS_METABOT_MNEMONIC in DSH BASH_ENV / skill envs; per-session scoped rpc-token authfiles
 * 2. Scoped session/metabot-bound RPC tokens + A2A lockdown + no client-trusted external_confirmed
 * 3. DSH fs/bash sensitive host access guard (unconditional before permissionMode/autoApprove)
 * 4. At-rest safeStorage encryption + idempotent migration for metabot_wallets & user_identity
 * 5. Gateway R-path/R-cwd rejection of sensitive userData files + nft-swap non-SQLite config path
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// fileURLToPath, NOT new URL(...).pathname: on Windows the URL pathname is
// "/C:/actions-runner/..." (leading slash before the drive letter) and
// path.resolve turns it into "C:\C:\actions-runner\..." — v1.1.3 tag run
// 45551178172 failed exactly this way. fileURLToPath yields a real OS path.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  formatPosixEnvFile,
  writeDshSkillSessionEnvFile,
  writeDshSkillSessionRpcTokenFile,
  dshSkillEnvFilePath,
  dshSkillRpcTokenFilePath,
  pruneStaleDshSkillEnvFiles,
  removeDshSkillSessionEnvFiles,
} = require('../dist-electron/main/libs/dshSkillSessionEnv.js');

const {
  getMetaidRpcToken,
  issueScopedMetaidRpcToken,
  authorizeMetaidRpcRequest,
  revokeScopedMetaidRpcTokensForSession,
  clearScopedMetaidRpcTokensForTests,
  listActiveScopedMetaidRpcTokens,
  isScopedMetaidRpcToken,
} = require('../dist-electron/main/services/metaidRpcEndpoint.js');

const {
  evaluateDshSensitiveAccess,
  isBlockedDshFilePath,
  detectSensitiveHostAccessInCommand,
} = require('../dist-electron/main/security/dshSensitiveAccessGuard.js');

const {
  MNEMONIC_ENC_PREFIX,
  setMnemonicVaultBackendForTests,
  isEncryptedMnemonic,
  encryptMnemonicAtRest,
  decryptMnemonicAtRest,
  migratePlaintextMnemonicsAtRest,
} = require('../dist-electron/main/security/mnemonicVault.js');

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
const { validateInvokeRestrictions } = require('../dist-electron/main/gateway/restrictions.js');
const { INVOKE_ALLOWLIST } = require('../dist-electron/main/gateway/allowlist.js');

function removeDirTolerant(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows CI handle tolerance
  }
}

function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  removeDirTolerant(dir);
}

// Synthetic test fixture phrase (non-BIP39 / non-real words to avoid scanner false positives)
const TEST_SEED_PHRASE_A = 'zqx-test-phrase-alpha-01 beta-02 gamma-03 delta-04 epsilon-05 zeta-06';
const TEST_SEED_PHRASE_B = 'zqx-test-phrase-omega-91 theta-92 iota-93 kappa-94 lambda-95 sigma-96';

// ---------------------------------------------------------------------------
// 1. DSH Skill Session Env & Source Contracts
// ---------------------------------------------------------------------------

test('dshSkillSessionEnv strips forbidden mnemonic/key vars and writes 0600 scoped rpc-token file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sec-b2-env-'));
  try {
    const rendered = formatPosixEnvFile({
      IDBOTS_METABOT_ID: '2',
      IDBOTS_METABOT_MNEMONIC: TEST_SEED_PHRASE_A,
      MNEMONIC: TEST_SEED_PHRASE_A,
      WALLET_MNEMONIC: TEST_SEED_PHRASE_A,
      SEED_PHRASE: TEST_SEED_PHRASE_A,
      PRIVATE_KEY: 'fake-priv',
      WIF: 'fake-wif',
      IDBOTS_RPC_URL: 'http://127.0.0.1:31200',
      IDBOTS_RPC_TOKEN: 'idbots_sess_abc123',
    });
    assert.ok(rendered.includes("IDBOTS_METABOT_ID='2'"));
    assert.ok(rendered.includes("IDBOTS_RPC_TOKEN='idbots_sess_abc123'"));
    assert.ok(!rendered.includes('IDBOTS_METABOT_MNEMONIC'));
    assert.ok(!rendered.includes('WALLET_MNEMONIC'));
    assert.ok(!rendered.includes('SEED_PHRASE'));
    assert.ok(!rendered.includes('PRIVATE_KEY'));
    assert.ok(!rendered.includes('WIF='));
    assert.ok(!rendered.includes(TEST_SEED_PHRASE_A));

    const authFile = writeDshSkillSessionRpcTokenFile(dir, 'cw-sess-1', 'idbots_sess_token_xyz');
    assert.equal(authFile, dshSkillRpcTokenFilePath(dir, 'cw-sess-1'));
    assert.equal(fs.readFileSync(authFile, 'utf8').trim(), 'idbots_sess_token_xyz');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
    }

    const envFile = writeDshSkillSessionEnvFile(dir, 'cw-sess-1', {
      IDBOTS_METABOT_ID: '2',
      IDBOTS_METABOT_MNEMONIC: TEST_SEED_PHRASE_A,
      IDBOTS_RPC_AUTHFILE: authFile,
    });
    assert.equal(envFile, dshSkillEnvFilePath(dir, 'cw-sess-1'));
    const diskContent = fs.readFileSync(envFile, 'utf8');
    assert.ok(!diskContent.includes(TEST_SEED_PHRASE_A));

    // Prune stale removes both .env and .rpc-token when older than cutoff
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(envFile, oldTime, oldTime);
    fs.utimesSync(authFile, oldTime, oldTime);
    const removed = pruneStaleDshSkillEnvFiles(dir, { activeDshSessionIds: new Set() });
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(envFile), false);
    assert.equal(fs.existsSync(authFile), false);

    // removeDshSkillSessionEnvFiles cleans up both immediately
    writeDshSkillSessionRpcTokenFile(dir, 'cw-sess-2', 'idbots_sess_temp');
    writeDshSkillSessionEnvFile(dir, 'cw-sess-2', { IDBOTS_METABOT_ID: '3' });
    removeDshSkillSessionEnvFiles(dir, 'cw-sess-2');
    assert.equal(fs.existsSync(dshSkillEnvFilePath(dir, 'cw-sess-2')), false);
    assert.equal(fs.existsSync(dshSkillRpcTokenFilePath(dir, 'cw-sess-2')), false);
  } finally {
    removeDirTolerant(dir);
  }
});

test('source contracts: main.ts, skillManager.ts, and coworkUtil.ts never leak mnemonic or master authfile to DSH', () => {
  const mainSrc = fs.readFileSync(path.join(repoRoot, 'src/main/main.ts'), 'utf8');
  const skillMgrSrc = fs.readFileSync(path.join(repoRoot, 'src/main/skillManager.ts'), 'utf8');
  const coworkUtilSrc = fs.readFileSync(path.join(repoRoot, 'src/main/libs/coworkUtil.ts'), 'utf8');

  // getSkillSessionEnvOverrides must not inject IDBOTS_METABOT_MNEMONIC and must
  // read wallet paths via non-decrypting metadata getters (so safeStorage
  // unavailability never crashes CoWork/DSH turns).
  const overridesIdx = mainSrc.indexOf('getSkillSessionEnvOverrides');
  assert.ok(overridesIdx > 0);
  const overridesSlice = mainSrc.slice(overridesIdx, overridesIdx + 5500);
  assert.ok(!overridesSlice.includes('IDBOTS_METABOT_MNEMONIC'), 'getSkillSessionEnvOverrides must not inject mnemonic');
  assert.ok(overridesSlice.includes('getMetabotWalletMetadataByMetabotId'), 'getSkillSessionEnvOverrides must use getMetabotWalletMetadataByMetabotId');
  assert.ok(overridesSlice.includes('getTwinWalletMetadata'), 'getSkillSessionEnvOverrides must use getTwinWalletMetadata');
  assert.ok(!overridesSlice.includes('getMetabotWalletByMetabotId'), 'getSkillSessionEnvOverrides must not decrypt wallet mnemonic');
  assert.ok(!overridesSlice.includes('getTwinWallet('), 'getSkillSessionEnvOverrides must not call decrypting getTwinWallet()');

  // skillManager must not inject IDBOTS_METABOT_MNEMONIC
  assert.ok(!skillMgrSrc.includes('IDBOTS_METABOT_MNEMONIC'), 'skillManager must not inject mnemonic');

  // coworkUtil must not inject master getMetaidRpcTokenFilePath into shared DSH child env
  assert.ok(!coworkUtilSrc.includes('getMetaidRpcTokenFilePath'), 'coworkUtil must not inject master RPC authfile into DSH child env');
});

// ---------------------------------------------------------------------------
// 2. Scoped RPC Tokens + Real HTTP metaidRpcServer Enforcement
// ---------------------------------------------------------------------------

test('scoped RPC tokens issue, authorize, scope, list, expire, and revoke cleanly', () => {
  clearScopedMetaidRpcTokensForTests();
  try {
    const master = 'test-master-token-batch2';
    const stdToken = issueScopedMetaidRpcToken({
      sessionId: 'sess-std-1',
      metabotId: 2,
      sessionType: 'standard',
      nowMs: 1_000_000,
      ttlMs: 120_000,
    });
    const a2aToken = issueScopedMetaidRpcToken({
      sessionId: 'sess-a2a-1',
      metabotId: 2,
      sessionType: 'a2a',
      nowMs: 1_000_000,
      ttlMs: 120_000,
    });
    assert.equal(isScopedMetaidRpcToken(stdToken), true);
    assert.equal(isScopedMetaidRpcToken(master), false);
    assert.notEqual(stdToken, a2aToken);

    assert.deepEqual(authorizeMetaidRpcRequest(`Bearer ${master}`, master, 1_000_500), {
      authorized: true,
      scope: 'master',
    });
    assert.deepEqual(authorizeMetaidRpcRequest(`Bearer ${stdToken}`, master, 1_000_500), {
      authorized: true,
      scope: 'session',
      sessionId: 'sess-std-1',
      metabotId: 2,
      sessionType: 'standard',
    });
    assert.deepEqual(authorizeMetaidRpcRequest(`Bearer ${a2aToken}`, master, 1_000_500), {
      authorized: true,
      scope: 'session',
      sessionId: 'sess-a2a-1',
      metabotId: 2,
      sessionType: 'a2a',
    });

    const active = listActiveScopedMetaidRpcTokens(1_000_500);
    assert.ok(active.includes(stdToken));
    assert.ok(active.includes(a2aToken));

    // Revocation
    revokeScopedMetaidRpcTokensForSession('sess-std-1');
    assert.equal(authorizeMetaidRpcRequest(`Bearer ${stdToken}`, master, 1_000_500).authorized, false);

    // Expiration
    assert.equal(authorizeMetaidRpcRequest(`Bearer ${a2aToken}`, master, 1_200_000).authorized, false);
  } finally {
    clearScopedMetaidRpcTokensForTests();
  }
});

test('metaidRpcServer enforces scoped metabot_id binding, A2A route lockdown, and rejects client external_confirmed bypass', async () => {
  clearScopedMetaidRpcTokensForTests();
  process.env.IDBOTS_RPC_TOKEN = 'test-master-rpc-token-batch2-http';
  const masterToken = getMetaidRpcToken();

  const MVC_ADDR_1 = '1TwinMvcAddr1111111111111111111111';
  const MVC_ADDR_2 = '1WorkerMvcAddr22222222222222222222';
  const EXTERNAL_ADDR = '1AttackerExternalAddr3333333333333';

  const metabotStore = {
    getMetabotById(id) {
      if (id !== 1 && id !== 2) return null;
      return {
        id,
        name: id === 1 ? 'Twin' : 'Worker',
        mvc_address: id === 1 ? MVC_ADDR_1 : MVC_ADDR_2,
        btc_address: `1BtcAddr${id}`,
        doge_address: `DDogeAddr${id}`,
        public_key: 'pk',
      };
    },
    listMetabots() {
      return [
        { id: 1, mvc_address: MVC_ADDR_1, btc_address: '1BtcAddr1', doge_address: 'DDogeAddr1' },
        { id: 2, mvc_address: MVC_ADDR_2, btc_address: '1BtcAddr2', doge_address: 'DDogeAddr2' },
      ];
    },
  };

  const kv = new Map([
    ['nft_swap_pilot_config', JSON.stringify({ collectionSlug: 'demo', issuerAddress: MVC_ADDR_1 })],
  ]);
  const sqlStore = {
    get: (key) => kv.get(key),
    set: (key, val) => kv.set(key, val),
    getDatabase() {
      return {
        run(sql) {
          if (/CREATE (TABLE|INDEX)|INSERT INTO bot_wallet_transfers/i.test(String(sql))) return;
        },
        exec() {
          return [];
        },
      };
    },
    getSaveFunction() {
      return () => {};
    },
  };

  let transferCalledCount = 0;
  const originalLoad = Module._load;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-rpc-b2-'));
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: () => dir,
          getAppPath: () => repoRoot,
        },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    if (request === './transferService') {
      return {
        executeTransfer: async () => {
          transferCalledCount += 1;
          return { success: true, txId: 'f'.repeat(64) };
        },
      };
    }
    if (request === './walletTransferService') {
      return {
        executeWalletMvcTransfer: async (_deps, params) => {
          if (params.to === EXTERNAL_ADDR && params.externalConfirmed !== true) {
            return {
              success: false,
              code: 'external_confirmation_required',
              error: 'External address requires explicit owner confirmation',
            };
          }
          transferCalledCount += 1;
          return {
            success: true,
            txid: 'e'.repeat(64),
            fee_sats: 300,
            channel: params.to === EXTERNAL_ADDR ? 'external' : 'local',
            to_metabot_id: params.to === MVC_ADDR_1 ? 1 : null,
            audit_id: 1,
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let server;
  try {
    const serverPath = require.resolve('../dist-electron/main/services/metaidRpcServer.js');
    delete require.cache[serverPath];
    const { startMetaidRpcServer } = require(serverPath);
    server = startMetaidRpcServer(() => metabotStore, () => sqlStore, () => null, { port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const workerStdToken = issueScopedMetaidRpcToken({
      sessionId: 'cw-worker-2',
      metabotId: 2,
      sessionType: 'standard',
    });
    const workerA2aToken = issueScopedMetaidRpcToken({
      sessionId: 'cw-a2a-2',
      metabotId: 2,
      sessionType: 'a2a',
    });

    const post = async (pathname, token, body) => {
      const res = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };

    // 1. Cross-bot impersonation blocked: Worker (2) cannot spend Twin (1)
    const crossBot = await post('/api/idbots/wallet/mvc/transfer', workerStdToken, {
      metabot_id: 1,
      to: MVC_ADDR_2,
      amount_sats: 1000,
    });
    assert.equal(crossBot.status, 403);
    assert.match(String(crossBot.json.error), /metabot_id_mismatch/);
    assert.equal(transferCalledCount, 0);

    // 2. Client-supplied external_confirmed: true is IGNORED for scoped session tokens
    const externalBypass = await post('/api/idbots/wallet/mvc/transfer', workerStdToken, {
      metabot_id: 2,
      to: EXTERNAL_ADDR,
      amount_sats: 1000,
      external_confirmed: true,
    });
    assert.equal(externalBypass.status, 400);
    assert.equal(externalBypass.json.code, 'external_confirmation_required');
    assert.equal(transferCalledCount, 0);

    // 3. Legacy /api/idbots/wallet/transfer blocks external address for scoped session tokens
    const legacyExt = await post('/api/idbots/wallet/transfer', workerStdToken, {
      metabot_id: 2,
      chain: 'mvc',
      to_address: EXTERNAL_ADDR,
      amount: '0.01',
    });
    assert.equal(legacyExt.status, 403);
    assert.match(String(legacyExt.json.error), /external_transfer_not_allowed_via_session_rpc/);
    assert.equal(transferCalledCount, 0);

    // 4. Local bot-to-bot transfer from own metabot_id still works for standard session token
    const localOk = await post('/api/idbots/wallet/mvc/transfer', workerStdToken, {
      metabot_id: 2,
      to: MVC_ADDR_1,
      amount_sats: 1000,
    });
    assert.equal(localOk.status, 200);
    assert.equal(localOk.json.success, true);
    assert.equal(transferCalledCount, 1);

    // 5. A2A token is blocked across financial, signing, private-chat, memory, and FT routes
    for (const blockedPath of [
      '/api/idbots/wallet/mvc/transfer',
      '/api/idbots/wallet/transfer',
      '/api/idbots/wallet/btc/sign-psbt',
      '/api/idbots/wallet/mvc/build-transfer-rawtx',
      '/api/idbots/chat/private-send',
      '/api/idbots/chat/private-history',
      '/api/idbots/memory/list',
      '/api/idbots/commerce/ft-escrow/buy',
      '/api/metaid/paybuzz/publish',
    ]) {
      const a2aResp = await post(blockedPath, workerA2aToken, { metabot_id: 2 });
      assert.equal(a2aResp.status, 403, `A2A token must get 403 on ${blockedPath}`);
      assert.match(String(a2aResp.json.error), /a2a_session_forbidden/);
    }

    // 6. Safe non-secret nft-swap-pilot config endpoint works over scoped token
    const cfgRes = await fetch(`${baseUrl}/api/metaid/config/nft-swap-pilot`, {
      headers: { Authorization: `Bearer ${workerStdToken}` },
    });
    assert.equal(cfgRes.status, 200);
    const cfgJson = await cfgRes.json();
    assert.equal(cfgJson.success, true);
    assert.equal(cfgJson.config.collectionSlug, 'demo');

    // 7. Master token retains backward-compatible behavior
    const masterOk = await post('/api/idbots/wallet/mvc/transfer', masterToken, {
      metabot_id: 1,
      to: EXTERNAL_ADDR,
      amount_sats: 1000,
      external_confirmed: true,
    });
    assert.equal(masterOk.status, 200);
    assert.equal(masterOk.json.success, true);
  } finally {
    Module._load = originalLoad;
    clearScopedMetaidRpcTokensForTests();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    removeDirTolerant(dir);
  }
});

// ---------------------------------------------------------------------------
// 3. DSH Sensitive Host Access Guard
// ---------------------------------------------------------------------------

test('dshSensitiveAccessGuard blocks fs & bash access to wallet DBs, RPC tokens, and session envs', () => {
  const userData = '/Users/demo/Library/Application Support/IDBots';
  const cwd = '/Users/demo/workspace';

  // File tools blocked
  assert.equal(
    evaluateDshSensitiveAccess({
      toolName: 'read',
      toolInput: { file_path: `${userData}/idbots.sqlite` },
      cwd,
      userDataPath: userData,
    }).blocked,
    true,
  );
  assert.equal(
    evaluateDshSensitiveAccess({
      toolName: 'read',
      toolInput: { file_path: `${userData}/metaid-rpc-token` },
      cwd,
      userDataPath: userData,
    }).blocked,
    true,
  );
  assert.equal(
    evaluateDshSensitiveAccess({
      toolName: 'read',
      toolInput: { file_path: `${userData}/dsh-skill-env/cw-other.env` },
      cwd,
      userDataPath: userData,
    }).blocked,
    true,
  );
  assert.equal(
    evaluateDshSensitiveAccess({
      toolName: 'read',
      toolInput: { file_path: '/Users/demo/.ssh/id_ed25519' },
      cwd,
      userDataPath: userData,
    }).blocked,
    true,
  );

  // Normal workspace file allowed
  assert.equal(
    evaluateDshSensitiveAccess({
      toolName: 'read',
      toolInput: { file_path: `${cwd}/README.md` },
      cwd,
      userDataPath: userData,
    }).blocked,
    false,
  );

  // Bash commands blocked
  for (const cmd of [
    `sqlite3 "${userData}/idbots.sqlite" "SELECT mnemonic FROM metabot_wallets"`,
    `cat "${userData}/metaid-rpc-token"`,
    `cat "${userData}/dsh-skill-env/cw-1.env"`,
    'echo $IDBOTS_RPC_TOKEN',
    'cat "$IDBOTS_RPC_AUTHFILE"',
    'printenv IDBOTS_METABOT_MNEMONIC',
    'security find-generic-password -s "IDBots Safe Storage"',
    'cat ~/.ssh/id_rsa',
  ]) {
    const verdict = evaluateDshSensitiveAccess({
      toolName: 'bash',
      toolInput: { command: cmd },
      cwd,
      userDataPath: userData,
    });
    assert.equal(verdict.blocked, true, `expected bash command to be blocked: ${cmd}`);
  }

  // A2A blocks raw env dump, standard allows normal commands
  assert.equal(
    detectSensitiveHostAccessInCommand('printenv', { sessionType: 'a2a' }).matched,
    true,
  );
  assert.equal(
    evaluateDshSensitiveAccess({
      toolName: 'bash',
      toolInput: { command: 'node "$SKILLS_ROOT/metabot-post-buzz/scripts/index.js" --text "hello"' },
      cwd,
      userDataPath: userData,
      sessionType: 'standard',
    }).blocked,
    false,
  );

  // Relative path resolving into userData sqlite also blocked
  assert.equal(isBlockedDshFilePath('../Library/Application Support/IDBots/idbots.sqlite-wal', '/Users/demo/workspace', userData), true);
});

// ---------------------------------------------------------------------------
// 4. At-Rest Mnemonic Encryption & Idempotent Migration
// ---------------------------------------------------------------------------

test('mnemonicVault encrypts metabot_wallets & user_identity at rest and migrates legacy plaintext rows idempotently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-vault-b2-'));
  const sqliteStore = await SqliteStore.create(dir);

  // Reversible XOR-with-nonce mock safeStorage backend (proves randomized ciphertext + decrypt)
  let counter = 0;
  const mockSafeStorage = {
    available: true,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(plain) {
      counter += 1;
      const key = (counter & 0x7f) || 1;
      const raw = Buffer.from(plain, 'utf8');
      const out = Buffer.alloc(raw.length + 1);
      out[0] = key;
      for (let i = 0; i < raw.length; i += 1) {
        out[i + 1] = raw[i] ^ key;
      }
      return out;
    },
    decryptString(buf) {
      const key = buf[0];
      const out = Buffer.alloc(buf.length - 1);
      for (let i = 1; i < buf.length; i += 1) {
        out[i - 1] = buf[i] ^ key;
      }
      return out.toString('utf8');
    },
  };

  try {
    const db = sqliteStore.getDatabase();
    const save = sqliteStore.getSaveFunction();
    const metabotStore = new MetabotStore(db, save);
    const userIdentityStore = new UserIdentityStore(db, save);

    // Phase A: simulate legacy plaintext rows inserted before encryption existed
    setMnemonicVaultBackendForTests({ ...mockSafeStorage, isEncryptionAvailable: () => false });
    const legacyWallet = metabotStore.insertMetabotWallet({ mnemonic: TEST_SEED_PHRASE_A });
    const rawLegacyRow = db.exec('SELECT mnemonic FROM metabot_wallets WHERE id = ?', [legacyWallet.id])[0].values[0][0];
    assert.equal(rawLegacyRow, TEST_SEED_PHRASE_A);
    assert.equal(isEncryptedMnemonic(rawLegacyRow), false);

    userIdentityStore.insert({
      mnemonic: TEST_SEED_PHRASE_B,
      mvc_address: '1UserMvc',
      btc_address: '1UserBtc',
      doge_address: 'DUserDoge',
      public_key: 'user-pk',
      chat_public_key: 'user-chat-pk',
      metaid: 'user-metaid',
      name: 'Owner',
    });
    const rawLegacyUser = db.exec('SELECT mnemonic FROM user_identity WHERE id = 1')[0].values[0][0];
    assert.equal(rawLegacyUser, TEST_SEED_PHRASE_B);

    // Migration skipped when encryption unavailable
    const skipped = migratePlaintextMnemonicsAtRest(db, save);
    assert.equal(skipped.skipped, true);

    // Phase B: enable OS encryption and run migration
    setMnemonicVaultBackendForTests(mockSafeStorage);
    const migrated = migratePlaintextMnemonicsAtRest(db, save);
    assert.equal(migrated.skipped, false);
    assert.equal(migrated.encryptedWallets, 1);
    assert.equal(migrated.encryptedUserIdentity, 1);

    // On-disk SQLite rows are now ciphertext, not plaintext
    const encWalletRow = db.exec('SELECT mnemonic FROM metabot_wallets WHERE id = ?', [legacyWallet.id])[0].values[0][0];
    const encUserRow = db.exec('SELECT mnemonic FROM user_identity WHERE id = 1')[0].values[0][0];
    assert.ok(String(encWalletRow).startsWith(MNEMONIC_ENC_PREFIX));
    assert.ok(!String(encWalletRow).includes(TEST_SEED_PHRASE_A));
    assert.ok(String(encUserRow).startsWith(MNEMONIC_ENC_PREFIX));
    assert.ok(!String(encUserRow).includes(TEST_SEED_PHRASE_B));

    // Store reads transparently decrypt
    assert.equal(metabotStore.getMetabotWalletById(legacyWallet.id)?.mnemonic, TEST_SEED_PHRASE_A);
    assert.equal(metabotStore.getMetabotWalletByMnemonic(TEST_SEED_PHRASE_A)?.id, legacyWallet.id);
    assert.equal(metabotStore.getMetabotWalletByMnemonicNormalized(TEST_SEED_PHRASE_A.toUpperCase())?.id, legacyWallet.id);
    assert.deepEqual(metabotStore.listAllMetabotWalletMnemonics(), [TEST_SEED_PHRASE_A]);
    assert.equal(userIdentityStore.get()?.mnemonic, TEST_SEED_PHRASE_B);

    // Second migration run is completely idempotent
    const secondRun = migratePlaintextMnemonicsAtRest(db, save);
    assert.equal(secondRun.skipped, false);
    assert.equal(secondRun.encryptedWallets, 0);
    assert.equal(secondRun.encryptedUserIdentity, 0);

    // Append-only trigger on metabot_wallets must remain active after migration
    assert.throws(
      () => db.run('UPDATE metabot_wallets SET path = ? WHERE id = ?', ['m/0/0', legacyWallet.id]),
      /append-only/i,
    );

    // Newly inserted wallet is encrypted immediately on write
    const enc = encryptMnemonicAtRest(TEST_SEED_PHRASE_B);
    assert.ok(enc.startsWith(MNEMONIC_ENC_PREFIX));
    assert.equal(decryptMnemonicAtRest(enc), TEST_SEED_PHRASE_B);
    assert.equal(encryptMnemonicAtRest(enc), enc, 'encryptMnemonicAtRest must be idempotent');

    // Phase C: simulate Electron safeStorage decryption becoming unavailable
    // (e.g. Keychain locked or signature mismatch between dev Electron and packaged IDBots.app)
    const twinBot = metabotStore.createMetabot({
      name: 'TwinBot',
      metabot_type: 'twin',
      created_by: 'local',
      wallet_id: legacyWallet.id,
      mvc_address: '1TwinMvc',
      btc_address: '1TwinBtc',
      doge_address: 'DTwinDoge',
      public_key: 'twin-pk',
      chat_public_key: 'twin-chat-pk',
      metaid: 'twin-metaid',
      role: 'twin',
      soul: 'soul',
      llm_id: 'deepseek-chat',
    });
    assert.ok(twinBot);

    let decryptCalls = 0;
    setMnemonicVaultBackendForTests({
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('Encryption is not available');
      },
      decryptString: () => {
        decryptCalls += 1;
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.');
      },
    });

    // Non-decrypting metadata/public getters succeed without touching safeStorage.decryptString
    const metaById = metabotStore.getMetabotWalletMetadataById(legacyWallet.id);
    assert.deepEqual(metaById, {
      id: legacyWallet.id,
      path: legacyWallet.path,
      created_at: legacyWallet.created_at,
    });
    const metaByBot = metabotStore.getMetabotWalletMetadataByMetabotId(twinBot.id);
    assert.deepEqual(metaByBot, {
      id: legacyWallet.id,
      path: legacyWallet.path,
      created_at: legacyWallet.created_at,
    });
    const twinMeta = metabotStore.getTwinWalletMetadata();
    assert.deepEqual(twinMeta, {
      id: twinBot.id,
      name: 'TwinBot',
      path: legacyWallet.path,
    });

    const publicUser = userIdentityStore.getPublic();
    assert.ok(publicUser);
    assert.equal(publicUser.name, 'Owner');
    assert.equal(publicUser.mvc_address, '1UserMvc');
    assert.equal('mnemonic' in publicUser, false, 'getPublic() must not expose mnemonic');
    assert.equal(decryptCalls, 0, 'metadata/public getters must never invoke safeStorage.decryptString');

    // Decrypting getters still fail closed with an actionable error when decryption is unavailable
    assert.throws(
      () => decryptMnemonicAtRest(enc),
      /safeStorage\.decryptString.*Decryption is not available.*Keychain/i,
    );
    assert.throws(
      () => metabotStore.getMetabotWalletByMetabotId(twinBot.id),
      /safeStorage\.decryptString.*Decryption is not available/i,
    );
    assert.throws(
      () => userIdentityStore.get(),
      /safeStorage\.decryptString.*Decryption is not available/i,
    );
  } finally {
    setMnemonicVaultBackendForTests(null);
    disposeStore(sqliteStore, dir);
  }
});

// ---------------------------------------------------------------------------
// 5. Gateway R-path Protection & nft-swap Non-SQLite Config
// ---------------------------------------------------------------------------

test('gateway R-path rejects idbots.sqlite, metaid-rpc-token, and dsh-skill-env even inside dataRoots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-gw-b2-'));
  try {
    const userData = path.join(dir, 'userData');
    const workspace = path.join(dir, 'workspace');
    const uploads = path.join(workspace, 'uploads');
    fs.mkdirSync(path.join(userData, 'dsh-skill-env'), { recursive: true });
    fs.mkdirSync(uploads, { recursive: true });
    const safeFile = path.join(workspace, 'notes.txt');
    fs.writeFileSync(safeFile, 'hello', 'utf8');

    const paths = {
      dataRoot: workspace,
      dataRoots: [userData],
      workspaceRoot: workspace,
      uploadsRoot: uploads,
    };

    const readEntry = INVOKE_ALLOWLIST['fs:readTextFile'];
    assert.ok(readEntry, 'fs:readTextFile must remain in frozen allowlist');

    // Safe workspace file allowed
    assert.equal(validateInvokeRestrictions('fs:readTextFile', [{ filePath: safeFile }], readEntry, paths), null);

    // Protected userData credential/DB files rejected with ARG_RESTRICTED
    for (const sensitiveTarget of [
      path.join(userData, 'idbots.sqlite'),
      path.join(userData, 'metaid-rpc-token'),
      path.join(userData, 'dsh-skill-env', 'cw-1.env'),
    ]) {
      const err = validateInvokeRestrictions('fs:readTextFile', [{ filePath: sensitiveTarget }], readEntry, paths);
      assert.ok(err, `expected gateway R-path to reject ${sensitiveTarget}`);
      assert.equal(err.code, 'ARG_RESTRICTED');
    }
  } finally {
    removeDirTolerant(dir);
  }
});

test('SKILLs/nft-swap readPilotConfig works via mirror JSON without opening idbots.sqlite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-nftswap-b2-'));
  try {
    const { readPilotConfig, PILOT_CONFIG_JSON_FILENAME } = await import(
      new URL('../SKILLs/nft-swap/cli/lib/cli-common.mjs', import.meta.url).href
    );
    const expected = {
      genesis: 'a'.repeat(40),
      codeHash: 'b'.repeat(40),
      issuerAddress: '1IssuerDemo',
    };
    fs.writeFileSync(path.join(dir, PILOT_CONFIG_JSON_FILENAME), JSON.stringify(expected), 'utf8');
    // Note: idbots.sqlite does NOT exist in `dir` at all!
    const loaded = readPilotConfig(dir);
    assert.deepEqual(loaded, expected);
  } finally {
    removeDirTolerant(dir);
  }
});
