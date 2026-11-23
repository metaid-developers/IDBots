/**
 * Cerebellum (小脑) Mobile tool-domain intent classifier.
 *
 * Rides inside `turnDecisionBundle` (`/v1/systemone`) to replace/assist the
 * Mobile regex heuristic (`MOBILE_TOOL_PATTERNS` in `toolCapabilityRegistry.ts`)
 * with semantic classification over the 7 expandable Mobile tool domains:
 *   workerEconomy, financial, social, metaweb, orchestration, memoryAdvanced, automation
 *
 * Why this exists:
 *   Regex triggers cause false-positive expansions on casual chat (for example,
 *   mentioning "任务多" or pasting a URL without wanting headless browser
 *   automation). Each false expansion mutates the active tool surface and forces
 *   DSH `ensureSessionWithHostTools` to dispose and recreate the agent.
 *
 * Design invariants:
 *   1. Pure and Electron-free (type-only imports only) so plain-Node tests can
 *      load it directly with `--experimental-strip-types`.
 *   2. Sticky-aware: domains already active in `currentMobileExpansions` do not
 *      need to be re-queried — only unexpanded domains are sent to `/v1/systemone`.
 *      If all 7 domains are already active, 0 questions are emitted.
 *   3. Disjoint question IDs (`mob_exp_<domain>`) so they multiplex cleanly
 *      with `mem_<i>`, `kn_<i>`, `best_skill`, `best_service`, gate, effort,
 *      and `task_intent_*`.
 *   4. Fail-closed to regex fallback: `parseMobileToolIntentAnswers` returns
 *      `null` when the payload is missing/malformed or below the answer coverage
 *      floor, letting the caller fall back to `resolveMobileToolExpansions`.
 */

import type { MobileToolExpansion } from '../libs/toolCapabilityRegistry';

export const MOBILE_TOOL_INTENT_KEYS: readonly MobileToolExpansion[] = [
  'workerEconomy',
  'financial',
  'social',
  'metaweb',
  'orchestration',
  'memoryAdvanced',
  'automation',
];

export const CEREBELLUM_MOBILE_EXPANSION_QUESTION_IDS: Record<MobileToolExpansion, string> = {
  workerEconomy: 'mob_exp_workerEconomy',
  financial: 'mob_exp_financial',
  social: 'mob_exp_social',
  metaweb: 'mob_exp_metaweb',
  orchestration: 'mob_exp_orchestration',
  memoryAdvanced: 'mob_exp_memoryAdvanced',
  automation: 'mob_exp_automation',
};

/**
 * Thresholds per domain: activate when `noul >= threshold`.
 * Slightly above 0.50 to avoid spurious expansions on casual keywords while
 * reliably activating clear domain requests.
 */
export const CEREBELLUM_MOBILE_EXPANSION_THRESHOLDS: Record<MobileToolExpansion, number> = {
  workerEconomy: 0.55,
  financial: 0.55,
  social: 0.55,
  metaweb: 0.55,
  orchestration: 0.55,
  memoryAdvanced: 0.55,
  automation: 0.55,
};

export const CEREBELLUM_MOBILE_EXPANSION_MIN_ANSWER_COVERAGE = 0.7;

