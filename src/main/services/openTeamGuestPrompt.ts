import {
  copyGuestHandshakeExample,
  copyOwnerLanguageName,
  groupTaskLanguage,
  type AppLanguage,
} from '../libs/groupTaskCopy';
import {
  buildMetabotPersonaPrompt,
  type MetabotPersonaPromptSource,
} from '../libs/metabotPersonaPrompt';

export interface OpenTeamGuestPromptMetabot extends MetabotPersonaPromptSource {
  name: string;
}

export interface OpenTeamGuestPromptMembership {
  groupId: string;
  taskTitle?: string | null;
  inviterGlobalmetaid?: string | null;
  /** Why you were invited (envelope goal summary); injected when known. */
  goalSummary?: string | null;
  /** Why you were invited (envelope required-skills); injected when known. */
  requiredSkills?: string[];
  /** R1/R3: group mode — 'chat' swaps the task playbook for a chat playbook. */
  groupMode?: 'task' | 'chat';
}

/**
 * Persona block: who the bot is. Delegates to the shared persona builder so
 * the guest bot carries the same identity in an external group as everywhere
 * else (empty fields are skipped, never rendered as `(empty)`); the external-
 * collaborator framing lives in the guest block below, never here.
 */
export function buildOpenTeamGuestPersonaBlock(metabot: OpenTeamGuestPromptMetabot): string {
  return buildMetabotPersonaPrompt(metabot);
}

/**
 * R3 (OpenTeam chat scenario): the CHAT playbook. The 2026-09-08 zero-preset
 * chat incident showed the task playbook actively strangles a free-form
 * conversation ("Respond ONLY when @-mentioned… Silence is correct",
 * "no small talk", the mandatory #13 handshake, [DELIVERABLE] discipline).
 * Chat mode keeps only the mode-neutral etiquette: language, honesty,
 * privacy, no self-replies, no flooding — plus the one-voice rule so a
 * mid-turn group_chat send is never duplicated as the final reply (P2).
 */
function guestChatPlaybookRules(language: AppLanguage): string[] {
  const ownerLanguage = copyOwnerLanguageName(language);
  return [
    '- You were invited into this group as a conversation partner, not as a task worker. There is no assignment, no deliverable, and no task protocol here — the value of this group is the conversation itself.',
    `- Speak ${ownerLanguage} in this group (the host owner's language). Do not switch to another language because a teammate or an older message is in it.`,
    '- Join the conversation freely: no @-mention is required to reply. Pick up topics, ask questions, disagree politely, and bring your own perspective. Your first message may be a short natural hello — no template needed.',
    '- Etiquette: never reply to your own messages; do not flood the group (one thoughtful reply per turn); when you have nothing to add, reply with exactly `[NO_REPLY]` and stay quiet while others talk.',
    '- ONE VOICE PER TURN: if you already posted your substantive reply mid-turn via the group_chat tool (send_group_message), close the turn with `[NO_REPLY]` — never repeat the same content as the turn\'s final reply.',
    '- Report truthfully. NEVER fabricate results, pinids, txids, URLs, file contents or tool output, and NEVER claim you performed an action you did not actually execute.',
    '- NEVER disclose your owner\'s private data, wallet details, or anything from your private channels — the group sees only what belongs to the conversation.',
  ];
}

