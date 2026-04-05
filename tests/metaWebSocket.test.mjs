import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function createFakeSocket() {
  const handlers = new Map();
  return {
    connected: true,
    disconnectCalls: 0,
    emitCalls: [],
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    emit(event, ...args) {
      this.emitCalls.push([event, ...args]);
    },
    removeAllListeners() {
      handlers.clear();
    },
    disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
    trigger(event, ...args) {
      const handler = handlers.get(event);
      if (handler) {
        handler(...args);
      }
    },
  };
}

function loadSocketModuleWithFakeIo(fakeIo) {
  const socketIo = require('socket.io-client');
  const originalIo = socketIo.io;
  const modulePath = require.resolve('../dist-electron/services/metaWebSocket.js');

  socketIo.io = fakeIo;
  delete require.cache[modulePath];

  return {
    modulePath,
    originalIo,
    socketIo,
    exports: require(modulePath),
  };
}

test('SocketIOClient reconnects when a heartbeat acknowledgement never arrives', async () => {
  const sockets = [];
  const loaded = loadSocketModuleWithFakeIo(() => {
    const socket = createFakeSocket();
    sockets.push(socket);
    return socket;
  });

  try {
    const { SocketIOClient } = loaded.exports;
    const client = new SocketIOClient({
      url: 'wss://example.test',
      path: '/socket/socket.io',
      metaid: 'idq1bot',
      type: 'pc',
      heartbeatInterval: 100,
      heartbeatTimeout: 20,
    }, () => {});

    client.connect();
    assert.equal(sockets.length, 1);

    sockets[0].trigger('connect');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].disconnectCalls >= 1, true);

    client.disconnect();
  } finally {
    loaded.socketIo.io = loaded.originalIo;
    delete require.cache[loaded.modulePath];
  }
});

test('SocketIOClient keeps the current connection when heartbeat acknowledgements arrive in time', async () => {
  const sockets = [];
  const loaded = loadSocketModuleWithFakeIo(() => {
    const socket = createFakeSocket();
    sockets.push(socket);
    return socket;
  });

  try {
    const { SocketIOClient } = loaded.exports;
    const client = new SocketIOClient({
      url: 'wss://example.test',
      path: '/socket/socket.io',
      metaid: 'idq1bot',
      type: 'pc',
      heartbeatInterval: 100,
      heartbeatTimeout: 30,
    }, () => {});

    client.connect();
    assert.equal(sockets.length, 1);

    sockets[0].trigger('connect');
    await new Promise((resolve) => setTimeout(resolve, 5));
    sockets[0].trigger('heartbeat_ack');
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].disconnectCalls, 0);

    client.disconnect();
  } finally {
    loaded.socketIo.io = loaded.originalIo;
    delete require.cache[loaded.modulePath];
  }
});