export const CEREBELLUM_MOBILE_EXPANSION_INSTRUCTIONS: Record<MobileToolExpansion, string> = {
  workerEconomy:
    'Does the user message at `current_message` explicitly ask to inspect, create, claim, publish, ' +
    'verify, or settle on-chain MetaTasks, Group Tasks, Escrow Orders, Agentpedia entries, ' +
    'Metaprotocol definitions, or prediction ledger records? False for casual talk or ordinary ' +
    'work/coding tasks.',
  financial:
    'Does the user message at `current_message` explicitly ask to check wallet balances, look up ' +
    'token/coin prices or market overviews ($TICKER, MRC-20, ID-Coin, MVC FT, BTC, SPACE, DOGE), ' +
    'transfer tokens/BTC/NFTs, trade goods/MRC-721/MRC-20/NFTs, handle payments/ME charges/multisig PSBTs, ' +
    'or inspect on-chain financial assets? False for unrelated casual chat.',
  social:
    'Does the user message at `current_message` explicitly ask to publish or send an on-chain ' +
    'social post (buzz, note, Q&A, log, omni cast), like/comment on a pin, or send a private/group ' +
    'chat message to another bot/user? False when only discussing news, trends, or replying directly.',
  metaweb:
    'Does the user message at `current_message` explicitly ask to search, browse, or query on-chain ' +
    'MetaWeb / AI-Internet content (posts, pins, MetaID profiles, online bots/services, on-chain ' +
    'Q&A, MetaApps, or MetaID protocols)? False for general web search, HTTP/API programming talk, ' +
    'or casual chat.',
  orchestration:
    'Does the user message at `current_message` explicitly ask to create or manage persistent ' +
    'tasks or long-term tasks, schedule recurring jobs, delegate work to Worker Bots or subagents, ' +
    'manage MetaBots, or check cross-session dispatch progress? False for casual mentions of ' +
    '"task", "team", or "schedule" without requesting orchestration.',
  memoryAdvanced:
    'Does the user message at `current_message` explicitly ask to search, inspect, or update ' +
    'long-term knowledge bases, saved procedures/playbooks, dream reflections/experiences, chain ' +
    'history, or preference lessons? False for ordinary conversation or summarizing text in chat.',
  automation:
    'Does the user message at `current_message` explicitly ask to launch or drive a headless ' +
    'browser (open/navigate a website, click page elements, take a browser/OS screenshot, play ' +
    'media in browser, or run web UI automation)? False when merely sharing or mentioning a URL ' +
    'or asking a general question.',
};

export const CEREBELLUM_MOBILE_EXPANSION_CRITERIA = {
  true: 'The user explicitly requests actions or queries that require tools in this domain.',
  false: 'Casual chat, unrelated topic, or solvable with core chat/read/search tools without expanding this domain.',
} as const;

export interface CerebellumMobileExpansionNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

/**
 * Determine which Mobile tool domains still need Cerebellum classification
 * (excludes any domains already sticky-active in `currentExpansions`).
 */
export function selectPendingMobileToolExpansions(
  currentExpansions?: readonly MobileToolExpansion[],
): MobileToolExpansion[] {
  if (!currentExpansions || currentExpansions.length === 0) {
    return [...MOBILE_TOOL_INTENT_KEYS];
  }
  const active = new Set(currentExpansions);
  return MOBILE_TOOL_INTENT_KEYS.filter((key) => !active.has(key));
}

export function buildMobileToolIntentQuestions(
  pendingExpansions: readonly MobileToolExpansion[] = MOBILE_TOOL_INTENT_KEYS,
): Record<string, CerebellumMobileExpansionNoulQuestion> {
  const questions: Record<string, CerebellumMobileExpansionNoulQuestion> = {};
  for (const key of pendingExpansions) {
    const qid = CEREBELLUM_MOBILE_EXPANSION_QUESTION_IDS[key];
    if (!qid) continue;
    questions[qid] = {
      type: 'noul',
      instructions: CEREBELLUM_MOBILE_EXPANSION_INSTRUCTIONS[key],
      criteria: { ...CEREBELLUM_MOBILE_EXPANSION_CRITERIA },
    };
  }
  return questions;
}

/**
 * Parse Cerebellum answers for `pendingExpansions`.
 * Returns the newly activated domains (possibly empty `[]` when the turn is
 * casual chat and needs zero expansions), or `null` when the payload is
 * unusable or fails the coverage floor (triggering regex fallback).
 */
export function parseMobileToolIntentAnswers(
  payload: unknown,
  pendingExpansions: readonly MobileToolExpansion[],
): MobileToolExpansion[] | null {
  if (pendingExpansions.length === 0) {
    return [];
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') {
    return null;
  }
  const record = answers as Record<string, unknown>;
  let validCount = 0;
  const activated: MobileToolExpansion[] = [];

  for (const key of pendingExpansions) {
    const qid = CEREBELLUM_MOBILE_EXPANSION_QUESTION_IDS[key];
    const answer = record[qid];
    const noul = answer && typeof answer === 'object'
      ? (answer as { noul?: unknown }).noul
      : undefined;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      continue;
    }
    validCount += 1;
    const clamped = Math.max(0, Math.min(1, noul));
    if (clamped >= CEREBELLUM_MOBILE_EXPANSION_THRESHOLDS[key]) {
      activated.push(key);
    }
  }

  const requiredCoverage = Math.ceil(
    pendingExpansions.length * CEREBELLUM_MOBILE_EXPANSION_MIN_ANSWER_COVERAGE,
  );
  if (validCount < requiredCoverage) {
    return null;
  }
  return activated;
}
