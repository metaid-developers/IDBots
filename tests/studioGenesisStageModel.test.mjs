import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const model = require('../dist-electron/main/services/studioGenesisStageModel.js');
const {
  GENESIS_STAGE_PROTOCOL,
  stripMarkdown,
  segmentText,
  parseTour,
  findCues,
  isGenesisTalkTool,
  genesisCopy,
  createGenesisStageState,
  applyTurnText,
  beginListening,
  showInvite,
  clearInvite,
  setGenesisPhase,
  setGenesisNaming,
} = model;

const texts = (segments) => segments.map((segment) => segment.text);

test('stripMarkdown keeps prose and emoji and drops markdown chrome', () => {
  const raw = [
    '# Hello',
    '**Welcome** to the [AI Internet](metaapp://abc) 👋',
    '',
    '- first `item`',
    '1. second _item_',
    '> quoted',
    '```js',
    'const hidden = true;',
    '```',
    '![logo](https://x/y.png)<b>tag</b>',
  ].join('\n');
  assert.equal(
    stripMarkdown(raw),
    'Hello\nWelcome to the AI Internet 👋\n\nfirst item\nsecond item\nquoted\n\ntag',
  );
});

test('segmentText splits zh greetings into short paragraph-bound segments', () => {
  const text = '你好呀！欢迎来到 AI 互联网 👋\n\n我是你的 Twin Bot，你在链上的 AI 分身。现在的名字 Pixel 只是系统临时起的。\n\n给我起个真正的名字吧！';
  const segments = segmentText(text, { language: 'zh', complete: true, idPrefix: 'g' });
  assert.deepEqual(texts(segments), [
    '你好呀！欢迎来到 AI 互联网 👋',
    '我是你的 Twin Bot，你在链上的 AI 分身。',
    '现在的名字 Pixel 只是系统临时起的。',
    '给我起个真正的名字吧！',
  ]);
  assert.deepEqual(segments.map((segment) => segment.id), ['g:0', 'g:1', 'g:2', 'g:3']);
});

test('segmentText caps long zh sentences at soft breaks', () => {
  const sentence = '我可以帮你在 AI 互联网上搜索资料、整理笔记、发布作品、联系其他 Bot、安排定时任务，还能陪你聊天解闷，以及更多你能想到的事情。';
  const segments = segmentText(sentence, { language: 'zh', complete: true, idPrefix: 'g' });
  assert.ok(segments.length >= 2, 'long sentence is split');
  for (const segment of segments) assert.ok([...segment.text].length <= 40, segment.text);
  assert.equal(texts(segments).join(''), sentence);
});

test('segmentText merges a tiny lead-in sentence and holds back the streaming tail', () => {
  const streaming = segmentText('Hi! I am your Twin Bot, your on-chain AI companion. My name', { language: 'en', complete: false, idPrefix: 'g' });
  assert.deepEqual(texts(streaming), ['Hi! I am your Twin Bot, your on-chain AI companion.']);
  const later = segmentText('Hi! I am your Twin Bot, your on-chain AI companion. My name is temporary.', { language: 'en', complete: true, idPrefix: 'g' });
  assert.deepEqual(texts(later), ['Hi! I am your Twin Bot, your on-chain AI companion.', 'My name is temporary.']);
});

test('segmentText is prefix-stable while text streams in', () => {
  const full = '欢迎来到 AI 互联网！我是你的 Twin Bot。\n\n我现在的名字是临时的，请给我起一个新名字。你也可以告诉我你希望我是什么性格。\n\n有事随时在左边叫我。';
  let previous = [];
  for (let end = 1; end <= full.length; end += 1) {
    const current = segmentText(full.slice(0, end), { language: 'zh', complete: false, idPrefix: 'g' });
    assert.ok(current.length >= previous.length, `segments never disappear at ${end}`);
    previous.forEach((segment, index) => assert.equal(current[index].text, segment.text, `segment ${index} stable at ${end}`));
    previous = current;
  }
  const done = segmentText(full, { language: 'zh', complete: true, idPrefix: 'g' });
  previous.forEach((segment, index) => assert.equal(done[index].text, segment.text));
});

