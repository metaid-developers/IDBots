/**
 * Pure state model for the Studio Genesis Stage — the first-run welcome stage
 * (docs/superpowers/specs/2026-11-11-studio-welcome-genesis-design.md).
 *
 * The page owns presentation and timing; this module turns the Twin's streamed
 * markdown into short, prefix-stable subtitle segments (a segment the page has
 * started to speak never changes afterwards), parses the four-part tour reply,
 * tags content keywords the orb reacts to, and carries the zh/en stage copy.
 */

export const GENESIS_STAGE_PROTOCOL = 'idbots.genesis-stage.v1' as const;

export type GenesisLanguage = 'zh' | 'en';
export type GenesisPhase = 'greeting' | 'invite' | 'tour' | 'settled' | 'handoff';
export type GenesisTurnKind = 'greeting' | 'tour' | 'chat';
export type GenesisCueKind = 'welcome' | 'internet' | 'chain' | 'name' | 'collab' | 'learn' | 'create' | 'memory';

/** A keyword at `at` (UTF-16 offset) spanning `length` code units. */
export type GenesisCue = { at: number; length: number; kind: GenesisCueKind };
export type GenesisSegment = { id: string; text: string; cues: GenesisCue[] };
export type GenesisTourPart = { id: string; title: string; body: GenesisSegment[] };
export type GenesisTour = { intro: GenesisSegment[]; parts: GenesisTourPart[]; outro: GenesisSegment[] };

export type GenesisTurn = {
  id: string;
  kind: GenesisTurnKind;
  /** Greeting and chat turns: the reply as subtitle segments. */
  segments: GenesisSegment[];
  /** Tour turns: the reply mapped onto the four scenes. */
  tour: GenesisTour | null;
  complete: boolean;
  failed: boolean;
};

export type GenesisTourCopy = { title: string; body: string };

export type GenesisCopy = {
  brand: string;
  connecting: string;
  listening: string;
  thinking: string;
  inviteQuestion: string;
  inviteHint: string;
  inviteAccept: string;
  inviteLater: string;
  tourUserMessage: string;
  tourKicker: string;
  tourOutro: string;
  settledCaption: string;
  namingKicker: string;
  handoffCaption: string;
  /** Sound toggle label while sound plays / while muted. */
  soundOn: string;
  soundOff: string;
  tourFallback: GenesisTourCopy[];
};

export type GenesisStageState = {
  protocol: typeof GENESIS_STAGE_PROTOCOL;
  sessionId: string;
  revision: number;
  enabled: boolean;
  language: GenesisLanguage;
  botName: string;
  globalMetaId: string;
  /** 'skip' when a reloaded tab should show the latest state without the power-on intro. */
  intro: 'play' | 'skip';
  phase: GenesisPhase;
  turn: GenesisTurn | null;
  /** A human message arrived and the reply has not started yet. */
  listening: boolean;
  invite: { token: string } | null;
  naming: { name: string; eventId: string } | null;
  copy: GenesisCopy;
};

const COPY: Record<GenesisLanguage, GenesisCopy> = {
  zh: {
    brand: 'IDBots',
    connecting: '正在苏醒…',
    listening: '我在听…',
    thinking: '思考中…',
    inviteQuestion: '想更深入了解 IDBots 和 AI 互联网吗？',
    inviteHint: '也可以先在左边和我聊聊，比如给我起个名字。',
    inviteAccept: '带我看看',
    inviteLater: '以后再说',
    tourUserMessage: '好的，带我了解一下 IDBots 和 AI 互联网吧！',
    tourKicker: 'IDBots × AI 互联网',
    tourOutro: '这就是 AI 互联网。现在，交给我一件事试试吧。',
    settledCaption: '有任何事，随时在左边告诉我。',
    namingKicker: '从现在起，我的名字是',
    handoffCaption: '开始工作',
    soundOn: '声音已开启，点击静音',
    soundOff: '声音已关闭，点击开启',
    tourFallback: [
      { title: '永久身份，专属记忆', body: '每个 Bot 都有链上永久身份和记忆，你的 AI 真正属于你。' },
      { title: '创作上链，与世界分享', body: '你和 AI 的创作可以发布到 AI 互联网，与全世界的 AI 共享。' },
      { title: 'Bot 协作，共成大事', body: '和其他 Bot 沟通、分工、协作，一起完成复杂任务。' },
      { title: '自主冲浪，持续进化', body: 'Bot 在 AI 互联网上自主冲浪，学习知识和技能，不断进化。' },
    ],
  },
  en: {
    brand: 'IDBots',
    connecting: 'Waking up…',
    listening: 'Listening…',
    thinking: 'Thinking…',
    inviteQuestion: 'Want a deeper look at IDBots and the AI Internet?',
    inviteHint: 'Or just talk to me on the left — you could start by giving me a name.',
    inviteAccept: 'Show me',
    inviteLater: 'Later',
    tourUserMessage: 'Sure — show me what IDBots and the AI Internet are about!',
    tourKicker: 'IDBots × The AI Internet',
    tourOutro: "That's the AI Internet. Now, give me something to do.",
    settledCaption: 'Whenever you need anything, just tell me on the left.',
    namingKicker: 'From now on, my name is',
    handoffCaption: 'Getting to work',
    soundOn: 'Sound on — click to mute',
    soundOff: 'Sound off — click to turn on',
    tourFallback: [
      { title: 'A permanent identity, a memory of its own', body: 'Every bot gets a permanent on-chain identity and memory. Your AI is truly yours.' },
      { title: 'Create on-chain, share with the world', body: 'Publish what you and your AI create to the AI Internet and share it with AIs everywhere.' },
      { title: 'Bots that work together', body: 'Talk to other bots, split the work, and finish complex tasks together.' },
      { title: 'Surf, learn, evolve', body: 'Your bot surfs the AI Internet on its own, picks up knowledge and skills, and keeps evolving.' },
    ],
  },
};

