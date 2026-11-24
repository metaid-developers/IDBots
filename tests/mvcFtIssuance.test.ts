import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { API_NET, mvc } from 'meta-contract';

import {
  MAX_MCP02_TOKEN_AMOUNT_BASE,
  buildMvcFtIssueRawTxLocally,
  buildMvcFtMintRawTxLocally,
  parseSensibleIdHex,
} from '../src/main/libs/buildMvcFtIssueRawTxWorker';
import {
  assertCompliantFtMetadata,
  ensureMvcFtIssuanceTables,
  executeMvcFtIssue,
  executeMvcFtMint,
  formatBaseSupplyToDisplay,
  listMvcFtIssuances,
  parseDisplaySupplyToBase,
  resetMvcFtIssueSessionCacheForTests,
} from '../src/main/services/mvcFtIssueService';
import { resetMvcSpendSessionStateForTests } from '../src/main/services/mvcSpendSessionState';
import { BotWalletTransferStore } from '../src/main/services/botWalletTransferStore';
import {
  MvcFtIssueConfirmationGate,
  handleMvcFtIssueRoute,
  handleMvcFtIssuedListRoute,
  handleMvcFtMintRoute,
  type MvcFtIssueGatewayDeps,
} from '../src/main/services/mvcFtIssueGatewayRoutes';
import { buildWalletAgentTools, type WalletToolsControl } from '../src/main/libs/walletAgentTools';

const ftProto = require('meta-contract/dist/mcp02/contract-proto/token.proto');

function buildSyntheticFundingUtxo(privKey: any, satoshis = 200_000) {
  const address = privKey.toAddress(API_NET.MAIN);
  const tx = new mvc.Transaction();
  tx.version = 10;
  tx.from({
    txId: '11'.repeat(32),
    outputIndex: 0,
    script: mvc.Script.buildPublicKeyHashOut(address).toHex(),
    satoshis: satoshis + 1_000,
  });
  tx.to(address, satoshis);
  return {
    address: address.toString(),
    wif: privKey.toWIF(),
    txId: tx.id as string,
    txHex: tx.uncheckedSerialize() as string,
    outputIndex: 0,
    satoshis,
  };
}

function makeFakeMetabotStore(bot: { id: number; name: string; mvcAddress: string }) {
  const row = {
    id: bot.id,
    name: bot.name,
    mvc_address: bot.mvcAddress,
    btc_address: '',
    doge_address: '',
  };
  return {
    getMetabotById: (id: number) => (id === bot.id ? row : null),
    listMetabots: () => [row],
    getMetabotWalletByMetabotId: () => null,
  } as any;
}

test('BigInt supply conversion, 64-bit signed MCP02 bounds, sensibleId parser, and compliance guard', () => {
  assert.equal(parseDisplaySupplyToBase('1000000', 8), 100_000_000_000_000n);
  assert.equal(parseDisplaySupplyToBase('0.125', 8), 12_500_000n);
  assert.equal(parseDisplaySupplyToBase('42', 0), 42n);
  assert.equal(parseDisplaySupplyToBase('1.000000000000000001', 18), 1_000_000_000_000_000_001n);
  assert.equal(parseDisplaySupplyToBase('0', 8, { allowZero: true }), 0n);

  assert.equal(formatBaseSupplyToDisplay(100_000_000_000_000n, 8), '1000000');
  assert.equal(formatBaseSupplyToDisplay('12500000', 8), '0.125');
  assert.equal(formatBaseSupplyToDisplay('42', 0), '42');

  // Exact 64-bit signed max succeeds; +1 overflows
  assert.equal(
    parseDisplaySupplyToBase(MAX_MCP02_TOKEN_AMOUNT_BASE.toString(), 0),
    MAX_MCP02_TOKEN_AMOUNT_BASE,
  );
  assert.throws(
    () => parseDisplaySupplyToBase((MAX_MCP02_TOKEN_AMOUNT_BASE + 1n).toString(), 0),
    /exceeds MCP02 64-bit signed integer limit/,
  );

  // Fractional precision overflow, scientific notation, zero without allowZero
  assert.throws(() => parseDisplaySupplyToBase('1.234', 2), /exceeding token decimals/);
  assert.throws(() => parseDisplaySupplyToBase('1e6', 8), /plain non-negative decimal string/);
  assert.throws(() => parseDisplaySupplyToBase('-5', 8), /plain non-negative decimal string/);
  assert.throws(() => parseDisplaySupplyToBase('0', 8), /must be greater than 0/);

  // Compliance guard blocks speculative financial-return phrases while allowing utility/points framing
  assert.doesNotThrow(() =>
    assertCompliantFtMetadata({
      tokenName: 'Sunny Read Credits',
      tokenSymbol: 'SREAD',
      memo: 'Pay-per-article utility voucher credits',
    }),
  );
  assert.throws(
    () =>
      assertCompliantFtMetadata({
        tokenName: `VIP \u7a33\u8d5a Coin`,
        tokenSymbol: 'VIP',
      }),
    /COMPLIANCE_VIOLATION/,
  );
});

