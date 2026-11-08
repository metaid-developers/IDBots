/**
 * Dispatch-report return path for cross-session work orders.
 *
 * When a bot dispatches work with `idbots_session_insert_user_message`
 * (notifySource on) and the dispatched turn settles, the host reports the
 * outcome back into the SOURCE session as a `dispatch_report:<deliveryId>`
 * delivery. Before this path existed, the dispatcher had to either invent a
 * "reply to my session" protocol for the worker (which the host did not
 * enforce, so a compliant worker only printed the report in its OWN session —
 * the orchestrator then waited forever) or poll blindly. The report is
 * host-generated factual plumbing: content of the worker stays untrusted
 * inside <worker_report>, exactly like ORCH-NOTIFY failure reports.
 */

export const DISPATCH_REPORT_EXCERPT_MAX_CHARS = 1600;

export type DispatchReportOutcome = 'completed' | 'failed';

export interface DispatchReportExcerpt {
  excerpt: string;
  truncated: boolean;
}

/** Tail-biased excerpt of the worker's final reply; null when there is none. */
export function tailDispatchReportExcerpt(
  text: string | null | undefined,
  maxChars: number = DISPATCH_REPORT_EXCERPT_MAX_CHARS,
): DispatchReportExcerpt | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return { excerpt: trimmed, truncated: false };
  return { excerpt: trimmed.slice(trimmed.length - maxChars), truncated: true };
}

/**
 * Deterministic message body for one settled dispatch (same inputs → same
 * bytes, so the `dispatch_report:<deliveryId>` idempotency dedupe holds).
 */
export function buildDispatchReportMessage(input: {
  deliveryId: string;
  targetSessionId: string;
  outcome: DispatchReportOutcome;
  /** Short machine reason for a failure (delivery error or turn diagnostic). */
  failureReason?: string | null;
  /** Worker's final reply (tail excerpt already applied by the caller). */
  finalReply: string | null;
  finalReplyTruncated?: boolean;
}): string {
  const lines: string[] = [
    `[DISPATCH-REPORT] 你此前投递到会话 ${input.targetSessionId} 的消息（deliveryId ${input.deliveryId}）已执行完毕，outcome=${input.outcome}。`,
  ];
  if (input.outcome === 'failed') {
    const reason = String(input.failureReason ?? '').trim() || 'unknown reason';
    lines.push(`失败原因：${reason}`);
  }
  const reply = String(input.finalReply ?? '').trim();
  if (reply) {
    const truncationNote = input.finalReplyTruncated
      ? `（仅截取末尾 ${DISPATCH_REPORT_EXCERPT_MAX_CHARS} 字，完整内容请读会话）`
      : '';
    lines.push(`该回合最后一条回复${truncationNote}：`, `<worker_report trust="untrusted">${reply}</worker_report>`);
  } else if (input.outcome === 'completed') {
    lines.push('该回合没有产生可见回复。');
  }
  lines.push(`如需完整上下文，用 idbots_session_read_all / idbots_session_read_latest 读取会话 ${input.targetSessionId}。本通知是宿主自动回执，若结果已满足需要，无需专门回复。`);
  return lines.join('\n');
}
