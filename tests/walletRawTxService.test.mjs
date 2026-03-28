import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import Module from 'node:module';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

let walletRawTxService;
try {
  walletRawTxService = require('../dist-electron/services/walletRawTxService.js');
} catch {
  walletRawTxService = null;
}

function buildSampleRawTxHex() {
  const inputTxid = '11'.repeat(32);
  const inputOut = Buffer.alloc(4);
  inputOut.writeUInt32LE(1, 0);
  const sequence = 'ffffffff';

  const recipientScript = `76a914${'22'.repeat(20)}88ac`;
  const changeScript = `76a914${'33'.repeat(20)}88ac`;

  const recipientValue = Buffer.alloc(8);
  recipientValue.writeBigUInt64LE(1000n, 0);
  const changeValue = Buffer.alloc(8);
  changeValue.writeBigUInt64LE(500n, 0);

  return [
    '01000000',
    '01',
    inputTxid,
    inputOut.toString('hex'),
    '00',
    sequence,
    '02',
    recipientValue.toString('hex'),
    '19',
    recipientScript,
    changeValue.toString('hex'),
    '19',
    changeScript,
    '00000000',
  ].join('');
}

function getSampleRecipientAddress() {
  const script = new mvc.Script(`76a914${'22'.repeat(20)}88ac`);
  return script.toAddress('livenet').toString();
}

function createStore() {
  return {
    getMetabotWalletByMetabotId(id) {
      if (id !== 1) return null;
      return {
        mnemonic: 'test mnemonic',
        path: "m/44'/10001'/0'/0/0",
      };
    },
  };
}

function loadWalletRawTxServiceWithSpawnStub(spawnImpl) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath(name) {
            if (name === 'userData') return os.tmpdir();
            if (name === 'exe') return process.execPath;
            return os.tmpdir();
          },
          getAppPath() {
            return process.cwd();
          },
        },
      };
    }
    if (request === 'child_process') {
      const actual = originalLoad(request, parent, isMain);
      return { ...actual, spawn: spawnImpl };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../dist-electron/services/walletRawTxService.js')];
    return require('../dist-electron/services/walletRawTxService.js');
  } finally {
    Module._load = originalLoad;
  }
}

test('summarizeMvcTransferTx returns txid, recipient output index, and spent outpoints', () => {
  assert.equal(
    typeof walletRawTxService?.summarizeMvcTransferTx,
    'function',
    'summarizeMvcTransferTx() should be exported',
  );

  const summary = walletRawTxService.summarizeMvcTransferTx({
    txHex: buildSampleRawTxHex(),
    amountSats: 1000,
  });

  assert.equal(summary.outputIndex, 0);
  assert.match(summary.txid, /^[0-9a-f]{64}$/i);
  assert.deepEqual(summary.spentOutpoints, [`${'11'.repeat(32)}:1`]);
  assert.equal(summary.changeOutpoint, `${summary.txid}:1`);
});

test('buildMvcTransferRawTx rejects invalid amount_sats before worker run', async () => {
  assert.equal(
    typeof walletRawTxService?.buildMvcTransferRawTx,
    'function',
    'buildMvcTransferRawTx() should be exported',
  );

  let invoked = false;
  await assert.rejects(
    () =>
      walletRawTxService.buildMvcTransferRawTx(
        createStore(),
        {
          metabotId: 1,
          toAddress: '1recipient',
          amountSats: 0,
          feeRate: 1,
        },
        {
          runMvcTransferRawTxWorker: async () => {
            invoked = true;
            return { txHex: buildSampleRawTxHex() };
          },
        },
      ),
    /amount_sats/i,
  );
  assert.equal(invoked, false);
});

test('buildMvcTransferRawTx summarizes a successful worker result into raw-tx response fields', async () => {
  assert.equal(
    typeof walletRawTxService?.buildMvcTransferRawTx,
    'function',
    'buildMvcTransferRawTx() should be exported',
  );

  const result = await walletRawTxService.buildMvcTransferRawTx(
    createStore(),
    {
      metabotId: 1,
      toAddress: getSampleRecipientAddress(),
      amountSats: 1000,
      feeRate: 1,
      excludeOutpoints: ['A'.repeat(64) + ':0'],
    },
    {
      runMvcTransferRawTxWorker: async (params) => {
        assert.deepEqual(params.excludeOutpoints, ['a'.repeat(64) + ':0']);
        return { txHex: buildSampleRawTxHex() };
      },
    },
  );

  assert.equal(result.raw_tx, buildSampleRawTxHex());
  assert.equal(result.output_index, 0);
  assert.deepEqual(result.spent_outpoints, [`${'11'.repeat(32)}:1`]);
  assert.match(result.txid, /^[0-9a-f]{64}$/i);
  assert.equal(result.change_outpoint, `${result.txid}:1`);
});