test('Real FtManager (debug:true sCrypt verification): 0-conf genesis + fixed-supply mint locks TokenGenesis', async () => {
  const privKey = new mvc.PrivateKey();
  const funding = buildSyntheticFundingUtxo(privKey, 200_000);

  const built = await buildMvcFtIssueRawTxLocally(
    {
      senderWif: funding.wif,
      senderAddress: funding.address,
      tokenName: 'Sunny Utility Credits',
      tokenSymbol: 'SUTIL',
      decimals: 8,
      initialSupplyBase: '2100000000000000', // 21,000,000.00000000
      allowIncreaseMints: false,
      feeRate: 1,
    },
    {
      fetchFundingUtxos: async () => [
        { txId: funding.txId, outputIndex: funding.outputIndex, satoshis: funding.satoshis, height: 100 },
      ],
      fetchRawTxHex: async (txId) => {
        if (txId.toLowerCase() === funding.txId.toLowerCase()) return funding.txHex;
        throw new Error(`Unexpected raw tx fetch: ${txId}`);
      },
    },
  );

  assert.equal(built.allowIncreaseMints, false);
  assert.ok(built.genesisTxHex.length > 200);
  assert.ok(built.mintTxHex && built.mintTxHex.length > 200);
  assert.equal(built.continuationGenesisOutpoint, null);
  assert.equal(built.continuationGenesisTxHex, null);
  assert.equal(built.tokenOutputIndex, 0);
  assert.equal(built.assetKey, `mvc-ft:${built.codehash}:${built.genesis}`);

  const parsedSensible = parseSensibleIdHex(built.sensibleId);
  assert.equal(parsedSensible.genesisTxId, built.genesisTxId.toLowerCase());
  assert.equal(parsedSensible.genesisOutputIndex, 0);

  // Decode minted Token output directly from raw tx and cross-check MCP02 proto header fields
  const mintTx = new mvc.Transaction(built.mintTxHex!);
  const tokenScriptBuf = mintTx.outputs[0].script.toBuffer();
  assert.equal(String(ftProto.getQueryCodehash(tokenScriptBuf)).toLowerCase(), built.codehash);
  assert.equal(String(ftProto.getQueryGenesis(tokenScriptBuf)).toLowerCase(), built.genesis);
  assert.equal(Number(ftProto.getDecimalNum(tokenScriptBuf)), 8);
  assert.equal(BigInt(ftProto.getTokenAmount(tokenScriptBuf).toString()), 2_100_000_000_000_000n);
  assert.ok(built.minerFeeSats > 0);
  assert.ok(built.totalFeeSats > built.minerFeeSats);
});

