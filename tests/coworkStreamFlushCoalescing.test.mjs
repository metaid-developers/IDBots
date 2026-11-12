// Renderer-side coalescing of the incremental cowork stream.
//
// Stream payloads now arrive as deltas and are buffered per message, so N
// updates within one frame (parallel sessions, IM/A2A relays, the Bot Browser
// panel) land as a single store dispatch, and the append fast path keeps
// today's message for the streaming bubble while every other message keeps its
// object identity — which is what stops the transcript from re-rendering every
// turn on every chunk.
//
// The protocol itself (reassembly, resync, truncation) is covered by
// coworkStreamDeltaProtocol.test.mjs; this file covers the dispatch cadence,
// the diverged-slice fallback, the unread bookkeeping and cleanup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadFixture = async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-stream-coalesce-'));
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
      sourcefile: 'cowork-stream-coalesce-entry.ts',
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
          return { path: 'cowork-coalesce-store', namespace: 'cowork-coalesce-test' };
        });
        esbuild.onLoad(
          { filter: /^cowork-coalesce-store$/, namespace: 'cowork-coalesce-test' },
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
                  globalThis.__coworkCoalesceDispatches.push(action);
                  const payload = action && action.payload;
                  if (payload && typeof payload.sessionId === 'string' && typeof payload.messageId === 'string') {
                    // Each slice reducer only touches its own session, so the
                    // stub must not cross-apply a task-view dispatch to the panel.
                    const session = action.type.startsWith('browserCowork/')
                      ? globalThis.__coworkCoalesceState.browserCowork.currentSession
                      : globalThis.__coworkCoalesceState.cowork.currentSession;
                    applyUpdate(session, payload);
                  }
                  return action;
                },
                getState() {
                  return globalThis.__coworkCoalesceState;
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
    delete globalThis.__coworkCoalesceDispatches;
    delete globalThis.__coworkCoalesceSessions;
    delete globalThis.__coworkCoalesceState;
  });
  return fixture;
};

