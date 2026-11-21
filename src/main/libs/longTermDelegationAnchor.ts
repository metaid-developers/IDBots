import type { LongTermSubtask, LongTermTaskDetail } from '../../renderer/types/longTermTask';

/**
 * Long-term delegation anchor — the single implementation of the
 * `<longterm_anchor>` block that must ride every delegation of a long-term
 * sub-project (agent tool `longterm_delegation_anchor` and the hard gate in
 * TwinOrchestrationService.withLongTermAnchor). It carries the ids, the goal,
 * the acceptance criteria, recent journal events, and the worker's duties, so
 * the worker pulls full context from the source instead of relying on the
 * Twin's relay.
 */

export const LONGTERM_ANCHOR_MARKER = '<longterm_anchor>';

export function buildDelegationAnchorBlock(
  detail: LongTermTaskDetail,
  subtask: LongTermSubtask,
  language: string,
): string {
  const zh = language === 'zh';
  const criteria = subtask.acceptanceCriteria.length > 0
    ? subtask.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : zh ? '  （未写验收标准）' : '  (no acceptance criteria on file)';
  const events = detail.events
    .slice(0, 5)
    .map((e) => `  - [${e.kind}/${e.actor}] ${e.detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  const originSessionId = subtask.originSessionId ?? detail.originSessionId ?? detail.definitionSessionId ?? null;
  const originMessageId = subtask.originMessageId ?? detail.originMessageId ?? null;
  const lines = zh
    ? [
        LONGTERM_ANCHOR_MARKER,
        `taskId: ${detail.id}`,
        `subtaskId: ${subtask.id}`,
        originSessionId ? `originSessionId: ${originSessionId}` : '',
        originMessageId ? `originMessageId: ${originMessageId}` : '',
        `任务: ${detail.title}${detail.isLongTerm ? ' [长期]' : ''}`,
        `目标: ${detail.goal}`,
        `子项目 #${subtask.ordinal}: ${subtask.title}`,
        `说明: ${subtask.description || '—'}`,
        '验收标准:',
        criteria,
        `执行通道: ${subtask.preferredChannel ?? '未定'}`,
        `当前状态: ${subtask.status}${subtask.waitNote ? `（等待: ${subtask.waitNote}）` : ''}`,
        events.length > 0 ? '近期动态（最近事件）:' : '',
        ...events,
        '工作要求:',
        '  1. 动手前先调用 task_get(taskId) 或 longterm_task_get(taskId) 读取全量上下文（目标、全部子任务、前序产物、事件流水）；如需核对人类发起时的精确原话，调用 task_context_read(taskId, subtaskId)——不要只凭自然语言转述行动。',
        '  2. 本委派只是该子项目的一个执行切片：禁止自行发明基建/配置面/通道；任何未经验证的前提先问，不要先建。',
        '  3. 长耗时步骤中途用 task_subtask_progress(subtaskId, note) 登记阶段进展；重大发现或偏差用 longterm_event_note(taskId, subtaskId) 记回任务事件流。',
        '  4. 完工或遇阻时，先调用 task_subtask_submit(subtaskId, ...) 将完成情况、数字产物路径/URI 与逐条自证证据（本地目录或文件 / metaapp:// / metafile:// / pin:// / URL）直接写入该子任务对象，再返回交接回执。',
        '</longterm_anchor>',
      ]
    : [
        LONGTERM_ANCHOR_MARKER,
        `taskId: ${detail.id}`,
        `subtaskId: ${subtask.id}`,
        originSessionId ? `originSessionId: ${originSessionId}` : '',
        originMessageId ? `originMessageId: ${originMessageId}` : '',
        `Task: ${detail.title}${detail.isLongTerm ? ' [Long-Term]' : ''}`,
        `Goal: ${detail.goal}`,
        `Sub-project #${subtask.ordinal}: ${subtask.title}`,
        `Description: ${subtask.description || '—'}`,
        'Acceptance criteria:',
        criteria,
        `Preferred channel: ${subtask.preferredChannel ?? 'undecided'}`,
        `Current status: ${subtask.status}${subtask.waitNote ? ` (waiting: ${subtask.waitNote})` : ''}`,
        events.length > 0 ? 'Recent journal events:' : '',
        ...events,
        'Worker duties:',
        '  1. Before acting, call task_get(taskId) or longterm_task_get(taskId) for the full context (goal, all sub-projects, prior artifacts, event journal), and call task_context_read(taskId, subtaskId) whenever you need the owner\'s verbatim origin context — never act on this brief alone.',
        '  2. This delegation is one execution slice of the sub-project: never invent infrastructure/config surfaces/channels; ask about any unverified premise before building.',
        '  3. Record mid-flight milestones via task_subtask_progress(subtaskId, note), and journal major findings or drift with longterm_event_note(taskId, subtaskId).',
        '  4. When finished or blocked, FIRST register your outcome, digital deliverables, and criterion-by-criterion evidence (local dir or file / metaapp:// / metafile:// / pin:// / URL) directly onto the subtask via task_subtask_submit(subtaskId, ...), then return your handoff.',
        '</longterm_anchor>',
      ];
  return lines.filter((line) => line !== '').join('\n');
}
