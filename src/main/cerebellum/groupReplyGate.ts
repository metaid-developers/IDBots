/**
 * Cerebellum (小脑) group-chat reply gate — roadmap #5.
 *
 * Unsolicited group replies today are a coin flip (random_reply_probability).
 * One Noul asks whether this bot actually has something to add. A false
 * verdict skips the whole reply turn. A null verdict leaves the coin flip
 * untouched. Mentions are decided in code and never reach this module.
 *
 * Threshold sits below 0.5 on purpose: a missed reply is worse than an
 * extra one, so borderline messages still get a reply.
 *
 * Pure and Electron-free. Never throws.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

export const CEREBELLUM_GROUP_REPLY_TIMEOUT_MS = 2500;

/**
 * Reply when P(should_reply) is at least this. Live calibration 2026-10-23
 * (scripts/cerebellum-group-reply-eval.mjs, jev-1.14.0, 10 labeled zh cases):
 * labeled replies scored >=0.79, labeled skips <=0.53 — the old 0.35 produced
 * 2-3 over-replies on casual chatter while 0.5 keeps lost=0 with one marginal
 * extra; sweep rows in docs/design/2026-10-13-cerebellum-system-handoff.md
 * §2.21.
 */
export const CEREBELLUM_GROUP_REPLY_THRESHOLD = 0.5;

export const CEREBELLUM_GROUP_REPLY_BOT_NAME_MAX_CHARS = 80;
export const CEREBELLUM_GROUP_REPLY_MESSAGE_MAX_CHARS = 800;
export const CEREBELLUM_GROUP_REPLY_RECENT_MAX = 8;
export const CEREBELLUM_GROUP_REPLY_RECENT_MESSAGE_MAX_CHARS = 400;

export const CEREBELLUM_GROUP_REPLY_QUESTION_ID = 'should_reply';

/**
 * English instructions. The group text stays in state, original language.
 * Keep this byte-synced with scripts/cerebellum-group-reply-eval.mjs —
 * that script builds the request through buildGroupReplyRequest.
 */
export const CEREBELLUM_GROUP_REPLY_INSTRUCTIONS =
  'Should the bot named at `bot_name` post a reply to the latest group-chat message at ' +
  '`latest_message`, given the preceding lines at `recent_messages`? ' +
  'Reply when the latest message raises a question, request, or topic this bot is expected to handle, ' +
  'or continues a thread the bot is already part of. ' +
  'Stay silent when the line is small talk among other people, aimed at someone else, or noise.';

export const CEREBELLUM_GROUP_REPLY_CRITERIA = {
  true: 'A reply from this bot would help; staying silent would miss something the group needs from it.',
  false: 'This bot has nothing to add; a reply would be chatter.',
} as const;

export interface CerebellumGroupReplyRequest {
  state: {
    bot_name: string;
    latest_message: string;
    recent_messages: string[];
  };
  model: string;
  questions: {
    should_reply: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
  };
}

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

export function buildGroupReplyRequest(input: {
  botName: string;
  latestMessage: string;
  recentMessages?: readonly string[];
  model: string;
}): CerebellumGroupReplyRequest {
  const recent = (input.recentMessages ?? [])
    .map((line) => truncateUtf16Prefix(collapseWhitespace(line), CEREBELLUM_GROUP_REPLY_RECENT_MESSAGE_MAX_CHARS))
    .filter((line) => line.length > 0)
    .slice(-CEREBELLUM_GROUP_REPLY_RECENT_MAX);
  return {
    state: {
      bot_name: truncateUtf16Prefix(collapseWhitespace(input.botName), CEREBELLUM_GROUP_REPLY_BOT_NAME_MAX_CHARS),
      latest_message: truncateUtf16Prefix(
        collapseWhitespace(input.latestMessage),
        CEREBELLUM_GROUP_REPLY_MESSAGE_MAX_CHARS,
      ),
      recent_messages: recent,
    },
    model: input.model,
    questions: {
      [CEREBELLUM_GROUP_REPLY_QUESTION_ID]: {
        type: 'noul',
        instructions: CEREBELLUM_GROUP_REPLY_INSTRUCTIONS,
        criteria: { ...CEREBELLUM_GROUP_REPLY_CRITERIA },
      },
    },
  };
}

/** Clamp a usable noul into 0..1. Unusable values return null. */
export function parseGroupReplyNoul(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const answer = (answers as Record<string, unknown>)[CEREBELLUM_GROUP_REPLY_QUESTION_ID];
  if (!answer || typeof answer !== 'object') return null;
  const noul = (answer as { noul?: unknown }).noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul)) return null;
  return Math.max(0, Math.min(1, noul));
}

/** true when the noul clears the over-reply threshold. */
export function groupReplyFromNoul(
  noul: number,
  threshold: number = CEREBELLUM_GROUP_REPLY_THRESHOLD,
): boolean {
  return noul >= threshold;
}

/**
 * Unsolicited reply policy. A boolean relevance verdict replaces the coin
 * flip. null keeps it: randomSample < probability, same as the pre-gate path.
 */
export function resolveUnsolicitedGroupReply(input: {
  relevance: boolean | null;
  randomSample: number;
  probability: number;
}): boolean {
  if (input.relevance === true) return true;
  if (input.relevance === false) return false;
  return input.randomSample < input.probability;
}

export async function decideGroupReplyWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  botName: string;
  latestMessage: string;
  recentMessages?: readonly string[];
  timeoutMs?: number;
  threshold?: number;
}): Promise<boolean | null> {
  if (!collapseWhitespace(input.latestMessage)) return null;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_GROUP_REPLY_TIMEOUT_MS),
  );
  try {
    const request = buildGroupReplyRequest({
      botName: input.botName,
      latestMessage: input.latestMessage,
      recentMessages: input.recentMessages,
      model: input.config.model,
    });
    const response = await input.fetchImpl(`${input.config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const noul = parseGroupReplyNoul(await response.json());
    if (noul === null) return null;
    return groupReplyFromNoul(noul, input.threshold ?? CEREBELLUM_GROUP_REPLY_THRESHOLD);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
