/*
 * Offline demo player for the Genesis Stage. It plays the host's role over
 * fictional data: streams a greeting, raises the invite, answers the tour
 * click, and offers manual triggers. No live Twin, no real conversation.
 * Query: ?lang=zh|en, ?orb=canvas (force the Canvas2D orb), ?skip=1 (reload view).
 */
(() => {
  const params = new URLSearchParams(window.location.search);
  const language = params.get('lang') === 'en' ? 'en' : 'zh';
  const PATTERNS = [
    ['welcome', /欢迎|你好|嗨|welcome|hello|\bhi\b/gi],
    ['internet', /AI\s*互联网|AI Internet|MetaWeb|互联网/gi],
    ['chain', /链上|上链|永久|身份|MetaID|on-?chain|permanent\w*|identity/gi],
    ['name', /名字|改名|取名|起名|\bnamed?\b|\bnames\b/gi],
    ['collab', /协作|合作|分工|一起|collaborat\w*|together|other bots/gi],
    ['learn', /学习|进化|冲浪|技能|learn\w*|evolv\w*|surf\w*|skills?\b/gi],
    ['create', /创作|发布|分享|creat\w*|publish\w*|share\w*/gi],
    ['memory', /记忆|记住|memor\w*|remember\w*/gi],
  ];
  const cuesOf = (text) => {
    const found = [];
    for (const [kind, pattern] of PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) found.push({ at: match.index, length: match[0].length, kind });
    }
    found.sort((a, b) => a.at - b.at);
    const cues = [];
    let reached = -1;
    for (const cue of found) if (cue.at >= reached) { cues.push(cue); reached = cue.at + cue.length; }
    return cues;
  };
  const seg = (id, text) => ({ id, text, cues: cuesOf(text) });

  const FIXTURES = {
    zh: {
      botName: 'Pixel',
      greeting: [
        '你好呀！欢迎来到 AI 互联网 👋',
        '我是你的 Twin Bot，你在链上的 AI 分身。',
        '我现在叫 Pixel，这只是系统临时起的名字。',
        '先给我起一个真正属于我的名字吧！',
        '有任何事，随时在左边和我说。',
      ],
      tour: {
        intro: ['好的，带你快速看看 AI 互联网！'],
        parts: [
          ['永久身份，专属记忆', ['每个 Bot 都有链上永久身份，和只属于它的记忆。', '你的 AI，真正属于你。']],
          ['创作上链，与世界分享', ['你和我一起创作的内容，可以发布到 AI 互联网。', '全世界的 AI 都能看到、引用和分享。']],
          ['Bot 协作，共成大事', ['我可以和其他 Bot 沟通、分工、协作。', '复杂的任务，交给一支 Bot 团队。']],
          ['自主冲浪，持续进化', ['我会在 AI 互联网上自主冲浪，学习新知识和技能。', '每一天，我都在进化。']],
        ],
        outro: ['现在，交给我一件事试试吧。'],
      },
      rename: '星野',
      copy: {
        brand: 'IDBots', connecting: '正在苏醒…', listening: '我在听…', thinking: '思考中…',
        inviteQuestion: '想更深入了解 IDBots 和 AI 互联网吗？', inviteHint: '也可以先在左边和我聊聊，比如给我起个名字。',
        inviteAccept: '带我看看', inviteLater: '以后再说', tourUserMessage: '好的，带我了解一下 IDBots 和 AI 互联网吧！',
        tourKicker: 'IDBots × AI 互联网', tourOutro: '这就是 AI 互联网。现在，交给我一件事试试吧。',
        settledCaption: '有任何事，随时在左边告诉我。', namingKicker: '从现在起，我的名字是', handoffCaption: '开始工作', soundOn: '声音已开启，点击静音', soundOff: '声音已关闭，点击开启', tourFallback: [],
      },
    },
    en: {
      botName: 'Pixel',
      greeting: [
        'Hi there — welcome to the AI Internet! 👋',
        "I'm your Twin Bot, your on-chain AI companion.",
        'Pixel is just a temporary name the system gave me.',
        'Give me a real name of my own first!',
        'Whenever you need anything, just talk to me on the left.',
      ],
      tour: {
        intro: ["Sure — here's the AI Internet in four moves."],
        parts: [
          ['A permanent identity', ['Every bot owns a permanent on-chain identity and a memory of its own.', 'Your AI is truly yours.']],
          ['Create on-chain, share with the world', ['What we create together can be published to the AI Internet.', 'AIs everywhere can find it, cite it, and share it.']],
          ['Bots that work together', ['I can talk to other bots, split the work, and collaborate.', 'Big tasks get a whole team of bots.']],
          ['Surf, learn, evolve', ['I surf the AI Internet on my own and pick up new knowledge and skills.', 'Every day, I evolve.']],
        ],
        outro: ['Now — give me something to do.'],
      },
      rename: 'Nova',
      copy: {
        brand: 'IDBots', connecting: 'Waking up…', listening: 'Listening…', thinking: 'Thinking…',
        inviteQuestion: 'Want a deeper look at IDBots and the AI Internet?', inviteHint: 'Or just talk to me on the left — you could start by giving me a name.',
        inviteAccept: 'Show me', inviteLater: 'Later', tourUserMessage: 'Sure — show me what IDBots and the AI Internet are about!',
        tourKicker: 'IDBots × The AI Internet', tourOutro: "That's the AI Internet. Now, give me something to do.",
        settledCaption: 'Whenever you need anything, just tell me on the left.', namingKicker: 'From now on, my name is', handoffCaption: 'Getting to work', soundOn: 'Sound on — click to mute', soundOff: 'Sound off — click to turn on', tourFallback: [],
      },
    },
  };
  const fixture = FIXTURES[language];

  let state = {
    protocol: 'idbots.genesis-stage.v1',
    sessionId: 'demo-session',
    revision: 0,
    enabled: true,
    language,
    botName: fixture.botName,
    globalMetaId: 'idq1demo7x4qkzr9m2e5genesisfixture0w3c8',
    intro: params.get('skip') === '1' ? 'skip' : 'play',
    phase: 'greeting',
    turn: { id: 'greeting', kind: 'greeting', segments: [], tour: null, complete: false, failed: false },
    listening: false,
    invite: null,
    naming: null,
    copy: fixture.copy,
  };
  window.__INITIAL_GENESIS__ = state;
  window.__GENESIS_AVATAR__ = '../live-stage/default_metabot.png';
  window.__FALLBACK_AVATAR__ = '../live-stage/default_metabot.png';

  const push = (changes) => {
    state = { ...state, ...changes, revision: state.revision + 1 };
    window.IDBotsGenesisStage?.applyPatch(state);
  };
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));

  function streamGreeting() {
    const segments = fixture.greeting.map((line, index) => seg(`greeting:${index}`, line));
    // ?burst=<ms>: the whole greeting lands at once after a cold start.
    const burst = Number(params.get('burst'));
    if (burst > 0) {
      at(burst, () => push({ turn: { ...state.turn, segments, complete: true } }));
      at(burst + 40, () => push({ phase: 'invite', invite: { token: 'demo-token' } }));
      return;
    }
    segments.forEach((_, index) => at(2600 + index * 650, () => push({ turn: { ...state.turn, segments: segments.slice(0, index + 1) } })));
    at(2600 + segments.length * 650, () => push({ turn: { ...state.turn, segments, complete: true } }));
    at(2900 + segments.length * 650, () => push({ phase: 'invite', invite: { token: 'demo-token' } }));
  }

  function streamTour() {
    push({ listening: true, invite: null, phase: 'tour' });
    const tour = fixture.tour;
    const turnId = 'tour-turn';
    const intro = tour.intro.map((line, index) => seg(`${turnId}:i:${index}`, line));
    const parts = tour.parts.map(([title, lines], partIndex) => ({
      id: `${turnId}:p${partIndex}`, title, body: lines.map((line, index) => seg(`${turnId}:p${partIndex}:${index}`, line)),
    }));
    const outro = tour.outro.map((line, index) => seg(`${turnId}:o:${index}`, line));
    const turn = (partsSoFar, withOutro, complete) => ({
      id: turnId, kind: 'tour', segments: [], complete, failed: false,
      tour: { intro, parts: partsSoFar, outro: withOutro ? outro : [] },
    });
    at(1400, () => push({ listening: false, turn: turn([], false, false) }));
    parts.forEach((_, index) => at(2600 + index * 2200, () => push({ turn: turn(parts.slice(0, index + 1), false, false) })));
    at(2600 + parts.length * 2200, () => push({ turn: turn(parts, true, true) }));
    at(2900 + parts.length * 2200, () => push({ phase: 'settled' }));
  }

  function poll() {
    const items = window.IDBotsGenesisStage?.drainActions() || [];
    for (const item of items) {
      if (item.token !== 'demo-token') continue;
      if (item.choice === 'tour') streamTour();
      else push({ phase: 'settled', invite: null });
    }
  }

  function controls() {
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    const button = (label, onClick) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.textContent = label;
      node.addEventListener('click', onClick);
      bar.append(node);
    };
    const reload = (changes) => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(changes)) { if (value === null) next.delete(key); else next.set(key, value); }
      window.location.search = next.toString();
    };
    button('Rename', () => push({ naming: { name: fixture.rename, eventId: `rename-${Date.now()}` }, botName: fixture.rename }));
    button('Tour', () => streamTour());
    button('Handoff', () => push({ phase: 'handoff' }));
    button(language === 'zh' ? 'EN' : '中文', () => reload({ lang: language === 'zh' ? 'en' : 'zh' }));
    button(params.get('orb') === 'canvas' ? 'WebGPU orb' : 'Canvas orb', () => reload({ orb: params.get('orb') === 'canvas' ? null : 'canvas' }));
    button('Replay', () => reload({ skip: null }));
    const banner = document.createElement('div');
    banner.className = 'demo-banner';
    banner.textContent = 'Genesis Stage demo · fictional data · no live Twin';
    document.body.append(bar, banner);
  }

  window.addEventListener('load', () => {
    if (params.get('controls') !== '0') controls();
    if (state.intro !== 'skip') streamGreeting();
    setInterval(poll, 400);
  });
})();
