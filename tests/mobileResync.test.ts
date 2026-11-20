import assert from 'node:assert/strict';
import test from 'node:test';
import { performResync, recoverNativeAppState } from '../src/mobile/app/hooks/useResync.ts';
import { mergeCoworkSnapshotMessages } from '../src/renderer/services/coworkSessionState.ts';
import type { CoworkMessage } from '../src/renderer/types/cowork.ts';

/**
 * REQ-E-5 reconnect resync: on every (re)connect the shell re-pulls hot state
 * in a fixed C2-ordered sequence. These tests drive the pure sequence with a
 * fake electron that records invoke order, and exercise the message merge
 * that rebuilds the transcript without duplicates.
 */

interface RecordedCall {
  channel: string;
  args: unknown[];
}

/** Fake electron whose invokes record themselves in order. */
function makeFakeElectron(options: { failGetSession?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const pendingPermissions = [
    {
      sessionId: 's-1',
      request: {
        sessionId: 's-1',
        toolName: 'write_file',
        toolInput: { path: '/data/workspace/x.txt' },
        requestId: 'req-1',
        toolUseId: null,
      },
      createdAt: 123,
    },
  ];
  const electron = {
    cowork: {
      getSession: async (sessionId: string, opts?: { messageLimit?: number }) => {
        calls.push({ channel: 'cowork.getSession', args: [sessionId, opts] });
        if (options.failGetSession) throw new Error('offline again');
        return {
          success: true,
          session: {
            id: sessionId,
            title: 'Demo',
            status: 'running',
            messages: [
              { id: 'm-1', type: 'user', content: 'hello', timestamp: 1 },
              { id: 'm-2', type: 'assistant', content: 'hi there', timestamp: 2 },
            ],
          },
        };
      },
      getStreamLiveContent: async (payload: { sessionId: string; messageId: string }) => {
        calls.push({ channel: 'cowork.getStreamLiveContent', args: [payload] });
        return { success: true, content: 'partial stream text' };
      },
    },
    mobile: {
      listPendingPermissions: async () => {
        calls.push({ channel: 'mobile.listPendingPermissions', args: [] });
        return pendingPermissions;
      },
    },
  };
  return { electron, calls, pendingPermissions };
}

const context = {
  getOpenSessionId: () => 's-1',
  getStreamingMessage: () => ({ sessionId: 's-1', messageId: 'm-2' }),
};

test('performResync runs the C2-ordered sequence: getSession, getStreamLiveContent, listPendingPermissions', async () => {
  const { electron, calls, pendingPermissions } = makeFakeElectron();
  const snapshot = await performResync(electron as never, context);

  assert.deepEqual(
    calls.map((call) => call.channel),
    ['cowork.getSession', 'cowork.getStreamLiveContent', 'mobile.listPendingPermissions'],
    'the three pulls must run strictly in order',
  );
  assert.equal(calls[0].args[0], 's-1');
  assert.deepEqual(calls[1].args[0], { sessionId: 's-1', messageId: 'm-2' });

  assert.equal(snapshot.session?.id, 's-1');
  assert.equal(snapshot.session?.messages.length, 2);
  assert.deepEqual(snapshot.liveContent, { sessionId: 's-1', messageId: 'm-2', content: 'partial stream text' });
  assert.deepEqual(snapshot.pendingPermissions, pendingPermissions);
});

test('performResync still runs later steps when an earlier step fails', async () => {
  const { electron, calls } = makeFakeElectron({ failGetSession: true });
  const snapshot = await performResync(electron as never, context);
  assert.equal(snapshot.session, null);
  assert.deepEqual(
    calls.map((call) => call.channel),
    ['cowork.getSession', 'cowork.getStreamLiveContent', 'mobile.listPendingPermissions'],
  );
  assert.equal(snapshot.liveContent?.content, 'partial stream text');
  assert.equal(snapshot.pendingPermissions.length, 1);
});

test('performResync skips the session and stream pulls when nothing is open', async () => {
  const { electron, calls } = makeFakeElectron();
  const snapshot = await performResync(electron as never, {
    getOpenSessionId: () => null,
    getStreamingMessage: () => null,
  });
  assert.deepEqual(
    calls.map((call) => call.channel),
    ['mobile.listPendingPermissions'],
  );
  assert.equal(snapshot.session, null);
  assert.equal(snapshot.liveContent, null);
});

test('native foreground resyncs and probes an already-online bridge', () => {
  let reconnects = 0;
  let resyncs = 0;
  const bridge = {
    connection: { getState: () => 'online' },
    gateway: { reconnectNow: () => { reconnects += 1; } },
  };
  recoverNativeAppState(true, bridge as never, () => { resyncs += 1; });
  assert.equal(reconnects, 1);
  assert.equal(resyncs, 1);
});

test('native foreground reconnects a disconnected gateway and lets onReconnected resync', () => {
  let reconnects = 0;
  let resyncs = 0;
  const bridge = {
    connection: { getState: () => 'reconnecting' },
    gateway: { reconnectNow: () => { reconnects += 1; } },
  };
  recoverNativeAppState(true, bridge as never, () => { resyncs += 1; });
  assert.equal(reconnects, 1);
  assert.equal(resyncs, 0, 'the existing reconnect notification owns the resync');
});

test('native background and disconnected mock events do not trigger recovery work', () => {
  let reconnects = 0;
  let resyncs = 0;
  const real = {
    connection: { getState: () => 'offline' },
    gateway: { reconnectNow: () => { reconnects += 1; } },
  };
  recoverNativeAppState(false, real as never, () => { resyncs += 1; });
  const mock = { connection: { getState: () => 'offline' } };
  recoverNativeAppState(true, mock as never, () => { resyncs += 1; });
  assert.equal(reconnects, 0);
  assert.equal(resyncs, 0);
});

function raw(id: string, type: CoworkMessage['type'], content: string, metadata?: CoworkMessage['metadata']): CoworkMessage {
  return { id, type, content, timestamp: 1, ...(metadata ? { metadata } : {}) };
}

test('snapshot merge uses stable ids and never text equality for optimistic sends', () => {
  const merged = mergeCoworkSnapshotMessages(
    [
      raw('local-1', 'user', 'hello'),
      raw('m-2', 'assistant', 'partial', { isStreaming: true }),
    ],
    [
      raw('m-1', 'user', 'hello'),
      raw('m-2', 'assistant', 'hi there', { isStreaming: true }),
    ],
    { 'm-2': 1 },
    { baseMessageRevisions: { 'm-2': 1 } },
  );

  assert.deepEqual(merged.map((entry) => entry.id), ['m-1', 'm-2', 'local-1']);
  assert.equal(merged.filter((entry) => entry.type === 'user').length, 2);
  assert.equal(merged.find((entry) => entry.id === 'm-2')?.content, 'hi there');
});

test('snapshot merge keeps unacked local sends without retaining stale non-local rows', () => {
  const merged = mergeCoworkSnapshotMessages(
    [
      raw('m-0', 'assistant', 'older'),
      raw('local-2', 'user', 'offline question'),
    ],
    [raw('m-1', 'user', 'hello')],
  );
  const ids = merged.map((entry) => entry.id);
  assert.deepEqual(ids, ['m-1', 'local-2']);
  assert.ok(!ids.includes('m-0'));
  assert.equal(new Set(ids).size, ids.length);
});
