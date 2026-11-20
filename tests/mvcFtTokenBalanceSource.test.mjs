import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

// Incident fixture: the exact Metalet v4 balance-list rows for the address
// from session 0c841356. wallet_token_balance used to report hard zeros for
// these because the open-api-mvc parser read a `balance` field the endpoint
// never sends; the fix reads the same source the wallet UI uses.
const INCIDENT_ADDRESS = '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za';
const INCIDENT_ROWS = [
  {
    codeHash: 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7',
    genesis: '2e6b92a31f85a60a301bd42566923aa7bd0ff9f7',
    name: 'Matrix',
    symbol: 'Token',
    icon: '',
    decimal: 2,
    sensibleId: 'd1ebdb785e2b6c43c62ac7b2356302503e9f1d0357a074ba90cc5ca8fdb4021700000000',
    utxoCount: '2',
    confirmed: 678813,
    confirmedString: '678813',
    unconfirmed: 0,
    unconfirmedString: '0',
  },
  {
    codeHash: 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7',
    genesis: '28a481ecdae9499a599a9457ae70b5cf234ef417',
    name: '',
    symbol: 'METAID',
    icon: '',
    decimal: 8,
    sensibleId: 'f1c52275148e6d4516707ffeec88794c1d905283ec3fe3d3090551afb61b4b0100000000',
    utxoCount: '4',
    confirmed: 102915788,
    confirmedString: '102915788',
    unconfirmed: 11926471,
    unconfirmedString: '11926471',
  },
];

async function loadMvcFtService() {
  return require('../dist-electron/main/services/mvcFtService.js');
}

test('wallet_token_balance source: v4 balance-list rows map to non-zero FT balances', async () => {
  const { listMvcFtAssets, mvcFtTokenBalanceFromAssets } = await loadMvcFtService();
  const assets = await listMvcFtAssets(INCIDENT_ADDRESS, {
    fetchBalanceList: async () => INCIDENT_ROWS,
  });
  const balance = mvcFtTokenBalanceFromAssets(INCIDENT_ADDRESS, assets);

  assert.equal(balance.address, INCIDENT_ADDRESS);
  assert.equal(balance.count, 2);

  const metaid = balance.tokens.find((t) => t.symbol === 'METAID');
  assert.ok(metaid, 'METAID row present');
  // The all-zero regression: spendable balance is confirmed + unconfirmed.
  assert.equal(metaid.balance, '1.14842259');
  assert.equal(metaid.confirmed, '1.02915788');
  assert.equal(metaid.unconfirmed, '0.11926471');
  assert.equal(metaid.decimal, 8);
  assert.equal(metaid.genesis, '28a481ecdae9499a599a9457ae70b5cf234ef417');
  assert.equal(metaid.codeHash, 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7');
  assert.equal(metaid.count, 4);
  assert.equal(metaid.sensibleId, 'f1c52275148e6d4516707ffeec88794c1d905283ec3fe3d3090551afb61b4b0100000000');

  const matrix = balance.tokens.find((t) => t.symbol === 'Token');
  assert.ok(matrix, 'Token row present');
  assert.equal(matrix.balance, '6788.13');
  assert.equal(matrix.confirmed, '6788.13');
  assert.equal(matrix.unconfirmed, '0.00');
  assert.equal(matrix.decimal, 2);
  assert.equal(matrix.tokenName, 'Matrix');
});

test('wallet_token_balance source: empty holdings map to a zero count', async () => {
  const { listMvcFtAssets, mvcFtTokenBalanceFromAssets } = await loadMvcFtService();
  const assets = await listMvcFtAssets(INCIDENT_ADDRESS, { fetchBalanceList: async () => [] });
  const balance = mvcFtTokenBalanceFromAssets(INCIDENT_ADDRESS, assets);
  assert.deepEqual(balance, { address: INCIDENT_ADDRESS, count: 0, tokens: [] });
});
