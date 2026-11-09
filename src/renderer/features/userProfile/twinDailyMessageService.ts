/**
 * twin 每日寄语 (Twin's daily note) — the {date, text} field service for the
 * 「我的」identity card (总裁办公室重构 · 用户中心身份卡 2026-11-09).
 *
 * The identity card's third line used to be the wallet address; that line is
 * now the daily-note slot. This module is the ONLY reader of the field:
 *
 *  1. `readTwinDailyMessage()` — today's twin-written note. The field lives in
 *     renderer localStorage under `TWIN_DAILY_MESSAGE_STORAGE_KEY` as a JSON
 *     `{date, text}` object (`date` = local `YYYY-MM-DD`). The note itself is
 *     produced OUT of band — the twin composes it during the daily-report
 *     flow (Monday side, not this tree) and lands it via
 *     `writeTwinDailyMessage()`. A stale / corrupt / missing entry is simply
 *     "no note today".
 *  2. `resolveSessionFallbackMessage()` — the fallback: ONE warm line picked
 *     randomly from `FALLBACK_DAILY_MESSAGES` per app session. Stable within
 *     the session (a module-level singleton, so re-renders and remounts keep
 *     the same line), fresh across sessions (each app process re-rolls).
 *
 * Boundaries (per the批单): NO model call, NO external API, NO network of any
 * kind — the module deliberately imports nothing and touches nothing but the
 * renderer's localStorage. The random source is injectable so tests can pin
 * exact outcomes deterministically.
 */

/** One twin-written daily note, as stored in the field. */
export interface TwinDailyMessageEntry {
  /** Local calendar day this note belongs to, `YYYY-MM-DD`. */
  date: string;
  /** The warm line itself (whitespace-trimmed on read). */
  text: string;
}

/** Renderer localStorage key holding the `{date, text}` JSON field. */
export const TWIN_DAILY_MESSAGE_STORAGE_KEY = 'twin.dailyMessage';

/**
 * Local positive-energy pool for the no-note-today fallback.
 * ≥ 60 entries; entry 0 is fixed by the批单 and must never move.
 */
export const FALLBACK_DAILY_MESSAGES: readonly string[] = [
  '坚信正确的事情，并保持乐观！',
  '今天也请慢慢来，好事不怕晚。',
  '累了就歇一歇，路还长，不急。',
  '你已经比昨天走得更远了。',
  '小小的进步，也值得为自己鼓掌。',
  '天气不会一直下雨，心情也是。',
  '把今天过好，就是对明天最好的准备。',
  '慢一点没关系，方向对了就行。',
  '你的努力，时间都记着账呢。',
  '别怕走弯路，弯路上的风景也很美。',
  '深呼吸三次，再难的事也可以先迈一小步。',
  '保持善意，好运会在不经意的地方等你。',
  '允许自己不完美，也允许今天普通。',
  '心里的石头，也可以一块一块卸下来。',
  '你认真生活的样子，本身就很了不起。',
  '世界很大，但你的小日子同样值得认真过。',
  '今天的阳光，也照在你的身上。',
  '与其焦虑远方，不如先喝口热水。',
  '休息不是浪费时间，是为了走更稳。',
  '每一次坚持，都在悄悄塑造更好的你。',
  '不开心的话，就说给信任的人听。',
  '生活偶尔卡顿，但主线剧情依然向前。',
  '你值得被温柔对待，包括被自己。',
  '把大目标切小，今天只做一小块就好。',
  '昨天的事翻篇了，今天仍是崭新的。',
  '心平气和，是最省力的强大。',
  '记得吃饭，记得喝水，记得喜欢自己。',
  '所有认真，都会在某个时刻回馈你。',
  '世界上总有人悄悄欣赏着你的认真。',
  '别急着否定自己，答案常常来得晚一点。',
  '今天的风很温柔，适合原谅自己。',
  '你不是一个人在赶路，我们都在。',
  '步子小一点，也能穿过漫长的一天。',
  '快乐可以很简单：晒晒太阳，伸个懒腰。',
  '你的存在本身，就已经让某些事变好了。',
  '顶峰不急，先看看脚下的花开。',
  '想哭就哭一场，眼泪也是自我修复。',
  '保持好奇心，生活就会不断给你惊喜。',
  '今天做不完的事，明天依然有机会。',
  '相信积累的力量，涓滴终成江海。',
  '你的每一次尝试，都在拓宽自己的边界。',
  '心里有光，慢慢走也能照亮前路。',
  '允许暂停，人生不是一场不能停的比赛。',
  '和自己和解，是最划算的成长。',
  '今天也要好好吃饭，好好睡觉。',
  '你比自己想象中更坚韧、更勇敢。',
  '不必事事争先，按自己的节奏走。',
  '烦恼写下来，就小了一半。',
  '生活会回报每一个不肯敷衍的人。',
  '风雨是暂时的，撑伞的人是自己，也是我们。',
  '每天进步一点点，一年就是一大截。',
  '保持乐观不是天真，是策略。',
  '你认真对待生活，生活也会认真待你。',
  '别忘了给今天的自己道一声辛苦。',
  '慢火煮出的汤，最暖；慢慢来的人，最稳。',
  '有些路绕一点，反而看见更好的风景。',
  '今天的你，已经做得足够好了。',
  '世界偶尔粗粝，但温柔的人自带光。',
  '把担心换成行动，焦虑就少一半。',
  '请继续相信：好事正在赶来的路上。',
  '心情低落时，先照顾好身体，情绪会跟上。',
  '每一个平凡的日子，都藏着小小的礼物。',
  '你不需要完美，只需要继续。',
  '万事开头难，但你已经开了头。',
];