test('Real FtManager 0-conf mintable issuance -> 0-conf follow-up mint (indexer empty) -> permanent supply lock', async () => {
  resetMvcSpendSessionStateForTests();
  resetMvcFtIssueSessionCacheForTests();

  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    ensureMvcFtIssuanceTables(db as any);

    const privKey = new mvc.PrivateKey();
    const funding = buildSyntheticFundingUtxo(privKey, 300_000);
    const metabotStore = makeFakeMetabotStore({
      id: 11,
      name: 'Bob',
      mvcAddress: funding.address,
    });
    const broadcastOrder: string[] = [];
    let originalUtxoServed = false;

    const serviceDeps = {
      getDb: () => db as any,
      metabotStore,
      getFeeRate: () => 1,
      confirmIssue: async () => true,
      buildIssueRawTx: (_store: any, params: any) =>
        buildMvcFtIssueRawTxLocally(
          {
            senderWif: funding.wif,
            senderAddress: funding.address,
            tokenName: params.tokenName,
            tokenSymbol: params.tokenSymbol,
            decimals: params.decimals,
            initialSupplyBase: params.initialSupplyBase,
            receiverAddress: params.receiverAddress,
            allowIncreaseMints: params.allowIncreaseMints,
            feeRate: params.feeRate,
            excludeOutpoints: params.excludeOutpoints,
            preferredFundingRawTxs: params.preferredFundingRawTxs,
          },
          {
            fetchFundingUtxos: async () => {
              if (!originalUtxoServed) {
                originalUtxoServed = true;
                return [{ txId: funding.txId, outputIndex: 0, satoshis: funding.satoshis, height: 101 }];
              }
              return [];
            },
            fetchRawTxHex: async (txId) => {
              if (txId.toLowerCase() === funding.txId.toLowerCase()) return funding.txHex;
              throw new Error(`Indexer lag simulated for ${txId}`);
            },
          },
        ),
      buildMintRawTx: async (_store: any, params: any) => {
        const { getMvcSpendSessionSnapshot } = await import('../src/main/services/mvcSpendSessionState');
        const snap = getMvcSpendSessionSnapshot(11);
        return buildMvcFtMintRawTxLocally(
          {
            senderWif: funding.wif,
            senderAddress: funding.address,
            sensibleId: params.sensibleId,
            amountBase: params.amountBase,
            receiverAddress: params.receiverAddress,
            allowIncreaseMints: params.allowIncreaseMints,
            feeRate: params.feeRate,
            excludeOutpoints: [...(params.excludeOutpoints ?? []), ...snap.excludeOutpoints],
            preferredFundingUtxos: snap.preferredFundingUtxos,
            preferredFundingRawTxs: params.preferredFundingRawTxs,
            knownGenesisUtxo: params.knownGenesisUtxo,
            genesisTxHexHint: params.genesisTxHexHint,
          },
          {
            // Simulate complete indexer lag: indexer knows NEITHER the unconfirmed MVC change UTXO NOR the TokenGenesis UTXO!
            fetchFundingUtxos: async () => [{ txId: funding.txId, outputIndex: 0, satoshis: funding.satoshis, height: 101 }],
            fetchGenesisUnspents: async () => [],
            fetchRawTxHex: async (txId) => {
              if (txId.toLowerCase() === funding.txId.toLowerCase()) return funding.txHex;
              throw new Error(`Indexer lag simulated for ${txId}`);
            },
          },
        );
      },
      broadcastTx: async (rawTx: string) => {
        const parsed = new mvc.Transaction(rawTx);
        broadcastOrder.push(parsed.id);
        return parsed.id;
      },
    };

    // 1. Issue mintable token: 1000.50 MPOINT (decimals=6)
    const issueOutcome = await executeMvcFtIssue(serviceDeps, {
      metabotId: 11,
      tokenName: 'MetaPoints',
      tokenSymbol: 'MPOINT',
      decimals: 6,
      initialSupply: '1000.5',
      allowIncreaseMints: true,
    });
    assert.equal(issueOutcome.status, 'broadcast');
    assert.equal(issueOutcome.success, true);
    assert.equal(broadcastOrder.length, 2);
    assert.equal(broadcastOrder[0], issueOutcome.genesisTxId);
    assert.equal(broadcastOrder[1], issueOutcome.mintTxId);

    const listedAfterIssue = listMvcFtIssuances(db as any, { metabotId: 11 });
    assert.equal(listedAfterIssue.length, 1);
    assert.equal(listedAfterIssue[0].allowIncreaseMints, true);
    assert.equal(listedAfterIssue[0].totalMintedDisplay, '1000.5');
    assert.equal(listedAfterIssue[0].continuationGenesisOutpoint, `${issueOutcome.mintTxId}:0`);

    // 2. Follow-up 0-conf mint: +250.25 MPOINT, and permanently lock supply (allowIncreaseMints=false)!
    const mintOutcome = await executeMvcFtMint(serviceDeps, {
      metabotId: 11,
      assetKey: issueOutcome.assetKey,
      amount: '250.25',
      allowIncreaseMints: false,
    });
    assert.equal(mintOutcome.status, 'broadcast');
    assert.equal(mintOutcome.success, true);
    assert.equal(broadcastOrder.length, 3);
    assert.equal(mintOutcome.allowIncreaseMints, false);
    assert.equal(mintOutcome.record?.totalMintedDisplay, '1250.75');
    assert.equal(mintOutcome.record?.allowIncreaseMints, false);
    assert.equal(mintOutcome.record?.continuationGenesisOutpoint, null);

    // 3. Attempting a 3rd mint after locking supply fails closed before touching the worker
    await assert.rejects(
      () =>
        executeMvcFtMint(serviceDeps, {
          metabotId: 11,
          assetKey: issueOutcome.assetKey,
          amount: '10',
        }),
      /FT_SUPPLY_LOCKED/,
    );
  } finally {
    db.close();
    resetMvcSpendSessionStateForTests();
    resetMvcFtIssueSessionCacheForTests();
  }
});

