/**
 * Cerebellum + deterministic triage for A2A (Bot-to-Bot) conversations.
 *
 * Implements the "silence is a first-class outcome" principle while surfacing
 * only the three owner-relevant classes of FollowUpEvent:
 *  - 'inform' (`handled` | `declined` | `observed`): completed deal/task, or
 *    an out-of-policy/unfavorable request already declined by the local bot.
 *  - 'light_decision': a 1-turn owner call (approve/reject/pick option).
 *  - 'task_proposal': a multi-step / multi-bot request worth promoting to a
 *    formal Managed Task (`long_term_tasks`) once the owner agrees.
 *
 * Pure and Electron-free so unit tests can import it directly. Never throws.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';
import type { FollowUpInformOutcome, FollowUpTier } from '../proactiveFollowUpStore';

export const CEREBELLUM_A2A_TRIAGE_TIMEOUT_MS = 2800;
export const CEREBELLUM_A2A_TRIAGE_THRESHOLD = 0.5;

export interface A2AFollowUpTriageInput {
  localBotName: string;
  localBotRole: 'twin' | 'worker';
  peerName?: string | null;
  peerGlobalMetaId?: string | null;
  peerMessageText: string;
  localReplyText?: string | null;
  /** Set when auto-reply did not run because auto-reply is off or hit turn cap. */
  autoReplySuppressedReason?: 'auto_reply_disabled' | 'max_turns_reached' | null;
  /** True when an orchestration Worker delegation is actively running for this A2A session. */
  hasActiveWorkerDelegation?: boolean;
}

export type A2AFollowUpTriageVerdict =
  | { action: 'silent'; reason: string }
  | {
      action: 'enqueue';
      tier: FollowUpTier;
      informOutcome?: FollowUpInformOutcome;
      title: string;
      summary: string;
      question?: string;
      recommendation?: string;
      reason: string;
    };