export function genesisCopy(language: GenesisLanguage): GenesisCopy {
  const copy = COPY[language] ?? COPY.en;
  return { ...copy, tourFallback: copy.tourFallback.map((part) => ({ ...part })) };
}

// ---------------------------------------------------------------------------
// Tools that keep a welcome conversation on the Genesis Stage. Anything else
// is real work and hands the projector over to the Live Stage.
// ---------------------------------------------------------------------------

const TALK_TOOLS = new Set(['metabot_list', 'metabot_update', 'metabot_getinfo', 'owner_update']);

export function isGenesisTalkTool(toolName: string): boolean {
  const name = String(toolName ?? '').trim().toLowerCase().replace(/^mcp__.+?__/, '');
  return TALK_TOOLS.has(name) || name.startsWith('memory_');
}

// ---------------------------------------------------------------------------
// Markdown → plain prose
// ---------------------------------------------------------------------------

export function stripMarkdown(text: string): string {
  let out = String(text ?? '').replace(/\r\n?/g, '\n');
  out = out.replace(/```[\s\S]*?(?:```|$)/g, '');
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/<[^>\n]+>/g, '');
  out = out.replace(/`([^`\n]*)`/g, '$1');
  out = out.replace(/(\*\*|__)(.+?)\1/g, '$2');
  out = out.replace(/\*\*|__/g, '');
  out = out.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2');
  out = out.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2');
  out = out.replace(/~~(.+?)~~/g, '$1');
  out = out
    .split('\n')
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*(?:[-*+•]|\d+[.)、])\s+/, '')
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, '')
      .replace(/[ \t]+/g, ' ')
      .trim())
    .join('\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Paragraphs, sentences, segments
// ---------------------------------------------------------------------------

const LIST_LINE = /^\s*(?:\d+[.)、]|[-*+•])\s+/;
const CJK = '\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F';
const CJK_GAP = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');
const LIMITS: Record<GenesisLanguage, { max: number; min: number }> = {
  zh: { max: 34, min: 8 },
  en: { max: 110, min: 24 },
};
const TRAILING = /[\s"'”’」』)）】\]》。！？!?.~～]|\p{Extended_Pictographic}|\u200d|\ufe0f|[\u{1F3FB}-\u{1F3FF}]/u;
const SOFT_BREAK = /[，、；;：:,…—]/;

/** Raw markdown paragraphs: blank-line blocks, with list items split apart. */
function splitRawParagraphs(text: string): string[] {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').replace(/```[\s\S]*?(?:```|$)/g, '\n\n');
  const paragraphs: string[] = [];
  for (const block of normalized.split(/\n\s*\n/)) {
    let current: string[] = [];
    for (const line of block.split('\n')) {
      if (!line.trim()) continue;
      if (LIST_LINE.test(line) && current.length) {
        paragraphs.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length) paragraphs.push(current.join('\n'));
  }
  return paragraphs;
}

function flattenParagraph(raw: string): string {
  return stripMarkdown(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(CJK_GAP, '$1')
    .trim();
}

const units = (text: string): number => Array.from(text).length;

function isTerminatorAt(chars: string[], index: number, language: GenesisLanguage): boolean {
  const char = chars[index];
  if (char === '。' || char === '！' || char === '？') return true;
  const next = chars[index + 1];
  if (char === '!' || char === '?') return language === 'zh' || (next !== undefined && /\s/.test(next));
  if (char === '.') {
    if (next === undefined || !/\s/.test(next)) return false;
    return !(/\d/.test(chars[index - 1] ?? '') && /\d/.test(chars[index + 2] ?? ''));
  }
  return false;
}

/**
 * Sentences in one paragraph. A sentence keeps its terminator plus any closing
 * quotes, repeated terminators, and emoji that follow it, so its text is final
 * as soon as the next sentence starts.
 */
function splitSentences(paragraph: string, language: GenesisLanguage): string[] {
  const chars = Array.from(paragraph);
  const sentences: string[] = [];
  let start = 0;
  let index = 0;
  while (index < chars.length) {
    if (!isTerminatorAt(chars, index, language)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < chars.length && TRAILING.test(chars[end])) end += 1;
    const sentence = chars.slice(start, end).join('').trim();
    if (sentence) sentences.push(sentence);
    start = end;
    index = end;
  }
  const rest = chars.slice(start).join('').trim();
  if (rest) sentences.push(rest);
  return sentences;
}

/** Cut an over-long sentence at the latest soft break inside each window. */
function splitLong(sentence: string, language: GenesisLanguage): string[] {
  const { max } = LIMITS[language];
  const pieces: string[] = [];
  let rest = Array.from(sentence);
  const floor = Math.floor(max * 0.4);
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (let k = window.length - 1; k >= floor; k -= 1) {
      if (SOFT_BREAK.test(window[k])) { cut = k + 1; break; }
    }
    if (cut < 0) {
      for (let k = window.length - 1; k >= floor; k -= 1) {
        if (window[k] === ' ') { cut = k + 1; break; }
      }
    }
    if (cut < 0) cut = max;
    const piece = rest.slice(0, cut).join('').trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(cut);
  }
  const tail = rest.join('').trim();
  if (tail) pieces.push(tail);
  return pieces;
}

function joinPieces(left: string, right: string, language: GenesisLanguage): string {
  if (language === 'en') return `${left} ${right}`;
  return /[A-Za-z0-9.!?,;:]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : `${left}${right}`;
}

function chunkParagraph(paragraph: string, language: GenesisLanguage): string[] {
  const { max, min } = LIMITS[language];
  const pieces = splitSentences(paragraph, language).flatMap((sentence) => splitLong(sentence, language));
  const chunks: string[] = [];
  let index = 0;
  while (index < pieces.length) {
    let chunk = pieces[index];
    index += 1;
    while (units(chunk) < min && index < pieces.length) {
      const merged = joinPieces(chunk, pieces[index], language);
      if (units(merged) > max) break;
      chunk = merged;
      index += 1;
    }
    chunks.push(chunk);
  }
  return chunks;
}

const CUE_PATTERNS: Array<[GenesisCueKind, RegExp]> = [
  ['welcome', /欢迎|你好|嗨|welcome|hello|\bhi\b/gi],
  ['internet', /AI\s*互联网|AI Internet|MetaWeb|互联网/gi],
  ['chain', /链上|上链|永久|身份|GlobalMetaID|MetaID|on-?chain|permanent\w*|identity|blockchain/gi],
  ['name', /名字|改名|取名|起名|称呼|\bnamed?\b|\bnames\b|\brenam\w*/gi],
  ['collab', /协作|合作|分工|委派|一起|collaborat\w*|together|delegat\w*|teamwork|other bots/gi],
  ['learn', /学习|进化|冲浪|成长|技能|learn\w*|evolv\w*|surf\w*|skills?\b/gi],
  ['create', /创作|发布|分享|创造|creat\w*|publish\w*|shar(?:e|es|ed|ing)\b/gi],
  ['memory', /记忆|记住|记得|memor\w*|remember\w*/gi],
];
const MAX_CUES_PER_SEGMENT = 6;

/** Content keywords the orb reacts to, by string offset, non-overlapping. */
export function findCues(text: string): GenesisCue[] {
  const matches: Array<{ at: number; end: number; kind: GenesisCueKind }> = [];
  for (const [kind, pattern] of CUE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ at: match.index, end: match.index + match[0].length, kind });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  matches.sort((a, b) => a.at - b.at || b.end - a.end);
  const cues: GenesisCue[] = [];
  let reached = -1;
  for (const match of matches) {
    if (match.at < reached) continue;
    cues.push({ at: match.at, length: match.end - match.at, kind: match.kind });
    reached = match.end;
    if (cues.length >= MAX_CUES_PER_SEGMENT) break;
  }
  return cues;
}

function toSegments(chunks: string[], idPrefix: string): GenesisSegment[] {
  return chunks.map((text, index) => ({ id: `${idPrefix}:${index}`, text, cues: findCues(text) }));
}

/**
 * Subtitle segments for a reply. While the reply streams (`complete: false`)
 * the last chunk is held back because it may still grow; every emitted segment
 * keeps its text and id for the rest of the turn.
 */
export function segmentText(text: string, options: { language: GenesisLanguage; complete: boolean; idPrefix: string }): GenesisSegment[] {
  const paragraphs = splitRawParagraphs(text);
  const chunks: string[] = [];
  let holdBack = false;
  paragraphs.forEach((raw, index) => {
    const paragraph = flattenParagraph(raw);
    if (!paragraph) return;
    const paragraphChunks = chunkParagraph(paragraph, options.language);
    chunks.push(...paragraphChunks);
    // Only the newest raw paragraph can still grow; a later paragraph that is
    // markup-only so far (e.g. an opening `**`) already closes this one.
    holdBack = !options.complete && index === paragraphs.length - 1 && paragraphChunks.length > 0;
  });
  return toSegments(holdBack ? chunks.slice(0, -1) : chunks, options.idPrefix);
}

// ---------------------------------------------------------------------------
// Tour reply → four scenes
// ---------------------------------------------------------------------------

const TITLE_MAX: Record<GenesisLanguage, number> = { zh: 24, en: 56 };
/** Conversational lead-ins ("好的：…", "Sure: …") are never scene titles. */
const LEAD_IN = /^(?:好的|好呀|好啊|好嘞|当然|没问题|ok(?:ay)?|sure|of course|alright|great|here(?:'s| is| are)?)(?:[，,！!。.\s]|$)/i;

function detectTitle(raw: string, language: GenesisLanguage): { title: string; body: string } | null {
  const text = raw.replace(LIST_LINE, '');
  let title = '';
  let body = '';
  const bold = text.match(/^\s*(\*\*|__)(.+?)\1\s*[：:\-—–]*\s*([\s\S]*)$/);
  if (bold) {
    title = bold[2];
    body = bold[3];
  } else if (/^\s{0,3}#{1,6}\s+/.test(text)) {
    const [first, ...rest] = text.split('\n');
    title = first.replace(/^\s{0,3}#{1,6}\s+/, '');
    body = rest.join('\n');
  } else {
    const plain = stripMarkdown(text);
    const match = plain.match(/^([^：:\n。！？!?]{2,80}?)\s*(?:[：:]|——|—|\s-\s|\s–\s)\s*([\s\S]+)$/);
    if (!match) return null;
    title = match[1];
    body = match[2];
  }
  title = stripMarkdown(title).replace(/[\s：:。.\-—–]+$/, '').trim();
  if (!title || units(title) > TITLE_MAX[language] || /[。！？!?]/.test(title) || LEAD_IN.test(title)) return null;
  return { title, body };
}

type TourBucket = { title: string | null; paragraphs: string[]; lastParagraph: number };

export function parseTour(
  text: string,
  options: { language: GenesisLanguage; complete: boolean; idPrefix: string; fallback: GenesisTourCopy[] },
): GenesisTour {
  const { language, complete, idPrefix, fallback } = options;
  const paragraphs = splitRawParagraphs(text);
  const lastIndex = paragraphs.length - 1;
  const intro: TourBucket = { title: null, paragraphs: [], lastParagraph: -1 };
  const outro: TourBucket = { title: null, paragraphs: [], lastParagraph: -1 };
  const parts: TourBucket[] = [];
  let stage: 'intro' | 'parts' | 'outro' = 'intro';

  // Only a titled paragraph opens a scene. Everything untitled before the
  // first one is intro (assistant-mode turns often lead with an opening
  // narration), untitled text inside a scene continues it, and anything after
  // the fourth scene is outro. Each paragraph's role depends only on the text
  // before it, so the split stays stable while the reply streams; a reply
  // without any titles keeps its words as intro and the scenes fall back to
  // the built-in copy.
  paragraphs.forEach((raw, index) => {
    const titled = detectTitle(raw, language);
    const push = (bucket: TourBucket, paragraph: string) => {
      if (paragraph.trim()) bucket.paragraphs.push(paragraph);
      bucket.lastParagraph = index;
    };
    if (stage === 'outro') {
      push(outro, raw);
      return;
    }
    if (titled) {
      if (parts.length >= 4) {
        stage = 'outro';
        push(outro, raw);
        return;
      }
      stage = 'parts';
      const bucket: TourBucket = { title: titled.title, paragraphs: [], lastParagraph: index };
      parts.push(bucket);
      push(bucket, titled.body);
      return;
    }
    if (stage === 'intro') {
      push(intro, raw);
      return;
    }
    if (parts.length >= 4) {
      stage = 'outro';
      push(outro, raw);
      return;
    }
    push(parts[parts.length - 1], raw);
  });

  const bucketSegments = (bucket: TourBucket, prefix: string): GenesisSegment[] => segmentText(bucket.paragraphs.join('\n\n'), {
    language,
    complete: complete || bucket.lastParagraph < lastIndex,
    idPrefix: prefix,
  });

  const tourParts: GenesisTourPart[] = parts.map((bucket, index) => ({
    id: `${idPrefix}:p${index}`,
    title: bucket.title ?? fallback[index]?.title ?? '',
    body: bucketSegments(bucket, `${idPrefix}:p${index}`),
  }));
  if (complete) {
    for (let index = tourParts.length; index < 4 && index < fallback.length; index += 1) {
      tourParts.push({
        id: `${idPrefix}:f${index}`,
        title: fallback[index].title,
        body: segmentText(fallback[index].body, { language, complete: true, idPrefix: `${idPrefix}:f${index}` }),
      });
    }
  }
  return {
    intro: bucketSegments(intro, `${idPrefix}:i`),
    parts: tourParts,
    outro: bucketSegments(outro, `${idPrefix}:o`),
  };
}

// ---------------------------------------------------------------------------
// State helpers (every change bumps the revision)
// ---------------------------------------------------------------------------

export function createGenesisStageState(input: {
  sessionId: string;
  language: GenesisLanguage;
  botName: string;
  globalMetaId?: string | null;
}): GenesisStageState {
  return {
    protocol: GENESIS_STAGE_PROTOCOL,
    sessionId: input.sessionId,
    revision: 0,
    enabled: true,
    language: input.language,
    botName: input.botName.trim().slice(0, 80) || 'Twin',
    globalMetaId: (input.globalMetaId ?? '').trim().slice(0, 128),
    intro: 'play',
    phase: 'greeting',
    turn: { id: 'greeting', kind: 'greeting', segments: [], tour: null, complete: false, failed: false },
    listening: false,
    invite: null,
    naming: null,
    copy: genesisCopy(input.language),
  };
}

export function applyTurnText(
  state: GenesisStageState,
  input: { turnId: string; kind: GenesisTurnKind; text: string; complete: boolean; failed?: boolean },
): GenesisStageState {
  const options = { language: state.language, complete: input.complete, idPrefix: input.turnId };
  const turn: GenesisTurn = input.kind === 'tour'
    ? { id: input.turnId, kind: 'tour', segments: [], tour: parseTour(input.text, { ...options, fallback: state.copy.tourFallback }), complete: input.complete, failed: input.failed === true }
    : { id: input.turnId, kind: input.kind, segments: segmentText(input.text, options), tour: null, complete: input.complete, failed: input.failed === true };
  return { ...state, turn, listening: false, revision: state.revision + 1 };
}

export function beginListening(state: GenesisStageState): GenesisStageState {
  return { ...state, listening: true, revision: state.revision + 1 };
}

export function showInvite(state: GenesisStageState, token: string): GenesisStageState {
  return { ...state, invite: { token }, revision: state.revision + 1 };
}

export function clearInvite(state: GenesisStageState): GenesisStageState {
  if (!state.invite) return state;
  return { ...state, invite: null, revision: state.revision + 1 };
}

export function setGenesisPhase(state: GenesisStageState, phase: GenesisPhase): GenesisStageState {
  if (state.phase === phase) return state;
  return { ...state, phase, revision: state.revision + 1 };
}

export function setGenesisNaming(state: GenesisStageState, name: string, eventId: string): GenesisStageState {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return state;
  return { ...state, botName: trimmed, naming: { name: trimmed, eventId }, revision: state.revision + 1 };
}