test('Owner confirmation gate + built-in Agent tools (wallet_token_issue, wallet_token_mint, wallet_token_issued_list)', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    ensureMvcFtIssuanceTables(db as any);
    let saveDbCount = 0;
    const transferStore = new BotWalletTransferStore(db as any, () => {
      saveDbCount += 1;
    });
    const privKey = new mvc.PrivateKey();
    const issuerAddress = privKey.toAddress(API_NET.MAIN).toString();
    const metabotStore = makeFakeMetabotStore({ id: 3, name: 'Sunny', mvcAddress: issuerAddress });

    let broadcastCount = 0;
    const fakeBuiltIssue = {
      codehash: 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7',
      genesis: 'aa'.repeat(20),
      sensibleId: `${'bb'.repeat(32)}00000000`,
      assetKey: `mvc-ft:c9cc7bbd1010b44873959a8b1a2bcedeb62302b7:${'aa'.repeat(20)}`,
      issuerAddress,
      receiverAddress: issuerAddress,
      tokenName: 'Club Pass',
      tokenSymbol: 'CPASS',
      decimals: 8,
      initialSupplyBase: '50000000000',
      allowIncreaseMints: false,
      genesisTxHex: '0a000000000000000000',
      genesisTxId: 'cc'.repeat(32),
      genesisFeeSats: 2800,
      mintTxHex: '0a000000000000000000',
      mintTxId: 'dd'.repeat(32),
      mintFeeSats: 3500,
      minerFeeSats: 6300,
      lockedDustSats: 1000,
      totalFeeSats: 7300,
      tokenOutputIndex: 0,
      continuationGenesisOutpoint: null,
      continuationGenesisTxHex: null,
      spentOutpoints: [`${'11'.repeat(32)}:0`],
      changeOutpoint: `${'dd'.repeat(32)}:1`,
      changeUtxo: null,
    };

    const control: Partial<WalletToolsControl> = {
      resolveMetabotIdByName: (name) => (name === 'Sunny' ? 3 : null),
      getMetabotMvcAddress: () => issuerAddress,
      issueToken: (params, host) =>
        executeMvcFtIssue(
          {
            getDb: () => db as any,
            saveDb: () => {
              saveDbCount += 1;
            },
            metabotStore,
            transferStore,
            getFeeRate: () => 1,
            confirmIssue: host?.confirmIssue,
            buildIssueRawTx: async () => fakeBuiltIssue,
            broadcastTx: async () => {
              broadcastCount += 1;
              return broadcastCount === 1 ? fakeBuiltIssue.genesisTxId : fakeBuiltIssue.mintTxId!;
            },
          },
          params,
        ),
      listIssuedTokens: (filter) => listMvcFtIssuances(db as any, filter),
    };

    let approvalDecision = false;
    let approvalCalls = 0;
    const registeredTools = new Map<string, (args: any) => Promise<any>>();
    buildWalletAgentTools({
      tool: (name, _desc, _schema, handler) => {
        registeredTools.set(name, handler);
        return { name };
      },
      control: control as WalletToolsControl,
      sessionId: 'sess-1',
      resolveMetabotId: () => 3,
      confirmTokenIssue: async () => {
        approvalCalls += 1;
        return approvalDecision;
      },
    });

    assert.ok(registeredTools.has('wallet_token_issue'));
    assert.ok(registeredTools.has('wallet_token_mint'));
    assert.ok(registeredTools.has('wallet_token_issued_list'));

    // 1. dry_run=true does NOT prompt owner and does NOT broadcast
    const dryRes = await registeredTools.get('wallet_token_issue')!({
      name: 'Club Pass',
      symbol: 'CPASS',
      decimals: 8,
      initial_supply: '500',
      dry_run: true,
    });
    assert.equal(dryRes.isError, undefined);
    assert.match(dryRes.content[0].text, /dry-run verified locally \(NOT broadcast\)/);
    assert.equal(approvalCalls, 0);
    assert.equal(broadcastCount, 0);

    // 2. Owner denies dialog -> error returned, zero broadcasts, refused row logged
    approvalDecision = false;
    const deniedRes = await registeredTools.get('wallet_token_issue')!({
      name: 'Club Pass',
      symbol: 'CPASS',
      decimals: 8,
      initial_supply: '500',
    });
    assert.equal(deniedRes.isError, true);
    assert.match(deniedRes.content[0].text, /OWNER_DENIED/);
    assert.equal(approvalCalls, 1);
    assert.equal(broadcastCount, 0);
    assert.equal(transferStore.list(10, 3)[0]?.status, 'refused');

    // 3. Owner approves dialog -> broadcasts genesis + mint, persists to SQLite
    approvalDecision = true;
    const okRes = await registeredTools.get('wallet_token_issue')!({
      name: 'Club Pass',
      symbol: 'CPASS',
      decimals: 8,
      initial_supply: '500',
    });
    assert.equal(okRes.isError, undefined);
    assert.match(okRes.content[0].text, /MVC MetaContract FT issued and broadcast on-chain/);
    assert.equal(approvalCalls, 2);
    assert.equal(broadcastCount, 2);

    // 4. wallet_token_issued_list returns the recorded token immediately
    const listRes = await registeredTools.get('wallet_token_issued_list')!({});
    assert.match(listRes.content[0].text, /Club Pass \(CPASS\)/);
    assert.match(listRes.content[0].text, /supplyPolicy: FIXED/);
  } finally {
    db.close();
  }
});