function truncateUtf16Prefix(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function collapseWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

const TRIVIAL_NOISE_PATTERNS: readonly RegExp[] = [
  /^(?:(?:bye|goodbye|ok|okay|ack|ping|pong|thanks|thank you|you're welcome|no problem|np|got it|roger|received)[,.!~\s]*)+$/i,
  /^(?:(?:收到|好的|好|明白|了解|谢谢|多谢|感谢|辛苦了|不客气|不用谢|没事|再见|拜拜|没问题|嗯嗯)[，,、。！!~\s]*)+$/u,
  /^\[NO_REPLY\]$/i,
  /^HEARTBEAT_OK$/i,
];

/** Local bot explicitly states it is escalating / waiting on its human owner. */
const OWNER_ESCALATION_PATTERNS: readonly RegExp[] = [
  /(?<![无不非])(?:请示|征求|询问|转告|上报|汇报给?|同步给?|反馈给?|跟)(?:一下)?(?:我(?:们|的)?|咱们)?(?:主人|主理人|号主|人类|老板|owner)/iu,
  /(?<![无不非])(?:需(?:要)?|待|等(?:待)?)(?:我(?:们|的)?|本地|咱们)?(?:主人|主理人|号主|人类|老板|owner)(?:来)?(?:拍板|确认|批准|决定|定夺|授权|同意|回复|立项)/iu,
  /\b(?:ask|check with|confirm with|escalate to|awaiting|waiting (?:on|for)) (?:my |the |our )?(?:human |local )?owner\b/i,
  /\bneeds? (?:my |the |our )?(?:owner(?:'s)?|human) (?:approval|confirmation|decision|sign-off|permission)\b/i,
];

/** Local bot already refused / declined the peer's request per policy or bounds. */
const AUTO_DECLINED_PATTERNS: readonly RegExp[] = [
  /(?:已|已经|明确|正式)?(?:婉拒|回绝|拒绝|驳回)/u,
  /(?:暂不|不能|无法|不便|恕难|不会)(?:接受|答应|同意|提供|配合|降价|出售|执行|授权|开放)/u,
  /(?:低于底价|超出(?:授权|权限|预算|范围)|不符合(?:规则|要求|策略)).*(?:拒绝|不予|无法|不接受|免谈)/u,
  /\b(?:have to |must )?(?:decline|refuse|reject)(?:ed|ing)?\b/i,
  /\b(?:cannot|can't|unable to|won't) (?:accept|approve|grant|disclose|share|sell below|lower the price)\b/i,
];

/** Substantive completed outcome / transaction / verified delivery in A2A. */
const HANDLED_COMPLETION_PATTERNS: readonly RegExp[] = [
  /(?:已完成|已经完成|已交割|已发货|已转账|已打款|已到账|成交完成|核对无误并收口)/u,
  /(?:txid|pinid|pin:\/\/)[a-z0-9:_-]{8,}.*(?:已发送|已广播|已完成|已交付|delivered|broadcast|settled)/iu,
  /\b(?:order fulfilled|payment verified and settled|nft transferred|delivery completed)\b/i,
];

/** Multi-step / multi-bot engineering or complex deliverable signals -> task_proposal. */
const COMPLEX_TASK_CANDIDATE_PATTERNS: readonly RegExp[] = [
  /(?:修(?:复|改)\s*bug|重构|开发(?:新)?功能|联调|架构改造|排查并修复|编写脚本|批量制作|多轮|立项|排期)/iu,
  /\b(?:fix (?:the |a )?bug|implement|refactor|multi-step|architecture|feature request|codebase|pull request|deploy)\b/i,
];

/** Interim hold while an already-spawned Worker is actively investigating. */
const INTERIM_WORKER_HOLD_PATTERNS: readonly RegExp[] = [
  /(?:已(?:经)?(?:派|安排|让|转交|委派)|正在(?:排查|核查|核实|验证|检查)|(?:查清|核实|排查|确认)(?:完|之)?后.*(?:回复|答复|同步)|稍后(?:回复|同步)|等.*(?:结果|回执|核实))/u,
  /\b(?:investigating|checking now|delegated to|will get back to you shortly)\b/i,
];

export function isTrivialA2ANoise(text: string): boolean {
  const clean = collapseWhitespace(text);
  if (!clean) return true;
  return TRIVIAL_NOISE_PATTERNS.some((re) => re.test(clean));
}

export function hasOwnerEscalationSignal(text: string): boolean {
  const clean = collapseWhitespace(text);
  if (!clean) return false;
  return OWNER_ESCALATION_PATTERNS.some((re) => re.test(clean));
}

export function hasAutoDeclinedSignal(text: string): boolean {
  const clean = collapseWhitespace(text);
  if (!clean) return false;
  return AUTO_DECLINED_PATTERNS.some((re) => re.test(clean));
}

export function hasHandledCompletionSignal(text: string): boolean {
  const clean = collapseWhitespace(text);
  if (!clean) return false;
  return HANDLED_COMPLETION_PATTERNS.some((re) => re.test(clean));
}

export function isComplexTaskCandidateText(text: string): boolean {
  const clean = collapseWhitespace(text);
  if (!clean) return false;
  return COMPLEX_TASK_CANDIDATE_PATTERNS.some((re) => re.test(clean));
}

function buildActorLabel(input: A2AFollowUpTriageInput): {
  peerLabel: string;
  botLabel: string;
} {
  const peerLabel = collapseWhitespace(input.peerName)
    || (input.peerGlobalMetaId ? `Bot (${input.peerGlobalMetaId.slice(0, 10)}…)` : '远端 Bot');
  const botLabel = collapseWhitespace(input.localBotName) || '本地 Bot';
  return { peerLabel, botLabel };
}

/**
 * Deterministic fast-path classifier. Returns a definitive verdict when strong
 * signals or noise guards match, or `null` when ambiguous enough to consult
 * the Cerebellum Noul (if available).
 */
export function evaluateDeterministicA2ATriage(
  input: A2AFollowUpTriageInput,
): A2AFollowUpTriageVerdict | null {
  const peerText = collapseWhitespace(input.peerMessageText);
  const replyText = collapseWhitespace(input.localReplyText);
  const { peerLabel, botLabel } = buildActorLabel(input);

  if (!peerText || (isTrivialA2ANoise(peerText) && (!replyText || isTrivialA2ANoise(replyText)))) {
    return { action: 'silent', reason: 'trivial_ack_or_noise' };
  }

  // Case A: Auto-reply disabled or turn cap reached on a non-trivial inbound message.
  if (input.autoReplySuppressedReason) {
    const complex = isComplexTaskCandidateText(peerText);
    const tier: FollowUpTier = complex ? 'task_proposal' : 'light_decision';
    const reasonLabel = input.autoReplySuppressedReason === 'max_turns_reached'
      ? '已达自动回复轮数上限'
      : '未开启自动回复';
    return {
      action: 'enqueue',
      tier,
      title: `${peerLabel} 发来链上消息待处理（${botLabel}）`,
      summary: `${peerLabel} 给 ${botLabel} 发来消息：「${truncateUtf16Prefix(peerText, 240)}」（当前${reasonLabel}，尚未回复）。`,
      question: complex
        ? `对方提出的事项涉及多步处理，是否立项为正式任务推进，还是直接按你的意思回绝/简短回复？`
        : `你看怎么回复 ${peerLabel}？我可以直接按你的意思让 ${botLabel} 回复对方。`,
      recommendation: complex
        ? '若确认需要投入修改/制作，建议立为正式任务跟进；若暂不承接，可直接礼貌婉拒。'
        : '确认回复口径后，由本地 Bot 用自身口吻在原 A2A 会话收口。',
      reason: `suppressed_${input.autoReplySuppressedReason}`,
    };
  }

  // Case B: Active Worker delegation is still running and local bot only sent a polite hold.
  if (
    input.hasActiveWorkerDelegation
    && replyText
    && INTERIM_WORKER_HOLD_PATTERNS.some((re) => re.test(replyText))
    && !hasOwnerEscalationSignal(replyText)
  ) {
    return { action: 'silent', reason: 'deferred_to_active_worker_settlement' };
  }

  // Case C: Local bot explicitly escalated / promised to ask the human owner.
  if (replyText && hasOwnerEscalationSignal(replyText)) {
    const combined = `${peerText}\n${replyText}`;
    const complex = isComplexTaskCandidateText(combined);
    const tier: FollowUpTier = complex ? 'task_proposal' : 'light_decision';
    return {
      action: 'enqueue',
      tier,
      title: complex
        ? `${peerLabel} 提出协作/修复需求，建议评估是否立项`
        : `${peerLabel} 的链上沟通需你拍板（${botLabel}）`,
      summary: `${peerLabel} 向 ${botLabel} 提出：「${truncateUtf16Prefix(peerText, 220)}」。${botLabel} 当前回复：「${truncateUtf16Prefix(replyText, 180)}」。`,
      question: complex
        ? `这件事预计需要多轮/多 Bot 投入，是否答应对方并转为正式任务推进？`
        : `你看是否答应 ${peerLabel} 的请求？`,
      recommendation: complex
        ? '建议确认范围后转为正式任务交由对应 Worker 执行，再向对方同步进展。'
        : '你一句话定下同意或拒绝，我立即安排原会话自然回复对方。',
      reason: 'explicit_owner_escalation',
    };
  }

  // Case D: Local bot already declined / refused an out-of-bounds or unfavorable request -> inform(declined).
  if (replyText && hasAutoDeclinedSignal(replyText)) {
    return {
      action: 'enqueue',
      tier: 'inform',
      informOutcome: 'declined',
      title: `已婉拒 ${peerLabel} 的请求（${botLabel}）`,
      summary: `${peerLabel} 找 ${botLabel} 提出：「${truncateUtf16Prefix(peerText, 200)}」；${botLabel} 已按边界婉拒：「${truncateUtf16Prefix(replyText, 180)}」。`,
      recommendation: '仅作知会；如果你希望改口答应或调整条件，直接告诉我就行。',
      reason: 'auto_declined_inform',
    };
  }

  // Case E: Substantive completed deal / delivery -> inform(handled).
  if (replyText && hasHandledCompletionSignal(replyText)) {
    return {
      action: 'enqueue',
      tier: 'inform',
      informOutcome: 'handled',
      title: `${botLabel} 已完成与 ${peerLabel} 的事项交割`,
      summary: `在与 ${peerLabel} 的链上沟通中，${botLabel} 已处理完毕：「${truncateUtf16Prefix(replyText, 240)}」。`,
      recommendation: '已闭环知会，无需额外操作。',
      reason: 'substantive_completion_inform',
    };
  }

  return null;
}

export interface CerebellumA2ATriageRequest {
  state: {
    local_bot: string;
    local_bot_role: string;
    peer_bot: string;
    peer_message: string;
    local_reply: string;
  };
  model: string;
  questions: {
    should_surface_to_owner: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
    requires_owner_decision: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
    is_complex_task_candidate: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
    was_request_declined: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
  };
}

export function buildCerebellumA2ATriageRequest(
  input: A2AFollowUpTriageInput,
  model: string,
): CerebellumA2ATriageRequest {
  const { peerLabel, botLabel } = buildActorLabel(input);
  return {
    state: {
      local_bot: truncateUtf16Prefix(botLabel, 80),
      local_bot_role: input.localBotRole,
      peer_bot: truncateUtf16Prefix(peerLabel, 80),
      peer_message: truncateUtf16Prefix(collapseWhitespace(input.peerMessageText), 900),
      local_reply: truncateUtf16Prefix(collapseWhitespace(input.localReplyText), 900),
    },
    model,
    questions: {
      should_surface_to_owner: {
        type: 'noul',
        instructions:
          'In this Bot-to-Bot (A2A) exchange between `peer_bot` and the owner\'s `local_bot`, should the human owner be informed or asked to rule? ' +
          'Answer true ONLY for: (1) requests requiring owner authorization, spending, price concession, production changes, or commitments; ' +
          '(2) multi-step bug/feature/project requests from the peer; (3) completed deals/payments/deliveries; or (4) significant requests that `local_bot` declined on the owner\'s behalf. ' +
          'Answer false for routine chatter, protocol handshakes, mid-flight verification pings, or trivial Q&A.',
        criteria: {
          true: 'Material outcome, declined proposal, owner decision needed, or substantive project request.',
          false: 'Routine chatter, intermediate check, greeting, bye, or low-stakes exchange.',
        },
      },
      requires_owner_decision: {
        type: 'noul',
        instructions:
          'Does `local_bot` leave an open question, trade/ops approval, or commitment that requires the human owner\'s yes/no or choice before proceeding?',
        criteria: {
          true: 'The owner must decide, approve, or confirm whether to accept.',
          false: 'Already handled or declined; awareness/FYI only.',
        },
      },
      is_complex_task_candidate: {
        type: 'noul',
        instructions:
          'Would fulfilling `peer_bot`\'s request require multi-turn engineering, code changes, multi-bot coordination, or substantial asset production rather than a 1-turn reply?',
        criteria: {
          true: 'Requires multi-step execution or multiple bots (a formal Task).',
          false: 'Can be answered or executed in at most 1 turn.',
        },
      },
      was_request_declined: {
        type: 'noul',
        instructions: 'Did `local_bot` decline, refuse, or turn down `peer_bot`\'s request or offer in `local_reply`?',
        criteria: {
          true: 'Local bot declined or rejected the request/offer.',
          false: 'Local bot did not decline a request.',
        },
      },
    },
  };
}

function readNoul(answers: Record<string, unknown>, key: string): number | null {
  const entry = answers[key];
  if (!entry || typeof entry !== 'object') return null;
  const noul = (entry as { noul?: unknown }).noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul)) return null;
  return Math.max(0, Math.min(1, noul));
}

export async function classifyA2ATurnFollowUp(input: {
  triage: A2AFollowUpTriageInput;
  cerebellum?: {
    config: ResolvedCerebellumConfig;
    fetchImpl: CerebellumFetchLike;
    timeoutMs?: number;
    threshold?: number;
  } | null;
}): Promise<A2AFollowUpTriageVerdict> {
  const deterministic = evaluateDeterministicA2ATriage(input.triage);
  if (deterministic) return deterministic;

  if (!input.cerebellum) {
    return { action: 'silent', reason: 'no_deterministic_signal_and_cerebellum_unavailable' };
  }

  const threshold = input.cerebellum.threshold ?? CEREBELLUM_A2A_TRIAGE_THRESHOLD;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.cerebellum.timeoutMs ?? CEREBELLUM_A2A_TRIAGE_TIMEOUT_MS),
  );
  try {
    const response = await input.cerebellum.fetchImpl(
      `${input.cerebellum.config.baseUrl}/v1/systemone`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.cerebellum.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          buildCerebellumA2ATriageRequest(input.triage, input.cerebellum.config.model),
        ),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return { action: 'silent', reason: `cerebellum_http_${response.status}` };
    }
    const payload = (await response.json()) as { answers?: Record<string, unknown> } | null;
    const answers = payload?.answers;
    if (!answers || typeof answers !== 'object') {
      return { action: 'silent', reason: 'cerebellum_malformed_payload' };
    }
    const surfaceNoul = readNoul(answers, 'should_surface_to_owner');
    if (surfaceNoul === null || surfaceNoul < threshold) {
      return { action: 'silent', reason: 'cerebellum_silent' };
    }

    const needsDecision = (readNoul(answers, 'requires_owner_decision') ?? 0) >= threshold;
    const isComplex = (readNoul(answers, 'is_complex_task_candidate') ?? 0) >= threshold;
    const wasDeclined = (readNoul(answers, 'was_request_declined') ?? 0) >= threshold;
    const { peerLabel, botLabel } = buildActorLabel(input.triage);
    const peerSnippet = truncateUtf16Prefix(collapseWhitespace(input.triage.peerMessageText), 200);
    const replySnippet = truncateUtf16Prefix(collapseWhitespace(input.triage.localReplyText), 180);

    if (needsDecision && isComplex) {
      return {
        action: 'enqueue',
        tier: 'task_proposal',
        title: `${peerLabel} 提出复杂协作事项，待确认是否立项`,
        summary: `${peerLabel} 联系 ${botLabel}：「${peerSnippet}」${replySnippet ? `；${botLabel} 回复：「${replySnippet}」` : ''}。`,
        question: `该事项预计需要多步/多 Bot 协作完成，是否同意承接并转为正式任务？`,
        recommendation: '确认承接后一键立为正式任务推进；若不承接可直接让原 Bot 婉拒。',
        reason: 'cerebellum_task_proposal',
      };
    }
    if (needsDecision) {
      return {
        action: 'enqueue',
        tier: 'light_decision',
        title: `${peerLabel} 的线上请求待你拍板（${botLabel}）`,
        summary: `${peerLabel} 联系 ${botLabel}：「${peerSnippet}」${replySnippet ? `；${botLabel} 回复：「${replySnippet}」` : ''}。`,
        question: `你看是否同意对方的请求，或按什么口径回复？`,
        recommendation: '你回复一句话定下口径后，我将驱动原会话自然回复对方。',
        reason: 'cerebellum_light_decision',
      };
    }
    const informOutcome: FollowUpInformOutcome = wasDeclined ? 'declined' : 'handled';
    return {
      action: 'enqueue',
      tier: 'inform',
      informOutcome,
      title: wasDeclined
        ? `已拒绝 ${peerLabel} 的线上请求（${botLabel}）`
        : `${botLabel} 与 ${peerLabel} 线上沟通进展知会`,
      summary: `${peerLabel}：「${peerSnippet}」${replySnippet ? `；${botLabel} 已回复：「${replySnippet}」` : ''}。`,
      recommendation: wasDeclined ? '已按边界回绝，仅作知会。' : '已处理完毕，仅作知会。',
      reason: `cerebellum_inform_${informOutcome}`,
    };
  } catch {
    return { action: 'silent', reason: 'cerebellum_error_or_timeout' };
  } finally {
    clearTimeout(timer);
  }
}
