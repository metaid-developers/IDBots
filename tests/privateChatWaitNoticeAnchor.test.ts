import test from 'node:test';
import assert from 'node:assert/strict';

import { anchorPrivateChatWaitNoticesBeforeReplies } from '../src/renderer/utils/privateChatWaitNoticeOrder';
import type { CoworkMessage } from '../src/renderer/types/cowork';

/**
 * The wait-notice anchoring contract (display-side only):
 *   - a wait notice whose reply is stored BEFORE it (the broadcast-completed-
 *     after-authoring artifact) is re-anchored directly before that reply;
 *   - a notice with no matching reply in the window, or already sitting
 *     before its reply, keeps its stored position;
 *   - everything else keeps its stored relative order.
 */

const PIN = 'ab'.repeat(32) + 'i0';
const OTHER_PIN = 'cd'.repeat(32) + 'i0';

function message(input: {
  id: string;
  type?: CoworkMessage['type'];
  content?: string;
  metadata?: Record<string, unknown>;
}): CoworkMessage {
  return {
    id: input.id,
    type: input.type ?? 'assistant',
    content: input.content ?? input.id,
    timestamp: 1_770_000_000_000,
    ...(input.metadata ? { metadata: input.metadata as CoworkMessage['metadata'] } : {}),
  } as CoworkMessage;
}

function ids(messages: CoworkMessage[]): string[] {
  return messages.map((message) => message.id);
}

test('notice stored after its reply is re-anchored directly before the reply', () => {
  const transcript = [
    message({ id: 'inbound', type: 'user', metadata: { sourceChannel: 'metaweb_private', pinId: PIN } }),
    message({
      id: 'reply',
      metadata: {
        sourceChannel: 'metaweb_private',
        direction: 'outgoing',
        privateChatReplyForPinId: PIN,
        privateChatDeliveryStatus: 'sent',
      },
    }),
    message({
      id: 'notice',
      metadata: {
        sourceChannel: 'metaweb_private',
        direction: 'outgoing',
        privateChatSkillWaitNotice: true,
        privateChatSkillWaitNoticeForPinId: PIN,
        privateChatDeliveryStatus: 'sent',
      },
    }),
  ];
  assert.deepEqual(
    ids(anchorPrivateChatWaitNoticesBeforeReplies(transcript)),
    ['inbound', 'notice', 'reply'],
  );
});

test('notice already sitting before its reply keeps its position', () => {
  const transcript = [
    message({ id: 'inbound', type: 'user', metadata: { pinId: PIN } }),
    message({
      id: 'notice',
      metadata: { privateChatSkillWaitNotice: true, privateChatSkillWaitNoticeForPinId: PIN },
    }),
    message({ id: 'reply', metadata: { privateChatReplyForPinId: PIN } }),
  ];
  assert.deepEqual(
    ids(anchorPrivateChatWaitNoticesBeforeReplies(transcript)),
    ['inbound', 'notice', 'reply'],
  );
});

test('notice with no matching reply in the window keeps its stored position', () => {
  const transcript = [
    message({ id: 'inbound', type: 'user', metadata: { pinId: PIN } }),
    message({ id: 'unrelated', content: 'hello', metadata: { direction: 'outgoing' } }),
    message({
      id: 'notice',
      metadata: { privateChatSkillWaitNotice: true, privateChatSkillWaitNoticeForPinId: PIN },
    }),
  ];
  assert.deepEqual(
    ids(anchorPrivateChatWaitNoticesBeforeReplies(transcript)),
    ['inbound', 'unrelated', 'notice'],
  );
});

test('messages between the reply and the notice keep their stored order', () => {
  const transcript = [
    message({ id: 'inbound', type: 'user', metadata: { pinId: PIN } }),
    message({ id: 'reply', metadata: { privateChatReplyForPinId: PIN } }),
    message({ id: 'newer-inbound', type: 'user', metadata: { pinId: OTHER_PIN } }),
    message({
      id: 'notice',
      metadata: { privateChatSkillWaitNotice: true, privateChatSkillWaitNoticeForPinId: PIN },
    }),
  ];
  assert.deepEqual(
    ids(anchorPrivateChatWaitNoticesBeforeReplies(transcript)),
    ['inbound', 'notice', 'reply', 'newer-inbound'],
  );
});

test('two artifact pairs anchor independently', () => {
  const transcript = [
    message({ id: 'reply-a', metadata: { privateChatReplyForPinId: PIN } }),
    message({
      id: 'notice-a',
      metadata: { privateChatSkillWaitNotice: true, privateChatSkillWaitNoticeForPinId: PIN },
    }),
    message({ id: 'reply-b', metadata: { privateChatReplyForPinId: OTHER_PIN } }),
    message({
      id: 'notice-b',
      metadata: { privateChatSkillWaitNotice: true, privateChatSkillWaitNoticeForPinId: OTHER_PIN },
    }),
  ];
  assert.deepEqual(
    ids(anchorPrivateChatWaitNoticesBeforeReplies(transcript)),
    ['notice-a', 'reply-a', 'notice-b', 'reply-b'],
  );
});

test('notices without a pin reference and plain transcripts are returned untouched', () => {
  const bare = [
    message({ id: 'a', content: 'one' }),
    message({ id: 'b', content: 'two' }),
  ];
  assert.equal(anchorPrivateChatWaitNoticesBeforeReplies(bare), bare);

  const orphanNotice = [
    message({ id: 'a', content: 'one' }),
    message({
      id: 'notice',
      metadata: { privateChatSkillWaitNotice: true },
    }),
  ];
  assert.equal(anchorPrivateChatWaitNoticesBeforeReplies(orphanNotice), orphanNotice);
});