test('Local RPC routes (/api/idbots/wallet/mvc/ft/issue, /mint, /issued): two-step confirmationToken gate blocks unconfirmed, tampered, or replayed calls', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    ensureMvcFtIssuanceTables(db as any);
    const privKey = new mvc.PrivateKey();
    const issuerAddress = privKey.toAddress(API_NET.MAIN).toString();
    const metabotStore = makeFakeMetabotStore({ id: 5, name: 'Bob', mvcAddress: issuerAddress });
    const gate = new MvcFtIssueConfirmationGate({ ttlMs: 300_000 });

    let broadcastCalls = 0;
    const sensibleId = `${'ee'.repeat(32)}00000000`;
    const assetKey = `mvc-ft:c9cc7bbd1010b44873959a8b1a2bcedeb62302b7:${'ff'.repeat(20)}`;

    const gatewayDeps: MvcFtIssueGatewayDeps = {
      getDb: () => db as any,
      getMetabotStore: () => metabotStore,
      resolveMvcFeeRate: () => 1,
      confirmationGate: gate,
      buildIssueRawTx: async (_store, params) => ({
        codehash: 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7',
        genesis: 'ff'.repeat(20),
        sensibleId,
        assetKey,
        issuerAddress,
        receiverAddress: params.receiverAddress || issuerAddress,
        tokenName: params.tokenName,
        tokenSymbol: params.tokenSymbol,
        decimals: params.decimals,
        initialSupplyBase: params.initialSupplyBase,
        allowIncreaseMints: Boolean(params.allowIncreaseMints),
        genesisTxHex: '0a00',
        genesisTxId: 'ee'.repeat(32),
        genesisFeeSats: 2800,
        mintTxHex: '0a00',
        mintTxId: '99'.repeat(32),
        mintFeeSats: 3600,
        minerFeeSats: 6400,
        lockedDustSats: 1500,
        totalFeeSats: 7900,
        tokenOutputIndex: 1,
        continuationGenesisOutpoint: `${'99'.repeat(32)}:0`,
        continuationGenesisTxHex: '0a00',
        spentOutpoints: [],
        changeOutpoint: null,
        changeUtxo: null,
      }),
      buildMintRawTx: async (_store, params) => ({
        codehash: 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7',
        genesis: 'ff'.repeat(20),
        sensibleId: params.sensibleId,
        assetKey,
        issuerAddress,
        receiverAddress: params.receiverAddress || issuerAddress,
        tokenName: 'Bob Read Credits',
        tokenSymbol: 'BREAD',
        decimals: 8,
        amountBase: params.amountBase,
        allowIncreaseMints: Boolean(params.allowIncreaseMints),
        mintTxHex: '0a00',
        mintTxId: '88'.repeat(32),
        mintFeeSats: 3700,
        minerFeeSats: 3700,
        lockedDustSats: 546,
        totalFeeSats: 4246,
        tokenOutputIndex: 1,
        continuationGenesisOutpoint: params.allowIncreaseMints ? `${'88'.repeat(32)}:0` : null,
        continuationGenesisTxHex: params.allowIncreaseMints ? '0a00' : null,
        spentOutpoints: [],
        changeOutpoint: null,
        changeUtxo: null,
      }),
      broadcastTx: async () => {
        broadcastCalls += 1;
        return `${String(broadcastCalls).padStart(2, '0')}`.repeat(32);
      },
    };

    // 1. Unconfirmed POST returns 409 CONFIRMATION_REQUIRED + confirmationToken, zero broadcasts
    const unconfirmed = await handleMvcFtIssueRoute(
      gatewayDeps,
      JSON.stringify({
        from: 'Bob',
        name: 'Bob Read Credits',
        symbol: 'BREAD',
        decimals: 8,
        initialSupply: '10000',
        allowIncreaseMints: true,
      }),
    );
    assert.equal(unconfirmed.status, 409);
    assert.equal(unconfirmed.body.errorCode, 'CONFIRMATION_REQUIRED');
    assert.equal(broadcastCalls, 0);
    const issueToken = String(unconfirmed.body.confirmationToken || '');
    assert.ok(issueToken.startsWith('ftissue_'));

    // 2. Tampering with initialSupply or allowIncreaseMints fails closed with 403 CONFIRMATION_TOKEN_MISMATCH
    const tampered = await handleMvcFtIssueRoute(
      gatewayDeps,
      JSON.stringify({
        from: 'Bob',
        name: 'Bob Read Credits',
        symbol: 'BREAD',
        decimals: 8,
        initialSupply: '999999', // tampered!
        allowIncreaseMints: true,
        ownerConfirmed: true,
        confirmationToken: issueToken,
      }),
    );
    assert.equal(tampered.status, 403);
    assert.equal(tampered.body.errorCode, 'CONFIRMATION_TOKEN_MISMATCH');
    assert.equal(broadcastCalls, 0);

    // 3. Matching parameters + confirmationToken succeeds (200) and broadcasts
    const confirmed = await handleMvcFtIssueRoute(
      gatewayDeps,
      JSON.stringify({
        from: 'Bob',
        name: 'Bob Read Credits',
        symbol: 'BREAD',
        decimals: 8,
        initialSupply: '10000',
        allowIncreaseMints: true,
        ownerConfirmed: true,
        confirmationToken: issueToken,
      }),
    );
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, 'broadcast');
    assert.equal(broadcastCalls, 2);

    // 4. Replaying consumed confirmationToken fails closed with 403
    const replayed = await handleMvcFtIssueRoute(
      gatewayDeps,
      JSON.stringify({
        from: 'Bob',
        name: 'Bob Read Credits',
        symbol: 'BREAD',
        decimals: 8,
        initialSupply: '10000',
        allowIncreaseMints: true,
        ownerConfirmed: true,
        confirmationToken: issueToken,
      }),
    );
    assert.equal(replayed.status, 403);
    assert.equal(broadcastCalls, 2);

    // 5. Mint dryRun -> confirm round-trip
    const mintPreview = await handleMvcFtMintRoute(gatewayDeps, {
      from: 'Bob',
      assetKey,
      amount: '2500.00',
      allowIncreaseMints: true,
      dryRun: true,
    });
    assert.equal(mintPreview.status, 200);
    assert.equal(mintPreview.body.status, 'dry_run');
    const mintConfToken = String(mintPreview.body.confirmationToken || '');

    const mintConfirmed = await handleMvcFtMintRoute(gatewayDeps, {
      from: 'Bob',
      assetKey,
      amount: '2500',
      allowIncreaseMints: true,
      ownerConfirmed: true,
      confirmationToken: mintConfToken,
    });
    assert.equal(mintConfirmed.status, 200);
    assert.equal(mintConfirmed.body.status, 'broadcast');
    assert.equal(broadcastCalls, 3);

    // 6. GET /api/idbots/wallet/mvc/ft/issued returns updated cumulative supply and strips raw tx hexes
    const listResp = handleMvcFtIssuedListRoute(gatewayDeps, new URLSearchParams('from=Bob'));
    assert.equal(listResp.status, 200);
    assert.equal(listResp.body.count, 1);
    const tokenRow = (listResp.body.tokens as any[])[0];
    assert.equal(tokenRow.tokenSymbol, 'BREAD');
    assert.equal(tokenRow.totalMintedDisplay, '12500');
    assert.equal('genesisTxHex' in tokenRow, false);
    assert.equal('continuationGenesisTxHex' in tokenRow, false);
  } finally {
    db.close();
  }
});

