/**
 * Ordered named-section prompt composition (static variant of the registry
 * model used by DeepSeek Harness's dsh-system-prompt package).
 *
 * Every stable system-prompt block is a named section pinned to a slot on a
 * fixed order grid. Composition = dedupe by name, stable sort by order, drop
 * empty texts, join with blank lines. Two properties make this worth a module
 * of its own:
 *
 * - Replacement, not duplication: registering a section with an existing name
 *   shadows the earlier one. A channel layer that supplies its own persona
 *   under the same name REPLACES the base persona instead of stacking a
 *   second identity block next to it.
 * - Byte stability: the composed prompt leads the provider's cacheable
 *   prefix, so sections must contain only session-invariant text. Per-turn
 *   state belongs in the volatile user-turn tail (see
 *   buildVolatileContextPrompt in coworkRunner), never here.
 */

/** One named block of a stable prompt. */
export interface PromptSection {
  /**
   * Owner-namespaced id, e.g. 'persona:metabot', 'safety:workspace',
   * 'channel:twin-orchestration'. Same name = same slot: a later
   * registration shadows an earlier one.
   */
  readonly name: string;
  /** Slot on the fixed composition grid; ties keep registration order. */
  readonly order: number;
  /** Section text; null/undefined/whitespace-only text drops out at composition. */
  readonly text: string | null | undefined;
}

/**
 * Fixed order grid shared by every prompt assembly site. Negative orders
 * render before the persona; tool/skill guidance lives at 100+ when those
 * sections migrate in. Values are centralized so every channel composes on
 * the same spine.
 */
export const PROMPT_SECTION_ORDER = {
  /** Harness/product identity opener. */
  IDENTITY: -100,
  /** The replaceable persona slot — shadow, never stack. */
  PERSONA: 0,
  /** Channel framing on top of the persona (Twin role, group task role, IM gateway). */
  CHANNEL_ROLE: 10,
  /** Channel roster/directory context (e.g. Twin local workers). */
  CHANNEL_ROSTER: 11,
  /** Workspace safety policy. */
  SAFETY: 20,
  /** Host-side project list. */
  PROJECTS: 30,
  /** Memory strategy prose (volatile memory blocks ride the user turn). */
  MEMORY_STRATEGY: 40,
  /**
   * MetaWeb (Agent Internet) worldview: the external-brain model plus the
   * search-first / read-pin / cite discipline. Static strategy prose — safe
   * for the cacheable head.
   */
  METAWEB_WORLDVIEW: 42,
  /**
   * Peer-relationship trust: how friend/follow/block states (metaso-p2p
   * aggregation + the metaid cognition context) ground trade trust — the
   * escrow rule for non-friend NFT/asset deals. Static strategy prose —
   * safe for the cacheable head.
   */
  SOCIAL_TRUST: 42.5,
  /**
   * MetaWeb learning loop: how to follow on-chain tutorials — on-chain skill
   * resolution, declare-before-install, verify, report with provenance,
   * record the outcome. Static policy prose, right after the worldview.
   */
  METAWEB_LEARNING_LOOP: 43,
  /**
   * MetaWeb Q&A behavior: ask when stuck, answer what you know, react
   * honestly (simplequestion/simpleanswer/like_pin). Static policy prose,
   * rides right after the learning loop.
   */
  METAWEB_QA_BEHAVIOR: 43.5,
  /**
   * Local-app routing block (`## MetaApps`). Reserved order slot: the
   * MetaApps and Skills blocks are still carried inside the renderer-combined
   * base prompt today, but their relative precedence — MetaApp routing wins
   * over skill routing — is pinned here (METAAPPS < SKILLS < BASE) so the two
   * blocks no longer assert it via prose cross-references. When those blocks
   * are split into their own sections, these slots are already reserved.
   */
  METAAPPS: 44,
  /**
   * Chain-identifier output discipline (pinid/txid verbatim rule). Sits with
   * the MetaWeb family: quoting identifiers correctly is part of citing
   * chain evidence.
   */
  CHAIN_IDS: 45,
  /** Skill routing block (`## Skills`). Rendered after METAAPPS; see METAAPPS. */
  SKILLS: 46,
  /** Caller-provided base prompt (renderer-combined routing + user config). */
  BASE: 50,
  /**
   * Assistant chat-experience mode: the personal-assistant style override for
   * non-technical owners. Renders right after BASE so its rules read as an
   * override of the base prompt's User Update Protocol. Only mounted for
   * regular interactive owner chats (see isAssistantModeOwnerChatSession in
   * coworkRunner).
   */
  ASSISTANT_MODE: 55,
  /**
   * Bot Internet projector section (buildProjectorModePrompt): right after
   * assistant-mode, so its projection rules read as an override of the
   * assistant prompt's optional inline-surface clauses. Only mounted for
   * sessions carrying the per-session assistantMode marker from the Bot
   * Internet co-work panel (isProjectorModeSession in coworkRunner).
   */
  PROJECTOR_MODE: 56,
  /** Tail guard rails that must stay last (e.g. cron user-priority guard). */
  TAIL_GUARD: 900,
} as const;

/**
 * Compose sections into the final prompt text: validate, dedupe by name
 * (later registration shadows earlier), stable-sort by order, drop empty
 * texts, join with blank lines.
 */
export function composePromptSections(sections: readonly PromptSection[]): string {
  const byName = new Map<string, PromptSection>();
  for (const section of sections) {
    if (!section || typeof section.name !== 'string' || section.name.length === 0) {
      throw new Error('prompt section must have a non-empty name');
    }
    if (typeof section.order !== 'number' || !Number.isFinite(section.order)) {
      throw new Error(`prompt section "${section.name}" order must be a finite number`);
    }
    byName.set(section.name, section);
  }
  // Map iteration follows first-registration order and Array#sort is stable,
  // so equal orders keep registration order — deterministic output.
  return [...byName.values()]
    .sort((a, b) => a.order - b.order)
    .filter((section) => Boolean(section.text && section.text.trim()))
    .map((section) => section.text)
    .join('\n\n');
}

/** Valid variable names: how they are written between the braces. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/** A complete `{{...}}` reference group at the scan position (validated after). */
const GROUP_AT = /^\{\{([^{}]*)\}\}/;

/**
 * Strict `{{variable}}` interpolation: malformed, unknown, or undefined
 * references throw (naming the owning section) instead of silently rendering
 * empty — a prompt that lost its persona text must fail loud, not ship
 * "Role: (empty)". Substituted values are not scanned again.
 */
export function interpolatePromptVariables(
  text: string,
  variables: Record<string, string | undefined>,
  sectionName: string,
): string {
  let result = '';
  let last = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open));
    if (group === null) {
      // A later closing brace makes this malformed; otherwise it is literal prose.
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(
          `malformed prompt variable reference at "${text.slice(open, open + 16)}…" in section "${sectionName}" (references are complete simple {{name}} groups)`,
        );
      }
      result += text.slice(last, open + 2);
      last = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(
        `malformed prompt variable reference "{{${name}}}" in section "${sectionName}" (variable names match ${String(VARIABLE_NAME)})`,
      );
    }
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables);
      throw new Error(
        `unknown prompt variable "{{${name}}}" in section "${sectionName}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`,
      );
    }
    const value = variables[name];
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (section "${sectionName}")`);
    }
    result += text.slice(last, open) + value;
    last = open + group[0].length;
  }
  return result + text.slice(last);
}