test('findCues locates content keywords in zh and en', () => {
  assert.deepEqual(findCues('欢迎来到 AI 互联网，给我起个名字'), [
    { at: 0, kind: 'welcome' },
    { at: 5, kind: 'internet' },
    { at: 16, kind: 'name' },
  ]);
  assert.deepEqual(findCues('Bots collaborate on-chain and keep evolving.').map((cue) => cue.kind), ['collab', 'chain', 'learn']);
  assert.ok(findCues('x'.repeat(10)).length === 0);
});

test('segments carry their cues', () => {
  const [segment] = segmentText('欢迎来到 AI 互联网！', { language: 'zh', complete: true, idPrefix: 'g' });
  assert.deepEqual(segment.cues.map((cue) => cue.kind), ['welcome', 'internet']);
});

test('parseTour reads titled parts with intro and outro', () => {
  const text = [
    '好的，带你快速看看！',
    '',
    '**永久身份，专属记忆**：每个 Bot 都有链上永久身份和记忆。',
    '',
    '创作上链：你的作品可以发布到 AI 互联网。',
    '',
    '### Bot 协作',
    '和其他 Bot 分工协作。',
    '',
    '4. 自主进化 —— 在 AI 互联网冲浪、学习、进化。',
    '',
    '现在，交给我一件事试试吧。',
  ].join('\n');
  const tour = parseTour(text, { language: 'zh', complete: true, idPrefix: 't', fallback: genesisCopy('zh').tourFallback });
  assert.deepEqual(texts(tour.intro), ['好的，带你快速看看！']);
  assert.deepEqual(tour.parts.map((part) => part.title), ['永久身份，专属记忆', '创作上链', 'Bot 协作', '自主进化']);
  assert.deepEqual(texts(tour.parts[0].body), ['每个 Bot 都有链上永久身份和记忆。']);
  assert.deepEqual(texts(tour.parts[2].body), ['和其他 Bot 分工协作。']);
  assert.deepEqual(texts(tour.parts[3].body), ['在 AI 互联网冲浪、学习、进化。']);
  assert.deepEqual(texts(tour.outro), ['现在，交给我一件事试试吧。']);
});

test('parseTour handles consecutive numbered lines without blank lines', () => {
  const text = 'Here you go:\n1. **A permanent identity**: every bot is yours.\n2. **Create on-chain**: publish and share.\n3. **Work together**: bots collaborate.\n4. **Evolve**: surf and learn.';
  const tour = parseTour(text, { language: 'en', complete: true, idPrefix: 't', fallback: genesisCopy('en').tourFallback });
  assert.deepEqual(tour.parts.map((part) => part.title), ['A permanent identity', 'Create on-chain', 'Work together', 'Evolve']);
  assert.deepEqual(texts(tour.intro), ['Here you go:']);
});

test('parseTour falls back to paragraph order and built-in copy', () => {
  const untitled = 'Intro line.\n\nOne.\n\nTwo.\n\nThree.\n\nFour.';
  const tour = parseTour(untitled, { language: 'en', complete: true, idPrefix: 't', fallback: genesisCopy('en').tourFallback });
  assert.deepEqual(texts(tour.intro), ['Intro line.']);
  assert.deepEqual(tour.parts.map((part) => texts(part.body)[0]), ['One.', 'Two.', 'Three.', 'Four.']);
  assert.deepEqual(tour.parts.map((part) => part.title), genesisCopy('en').tourFallback.map((part) => part.title));

  const short = parseTour('**Only one**: a single part.', { language: 'en', complete: true, idPrefix: 't', fallback: genesisCopy('en').tourFallback });
  assert.equal(short.parts.length, 4);
  assert.equal(short.parts[0].title, 'Only one');
  assert.equal(short.parts[1].title, genesisCopy('en').tourFallback[1].title);

  const streaming = parseTour('**Only one**: a single part.', { language: 'en', complete: false, idPrefix: 't', fallback: genesisCopy('en').tourFallback });
  assert.equal(streaming.parts.length, 1, 'no fallback fill while the reply is still streaming');
});