const startHarness = async (t, { withFrames = true } = {}) => {
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
  globalThis.__coworkCoalesceSessions = [mainSession, panelSession];
  globalThis.__coworkCoalesceDispatches = [];
  globalThis.__coworkCoalesceState = {
    cowork: {
      sessions: [],
      currentSessionId: 's1',
      currentSession: mainSession,
      browserOpenSessionId: null,
      unreadSessionIds: [],
      isStreaming: true,
      pendingPermissions: [],
    },
    browserCowork: { currentSession: panelSession, isStreaming: true },
  };

  const listeners = {};
  const pendingFrames = [];
  let nextFrameId = 1;
  const stub = (name) => (callback) => {
    listeners[name] = callback;
    return () => { delete listeners[name]; };
  };

  globalThis.window = {
    ...(withFrames
      ? {
        requestAnimationFrame: (callback) => {
          const id = nextFrameId++;
          pendingFrames.push({ id, callback });
          return id;
        },
        cancelAnimationFrame: (id) => {
          const index = pendingFrames.findIndex((frame) => frame.id === id);
          if (index !== -1) pendingFrames.splice(index, 1);
        },
      }
      : {}),
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
        getStreamLiveContent: async () => ({ success: false }),
      },
    },
  };

  await coworkService.init();

  const encoder = new CoworkStreamUiDeltaEncoder({ truncate: (value) => value });
  let text = '';
  const deliver = (piece) => {
    text += piece;
    const payload = encoder.encode({ sessionId: 's1', messageId: 'm1', content: text });
    if (payload) listeners.messageUpdate(payload);
    return payload;
  };

  const drainFrames = () => {
    const frames = pendingFrames.splice(0);
    frames.forEach((frame) => frame.callback(0));
    return frames.length;
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    for (let pass = 0; pass < 3; pass += 1) {
      if (drainFrames() === 0 && pass > 0) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const contentDispatches = () => globalThis.__coworkCoalesceDispatches
    .filter((action) => /(updateMessageContent|appendMessageContent|updateBrowserMessageContent|appendBrowserMessageContent)$/.test(action.type));

  t.after(() => coworkService.cleanupListeners());

  return {
    coworkService,
    deliver,
    settle,
    drainFrames,
    frameCount: () => pendingFrames.length,
    contentDispatches,
    dispatches: () => globalThis.__coworkCoalesceDispatches,
    state: () => globalThis.__coworkCoalesceState,
    mainSession,
    panelSession,
    listeners,
    text: () => text,
  };
};

test('a burst of stream updates lands as one dispatch pair per frame', async (t) => {
  const harness = await startHarness(t);

  for (let index = 0; index < 40; index += 1) harness.deliver(`token-${index} `);
  assert.equal(harness.frameCount(), 1, 'one frame scheduled for the whole burst');
  assert.equal(harness.contentDispatches().length, 0, 'nothing lands before the frame');

  await harness.settle();
  assert.equal(harness.contentDispatches().length, 2, 'one dispatch per open slice, not one per payload');
  assert.equal(harness.mainSession.messages[1].content, harness.text());
  assert.equal(harness.panelSession.messages[1].content, harness.text());

  // The next frame appends only the grown tail instead of rewriting the whole
  // text: the reducer touches one message object and nothing else.
  const before = harness.contentDispatches().length;
  harness.deliver('and more ');
  await harness.settle();
  const landed = harness.contentDispatches().slice(before);
  assert.ok(
    landed.some((action) => /appendMessageContent$/.test(action.type)),
    'the task view takes the append path',
  );
  assert.equal(harness.mainSession.messages[1].content, harness.text());
});

test('a background stream still raises the unread marker without touching content', async (t) => {
  const harness = await startHarness(t);
  // The user is looking at another session while this one streams.
  harness.state().cowork.currentSessionId = 's2';
  harness.state().cowork.currentSession = { id: 's2', status: 'idle', messages: [] };
  harness.state().browserCowork.currentSession = null;

  harness.deliver('background token');
  await harness.settle();

  const landed = harness.contentDispatches();
  assert.equal(landed.length, 1, 'the reducer still sees the session traffic');
  assert.equal(landed[0].payload.sessionId, 's1');
  assert.equal(landed[0].payload.content, undefined, 'no content is shipped for a session nobody renders');
  assert.equal(landed[0].payload.delta, undefined);
});

test('a slice that diverged from the stream gets the whole text, not a bogus append', async (t) => {
  const harness = await startHarness(t);
  harness.deliver('alpha ');
  await harness.settle();
  harness.deliver('beta ');
  await harness.settle();
  assert.equal(harness.panelSession.messages[1].content, harness.text());

  // The panel reloads its copy from the database mid-stream.
  harness.panelSession.messages[1].content = 'stale database copy';
  const before = harness.contentDispatches().length;
  harness.deliver('gamma');
  await harness.settle();

  const landed = harness.contentDispatches().slice(before);
  assert.ok(
    landed.some((action) => action.type === 'cowork/appendMessageContent'),
    'the untouched slice keeps appending',
  );
  assert.ok(
    landed.some((action) => action.type === 'browserCowork/updateBrowserMessageContent'
      && action.payload.content === harness.text()),
    'the diverged slice is rewritten with the full streamed text',
  );
  assert.equal(harness.panelSession.messages[1].content, harness.text());
  assert.equal(harness.mainSession.messages[1].content, harness.text());
});

test('updates still land when the window throttles animation frames', async (t) => {
  const harness = await startHarness(t, { withFrames: false });
  harness.deliver('no frames available');
  assert.equal(harness.frameCount(), 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(harness.mainSession.messages[1].content, harness.text(), 'the trailing timer is the ceiling');
});

test('cleanup drops buffered updates and cancels the pending flush', async (t) => {
  const harness = await startHarness(t);
  harness.deliver('never delivered');
  assert.equal(harness.frameCount(), 1);
  harness.coworkService.cleanupListeners();
  assert.equal(harness.drainFrames(), 0, 'the scheduled frame is cancelled');
  await harness.settle();
  assert.equal(harness.mainSession.messages[1].content, '');
  assert.equal(harness.contentDispatches().length, 0);
});