test('buildMvcTransferRawTx rejects malformed exclude_outpoints before worker run', async () => {
  assert.equal(
    typeof walletRawTxService?.buildMvcTransferRawTx,
    'function',
    'buildMvcTransferRawTx() should be exported',
  );

  let invoked = false;
  await assert.rejects(
    () =>
      walletRawTxService.buildMvcTransferRawTx(
        createStore(),
        {
          metabotId: 1,
          toAddress: getSampleRecipientAddress(),
          amountSats: 1000,
          feeRate: 1,
          excludeOutpoints: ['not-an-outpoint'],
        },
        {
          runMvcTransferRawTxWorker: async () => {
            invoked = true;
            return { txHex: buildSampleRawTxHex() };
          },
        },
      ),
    /exclude_outpoints/i,
  );
  assert.equal(invoked, false);
});

test('buildMvcFtTransferRawTx rejects invalid token fields before worker run', async () => {
  assert.equal(
    typeof walletRawTxService?.buildMvcFtTransferRawTx,
    'function',
    'buildMvcFtTransferRawTx() should be exported',
  );

  let invoked = false;
  await assert.rejects(
    () =>
      walletRawTxService.buildMvcFtTransferRawTx(
        createStore(),
        {
          metabotId: 1,
          token: {
            symbol: 'MC',
            genesisHash: '',
            codeHash: 'code',
            decimal: 8,
          },
          toAddress: '1recipient',
          amount: '500000000',
          feeRate: 1,
        },
        {
          runMvcFtTransferRawTxWorker: async () => {
            invoked = true;
            return {
              txHex: 'aa',
              amountCheckRawTx: 'bb',
              outputIndex: 0,
            };
          },
        },
      ),
    /token/i,
  );
  assert.equal(invoked, false);
});

test('buildMvcFtTransferRawTx returns worker raw-tx fields and preserves spend metadata', async () => {
  assert.equal(
    typeof walletRawTxService?.buildMvcFtTransferRawTx,
    'function',
    'buildMvcFtTransferRawTx() should be exported',
  );

  const result = await walletRawTxService.buildMvcFtTransferRawTx(
    createStore(),
    {
      metabotId: 1,
      token: {
        symbol: 'MC',
        tokenID: 'token-id',
        genesisHash: 'genesis',
        codeHash: 'code',
        decimal: 8,
      },
      toAddress: getSampleRecipientAddress(),
      amount: '500000000',
      feeRate: 1,
      fundingRawTx: buildSampleRawTxHex(),
      fundingOutpoint: `${'11'.repeat(32)}:1`,
    },
    {
      runMvcFtTransferRawTxWorker: async (params) => {
        assert.equal(params.token.genesisHash, 'token-id');
        assert.equal(params.fundingRawTx, buildSampleRawTxHex());
        assert.equal(params.fundingOutpoint, `${'11'.repeat(32)}:1`);
        return {
          txHex: buildSampleRawTxHex(),
          amountCheckRawTx: 'amount-check-raw',
          outputIndex: 0,
          spentOutpoints: ['c'.repeat(64) + ':2'],
          changeOutpoint: 'ft-txid:1',
        };
      },
    },
  );

  assert.equal(result.raw_tx, buildSampleRawTxHex());
  assert.equal(result.output_index, 0);
  assert.equal(result.amount_check_raw_tx, 'amount-check-raw');
  assert.deepEqual(result.spent_outpoints, ['c'.repeat(64) + ':2']);
  assert.equal(result.change_outpoint, 'ft-txid:1');
});

test('buildMvcFtTransferRawTx rejects partial funding tx context', async () => {
  await assert.rejects(
    () =>
      walletRawTxService.buildMvcFtTransferRawTx(
        createStore(),
        {
          metabotId: 1,
          token: {
            symbol: 'MC',
            tokenID: 'token-id',
            genesisHash: 'genesis',
            codeHash: 'code',
            decimal: 8,
          },
          toAddress: getSampleRecipientAddress(),
          amount: '500000000',
          feeRate: 1,
          fundingRawTx: buildSampleRawTxHex(),
        },
        {
          runMvcFtTransferRawTxWorker: async () => {
            throw new Error('should not be called');
          },
        },
      ),
    /funding_raw_tx and funding_outpoint/i,
  );
});

