// Renderer-side whole-message loss detection for the live cowork stream.
//
// Every store-written message carries a per-session monotonic `sequence`. When
// the live tail delivered by `cowork:stream:message` jumps by more than one, a
// base message event never reached this renderer (the 2026-10-22 incident: a
// heartbeat-driven turn's entire output stayed invisible until the owner
// re-selected the session). The service then heals the open session with a
// debounced reload. This file covers: gap → heal, no gap → no heal, and
// seeding from a loaded window.

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-stream-gap-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'cowork-stream-gap.mjs');

  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { coworkService } from './src/renderer/services/cowork.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'cowork-stream-gap-entry.ts',
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
          return { path: 'cowork-gap-store', namespace: 'cowork-gap-test' };
        });
        esbuild.onLoad(
          { filter: /^cowork-gap-store$/, namespace: 'cowork-gap-test' },
          () => ({
            loader: 'js',
            contents: `
              export const store = {
                dispatch(action) {
                  globalThis.__coworkGapDispatches.push(action);
                  return action;
                },
                getState() {
                  return globalThis.__coworkGapState;
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
    delete globalThis.__coworkGapDispatches;
    delete globalThis.__coworkGapState;
  });
  return fixture;
};

const startHarness = async (t) => {
  const { coworkService } = await loadFixture(t);

  globalThis.__coworkGapDispatches = [];
  globalThis.__coworkGapState = {
    cowork: {
      sessions: [{ id: 's1', title: 's1', status: 'running' }],
      currentSessionId: 's1',
      currentSession: {
        id: 's1',
        status: 'running',
        messages: [{ id: 'u1', type: 'user', content: 'hi', timestamp: 1, sequence: 1 }],
      },
      browserOpenSessionId: null,
      unreadSessionIds: [],
      isStreaming: true,
      pendingPermissions: [],
    },
    browserCowork: { currentSession: null, isStreaming: false },
  };

  const listeners = {};
  const getSessionCalls = [];
  const stub = (name) => (callback) => {
    listeners[name] = callback;
    return () => { delete listeners[name]; };
  };

  globalThis.window = {
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
        getSession: async (sessionId) => {
          getSessionCalls.push(sessionId);
          return {
            success: true,
            session: {
              id: sessionId,
              status: 'completed',
              messages: [
                { id: 'u1', type: 'user', content: 'hi', timestamp: 1, sequence: 1 },
                { id: 'm2', type: 'assistant', content: 'healed', timestamp: 2, sequence: 5 },
              ],
            },
          };
        },
      },
    },
  };

  await coworkService.init();
  t.after(() => coworkService.cleanupListeners());

  const send = (seq, id = `m${seq}`) => listeners.message({
    sessionId: 's1',
    message: { id, type: 'assistant', content: `chunk ${seq}`, timestamp: seq, sequence: seq },
  });

  return { coworkService, listeners, send, getSessionCalls };
};

test('a jump in the live sequence tail heals the open session with a debounced reload', async (t) => {
  const { send, getSessionCalls } = await startHarness(t);
  send(2); // contiguous — no gap
  send(5); // 3 and 4 never arrived — gap
  send(9); // another gap inside the debounce window — must not schedule a second heal
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.deepEqual(getSessionCalls, ['s1'], 'exactly one heal reload, for the open session');
});

test('contiguous sequences never trigger the heal', async (t) => {
  const { send, getSessionCalls } = await startHarness(t);
  send(2);
  send(3);
  send(4);
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.deepEqual(getSessionCalls, []);
});

test('a session load seeds the tail: the next live message is measured from the window, not from zero', async (t) => {
  const { coworkService, send, getSessionCalls } = await startHarness(t);
  getSessionCalls.length = 0;
  await coworkService.loadSession('s1'); // window ends at sequence 5
  assert.deepEqual(getSessionCalls, ['s1'], 'the explicit load itself');
  getSessionCalls.length = 0;
  send(6); // contiguous with the seeded tail — no gap
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.deepEqual(getSessionCalls, []);
});

test('the heal is skipped when the gapped session is not on screen', async (t) => {
  const { listeners, getSessionCalls } = await startHarness(t);
  globalThis.__coworkGapState.cowork.currentSessionId = 'other';
  listeners.message({ sessionId: 's1', message: { id: 'm2', type: 'assistant', content: 'x', timestamp: 2, sequence: 2 } });
  listeners.message({ sessionId: 's1', message: { id: 'm5', type: 'assistant', content: 'y', timestamp: 3, sequence: 5 } });
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.deepEqual(getSessionCalls, [], 'background sessions re-read on open; no heal reload');
});