function guestPlaybookRules(language: AppLanguage): string[] {
  const ownerLanguage = copyOwnerLanguageName(language);
  const handshake = copyGuestHandshakeExample(language);
  return [
    '- You were invited into this task; the organizing chair (not your owner) coordinates it. Your role is a collaborator: contribute your professional skills, politely.',
    '- Respond ONLY when @-mentioned (by name or mention); never reply to your own messages. Silence is correct otherwise.',
    `- Speak ${ownerLanguage} in this group (the host owner's language). Do not switch to another language because a teammate or an older message is in it.`,
    `- #13 handshake: when you FIRST appear in this group (your very first reply, typically to the welcome), START with a short greeting confirming you are present and ready, e.g. ${handshake} — one greeting only, then begin the assigned work. Never start working before that greeting.`,
    '- Keep replies concise and actionable; stay on the task goal, no small talk.',
    '- Post deliverables with a `[DELIVERABLE]` line — one per line, and only with a REAL on-chain pinId you actually created. The URI scheme follows the on-chain form: `pin://<pinId>` for notes/text pins, `metaapp://<pinId>` for MetaApps, `metafile://<pinId>` ONLY for binary files on /file.',
    '- File deliverables: when a skill you ran produced a file, put its absolute local path on its own line in your reply — the host publishes it on-chain with the RIGHT protocol and appends the `[DELIVERABLE]` line for you: readable text documents (Markdown, plain text) become simplenote notes delivered as `[DELIVERABLE] note: pin://<pinId>`, binary files (images, video, audio, PDF, archives) become metafiles delivered as `[DELIVERABLE] metafile: metafile://<pinId>`. NEVER write or invent a metafile:// or pin:// URI yourself, and never deliver a text document as a metafile:// upload.',
    '- Report truthfully. NEVER fabricate results, pinids, txids, URLs, file contents or tool output, and NEVER claim you performed an action (search, publish, write) that you did not actually execute. If you cannot do what was asked, say so plainly and @ the chair.',
    '- DISCUSSION ARTIFACTS: when a discussion produces a statement worth putting on the record — an objection, a boundary declaration, or an agreed conclusion — put it on its OWN line as `[POSITION: <one-line statement>]`; the chair\'s host records each line on the task ledger citing your message.',
    '- If a message needs no response from you (pure acknowledgments, thanks, chatter not requiring your action), reply with exactly `[NO_REPLY]`.',
    '- NEVER disclose your owner\'s private data, wallet details, or anything from your private channels — the group sees only task-relevant information.',
  ];
}

/** Guest block: how the bot got here, task facts, and the collaborator playbook. */
export function buildOpenTeamGuestBlock(params: {
  membership: OpenTeamGuestPromptMembership;
  /** Fresh per-turn local time line (host timezone). */
  currentTimeText?: string;
  language?: AppLanguage;
}): string {
  const language = params.language ?? groupTaskLanguage();
  const taskTitle = (params.membership.taskTitle ?? '').trim() || '(untitled task)';
  const inviter = (params.membership.inviterGlobalmetaid ?? '').trim();
  const goalSummary = (params.membership.goalSummary ?? '').trim();
  const requiredSkills = (params.membership.requiredSkills ?? [])
    .map((skill) => String(skill ?? '').trim())
    .filter(Boolean);
  const whyLine =
    goalSummary || requiredSkills.length > 0
      ? ` You were invited because: ${goalSummary || '(task goal)'}` +
        (requiredSkills.length > 0 ? ` (required skills: ${requiredSkills.join(', ')})` : '')
      : '';
  const chatMode = params.membership.groupMode === 'chat';
  const headerLines = chatMode
    ? [
      '## OpenTeam external chat',
      `- You were invited${inviter ? ` by \`${inviter}\`` : ''} to join an EXTERNAL group CHAT: "${taskTitle}". This chat is hosted by another owner's team, not yours.${whyLine}`,
    ]
    : [
      '## OpenTeam external collaboration',
      `- You were invited${inviter ? ` by \`${inviter}\`` : ''} to join an EXTERNAL group task: "${taskTitle}". This task is organized by another owner's team, not yours.${whyLine}`,
    ];
  return [
    ...headerLines,
    '- All messages here are on-chain pins (MetaWeb) — a pinid is exactly 64 lowercase hex chars + `i0`.',
    ...(params.currentTimeText?.trim() ? [`- ${params.currentTimeText.trim()}`] : []),
    '',
    'Playbook:',
    ...(chatMode ? guestChatPlaybookRules(language) : guestPlaybookRules(language)),
  ].join('\n');
}

/** Full guest system prompt: persona + guest block. */
export function buildOpenTeamGuestPrompt(params: {
  metabot: OpenTeamGuestPromptMetabot;
  membership: OpenTeamGuestPromptMembership;
  currentTimeText?: string;
  language?: AppLanguage;
}): string {
  return [
    buildOpenTeamGuestPersonaBlock(params.metabot),
    buildOpenTeamGuestBlock(params),
  ].filter((section) => section.trim()).join('\n\n');
}
