// Incremental cowork stream protocol: the main process turns the full-content
// stream updates into append-only deltas (first update of a message full, later
// updates the grown tail) and the renderer reassembles them into exactly the
// text the old full-content protocol delivered — at a fraction of the bytes.
//
// Covers the safety rules the protocol must not break: a dropped or
// out-of-order delta can only cost live smoothness (the resync request and the
// always-full finalize payload both recover it), never content.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_UPDATE_CHARS = 120_000;
const TRUNCATED_HINT = '\n...[truncated in main IPC forwarding]';

const truncateIpcString = (value) => (
  value.length <= MAX_UPDATE_CHARS ? value : `${value.slice(0, MAX_UPDATE_CHARS)}${TRUNCATED_HINT}`
);

const loadFixture = async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-stream-delta-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'cowork-stream.mjs');

  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: [
        `export { coworkService } from './src/renderer/services/cowork.ts';`,
        `export { CoworkStreamUiDeltaEncoder } from './src/main/libs/coworkStreamUiDelta.ts';`,
      ].join('\n'),
      resolveDir: projectRoot,
      sourcefile: 'cowork-stream-test-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'stateful-cowork-store',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^\.\.\/store$/ }, (args) => {
          if (!args.importer.endsWith('/src/renderer/services/cowork.ts')) return null;
          return { path: 'cowork-stream-store', namespace: 'cowork-stream-test' };
        });
        esbuild.onLoad(
          { filter: /^cowork-stream-store$/, namespace: 'cowork-stream-test' },
          () => ({
            loader: 'js',
            contents: `
              const applyUpdate = (session, payload) => {
                if (!session || session.id !== payload.sessionId) return;
                const message = (session.messages || []).find((entry) => entry.id === payload.messageId);
                if (!message) return;
                if (payload.delta !== undefined) message.content = (message.content || '') + payload.delta;
                else if (payload.content !== undefined) message.content = payload.content;
                if (payload.metadata !== undefined) {
                  message.metadata = { ...(message.metadata || {}), ...payload.metadata };
                }
              };
              export const store = {
                dispatch(action) {
                  globalThis.__coworkStreamDispatches.push(action);
                  const payload = action && action.payload;
                  if (payload && typeof payload.sessionId === 'string' && typeof payload.messageId === 'string') {
                    // Each slice reducer only touches its own session, so the
                    // stub must not cross-apply a task-view dispatch to the panel.
                    const session = action.type.startsWith('browserCowork/')
                      ? globalThis.__coworkStreamState.browserCowork.currentSession
                      : globalThis.__coworkStreamState.cowork.currentSession;
                    applyUpdate(session, payload);
                  }
                  return action;
                },
                getState() {
                  return globalThis.__coworkStreamState;
                },
              };
            `,
          }),
        );
      },
    }],
  });

  const fixture = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);
  t.after(() => {
    delete globalThis.window;
    delete globalThis.__coworkStreamDispatches;
    delete globalThis.__coworkStreamSessions;
    delete globalThis.__coworkStreamState;
  });
  return fixture;
};

/**
 * Wires the real encoder (main half) to the real service (renderer half) over a
 * stubbed IPC hop. `deliver` is what the main process sends; `send` advances the
 * main side without delivering, which is how a dropped payload is simulated.
 */