/** Local `YYYY-MM-DD` for a date (the field's `date` grammar). */
export function getLocalDateKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Validates one raw stored value against "is this TODAY's note". */
export function parseTwinDailyMessage(raw: unknown, today: string): TwinDailyMessageEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { date?: unknown; text?: unknown };
  if (typeof candidate.date !== 'string' || typeof candidate.text !== 'string') return null;
  if (candidate.date !== today) return null;
  const text = candidate.text.trim();
  if (!text) return null;
  return { date: candidate.date, text };
}

/**
 * Today's twin note, or null when the field is absent / corrupt / stale /
 * belongs to another day. Safe outside the renderer (returns null when
 * localStorage does not exist, e.g. in node-run tests).
 */
export function readTwinDailyMessage(now: Date = new Date()): TwinDailyMessageEntry | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const raw = storage.getItem(TWIN_DAILY_MESSAGE_STORAGE_KEY);
    if (!raw) return null;
    return parseTwinDailyMessage(JSON.parse(raw), getLocalDateKey(now));
  } catch {
    return null;
  }
}

/**
 * The single write entry point for the producer side (twin daily-report flow /
 * Monday): lands today's note for the identity card to pick up. Never called
 * by the card itself.
 */
export function writeTwinDailyMessage(entry: TwinDailyMessageEntry, now: Date = new Date()): void {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('twin daily message needs the renderer localStorage');
  storage.setItem(
    TWIN_DAILY_MESSAGE_STORAGE_KEY,
    JSON.stringify({ date: entry.date || getLocalDateKey(now), text: entry.text }),
  );
}

/**
 * PURE pick: one pool member from a uniform random source. Injectable `rand`
 * keeps the outcome deterministic under test (rand()=0 → the fixed first
 * entry; rand()→1 → the last entry).
 */
export function pickRandomFallbackMessage(rand: () => number = Math.random): string {
  const pool = FALLBACK_DAILY_MESSAGES;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  return pool[index];
}

/**
 * The session-stable fallback: the FIRST pick in this app process is cached
 * for its whole lifetime, so re-renders and remounts keep the same line while
 * every new app session re-rolls.
 */
let sessionFallbackMessage: string | null = null;
export function resolveSessionFallbackMessage(rand: () => number = Math.random): string {
  if (sessionFallbackMessage === null) {
    sessionFallbackMessage = pickRandomFallbackMessage(rand);
  }
  return sessionFallbackMessage;
}