test('parseTour emissions are prefix-stable while the tour streams', () => {
  const full = 'Sure, here is the quick tour!\n\n**A permanent identity**: every bot owns an on-chain identity. Its memory stays with it.\n\n**Create on-chain**: publish what you make and share it with AIs everywhere.\n\n**Work together**: bots split the work and collaborate.\n\n**Evolve**: your bot surfs, learns, and keeps evolving.\n\nNow give me something to do.';
  const fallback = genesisCopy('en').tourFallback;
  const flatten = (tour) => [
    ...tour.intro.map((segment) => [segment.id, segment.text]),
    ...tour.parts.flatMap((part) => [[part.id, part.title], ...part.body.map((segment) => [segment.id, segment.text])]),
    ...tour.outro.map((segment) => [segment.id, segment.text]),
  ];
  let previous = new Map();
  for (let end = 1; end <= full.length; end += 1) {
    const tour = parseTour(full.slice(0, end), { language: 'en', complete: false, idPrefix: 't', fallback });
    const current = new Map(flatten(tour));
    for (const [id, value] of previous) {
      if (id.split(':').length === 2 && id.startsWith('t:p')) continue; // part titles may appear before their body
      assert.equal(current.get(id), value, `${id} stable at ${end}`);
    }
    previous = current;
  }
  const done = parseTour(full, { language: 'en', complete: true, idPrefix: 't', fallback });
  assert.deepEqual(done.parts.map((part) => part.title), ['A permanent identity', 'Create on-chain', 'Work together', 'Evolve']);
  assert.deepEqual(texts(done.outro), ['Now give me something to do.']);
});

test('talk tools keep the welcome; work tools do not', () => {
  for (const name of ['metabot_update', 'metabot_list', 'metabot_getinfo', 'owner_update', 'memory_write', 'mcp__idbots__metabot_update']) {
    assert.equal(isGenesisTalkTool(name), true, name);
  }
  for (const name of ['web_search', 'local_worker_delegate', 'bot_browser_open', 'write', 'bash', 'metabot_create', '']) {
    assert.equal(isGenesisTalkTool(name), false, name);
  }
});

test('copy is complete in both languages with four tour fallbacks', () => {
  for (const language of ['zh', 'en']) {
    const copy = genesisCopy(language);
    assert.equal(copy.tourFallback.length, 4);
    for (const [key, value] of Object.entries(copy)) {
      if (key === 'tourFallback') continue;
      assert.equal(typeof value, 'string', key);
      assert.ok(value.trim(), `${language}.${key}`);
    }
    copy.tourFallback.forEach((part) => assert.ok(part.title && part.body));
  }
});

test('state helpers bump revisions and shape turns', () => {
  const initial = createGenesisStageState({ sessionId: 's1', language: 'en', botName: 'Pixel', globalMetaId: 'idq1abc' });
  assert.equal(initial.protocol, GENESIS_STAGE_PROTOCOL);
  assert.equal(initial.revision, 0);
  assert.equal(initial.phase, 'greeting');
  assert.equal(initial.intro, 'play');
  assert.equal(initial.turn.kind, 'greeting');

  const streaming = applyTurnText(initial, { turnId: 'greeting', kind: 'greeting', text: 'Hello there, welcome to the AI Internet! I am', complete: false });
  assert.equal(streaming.revision, 1);
  assert.deepEqual(texts(streaming.turn.segments), ['Hello there, welcome to the AI Internet!']);
  assert.equal(streaming.listening, false);

  const listening = beginListening(streaming);
  assert.equal(listening.listening, true);

  const tour = applyTurnText(listening, { turnId: 'm2', kind: 'tour', text: '**One**: a.', complete: true });
  assert.equal(tour.turn.kind, 'tour');
  assert.equal(tour.turn.tour.parts.length, 4);
  assert.equal(tour.turn.complete, true);
  assert.equal(tour.listening, false);

  const invited = showInvite(tour, 'tok');
  assert.deepEqual(invited.invite, { token: 'tok' });
  assert.equal(clearInvite(invited).invite, null);
  assert.equal(setGenesisPhase(invited, 'settled').phase, 'settled');
  const named = setGenesisNaming(invited, 'Nova', 'e1');
  assert.equal(named.botName, 'Nova');
  assert.deepEqual(named.naming, { name: 'Nova', eventId: 'e1' });
  assert.ok(named.revision > invited.revision);
});

test('a failed turn with no text keeps fallback-ready empty segments', () => {
  const initial = createGenesisStageState({ sessionId: 's1', language: 'zh', botName: 'Pixel', globalMetaId: '' });
  const failedTour = applyTurnText(initial, { turnId: 'm2', kind: 'tour', text: '', complete: true, failed: true });
  assert.equal(failedTour.turn.failed, true);
  assert.deepEqual(failedTour.turn.tour.parts.map((part) => part.title), genesisCopy('zh').tourFallback.map((part) => part.title));
});