test('Compiled buildMvcFtIssueRawTxWorker.js subprocess: reads env mnemonic + JSON stdin and builds real genesis + mint bundle', async () => {
  const workerPath = path.resolve(__dirname, '..', 'dist-electron', 'main', 'libs', 'buildMvcFtIssueRawTxWorker.js');
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const hdPrivateKey = mvc.HDPrivateKey.fromSeed(
    mvc.Mnemonic.fromString(testMnemonic).toSeed(),
    API_NET.MAIN,
  );
  const childKey = hdPrivateKey.deriveChild("m/44'/10001'/0'/0/0").privateKey;
  const funding = buildSyntheticFundingUtxo(childKey, 200_000);

  const payload = JSON.stringify({
    action: 'issue',
    tokenName: 'Worker Smoke Credits',
    tokenSymbol: 'WSMK',
    decimals: 6,
    initialSupplyBase: '123456000',
    allowIncreaseMints: false,
    feeRate: 1,
    preferredFundingUtxos: [funding],
    preferredFundingRawTxs: { [funding.txId]: funding.txHex },
  });

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        IDBOTS_METABOT_MNEMONIC: testMnemonic,
        IDBOTS_METABOT_PATH: "m/44'/10001'/0'",
        IDBOTS_METALET_HOST: 'http://127.0.0.1:9',
        IDBOTS_MVC_API_HOST: 'http://127.0.0.1:9',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(payload);
  });

  assert.equal(result.code, 0, `Worker failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.success, true);
  assert.equal(parsed.tokenSymbol, 'WSMK');
  assert.equal(parsed.decimals, 6);
  assert.equal(parsed.initialSupplyBase, '123456000');
  assert.equal(parsed.allowIncreaseMints, false);
  assert.match(String(parsed.assetKey), /^mvc-ft:[0-9a-f]{40}:[0-9a-f]{40}$/);
  assert.match(String(parsed.genesisTxId), /^[0-9a-f]{64}$/);
  assert.match(String(parsed.mintTxId), /^[0-9a-f]{64}$/);
  assert.ok(parsed.totalFeeSats > 0);
});
