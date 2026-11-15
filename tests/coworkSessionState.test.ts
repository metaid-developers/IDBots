import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CoworkMessage } from '../src/renderer/types/cowork';
import {
  applyCoworkSessionEvent,
  applyCoworkSessionSnapshot,
  createCoworkSessionEventState,
  mergeCoworkSnapshotMessages,
} from '../src/renderer/services/coworkSessionState';

function message(
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata?: CoworkMessage['metadata'],
  sequence?: number,
): CoworkMessage {
  return { id, type, content, timestamp: 1, ...(metadata ? { metadata } : {}), ...(sequence ? { sequence } : {}) };
}

describe('cowork session state', () => {
  it('does not overwrite stream content that changed after a snapshot request started', () => {
    const existing = [message('m1', 'assistant', 'newer text')];
    const merged = mergeCoworkSnapshotMessages(
      existing,
      [message('m1', 'assistant', 'older text')],
      { m1: 2 },
      { baseMessageRevisions: { m1: 1 } },
    );
    assert.equal(merged[0]?.content, 'newer text');
  });

  it('never uses identical text as an optimistic-message identity key', () => {
    const merged = mergeCoworkSnapshotMessages(
      [message('local-new', 'user', 'repeat')],
      [message('server-old', 'user', 'repeat')],
    );
    assert.deepEqual(merged.map((entry) => entry.id), ['server-old', 'local-new']);
  });

  it('replaces only the optimistic message acknowledged by submission id in a snapshot', () => {
    const merged = mergeCoworkSnapshotMessages(
      [
        message('local-submit-1', 'user', 'same text', { submissionId: 'submit-1', optimistic: true }),
        message('local-submit-2', 'user', 'same text', { submissionId: 'submit-2', optimistic: true }),
      ],
      [message('server-submit-1', 'user', 'same text', { submissionId: 'submit-1' })],
    );
    assert.deepEqual(merged.map((entry) => entry.id), ['server-submit-1', 'local-submit-2']);
  });

  it('keeps unacknowledged local sends after server history in display order', () => {
    const merged = mergeCoworkSnapshotMessages(
      [message('local-new', 'user', 'new')],
      [message('server-old', 'assistant', 'old')],
    );
    assert.deepEqual(merged.map((entry) => entry.id), ['server-old', 'local-new']);
  });

  it('preserves earlier loaded pages while merging the latest window', () => {
    const merged = mergeCoworkSnapshotMessages(
      [message('earlier', 'assistant', 'earlier')],
      [message('latest', 'assistant', 'latest')],
      {},
      { preserveMissingMessages: true },
    );
    assert.deepEqual(merged.map((entry) => entry.id), ['earlier', 'latest']);
  });

  it('isolates message, completion, and permission events by session id', () => {
    const visible = createCoworkSessionEventState('visible');
    const background = createCoworkSessionEventState('background');
    const untouched = applyCoworkSessionEvent(visible, {
      type: 'message',
      sessionId: 'background',
      message: message('bg-message', 'assistant', 'BACKGROUND'),
    });
    assert.equal(untouched.state, visible);

    const running = applyCoworkSessionEvent(visible, {
      type: 'message',
      sessionId: 'visible',
      message: message('u1', 'user', 'work'),
    }).state;
    const afterBackgroundComplete = applyCoworkSessionEvent(running, {
      type: 'complete',
      sessionId: 'background',
    });
    assert.equal(afterBackgroundComplete.state, running);

    const withBackgroundPermission = applyCoworkSessionEvent(background, {
      type: 'permission',
      sessionId: 'background',
      request: {
        sessionId: 'background', requestId: 'bg-request', toolName: 'Bash', toolInput: {},
      },
    }).state;
    assert.equal(withBackgroundPermission.pendingPermissions.length, 1);
    assert.equal(running.pendingPermissions.length, 0);
  });

  it('replaces an optimistic bubble when its persisted message event arrives', () => {
    const initial = createCoworkSessionEventState('s1');
    initial.messages.push(message('local-submit-1', 'user', 'same text', { submissionId: 'submit-1', optimistic: true }));
    const next = applyCoworkSessionEvent(initial, {
      type: 'message',
      sessionId: 's1',
      message: message('server-submit-1', 'user', 'same text', { submissionId: 'submit-1' }),
    });
    assert.deepEqual(next.state.messages.map((entry) => entry.id), ['server-submit-1']);
  });

  it('drops a remotely resolved request without inventing an approval outcome', () => {
    const initial = createCoworkSessionEventState('s1');
    const pending = applyCoworkSessionEvent(initial, {
      type: 'permission',
      sessionId: 's1',
      request: { sessionId: 's1', requestId: 'r1', toolName: 'Bash', toolInput: {} },
    }).state;
    const resolved = applyCoworkSessionEvent(pending, {
      type: 'permissionResolved', sessionId: 's1', requestId: 'r1',
    }).state;
    assert.deepEqual(resolved.pendingPermissions, []);
    assert.equal('resolved' in resolved, false);
  });

  it('reports sequence gaps and settles local streaming flags on terminal events', () => {
    const initial = createCoworkSessionEventState('s1');
    const first = applyCoworkSessionEvent(initial, {
      type: 'message', sessionId: 's1', message: message('m1', 'assistant', 'one', { isStreaming: true }, 1),
    });
    assert.equal(first.sequenceGap, false);
    const gap = applyCoworkSessionEvent(first.state, {
      type: 'message', sessionId: 's1', message: message('m3', 'assistant', 'three', undefined, 3),
    });
    assert.equal(gap.sequenceGap, true);
    const complete = applyCoworkSessionEvent(gap.state, { type: 'complete', sessionId: 's1' });
    assert.equal(complete.state.status, 'completed');
    assert.equal(complete.state.messages[0]?.metadata?.isStreaming, false);
  });

  it('merges snapshots by stable id and keeps later local revisions', () => {
    const initial = createCoworkSessionEventState('s1');
    const withMessage = applyCoworkSessionEvent(initial, {
      type: 'message', sessionId: 's1', message: message('m1', 'assistant', 'partial'),
    }).state;
    const withUpdate = applyCoworkSessionEvent(withMessage, {
      type: 'content', sessionId: 's1', messageId: 'm1', content: 'partial plus newer',
    }).state;
    const merged = applyCoworkSessionSnapshot(withUpdate, {
      id: 's1', title: 'Restored', status: 'running', messages: [message('m1', 'assistant', 'partial')],
    } as never, { baseMessageRevisions: withMessage.messageRevisions });
    assert.equal(merged.title, 'Restored');
    assert.equal(merged.messages[0]?.content, 'partial plus newer');
  });
});
