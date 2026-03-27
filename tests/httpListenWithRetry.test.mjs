import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let listenWithRetry;
try {
  ({ listenWithRetry } = require('../dist-electron/services/httpListenWithRetry.js'));
} catch {
  listenWithRetry = null;
}

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('listenWithRetry() eventually binds after the port is released', async () => {
  assert.equal(typeof listenWithRetry, 'function', 'listenWithRetry() should be exported');

  const blocker = http.createServer((_req, res) => res.end('busy'));
  const port = await listen(blocker, 0);

  const server = http.createServer((_req, res) => res.end('ok'));
  const events = [];
  const listening = new Promise((resolve, reject) => {
    listenWithRetry(server, port, '127.0.0.1', {
      retryDelayMs: 25,
      maxAttempts: 20,
      logger: {
        warn: (message) => events.push(`warn:${message}`),
        error: (message) => reject(new Error(String(message))),
      },
      onListening: resolve,
    });
  });

  setTimeout(() => {
    blocker.close();
  }, 80);

  await listening;

  assert.ok(server.listening, 'server should eventually bind after the blocker releases the port');
  assert.ok(events.some((message) => message.startsWith('warn:')), 'expected at least one retry warning before bind succeeds');

  server.close();
  if (blocker.listening) {
    blocker.close();
  }
});
