import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDiagnosticSystemMetadata,
  isRenderableAssistantOrSystemMessage,
} from '../src/renderer/utils/coworkMessageVisibility';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const msg = (overrides: Partial<CoworkMessage>): CoworkMessage => ({
  id: 'm1',
  type: 'system',
  content: '',
  timestamp: 1,
  ...overrides,
});

test('empty replyTruncatedTurn / emptyTerminalTurn / dshTurnStalled diagnostics stay renderable', () => {
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ metadata: { replyTruncatedTurn: true } })), true);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ metadata: { emptyTerminalTurn: true } })), true);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ metadata: { dshTurnStalled: true } })), true);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ metadata: { dshTurnInterrupted: true } })), true);
  assert.equal(isDiagnosticSystemMetadata({ replyTruncatedTurn: true }), true);
  assert.equal(isDiagnosticSystemMetadata({ dshTurnInterrupted: true }), true);
});

test('empty system messages without a diagnostic flag stay hidden', () => {
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ content: '', metadata: {} })), false);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ content: '   ' })), false);
});

test('outbound-IM echoes stay renderable even with an empty body (attachment-only send)', () => {
  // im_send_message writes delivery evidence into the target chat. An
  // attachment-only send has an intentionally empty body — its image/file
  // bubbles ARE the message, so the filter must not drop the row.
  assert.equal(
    isRenderableAssistantOrSystemMessage(msg({
      content: '',
      metadata: {
        imOutboundSend: true,
        imOutboundOk: true,
        imOutboundRecordVersion: 2,
        imOutboundAttachmentItems: [{ name: 'photo.png', path: '/tmp/photo.png', kind: 'image', bytes: 512 }],
      },
    })),
    true,
  );
  assert.equal(isDiagnosticSystemMetadata({ imOutboundSend: true }), false, 'not a diagnostic — its own rule');
});

test('DSH compaction checkpoints (empty body, metadata-only) stay renderable', () => {
  // The mapper stores compaction/summary stubs as content:'' plus
  // { compaction: true, compactedItems, compactedTokens }; the one-line
  // localized notice renders from metadata alone.
  assert.equal(
    isRenderableAssistantOrSystemMessage(msg({ metadata: { compaction: true, compactedItems: 3, compactedTokens: 420 } })),
    true,
  );
  assert.equal(isDiagnosticSystemMetadata({ compaction: true }), true);
});

test('finalized thinking with body stays renderable so the Think row can collapse', () => {
  assert.equal(
    isRenderableAssistantOrSystemMessage(msg({
      type: 'assistant',
      content: 'still figuring it out',
      metadata: { isThinking: true, isStreaming: false, isFinal: true },
    })),
    true,
  );
});

test('empty streaming thinking stays visible; empty finalized thinking is hidden', () => {
  assert.equal(
    isRenderableAssistantOrSystemMessage(msg({
      type: 'assistant',
      content: '',
      metadata: { isThinking: true, isStreaming: true },
    })),
    true,
  );
  assert.equal(
    isRenderableAssistantOrSystemMessage(msg({
      type: 'assistant',
      content: '',
      metadata: { isThinking: true, isStreaming: false, isFinal: true },
    })),
    false,
  );
});

test('ordinary assistant text and error metadata stay renderable', () => {
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ type: 'assistant', content: 'done' })), true);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ content: '', metadata: { error: 'boom' } })), true);
});
