/**
 * Content-hash deduplication for the per-turn volatile context tail.
 *
 * The runner injects volatile context (memory blocks, browser tabs, remote
 * services, experience summaries) into the CURRENT user message so the
 * cacheable prompt head stays byte-stable. Every injected token sits in the
 * request tail, which is a guaranteed cache miss each turn — so re-injecting
 * a section whose bytes are identical to the previous turn's injection buys
 * nothing and only grows the miss denominator. This module dedups those
 * sections: a byte-identical section is omitted because the model can still
 * read the previous injection in the conversation history.
 *
 * Validity of "still in history" is bounded by the SDK session identity: a
 * reset session (claudeSessionId cleared — system-prompt change, compaction,
 * stale-session retry) has no history to fall back on, so the dedup state is
 * keyed by that generation and a changed generation invalidates all cached
 * hashes (everything is injected again). Mirrors the DeepSeek Harness
 * RuntimeContextProjection semantics: the retained hash always tracks the
 * LAST injected text, so a section that changed away and changed back is
 * re-injected instead of being wrongly deduped.
 *
 * Pure module: no I/O, no Electron imports.
 */

import { createHash } from 'crypto';

/** One rendered volatile section. `key` is the dedup-cache identity. */
export interface VolatileSection {
  key: string;
  text: string;
  /**
   * Sections that must be injected every turn regardless of hash (e.g. the
   * memory block, which is re-ranked by the current user text and carries
   * user facts). Dedup is skipped for these.
   */
  alwaysInject?: boolean;
  /**
   * Optional minimum number of turns after an injection before a hash-changed
   * version of this section is re-injected (used to suppress P2P presence
   * flicker re-injecting ~25KB `<available_remote_services>` every turn).
   */
  minChangeCooldownTurns?: number;
}

/** Dedup state for one session, invalidated by an SDK-session generation change. */
export interface VolatileDedupState {
  /** SDK session identity the cached hashes belong to; null = fresh session. */
  generation: string | null;
  hashes: Map<string, string>;
  turnsSinceInject?: Map<string, number>;
}

export function createVolatileDedupState(generation: string | null): VolatileDedupState {
  return { generation, hashes: new Map(), turnsSinceInject: new Map() };
}

export function hashVolatileSection(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const RECENT_SESSIONS_REL_AGE_RE = /^(- )\((?:just now|\d+[mhd] ago)\)( IDBots:\/\/)/gm;
const EXPERIENCE_SUBBLOCK_RE = /<(metabot_self_identity|value_boundaries|work_reviews|recent_daily_summaries|proven_techniques|knowledge|procedures)\b[^>]*>[\s\S]*?<\/\1>(?:\s*<instruction>[\s\S]*?<\/instruction>)?/g;

function normalizeHashInput(key: string, text: string): string {
  if (key === 'recent-sessions') {
    return text.replace(RECENT_SESSIONS_REL_AGE_RE, '$1(age)$2');
  }
  return text;
}

/**
 * Apply content dedup to a list of rendered sections. Returns the texts to
 * inject, in order. Empty texts are dropped; identical-to-previous sections
 * are omitted; every hash is recorded so the comparison always tracks the
 * LAST injection (A -> B -> A re-injects A).
 */
export function applyVolatileDedup(
  sections: VolatileSection[],
  state: VolatileDedupState
): string[] {
  const kept: string[] = [];
  const turnsMap = state.turnsSinceInject ?? (state.turnsSinceInject = new Map());
  for (const section of sections) {
    const text = typeof section.text === 'string' ? section.text.trim() : '';
    if (!text) {
      continue;
    }
    if (section.key === 'experience' && section.alwaysInject !== true) {
      const matches = [...text.matchAll(EXPERIENCE_SUBBLOCK_RE)];
      if (matches.length > 0) {
        const subKept: string[] = [];
        for (const match of matches) {
          const tag = match[1];
          const chunk = match[0].trim();
          const subKey = `experience:${tag}`;
          const subHash = hashVolatileSection(chunk);
          const prevSubHash = state.hashes.get(subKey);
          state.hashes.set(subKey, subHash);
          if (prevSubHash === subHash) continue;
          subKept.push(chunk);
        }
        if (subKept.length > 0) {
          kept.push(subKept.join('\n\n'));
        }
        continue;
      }
    }
    const hash = hashVolatileSection(normalizeHashInput(section.key, text));
    const previousHash = state.hashes.get(section.key);
    if (section.alwaysInject !== true && previousHash === hash) {
      // Byte-identical to the previous injection of this SDK-session
      // generation — still visible in history, so skip it.
      turnsMap.set(section.key, (turnsMap.get(section.key) ?? 0) + 1);
      continue;
    }
    const cooldown = section.minChangeCooldownTurns ?? 0;
    const elapsedTurns = turnsMap.get(section.key);
    if (
      section.alwaysInject !== true
      && previousHash !== undefined
      && cooldown > 0
      && elapsedTurns !== undefined
      && elapsedTurns < cooldown
    ) {
      turnsMap.set(section.key, elapsedTurns + 1);
      continue;
    }
    state.hashes.set(section.key, hash);
    turnsMap.set(section.key, 1);
    kept.push(text);
  }
  return kept;
}