test('buildMvcFtTransferRawTx default worker path forwards funding tx context to the spawned worker payload', async () => {
  const stdinWrites = [];
  const service = loadWalletRawTxServiceWithSpawnStub(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write(chunk, cb) {
        stdinWrites.push(chunk.toString());
        if (typeof cb === 'function') cb();
      },
      end() {
        process.nextTick(() => {
          child.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                success: true,
                txHex: buildSampleRawTxHex(),
                amountCheckRawTx: 'amount-check-raw',
                outputIndex: 0,
              })}\n`,
            ),
          );
          child.emit('close', 0);
        });
      },
    };
    return child;
  });

  await service.buildMvcFtTransferRawTx(createStore(), {
    metabotId: 1,
    token: {
      symbol: 'MC',
      tokenID: 'token-id',
      genesisHash: 'genesis',
      codeHash: 'code',
      decimal: 8,
    },
    toAddress: getSampleRecipientAddress(),
    amount: '500000000',
    feeRate: 1,
    fundingRawTx: buildSampleRawTxHex(),
    fundingOutpoint: `${'11'.repeat(32)}:1`,
  });

  assert.equal(stdinWrites.length, 1);
  const payload = JSON.parse(stdinWrites[0]);
  assert.equal(payload.fundingRawTx, buildSampleRawTxHex());
  assert.equal(payload.fundingOutpoint, `${'11'.repeat(32)}:1`);
});

test('buildMvcOrderedRawTxBundle chains the previous change output into later bundle steps', async () => {
  assert.equal(
    typeof walletRawTxService?.buildMvcOrderedRawTxBundle,
    'function',
    'buildMvcOrderedRawTxBundle() should be exported',
  );

  const mvcSummary = walletRawTxService.summarizeMvcTransferTx({
    txHex: buildSampleRawTxHex(),
    amountSats: 1000,
    toAddress: getSampleRecipientAddress(),
  });

  const calls = [];
  const result = await walletRawTxService.buildMvcOrderedRawTxBundle(
    createStore(),
    {
      metabotId: 1,
      steps: [
        {
          kind: 'mvc_transfer',
          toAddress: getSampleRecipientAddress(),
          amountSats: 1000,
          feeRate: 1,
          excludeOutpoints: ['A'.repeat(64) + ':0'],
        },
        {
          kind: 'mvc_ft_transfer',
          token: {
            symbol: 'MC',
            tokenID: 'token-id',
            genesisHash: 'genesis',
            codeHash: 'code',
            decimal: 8,
          },
          toAddress: getSampleRecipientAddress(),
          amount: '500000000',
          feeRate: 1,
          funding: {
            stepIndex: 0,
            useOutput: 'change',
          },
        },
      ],
    },
    {
      runMvcTransferRawTxWorker: async (params) => {
        calls.push({ type: 'mvc', params });
        return { txHex: buildSampleRawTxHex() };
      },
      runMvcFtTransferRawTxWorker: async (params) => {
        calls.push({ type: 'mvc-ft', params });
        return {
          txHex: buildSampleRawTxHex(),
          amountCheckRawTx: 'amount-check-raw',
          outputIndex: 0,
        };
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'mvc');
  assert.equal(calls[1].type, 'mvc-ft');
  assert.deepEqual(calls[0].params.excludeOutpoints, ['a'.repeat(64) + ':0']);
  assert.equal(calls[1].params.fundingRawTx, buildSampleRawTxHex());
  assert.equal(calls[1].params.fundingOutpoint, mvcSummary.changeOutpoint);

  assert.equal(Array.isArray(result.steps), true);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].kind, 'mvc_transfer');
  assert.equal(result.steps[0].change_outpoint, mvcSummary.changeOutpoint);
  assert.equal(result.steps[1].kind, 'mvc_ft_transfer');
  assert.equal(result.steps[1].amount_check_raw_tx, 'amount-check-raw');
  assert.equal(result.steps[1].resolved_funding_outpoint, mvcSummary.changeOutpoint);
});
