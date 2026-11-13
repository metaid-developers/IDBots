import test from 'node:test';
import assert from 'node:assert/strict';

const {
  runMvcCreatePinWithInsufficientFundsRescue,
} = await import('../dist-electron/main/services/metaidCore.js');
const {
  getMvcSpendSessionSnapshot,
  recordMvcSpentOutpoints,
  resetMvcSpendSessionStateForTests,
} = await import('../dist-electron/main/services/mvcSpendSessionState.js');

function silenceConsole() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
  };
}

test('returns the run result immediately when the first attempt succeeds', async () => {
  const restore = silenceConsole();
  try {
    let runCalls = 0;
    let fundingCalls = 0;
    const result = await runMvcCreatePinWithInsufficientFundsRescue({
      metabotId: 901,
      operation: 'create',
      path: '/protocols/simplemsg',
      requestFreshFunding: async () => {
        fundingCalls += 1;
        return true;
      },
      run: async () => {
        runCalls += 1;
        return { txids: ['tx-ok'] };
      },
    });
    assert.deepEqual(result, { txids: ['tx-ok'] });
    assert.equal(runCalls, 1);
    assert.equal(fundingCalls, 0);
  } finally {
    restore();
  }
});

test('requests the gas subsidy once and retries after an insufficient-funds failure', async () => {
  const restore = silenceConsole();
  resetMvcSpendSessionStateForTests();
  const metabotId = 902;
  recordMvcSpentOutpoints(metabotId, [`${'ab'.repeat(32)}:0`]);
  assert.equal(getMvcSpendSessionSnapshot(metabotId).excludeOutpoints.length, 1);
  try {
    let runCalls = 0;
    const fundingTriggers = [];
    const result = await runMvcCreatePinWithInsufficientFundsRescue({
      metabotId,
      operation: 'modify',
      path: '/info/name',
      requestFreshFunding: async (trigger) => {
        fundingTriggers.push(trigger);
        return true;
      },
      run: async () => {
        runCalls += 1;
        if (runCalls === 1) {
          throw new Error('MetaBot 余额不足，无法支付本次上链所需的手续费，请先充值后重试。');
        }
        return { txids: ['tx-after-subsidy'] };
      },
    });
    assert.deepEqual(result, { txids: ['tx-after-subsidy'] });
    assert.equal(runCalls, 2);
    assert.deepEqual(fundingTriggers, ['insufficient bot-wallet funds']);
    // The rescue clears stale UTXO exclusions before retrying.
    assert.deepEqual(getMvcSpendSessionSnapshot(metabotId).excludeOutpoints, []);
  } finally {
    restore();
    resetMvcSpendSessionStateForTests();
  }
});

test('matches the wrapped sponsor-fallback insufficient-funds message', async () => {
  const restore = silenceConsole();
  resetMvcSpendSessionStateForTests();
  try {
    let runCalls = 0;
    let fundingCalls = 0;
    const result = await runMvcCreatePinWithInsufficientFundsRescue({
      metabotId: 903,
      operation: 'modify',
      path: '/info/bio',
      requestFreshFunding: async () => {
        fundingCalls += 1;
        return true;
      },
      run: async () => {
        runCalls += 1;
        if (runCalls === 1) {
          throw new Error(
            'Sponsored MVC createPin fell back to self-paid (sponsor no_user_utxo at address_info)'
            + ' but the self-paid broadcast failed: MetaBot 余额不足，无法支付本次上链所需的手续费，请先充值后重试。',
          );
        }
        return { txids: ['tx-sponsored-after-funding'] };
      },
    });
    assert.deepEqual(result, { txids: ['tx-sponsored-after-funding'] });
    assert.equal(runCalls, 2);
    assert.equal(fundingCalls, 1);
  } finally {
    restore();
    resetMvcSpendSessionStateForTests();
  }
});