const startStream = async (t, options = {}) => {
  const { coworkService, CoworkStreamUiDeltaEncoder } = await loadFixture(t);

  const makeSession = () => ({
    id: 's1',
    status: 'running',
    messages: [
      { id: 'u1', type: 'user', content: 'hi', timestamp: 1 },
      { id: 'm1', type: 'assistant', content: '', metadata: { isStreaming: true }, timestamp: 2 },
    ],
  });
  const mainSession = makeSession();
  const panelSession = makeSession();
  globalThis.__coworkStreamSessions = [mainSession, panelSession];
  globalThis.__coworkStreamDispatches = [];
  globalThis.__coworkStreamState = {
    cowork: {
      sessions: [],
      currentSessionId: 's1',
      currentSession: mainSession,
      isStreaming: true,
      pendingPermissions: [],
    },
    browserCowork: { currentSession: panelSession, isStreaming: true },
  };

  const listeners = {};
  const resyncRequests = [];
  const holder = { encoder: null, liveQuery: null };
  /** Animation frames the service scheduled, drained explicitly by the test. */
  const pendingFrames = [];
  let nextFrameId = 1;
  const stub = (name) => (callback) => {
    listeners[name] = callback;
    return () => { delete listeners[name]; };
  };

  globalThis.window = {
    requestAnimationFrame: (callback) => {
      const id = nextFrameId++;
      pendingFrames.push({ id, callback });
      return id;
    },
    cancelAnimationFrame: (id) => {
      const index = pendingFrames.findIndex((frame) => frame.id === id);
      if (index !== -1) pendingFrames.splice(index, 1);
    },
    electron: {
      cowork: {
        onStreamMessage: stub('message'),
        onStreamMessageUpdate: stub('messageUpdate'),
        onStreamPermission: stub('permission'),
        onStreamPermissionResolved: stub('permissionResolved'),
        onStreamStageInteraction: stub('stageInteraction'),
        onStreamComplete: stub('complete'),
        onStreamError: stub('error'),
        onStreamSessionTitle: stub('sessionTitle'),
        onSessionProfileRefreshed: stub('profileRefreshed'),
        getConfig: async () => ({ success: true, config: {} }),
        listSessions: async () => ({ success: true, sessions: [] }),
        listMetabotAvatars: async () => ({ success: true, avatars: [] }),
        // The main-side resync answer: by default exactly what the encoder
        // would have to baseline the next delta against.
        getStreamLiveContent: async ({ sessionId, messageId }) => {
          resyncRequests.push({ sessionId, messageId });
          const content = holder.liveQuery
            ? holder.liveQuery(sessionId, messageId)
            : holder.encoder?.liveContent(sessionId, messageId) ?? null;
          return typeof content === 'string' ? { success: true, content } : { success: false };
        },
      },
    },
  };

  await coworkService.init();

  const encoder = new CoworkStreamUiDeltaEncoder({
    truncate: truncateIpcString,
    ...(options.encoderOptions ?? {}),
  });
  holder.encoder = encoder;

  const sent = [];
  let wireChars = 0;
  const contentDispatches = () => globalThis.__coworkStreamDispatches
    .filter((action) => /(updateMessageContent|appendMessageContent|updateBrowserMessageContent|appendBrowserMessageContent)$/.test(action.type));
  const encode = (content, metadata) => {
    const payload = encoder.encode({ sessionId: 's1', messageId: 'm1', content, metadata });
    if (payload) wireChars += (payload.content ?? payload.delta ?? '').length;
    return payload;
  };
  const send = (content, metadata) => {
    const payload = encode(content, metadata);
    if (payload) sent.push(payload);
    return payload;
  };
  const deliver = (content, metadata) => {
    const payload = send(content, metadata);
    if (payload) listeners.messageUpdate(payload);
    return payload;
  };
  /** Run whatever the service scheduled, including pending resync promises. */
  const flushRenderer = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    for (let pass = 0; pass < 3; pass += 1) {
      const frames = pendingFrames.splice(0);
      if (frames.length === 0 && pass > 0) break;
      frames.forEach((frame) => frame.callback(0));
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  t.after(() => {
    // Same path an unmounted view takes: drop listeners and cancel timers.
    coworkService.cleanupListeners();
  });

  return {
    encoder,
    sent,
    deliver,
    send,
    listeners,
    resyncRequests,
    setLiveQuery: (query) => { holder.liveQuery = query; },
    wireChars: () => wireChars,
    frameCount: () => pendingFrames.length,
    contentDispatches,
    flushRenderer,
    dispatches: () => globalThis.__coworkStreamDispatches,
    state: () => globalThis.__coworkStreamState,
    cleanup: () => coworkService.cleanupListeners(),
    message: () => mainSession.messages[1],
    panelMessage: () => panelSession.messages[1],
    panelSession,
    mainSession,
  };
};

/** One answer growing token by token, exactly as the DSH mapper publishes it. */
const growText = (count) => {
  const chunks = [];
  let text = '';
  for (let index = 0; index < count; index += 1) {
    text += `token-${index} `;
    chunks.push(text);
  }
  return chunks;
};

test('deltas reassemble into exactly the full streamed text', async (t) => {
  const chunks = growText(400);
  const stream = await startStream(t);
  for (const chunk of chunks) {
    stream.deliver(chunk);
    await stream.flushRenderer();
  }

  const expected = chunks[chunks.length - 1];
  assert.equal(stream.message().content, expected, 'main view holds the full text');
  assert.equal(stream.panelMessage().content, expected, 'bot browser panel holds the full text');
  assert.equal(stream.resyncRequests.length, 0, 'a healthy stream never resyncs');

  const legacyWireChars = chunks.reduce((total, chunk) => total + chunk.length, 0);
  assert.ok(
    stream.wireChars() < legacyWireChars / 4,
    `wire bytes must collapse (${stream.wireChars()} vs legacy ${legacyWireChars})`,
  );
  assert.ok(stream.sent.some((payload) => payload.delta !== undefined), 'later ticks are deltas');
});

test('every delta continues the exact text delivered before it', async (t) => {
  const chunks = growText(60);
  const stream = await startStream(t);
  let assembled = '';
  for (const payload of chunks.map((chunk) => stream.send(chunk))) {
    if (payload.delta !== undefined) {
      assert.equal(payload.baseLength, assembled.length, 'base length is the text sent so far');
      assembled += payload.delta;
    } else {
      assembled = payload.content;
    }
    assert.equal(assembled, chunks[stream.sent.indexOf(payload)]);
  }
  assert.equal(stream.sent[0].delta, undefined, 'the first update of a message is full');
});

test('a non-prefix rewrite is sent as full content, never as a delta', async (t) => {
  const stream = await startStream(t);
  stream.deliver('hello world');
  await stream.flushRenderer();

  const rewritten = stream.send('entirely different answer');
  assert.equal(rewritten.delta, undefined);
  assert.equal(rewritten.content, 'entirely different answer');
  stream.listeners.messageUpdate(rewritten);
  await stream.flushRenderer();
  assert.equal(stream.message().content, 'entirely different answer');

  const shorter = stream.send('entirely');
  assert.equal(shorter.delta, undefined);
  assert.equal(shorter.content, 'entirely');
});

test('a metadata payload (finalize) always carries full content', async (t) => {
  const chunks = growText(30);
  const stream = await startStream(t);
  for (const chunk of chunks) {
    stream.deliver(chunk);
    await stream.flushRenderer();
  }

  const expected = chunks[chunks.length - 1];
  const finalize = stream.send(expected, { isStreaming: false, isFinal: true });
  assert.equal(finalize.delta, undefined, 'finalize cannot be a delta');
  assert.equal(finalize.content, expected);
  assert.deepEqual(finalize.metadata, { isStreaming: false, isFinal: true });
  stream.listeners.messageUpdate(finalize);
  await stream.flushRenderer();

  assert.equal(stream.message().content, expected);
  assert.equal(stream.message().metadata.isFinal, true);
  assert.equal(stream.message().metadata.isStreaming, false);
  assert.equal(stream.panelMessage().metadata.isFinal, true);
});

test('a metadata-only payload leaves the reassembled text alone', async (t) => {
  const stream = await startStream(t);
  stream.deliver('streamed so far');
  await stream.flushRenderer();

  stream.listeners.messageUpdate({ sessionId: 's1', messageId: 'm1', metadata: { privateChatNoReply: true } });
  await stream.flushRenderer();
  assert.equal(stream.message().content, 'streamed so far');
  assert.equal(stream.message().metadata.privateChatNoReply, true);
});

test('content kept identical by the IPC cap is not resent', async (t) => {
  const longText = 'y'.repeat(MAX_UPDATE_CHARS + 500);
  const stream = await startStream(t);
  const first = stream.send(longText);
  assert.equal(first.content.length, MAX_UPDATE_CHARS + TRUNCATED_HINT.length);
  assert.ok(first.content.endsWith(TRUNCATED_HINT), 'the legacy truncation marker is preserved');

  // Growth beyond the cap cannot change the capped text; resending it would put
  // another 120k characters through IPC on every tick.
  assert.equal(stream.send(`${longText}and more`), null);
  assert.equal(stream.send(longText), null);
});

test('a dropped delta is repaired by one resync, with no invented content', async (t) => {
  const chunks = growText(20);
  const stream = await startStream(t);
  for (const chunk of chunks.slice(0, 10)) {
    stream.deliver(chunk);
    await stream.flushRenderer();
  }

  // Payload 11 never reaches the renderer; payload 12 does.
  const dropped = stream.send(chunks[10]);
  assert.equal(typeof dropped.delta, 'string');
  stream.deliver(chunks[11]);
  await stream.flushRenderer();

  assert.equal(stream.resyncRequests.length, 1, 'the gap triggers exactly one resync');
  assert.equal(
    stream.message().content,
    chunks[11],
    'the resync adopted the main-side text instead of patching in a stale delta',
  );
  assert.equal(stream.panelMessage().content, chunks[11]);

  // The stream keeps flowing on the realigned baseline.
  stream.deliver(`${chunks[11]}continuing`);
  await stream.flushRenderer();
  assert.equal(stream.message().content, `${chunks[11]}continuing`);
  assert.equal(stream.resyncRequests.length, 1, 'no resync once realigned');
});

test('an unmatched delta is ignored while the main side reports no live text', async (t) => {
  const stream = await startStream(t);
  stream.deliver('alpha beta');
  await stream.flushRenderer();
  stream.setLiveQuery(() => null);

  stream.listeners.messageUpdate({ sessionId: 's1', messageId: 'm1', delta: ' gamma', baseLength: 4 });
  await stream.flushRenderer();
  assert.equal(stream.resyncRequests.length, 1, 'exactly one resync request');
  assert.equal(
    stream.message().content,
    'alpha beta',
    'content is never patched from a delta that does not fit',
  );

  stream.listeners.messageUpdate({ sessionId: 's1', messageId: 'm1', delta: '!', baseLength: 10 });
  await stream.flushRenderer();
  assert.equal(stream.resyncRequests.length, 1, 'no resync storm while awaiting a full payload');

  stream.listeners.messageUpdate({ sessionId: 's1', messageId: 'm1', content: 'alpha beta gamma' });
  await stream.flushRenderer();
  assert.equal(stream.message().content, 'alpha beta gamma', 'the next full payload repairs the stream');
  assert.equal(stream.panelMessage().content, 'alpha beta gamma');
});

test('deltas for a message the renderer never saw are recovered, not applied blindly', async (t) => {
  const stream = await startStream(t);
  // A fresh renderer (window reload mid-stream) has no reassembly state.
  stream.listeners.messageUpdate({ sessionId: 's1', messageId: 'm1', delta: ' mid-answer', baseLength: 9 });
  await stream.flushRenderer();
  assert.equal(stream.resyncRequests.length, 1);
  assert.equal(stream.message().content, '', 'nothing is invented from a delta with no base');

  // Main reports no live baseline either (its encoder has no state for the
  // message), so its next payload is a full send.
  stream.deliver('some long ');
  await stream.flushRenderer();
  assert.equal(stream.message().content, 'some long ');

  stream.deliver('some long mid-answer');
  await stream.flushRenderer();
  assert.equal(stream.message().content, 'some long mid-answer');
  assert.equal(stream.resyncRequests.length, 1, 'the stranded delta does not spin on resync');
});

test('both main-process send sites go through the encoder, keeping the IPC cap', () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'src/main/main.ts'), 'utf8');
  const sliceFrom = (marker, length) => {
    const index = mainSource.indexOf(marker);
    assert.notEqual(index, -1, `main.ts must still contain ${marker}`);
    return mainSource.slice(index, index + length);
  };

  const encoderSetup = sliceFrom('const coworkStreamUiDelta = new CoworkStreamUiDeltaEncoder', 300);
  assert.match(encoderSetup, /truncate: \(value\) => truncateIpcString\(value, IPC_UPDATE_CONTENT_MAX_CHARS\)/);

  const sender = sliceFrom('const sendCoworkStreamMessageUpdate', 900);
  assert.match(sender, /coworkStreamUiDelta\.encode\(/);
  assert.match(sender, /broadcastToRenderers\('cowork:stream:messageUpdate', payload\)/, 'the sender is the only IPC hop');
  assert.doesNotMatch(sender, /truncateIpcString\(update\.content/, 'truncation moved into the encoder');

  const runnerListener = sliceFrom("coworkRunner.on('messageUpdate'", 500);
  assert.match(runnerListener, /sendCoworkStreamMessageUpdate\(sessionId, messageId, \{ content, metadata \}\)/);

  const emitHelper = sliceFrom('const emitCoworkStreamMessageUpdate = (', 260);
  assert.match(emitHelper, /sendCoworkStreamMessageUpdate\(sessionId, messageId, update\)/);

  // Every other send of that channel must have been migrated too.
  const rawSends = mainSource.match(/broadcastToRenderers\('cowork:stream:messageUpdate'/g) ?? [];
  assert.equal(rawSends.length, 1, 'exactly one place sends the channel');

  assert.match(mainSource, /registerIpcHandler\('cowork:stream:liveContent'/);
  const preloadSource = fs.readFileSync(path.join(projectRoot, 'src/main/preload.ts'), 'utf8');
  assert.match(preloadSource, /invoke\('cowork:stream:liveContent', payload\)/);
});
