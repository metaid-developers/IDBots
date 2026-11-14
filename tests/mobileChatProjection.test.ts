import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CoworkMessage } from '../src/renderer/types/cowork';
import { projectChatMessages } from '../src/mobile/app/chatProjection';
import {
  buildConversationTurns,
  buildDisplayItems,
  getVisibleAssistantItems,
} from '../src/renderer/services/coworkConversationProjection';

function message(id: string, type: CoworkMessage['type'], content: string, metadata?: CoworkMessage['metadata']): CoworkMessage {
  return { id, type, content, timestamp: 1, ...(metadata ? { metadata } : {}) };
}

describe('mobile chat projection', () => {
  it('matches desktop Assistant visibility for a mixed transcript', () => {
    const messages = [
      message('u1', 'user', 'Do the work'),
      message('think', 'assistant', 'RAW_THINKING', { isThinking: true, isStreaming: true }),
      message('tool', 'tool_use', 'RAW_TOOL_EVENT', { toolName: 'Bash', toolUseId: 'call-1' }),
      message('result', 'tool_result', 'RAW_TOOL_RESULT', { toolUseId: 'call-1' }),
      message('progress', 'assistant', 'Working on it', { narration: true }),
      message('subagent', 'system', 'INTERNAL', { subagentEvent: { event: 'task_started', taskId: 't1' } }),
      message('answer', 'assistant', 'Done'),
      message('diagnostic', 'system', '', { emptyTerminalTurn: true }),
    ];
    const mobile = projectChatMessages(messages);
    assert.deepEqual(mobile.map((entry) => entry.id), ['u1', 'progress', 'answer', 'diagnostic']);
    assert.equal(mobile.at(-1)?.diagnostic, 'emptyTerminal');

    const [turn] = buildConversationTurns(buildDisplayItems(messages));
    const desktopIds = getVisibleAssistantItems(turn!.assistantItems, true).map((item) => item.message.id);
    assert.deepEqual(mobile.filter((entry) => entry.role !== 'user').map((entry) => entry.id), desktopIds);
  });

  it('strips think tags and never creates an empty Assistant bubble', () => {
    const views = projectChatMessages([
      message('a1', 'assistant', '<think>private</think>Visible answer'),
      message('a2', 'assistant', '<think>private only</think>'),
    ]);
    assert.deepEqual(views.map((entry) => [entry.id, entry.text]), [['a1', 'Visible answer']]);
  });

  it('hides scheduled-task lifecycle and follow-up protocols without changing the user task or answer', () => {
    const lifecycle = '[Scheduled task lifecycle] Task "Short result" (id abc), fire #1. Retire it when done.\n\n';
    const contract = '[End-of-run follow-up contract] End this run\'s final message with exactly ONE tag:\nThe tag routes this session between the owner\'s Follow-Up list and the autonomous fold; a missing or wrong tag costs the owner attention they did not owe.\n\n';
    const views = projectChatMessages([
      message('scheduled', 'user', `${lifecycle}${contract}只回复：定时任务执行成功。不要调用工具。`),
      message('answer', 'assistant', '定时任务执行成功\n[FOLLOW_UP: none]'),
    ]);
    assert.deepEqual(views.map((entry) => [entry.id, entry.text]), [
      ['scheduled', '只回复：定时任务执行成功。不要调用工具。'],
      ['answer', '定时任务执行成功'],
    ]);
  });

  it('does not strip ordinary text that merely mentions follow-up protocols', () => {
    const ordinary = 'Explain [Scheduled task lifecycle] and [End-of-run follow-up contract] to me';
    const views = projectChatMessages([message('u1', 'user', ordinary)]);
    assert.equal(views[0]?.text, ordinary);
  });

  it('keeps terminal errors and owner progress visible — unknown ones as the localized one-liner', () => {
    const views = projectChatMessages([
      message('progress', 'assistant', 'A problem needs attention', { narration: true, ownerUpdateKind: 'problem' }),
      // No diagnostic metadata, no relay-quota code: an unknown terminal error
      // collapses into the localized turnFailed one-liner (ChatScreen renders
      // mobile.chat.diagnostic.turnFailed), never the raw upstream copy.
      message('error', 'system', 'Error: turn failed'),
    ]);
    assert.deepEqual(views.map((entry) => entry.role), ['assistant', 'error']);
    assert.equal(views[1]?.diagnostic, 'turnFailed');
    assert.equal(views[1]?.text, '');
  });
});