test('matches the English not-enough-balance fingerprint', async () => {
  const restore = silenceConsole();
  resetMvcSpendSessionStateForTests();
  try {
    let runCalls = 0;
    const result = await runMvcCreatePinWithInsufficientFundsRescue({
      metabotId: 904,
      operation: 'create',
      path: '/protocols/simplebuzz',
      requestFreshFunding: async () => true,
      run: async () => {
        runCalls += 1;
        if (runCalls === 1) {
          throw new Error('Not enough balance');
        }
        return { txids: ['tx-en'] };
      },
    });
    assert.deepEqual(result, { txids: ['tx-en'] });
    assert.equal(runCalls, 2);
  } finally {
    restore();
    resetMvcSpendSessionStateForTests();
  }
});

test('rethrows the original error when the subsidy request fails', async () => {
  const restore = silenceConsole();
  resetMvcSpendSessionStateForTests();
  try {
    let runCalls = 0;
    let fundingCalls = 0;
    await assert.rejects(
      runMvcCreatePinWithInsufficientFundsRescue({
        metabotId: 905,
        operation: 'create',
        path: '/protocols/simplemsg',
        requestFreshFunding: async () => {
          fundingCalls += 1;
          return false;
        },
        run: async () => {
          runCalls += 1;
          throw new Error('MetaBot 余额不足，无法支付本次上链所需的手续费，请先充值后重试。');
        },
      }),
      /余额不足/,
    );
    assert.equal(runCalls, 1);
    assert.equal(fundingCalls, 1);
  } finally {
    restore();
    resetMvcSpendSessionStateForTests();
  }
});

test('does not retry non-balance failures', async () => {
  const restore = silenceConsole();
  resetMvcSpendSessionStateForTests();
  try {
    let runCalls = 0;
    let fundingCalls = 0;
    await assert.rejects(
      runMvcCreatePinWithInsufficientFundsRescue({
        metabotId: 906,
        operation: 'create',
        path: '/protocols/simplemsg',
        requestFreshFunding: async () => {
          fundingCalls += 1;
          return true;
        },
        run: async () => {
          runCalls += 1;
          throw new Error('sponsor service returned HTTP 500');
        },
      }),
      /HTTP 500/,
    );
    assert.equal(runCalls, 1);
    assert.equal(fundingCalls, 0);
  } finally {
    restore();
    resetMvcSpendSessionStateForTests();
  }
});

test('propagates the retry error when the write still fails after funding', async () => {
  const restore = silenceConsole();
  resetMvcSpendSessionStateForTests();
  try {
    let runCalls = 0;
    await assert.rejects(
      runMvcCreatePinWithInsufficientFundsRescue({
        metabotId: 907,
        operation: 'create',
        path: '/protocols/simplemsg',
        requestFreshFunding: async () => true,
        run: async () => {
          runCalls += 1;
          throw new Error(runCalls === 1 ? 'Not enough balance' : 'broadcast rejected by node');
        },
      }),
      /broadcast rejected by node/,
    );
    assert.equal(runCalls, 2);
  } finally {
    restore();
    resetMvcSpendSessionStateForTests();
  }
});

test('waits for the granted subsidy to settle before the retry', async () => {
  const restore = silenceConsole();
  try {
    const order = [];
    let runCalls = 0;
    const result = await runMvcCreatePinWithInsufficientFundsRescue({
      metabotId: 905,
      operation: 'create',
      path: '/info/bio',
      settleMs: 3000,
      sleep: async (ms) => { order.push(`sleep:${ms}`); },
      requestFreshFunding: async () => { order.push('fund'); return true; },
      run: async () => {
        runCalls += 1;
        order.push(`run:${runCalls}`);
        if (runCalls === 1) throw new Error('Not enough balance');
        return { txids: ['tx-after-settle'] };
      },
    });
    assert.deepEqual(result, { txids: ['tx-after-settle'] });
    assert.deepEqual(order, ['run:1', 'fund', 'sleep:3000', 'run:2']);
  } finally {
    restore();
  }
});
