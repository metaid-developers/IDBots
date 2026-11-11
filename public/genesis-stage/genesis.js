/*
 * Studio Genesis Stage runtime — the first-run welcome stage.
 *
 * The host (studioGenesisStageService) owns every fact: the Twin's words, the
 * turn boundaries, the invite token, the naming event, and the handoff. This
 * page owns presentation and pacing only: it speaks host-provided segments at
 * reading pace, reacts to content cues, plays the four tour scenes, and queues
 * invite clicks for the host to drain. All text reaches the DOM through
 * textContent.
 */
(() => {
  'use strict';
  const PROTOCOL = 'idbots.genesis-stage.v1';
  const initial = window.__INITIAL_GENESIS__;
  if (!initial || initial.protocol !== PROTOCOL) return;

  let state = initial;
  const body = document.body;
  const reducedMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  const forcedCanvas = new URLSearchParams(window.location.search).get('orb') === 'canvas';
  const actionQueue = [];

  // ───────────────────────────── helpers ─────────────────────────────
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = {
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inOutCubic: (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outBack: (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    inCubic: (t) => t * t * t,
  };
  const hash = (n) => { const value = Math.sin(n * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
  const hexToRgb = (hex) => [0, 2, 4].map((offset) => Number.parseInt(String(hex).slice(1 + offset, 3 + offset), 16) / 255);
  const rgbToCss = (rgb, alpha = 1) => `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${alpha})`;
  const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const el = (tag, className, attrs) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const text = (node, value) => { node.textContent = value; return node; };
  const isZh = () => state.language === 'zh';
  const shortId = (id) => (id && id.length > 16 ? `${id.slice(0, 7)}…${id.slice(-5)}` : id || '');

  // ───────────────────────────── DOM ─────────────────────────────
  const stage = el('main', 'g-stage', { 'aria-live': 'polite' });
  const voidLayer = el('div', 'g-void');
  const liveVoid = el('div', 'g-void-live');
  const field = el('canvas', 'g-field', { 'aria-hidden': 'true' });
  const fx = el('canvas', 'g-fx', { 'aria-hidden': 'true' });
  const orbBox = el('div', 'g-orb');
  const orbBody = el('div', 'g-orb-body');
  const halo = el('div', 'g-orb-halo');
  const orbLayers = el('div', 'g-orb-layers');
  orbBody.append(halo, orbLayers);
  orbBox.append(orbBody);
  const avatar = el('img', 'g-avatar', { alt: '' });
  avatar.addEventListener('error', () => { if (avatar.src !== window.__FALLBACK_AVATAR__) avatar.src = window.__FALLBACK_AVATAR__; });
  if (typeof window.__GENESIS_AVATAR__ === 'string') avatar.src = window.__GENESIS_AVATAR__;

  const crt = el('div', 'g-crt', { 'aria-hidden': 'true' });
  crt.append(el('i', 'g-crt-scan'), el('i', 'g-crt-flash'), el('i', 'g-crt-line'), el('i', 'g-crt-dot'), el('i', 'g-crt-drop'));

  const hud = el('header', 'g-hud');
  const hudLeft = el('div', 'g-hud-left');
  const hudMark = el('span', 'g-hud-mark');
  hudMark.append(document.createTextNode('ID'), text(el('b'), 'Bots'));
  const hudPhase = el('span', 'g-hud-phase');
  hudLeft.append(hudMark, el('i', 'g-hud-sep'), hudPhase);
  const hudRight = el('div', 'g-hud-right');
  const hudName = el('span', 'g-hud-name');
  const hudId = el('span', 'g-hud-id');
  const hudClock = el('span', 'g-hud-clock');
  const hudSound = el('button', 'g-hud-sound', { type: 'button' });
  hudSound.append(el('i'), el('i'), el('i'));
  hudRight.append(hudSound, el('i', 'g-hud-pulse'), hudName, hudId, hudClock);
  hud.append(hudLeft, hudRight);

  const scene = el('section', 'g-scene');
  const sceneIndex = el('div', 'g-scene-index');
  const sceneTitle = el('h2', 'g-scene-title');
  scene.append(sceneIndex, sceneTitle);

  const subtitle = el('section', 'g-subtitle');
  const linePrev = el('p', 'g-line g-line-prev');
  const lineNow = el('p', 'g-line g-line-now');
  const status = el('div', 'g-status');
  subtitle.append(linePrev, lineNow, status);

  const naming = el('section', 'g-naming');
  const namingKicker = el('small');
  const namingName = el('strong');
  naming.append(namingKicker, namingName);

  const invite = el('section', 'g-invite', { role: 'dialog', 'aria-modal': 'false' });
  const inviteQuestion = el('p', 'g-invite-q');
  const inviteHint = el('p', 'g-invite-hint');
  const inviteActions = el('div', 'g-invite-actions');
  const inviteAccept = el('button', 'g-btn is-primary', { type: 'button' });
  const inviteLater = el('button', 'g-btn', { type: 'button' });
  inviteActions.append(inviteAccept, inviteLater);
  invite.append(inviteQuestion, inviteHint, inviteActions);

  const progress = el('nav', 'g-progress', { 'aria-hidden': 'true' });
  const progressBars = [0, 1, 2, 3].map(() => el('i'));
  progress.append(...progressBars);

  stage.append(voidLayer, liveVoid, field, orbBox, fx, avatar, crt, hud, scene, subtitle, naming, invite, progress, el('div', 'g-grain', { 'aria-hidden': 'true' }));
  body.append(stage);

  // ───────────────────────────── sound ─────────────────────────────
  // Synthesized cues (genesis-sound.js); the owner's mute choice is remembered
  // for every Genesis page on this origin.
  const SOUND_KEY = 'idbots.genesis.sound';
  const readSoundPreference = () => {
    try { return window.localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
  };
  const sound = typeof window.createGenesisSound === 'function'
    ? window.createGenesisSound({ enabled: readSoundPreference() })
    : null;
  const sfx = (name, params) => { if (sound && !local.handoff) sound.cue(name, params); };
  function syncSoundButton() {
    const on = Boolean(sound && sound.isEnabled());
    const label = on ? (state.copy.soundOn || 'Sound on') : (state.copy.soundOff || 'Sound off');
    hudSound.hidden = !sound || !sound.getContext();
    hudSound.dataset.on = on ? 'true' : 'false';
    hudSound.setAttribute('aria-pressed', String(on));
    hudSound.setAttribute('aria-label', label);
    hudSound.title = label;
  }
  hudSound.addEventListener('click', () => {
    if (!sound) return;
    const next = !sound.isEnabled();
    sound.setEnabled(next);
    try { window.localStorage.setItem(SOUND_KEY, next ? 'on' : 'off'); } catch { /* the choice stays this page's */ }
    syncSoundButton();
  });
  // Autoplay is allowed in the IDBots host; elsewhere the first touch unlocks audio.
  const unlockSound = () => { if (sound) sound.resume(); };
  window.addEventListener('pointerdown', unlockSound, true);
  window.addEventListener('keydown', unlockSound, true);

  // ───────────────────────────── orb looks ─────────────────────────────
  const BASE = typeof window.liquidOrbBaseParams === 'function' ? window.liquidOrbBaseParams() : {};
  const BASE_COLORS = {
    colorA: '#FFD86B', colorB: '#82F4FF', colorC: '#FF7BD5', colorD: '#8E6CFF', glowColor: '#956CFF',
    shellMid: '#9BF4FF', shellEdge: '#C5A9FF',
  };
  const PALETTES = {
    base: BASE_COLORS,
    birth: { colorA: '#B6F0FF', colorB: '#3D7DFF', colorC: '#9BE7FF', colorD: '#5B4BFF', glowColor: '#58A6FF', shellMid: '#A9F1FF', shellEdge: '#9DB7FF' },
    plasma: { colorA: '#FF9BE2', colorB: '#7E8BFF', colorC: '#7CF4FF', colorD: '#C27BFF', glowColor: '#B37BFF', shellMid: '#D3B7FF', shellEdge: '#FF9BE2' },
    cool: { colorA: '#9EF1FF', colorB: '#6EA8FF', colorC: '#C5A9FF', colorD: '#5E7CFF', glowColor: '#6C8CFF', shellMid: '#9BF4FF', shellEdge: '#C5A9FF' },
    dusk: { colorA: '#FFC37B', colorB: '#FF7BD5', colorC: '#8E6CFF', colorD: '#82F4FF', glowColor: '#C56CFF', shellMid: '#FFC9E8', shellEdge: '#C5A9FF' },
    identity: { colorA: '#E3CF8F', colorB: '#7F97CC', colorC: '#DCE4F7', colorD: '#3E4A66', glowColor: '#E8CF7A', shellMid: '#DCE4F7', shellEdge: '#E8CF7A' },
    publish: { colorA: '#82F4FF', colorB: '#FF7BD5', colorC: '#FFD86B', colorD: '#8E6CFF', glowColor: '#FF6FCF', shellMid: '#9BF4FF', shellEdge: '#FF9DE6' },
    collab: { colorA: '#5EF2FF', colorB: '#2FD3C6', colorC: '#9BF4FF', colorD: '#3A8BFF', glowColor: '#43E0FF', shellMid: '#9BF4FF', shellEdge: '#7FD4FF' },
    evolve: { colorA: '#B49BFF', colorB: '#8E6CFF', colorC: '#E0A3FF', colorD: '#5EF2FF', glowColor: '#9E7BFF', shellMid: '#D8C8FF', shellEdge: '#B49BFF' },
  };
  const CUE_PALETTES = {
    welcome: { colorA: '#FFD86B', colorB: '#FFB27A', colorC: '#FF7BD5', colorD: '#FFE9A8', glowColor: '#FFB35C' },
    internet: { colorA: '#82F4FF', colorB: '#8E6CFF', colorC: '#FF7BD5', colorD: '#7CFFB2', glowColor: '#6FD3FF' },
    chain: { colorA: '#F2F5FF', colorB: '#C9D8FF', colorC: '#FFE7A3', colorD: '#8FA3C7', glowColor: '#D8E4FF' },
    name: { colorA: '#FFDC51', colorB: '#FFC24D', colorC: '#FFF1B8', colorD: '#E8A93A', glowColor: '#FFD24D' },
    collab: { colorA: '#5EF2FF', colorB: '#2FD3C6', colorC: '#9BF4FF', colorD: '#3AA0FF', glowColor: '#43E0FF' },
    learn: { colorA: '#B49BFF', colorB: '#8E6CFF', colorC: '#E0A3FF', colorD: '#6A5BFF', glowColor: '#9E7BFF' },
    create: { colorA: '#FF7BD5', colorB: '#FF9DE6', colorC: '#FFD86B', colorD: '#C86BFF', glowColor: '#FF6FCF' },
    memory: { colorA: '#9FD4FF', colorB: '#C5A9FF', colorC: '#EAF4FF', colorD: '#7DA6FF', glowColor: '#A9C8FF' },
  };
  const LOOKS = {
    birth: { style: 20, palette: 'birth', params: { radius: .6, speed: 1.5, warp: 4.6, contourDeform: .9, glassOpacity: .5, edgeGlow: .22, exposure: 1.5, zoom: .42 } },
    plasma: { style: 11, palette: 'plasma', params: { radius: .6, speed: 1.25, warp: 4.2, contourDeform: .8, glassOpacity: .52, edgeGlow: .18, exposure: 1.42 } },
    home: { style: 9, palette: 'base', params: { radius: .6, speed: .95, warp: 3.6, contourDeform: .5, glassOpacity: .6, edgeGlow: .12, exposure: 1.36 } },
    thinking: { style: 9, palette: 'cool', params: { radius: .58, speed: .55, warp: 2.7, contourDeform: .32, glassOpacity: .62, edgeGlow: .09, exposure: 1.3 } },
    listening: { style: 9, palette: 'cool', params: { radius: .55, speed: .42, warp: 2.4, contourDeform: .18, glassOpacity: .66, edgeGlow: .17, exposure: 1.28 } },
    identity: { style: 22, palette: 'identity', params: { radius: .55, speed: .6, warp: 3, contourDeform: .14, glassOpacity: .66, edgeGlow: .12, exposure: .98, metalEvolution: 1.4 } },
    publish: { style: 14, palette: 'publish', params: { radius: .56, speed: 1.05, warp: 3.8, contourDeform: .6, glassOpacity: .58, edgeGlow: .2, exposure: 1.4 } },
    collab: { style: 10, palette: 'collab', params: { radius: .5, speed: .9, warp: 3.6, contourDeform: .45, glassOpacity: .6, edgeGlow: .16, exposure: 1.18 } },
    evolve: { style: 15, palette: 'evolve', params: { radius: .56, speed: 1.2, warp: 4.4, contourDeform: 1.1, glassOpacity: .56, edgeGlow: .2, exposure: 1.42 } },
    finale: { style: 9, palette: 'base', params: { radius: .58, speed: .8, warp: 3.4, contourDeform: .3, glassOpacity: .62, edgeGlow: .11, exposure: 1.36 } },
    handoff: { style: 9, palette: 'base', params: { radius: .72, speed: .82, warp: 3.2, contourDeform: .035, glassOpacity: .62, edgeGlow: .08, exposure: 1.36, zoom: .36 } },
  };
  const EVOLVE_STYLES = [15, 13, 21, 23];
  const SCENE_LOOKS = ['identity', 'publish', 'collab', 'evolve'];
  const SCENE_MODES = ['identity', 'publish', 'collab', 'evolve'];
  const SCENE_TINTS = ['#f2e2a8', '#ffb0e8', '#8ff6ef', '#cdb8ff'];

  // ───────────────────────────── orb manager ─────────────────────────────
  const orb = {
    backend: 'loading',
    layers: [],
    active: null,
    look: 'home',
    params: { ...BASE, ...LOOKS.home.params },
    style: 9,
    paletteName: 'base',
    radius: LOOKS.home.params.radius,
    failed: false,
    mounting: false,
  };

  function lookParams(name) {
    const look = LOOKS[name] || LOOKS.home;
    return { ...BASE, ...look.params };
  }

  function disposeLayer(layer, destroyDevice = false) {
    if (!layer) return;
    clearTimeout(layer.fadeTimer);
    try { layer.controller?.dispose(destroyDevice); } catch { /* already gone */ }
    layer.canvas.remove();
    orb.layers = orb.layers.filter((entry) => entry !== layer);
  }

  function switchToCanvas(reason) {
    if (orb.backend === 'canvas') return;
    orb.failed = true;
    const devices = new Set(orb.layers.map((layer) => layer.controller?.getSharedResources?.()?.device).filter(Boolean));
    [...orb.layers].forEach((layer) => disposeLayer(layer));
    devices.forEach((device) => { try { device.destroy(); } catch { /* lost */ } });
    orb.active = null;
    orb.backend = 'canvas';
    window.__genesisOrbError = reason instanceof Error ? reason.message : String(reason || '');
    mountLayer(orb.style, true);
  }

  function mountLayer(style, immediate) {
    const previous = orb.active;
    const canvas = el('canvas', '', { 'aria-hidden': 'true' });
    canvas.dataset.orbStyle = String(style);
    orbLayers.append(canvas);
    const layer = { canvas, controller: null, style, fadeTimer: 0 };
    orb.layers.push(layer);
    orb.active = layer;
    const params = { ...orb.params, style };
    const reveal = () => {
      if (orb.active !== layer) return;
      orb.ready = true;
      body.dataset.orbBackend = orb.backend;
      window.__genesisBackend = orb.backend;
      canvas.getBoundingClientRect();
      canvas.dataset.active = 'true';
      if (previous && previous !== layer) {
        previous.canvas.dataset.active = 'false';
        previous.fadeTimer = setTimeout(() => disposeLayer(previous), immediate ? 0 : 950);
      }
    };
    if (orb.backend === 'canvas' || forcedCanvas || orb.failed || typeof window.createLiquidOrbRenderer !== 'function') {
      orb.backend = 'canvas';
      try {
        layer.controller = window.createFallbackOrb(canvas, { onReady: reveal });
        layer.controller.setParams(params, { immediate: true });
        layer.controller.setReduced(reduced());
      } catch (error) {
        window.__genesisOrbError = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    orb.mounting = true;
    // Continue the previous layer's contour: the shader animates on
    // time × speed, so the new layer starts where the old one is.
    const previousPhase = previous?.controller?.getPhase?.();
    const startPhase = Number.isFinite(previousPhase)
      ? previousPhase * ((previous.speed || 1) / (params.speed || 1))
      : undefined;
    layer.speed = params.speed;
    window.createLiquidOrbRenderer(canvas, {
      startPhase,
      sharedResources: previous?.controller?.getSharedResources?.() || undefined,
      onReady: () => { orb.backend = 'webgpu'; reveal(); },
      onError: (error) => switchToCanvas(error),
    }).then((controller) => {
      orb.mounting = false;
      if (orb.active !== layer || orb.backend === 'canvas') {
        // Superseded before it was ready: nothing else can share its device.
        layer.controller = controller;
        disposeLayer(layer, !previous?.controller);
        return;
      }
      layer.controller = controller;
      controller.setParams(params, { immediate: true });
      controller.setReduced(reduced());
    }).catch((error) => { orb.mounting = false; switchToCanvas(error); });
  }

  /** Move the orb to a named look; a different shader style cross-fades a new layer. */
  function morph(name, options = {}) {
    const look = LOOKS[name] || LOOKS.home;
    orb.look = name;
    orb.params = lookParams(name);
    orb.paletteName = options.palette || look.palette;
    const style = options.style ?? look.style;
    const sameStyle = style === orb.style;
    orb.style = style;
    if (!orb.active) { mountLayer(style, true); return; }
    if (orb.backend === 'canvas' || sameStyle) {
      orb.layers.forEach((layer) => layer.controller?.setParams({ ...orb.params, style }, options));
      return;
    }
    mountLayer(style, false);
  }

  function setOrbStyle(style) {
    if (style === orb.style) return;
    orb.style = style;
    if (orb.backend === 'canvas') return;
    mountLayer(style, false);
  }

  function orbFrame(modulation, colors) {
    for (const layer of orb.layers) {
      const controller = layer.controller;
      if (!controller) continue;
      controller.setModulation(modulation);
      controller.setParams(colors);
    }
    orb.radius = lerp(orb.radius, orb.params.radius + (modulation.radius || 0), .12);
  }

  // ───────────────────────────── motion state ─────────────────────────────
  function reduced() {
    return reducedMedia.matches || document.hidden || state.enabled === false;
  }

  const local = {
    bootAt: 0,
    boot: 'pending',
    introDone: false,
    turnId: null,
    turnKind: null,
    played: new Set(),
    sceneIndex: -1,
    sceneEnteredAt: 0,
    evolveStep: 0,
    evolveAt: 0,
    blockUntil: 0,
    inviteToken: null,
    inviteAnswered: null,
    namingEventId: null,
    pendingNaming: null,
    handoff: false,
    settled: false,
    wasListening: false,
    birthAt: 0,
    shiftedPlasma: false,
    shiftedHome: false,
    lastPhaseLabel: '',
    ambientAt: 0,
    ambientIndex: 0,
  };

  // ───────────────────────────── speech ─────────────────────────────
  const speech = {
    segment: null,
    turnId: null,
    chars: [],
    offsets: [0],
    typed: 0,
    nextAt: 0,
    holdUntil: 0,
    typing: false,
    level: 0,
    cueIndex: 0,
    renderedTyped: -1,
    virtual: false,
  };
  const flashes = [];

  const charRate = () => (isZh() ? 28 : 64);
  const PAUSES = { '，': 160, '、': 140, ',': 120, '；': 220, ';': 200, '：': 180, ':': 160, '。': 360, '！': 360, '？': 360, '.': 300, '!': 300, '?': 300, '…': 260, '—': 160 };

  // The full text is already readable in the chat on the left, so the stage
  // keeps a brisk subtitle pace rather than full reading time.
  function holdFor(segment) {
    const units = Array.from(segment.text).length;
    return isZh() ? clamp(units * 70, 1100, 3400) : clamp(units * 26, 1100, 3800);
  }

  function startSegment(segment, t, options = {}) {
    retireLine();
    speech.segment = segment;
    speech.turnId = local.turnId;
    speech.chars = Array.from(segment.text);
    speech.offsets = [0];
    for (const char of speech.chars) speech.offsets.push(speech.offsets[speech.offsets.length - 1] + char.length);
    speech.cueIndex = 0;
    speech.virtual = options.virtual === true;
    speech.renderedTyped = -1;
    lineNow.classList.remove('is-settled');
    if (reduced() || options.instant) {
      speech.typed = speech.chars.length;
      speech.typing = false;
      speech.holdUntil = t + (options.instant ? 0 : holdFor(segment) * .6);
    } else {
      speech.typed = 0;
      speech.typing = true;
      speech.nextAt = t + 120;
      speech.holdUntil = Infinity;
      sfx('segment');
    }
    setStatus('');
    renderLine();
  }

  function retireLine() {
    const current = lineNow.textContent;
    if (!current) return;
    text(linePrev, current);
    lineNow.replaceChildren();
  }

  function finishSegment() {
    if (speech.segment) local.played.add(speech.segment.id);
    speech.segment = null;
    speech.typing = false;
  }

  /** The owner spoke: the bot stops mid-sentence and drops the rest of its old reply. */
  function silenceTurn(t) {
    const turn = currentTurn();
    if (!turn) return;
    const ids = turn.kind === 'tour' && turn.tour
      ? [...turn.tour.intro, ...turn.tour.parts.flatMap((part) => part.body), ...turn.tour.outro].map((segment) => segment.id)
      : turn.segments.map((segment) => segment.id);
    ids.forEach((id) => local.played.add(id));
    fastForwardSpeech(t);
  }

  function fastForwardSpeech(t) {
    if (!speech.segment) return;
    speech.typed = speech.chars.length;
    speech.typing = false;
    speech.holdUntil = Math.min(speech.holdUntil, t + 450);
    renderLine();
  }

  function triggerCue(kind, t) {
    sfx('cue', { kind });
    flashes.push({ kind, t0: t });
    if (flashes.length > 6) flashes.shift();
    const palette = CUE_PALETTES[kind];
    if (palette) addRipple(t, palette.glowColor, { width: 1.6, life: 1500, speed: 170 });
  }

  function updateSpeech(t, dt) {
    speech.level *= Math.exp(-dt * 7.5);
    if (!speech.segment || !speech.typing) return;
    let changed = false;
    while (speech.typing && t >= speech.nextAt) {
      const char = speech.chars[speech.typed];
      speech.typed += 1;
      changed = true;
      const offset = speech.offsets[speech.typed - 1];
      const cues = speech.segment.cues || [];
      while (speech.cueIndex < cues.length && cues[speech.cueIndex].at <= offset) {
        triggerCue(cues[speech.cueIndex].kind, t);
        speech.cueIndex += 1;
      }
      if (/[\p{L}\p{N}]/u.test(char)) speech.level = Math.min(1, speech.level + (isZh() ? .5 : .28));
      const pause = PAUSES[char] || 0;
      speech.nextAt += 1000 / charRate() + pause;
      if (speech.typed >= speech.chars.length) {
        speech.typing = false;
        speech.holdUntil = t + holdFor(speech.segment);
      }
    }
    if (changed) renderLine();
  }

  function renderLine() {
    const segment = speech.segment;
    if (!segment) return;
    if (speech.renderedTyped === speech.typed && !speech.typing) return;
    speech.renderedTyped = speech.typed;
    const end = speech.offsets[speech.typed];
    const freshFrom = speech.typing ? speech.offsets[Math.max(0, speech.typed - 2)] : end;
    const cuts = new Set([0, end, freshFrom]);
    for (const cue of segment.cues || []) {
      if (cue.at < end) { cuts.add(cue.at); cuts.add(Math.min(end, cue.at + cue.length)); }
    }
    const points = [...cuts].filter((value) => value <= end).sort((a, b) => a - b);
    const nodes = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index], to = points[index + 1];
      if (to <= from) continue;
      const span = el('span');
      const cue = (segment.cues || []).find((entry) => from >= entry.at && from < entry.at + entry.length);
      if (cue) span.className = `kw kw-${cue.kind}`;
      if (from >= freshFrom && speech.typing) span.classList.add('g-fresh');
      text(span, segment.text.slice(from, to));
      nodes.push(span);
    }
    if (speech.typing) nodes.push(el('span', 'g-caret'));
    lineNow.replaceChildren(...nodes);
  }

  function setStatus(value) {
    if (status.textContent !== value) text(status, value);
    status.classList.toggle('is-on', Boolean(value));
  }

  function settleLine(value) {
    if (lineNow.textContent === value) return;
    retireLine();
    lineNow.replaceChildren(document.createTextNode(value));
    lineNow.classList.add('is-settled');
  }

  // ───────────────────────────── director ─────────────────────────────
  const SCENE_MIN_MS = 6200;

  function currentTurn() { return state.turn || null; }

  function nextItem(t) {
    const turn = currentTurn();
    if (!turn) return null;
    if (turn.kind !== 'tour') {
      const segment = turn.segments.find((entry) => !local.played.has(entry.id));
      return segment ? { type: 'speak', segment } : null;
    }
    const tour = turn.tour || { intro: [], parts: [], outro: [] };
    for (const segment of tour.intro) if (!local.played.has(segment.id)) return { type: 'speak', segment };
    if (!tour.parts.length && !turn.complete) return null;
    for (let index = 0; index < tour.parts.length; index += 1) {
      const part = tour.parts[index];
      if (local.sceneIndex < index) {
        if (index > 0 && local.sceneIndex === index - 1 && t - local.sceneEnteredAt < SCENE_MIN_MS) return { type: 'dwell' };
        return { type: 'scene', index, part };
      }
      for (const segment of part.body) if (!local.played.has(segment.id)) return { type: 'speak', segment };
      const mayGrow = index === tour.parts.length - 1 && !turn.complete && tour.outro.length === 0;
      if (mayGrow) return null;
    }
    if (local.sceneIndex < 4) {
      if (!turn.complete && tour.outro.length === 0) return null;
      if (local.sceneIndex >= 0 && t - local.sceneEnteredAt < SCENE_MIN_MS) return { type: 'dwell' };
      return { type: 'finale' };
    }
    for (const segment of tour.outro) if (!local.played.has(segment.id)) return { type: 'speak', segment };
    return null;
  }

  function enterScene(index, part, t) {
    local.sceneIndex = index;
    local.sceneEnteredAt = t;
    local.blockUntil = t + 1300;
    retireLine();
    lineNow.replaceChildren();
    text(sceneIndex, `${String(index + 1).padStart(2, '0')} / 04`);
    text(sceneTitle, part.title || '');
    scene.style.setProperty('--scene-tint', SCENE_TINTS[index]);
    scene.classList.remove('is-on');
    scene.getBoundingClientRect();
    scene.classList.add('is-on');
    progress.classList.add('is-on');
    progressBars.forEach((bar, barIndex) => bar.style.setProperty('--fill', barIndex <= index ? '1' : '0'));
    setFieldMode(SCENE_MODES[index], t);
    morph(SCENE_LOOKS[index]);
    sfx('chapter', { index });
    if (index === 3) { local.evolveStep = 0; local.evolveAt = t; sfx('warp', { delay: 0.4 }); }
    addRipple(t, PALETTES[SCENE_LOOKS[index]].glowColor, { width: 2.4, life: 1800, speed: 260 });
    bloom(t, PALETTES[SCENE_LOOKS[index]].glowColor);
  }

  function enterFinale(t) {
    local.sceneIndex = 4;
    local.sceneEnteredAt = t;
    scene.classList.remove('is-on');
    progressBars.forEach((bar) => bar.style.setProperty('--fill', '1'));
    setTimeout(() => progress.classList.remove('is-on'), 1600);
    setFieldMode('finale', t);
    morph('finale');
    bloom(t, '#FFDC51');
    sfx('finale');
    const turn = currentTurn();
    if (turn && turn.tour && turn.tour.outro.length === 0) {
      startSegment({ id: `${turn.id}:outro-fallback`, text: state.copy.tourOutro, cues: [] }, t, { virtual: true });
    }
  }

  function exitTour(t) {
    if (local.sceneIndex < 0) return;
    local.sceneIndex = -1;
    scene.classList.remove('is-on');
    progress.classList.remove('is-on');
    setFieldMode('idle', t);
    morph('home');
  }

  function handleTurnChange(t) {
    const turn = currentTurn();
    const nextId = turn ? turn.id : null;
    if (nextId === local.turnId) return;
    const previousKind = local.turnKind;
    local.turnId = nextId;
    local.turnKind = turn ? turn.kind : null;
    local.settled = false;
    if (speech.segment) fastForwardSpeech(t);
    if (turn && turn.kind === 'tour') {
      local.sceneIndex = -1;
      setFieldMode('idle', t);
    } else if (previousKind === 'tour') {
      exitTour(t);
    }
  }

  function inviteReady(t) {
    if (!state.invite || local.handoff || !local.introDone) return false;
    if (local.inviteAnswered === state.invite.token) return false;
    if (state.listening) return false;
    const turn = currentTurn();
    if (turn && !turn.complete) return false;
    if (nextItem(t)) return false;
    return !speech.segment || (!speech.typing && t >= speech.holdUntil);
  }

  function syncInvite(t) {
    const show = inviteReady(t);
    if (show && !invite.classList.contains('is-on')) {
      text(inviteQuestion, state.copy.inviteQuestion);
      text(inviteHint, state.copy.inviteHint);
      text(inviteAccept, state.copy.inviteAccept);
      text(inviteLater, state.copy.inviteLater);
      inviteAccept.disabled = false;
      inviteLater.disabled = false;
      local.inviteToken = state.invite.token;
      bloom(t, '#82F4FF');
      sfx('invite-open');
    }
    invite.classList.toggle('is-on', show);
    const flag = show ? 'on' : 'off';
    if (body.dataset.invite !== flag) body.dataset.invite = flag;
  }

  function answerInvite(choice) {
    const token = local.inviteToken;
    if (!token || local.inviteAnswered === token) return;
    local.inviteAnswered = token;
    actionQueue.push({ token, choice });
    inviteAccept.disabled = true;
    inviteLater.disabled = true;
    invite.classList.remove('is-on');
    body.dataset.invite = 'off';
    const now = performance.now();
    if (choice === 'tour') {
      bloom(now, '#FFDC51');
      setStatus(state.copy.thinking);
      sfx('invite-accept');
    } else {
      settleLine(state.copy.settledCaption);
      sfx('invite-later');
    }
  }
  inviteAccept.addEventListener('click', () => answerInvite('tour'));
  inviteLater.addEventListener('click', () => answerInvite('later'));

  function idle(t) {
    const turn = currentTurn();
    if (local.sceneIndex >= 0 && local.sceneIndex < 4) {
      setStatus(turn && !turn.complete ? state.copy.thinking : '');
      return;
    }
    if (state.listening) {
      setStatus(state.copy.listening);
      if (orb.look !== 'listening') morph('listening');
      return;
    }
    if (turn && !turn.complete) {
      const nothingYet = (turn.kind === 'tour' ? !(turn.tour && (turn.tour.intro.length || turn.tour.parts.length)) : !turn.segments.length);
      setStatus(nothingYet && turn.kind === 'greeting' ? state.copy.connecting : state.copy.thinking);
      if (nothingYet && orb.look !== 'thinking' && local.sceneIndex < 0) morph('thinking');
      return;
    }
    setStatus('');
    if (speech.segment && speech.typing) return;
    if (orb.look === 'thinking' || orb.look === 'listening') morph(local.sceneIndex === 4 ? 'finale' : 'home');
    if (state.phase === 'settled' && !state.invite && !speech.typing && (!speech.segment || t >= speech.holdUntil) && !local.settled) {
      local.settled = true;
      settleLine(state.copy.settledCaption);
      sfx('settle');
    }
  }

  function advance(t) {
    if (!local.introDone || local.handoff) return;
    if (local.pendingNaming && !namingFx.active) startNaming(local.pendingNaming, t);
    if (t < local.blockUntil) { syncInvite(t); return; }
    if (speech.segment) {
      if (speech.typing || t < speech.holdUntil) { syncInvite(t); return; }
      const item = nextItem(t);
      if (!item || item.type === 'dwell') { syncInvite(t); idle(t); return; }
      finishSegment();
    }
    const item = nextItem(t);
    if (!item || item.type === 'dwell') { idle(t); syncInvite(t); return; }
    if (item.type === 'speak') {
      if (orb.look === 'thinking' || orb.look === 'listening') morph(local.sceneIndex >= 0 && local.sceneIndex < 4 ? SCENE_LOOKS[local.sceneIndex] : 'home');
      startSegment(item.segment, t);
    } else if (item.type === 'scene') {
      enterScene(item.index, item.part, t);
    } else if (item.type === 'finale') {
      enterFinale(t);
    }
    syncInvite(t);
  }

  function updateSceneTitle() {
    const turn = currentTurn();
    if (!turn || turn.kind !== 'tour' || local.sceneIndex < 0 || local.sceneIndex > 3) return;
    const part = turn.tour && turn.tour.parts[local.sceneIndex];
    if (part && sceneTitle.textContent !== part.title) text(sceneTitle, part.title);
  }

  function phaseLabel() {
    if (local.handoff) return 'HANDOFF';
    if (!local.introDone) return 'GENESIS';
    if (local.sceneIndex >= 0 && local.sceneIndex < 4) return `CHAPTER ${String(local.sceneIndex + 1).padStart(2, '0')}/04`;
    if (state.listening) return 'LISTENING';
    if (state.phase === 'settled' || local.sceneIndex === 4) return 'STANDBY';
    return 'ONLINE';
  }

  function updateHud(t) {
    const label = phaseLabel();
    if (label !== local.lastPhaseLabel) { local.lastPhaseLabel = label; text(hudPhase, label); }
    if (hudName.textContent !== state.botName) text(hudName, state.botName);
    const id = shortId(state.globalMetaId);
    if (hudId.textContent !== id) text(hudId, id);
    const elapsed = Math.max(0, (t - local.bootAt) / 1000);
    const minutes = Math.floor(elapsed / 60);
    text(hudClock, `T+${String(minutes).padStart(2, '0')}:${(elapsed % 60).toFixed(1).padStart(4, '0')}`);
  }

  // ───────────────────────────── field (behind the orb) ─────────────────────────────
  const fieldCtx = field.getContext('2d');
  const fxCtx = fx.getContext('2d');
  let width = 0, height = 0, ratio = 1;
  const FIELD = { mode: 'void', modeAt: 0, ripples: [], pins: [], pinAt: 0, nodes: [], blooms: [], engraved: 0, packets: {} };
  const dust = Array.from({ length: 150 }, (_, index) => ({
    angle: hash(index) * Math.PI * 2,
    home: 1.35 + hash(index + 11) * 2.4,
    dist: 2.4 + hash(index + 21) * 3.6,
    speed: (.05 + hash(index + 31) * .16) * (hash(index + 41) > .5 ? 1 : -1),
    size: .5 + hash(index + 51) * 1.5,
    tint: hash(index + 61),
    twinkle: hash(index + 71) * Math.PI * 2,
  }));
  const streaks = Array.from({ length: 110 }, (_, index) => ({
    angle: hash(index + 101) * Math.PI * 2,
    dist: 1.2 + hash(index + 111) * 4,
    speed: .3 + hash(index + 121) * .7,
  }));
  const memory = Array.from({ length: 26 }, (_, index) => ({ angle: hash(index + 201) * Math.PI * 2, phase: hash(index + 211) }));

  function resizeCanvases() {
    ratio = Math.min(window.devicePixelRatio || 1, 1.75);
    width = stage.clientWidth;
    height = stage.clientHeight;
    for (const canvas of [field, fx]) {
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
    }
    fieldCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    fxCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function geometry() {
    const rect = orbBox.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    return {
      cx: rect.left - stageRect.left + rect.width / 2,
      cy: rect.top - stageRect.top + rect.height / 2,
      R: Math.max(8, (rect.width / 2) * orb.radius),
    };
  }

  function setFieldMode(mode, t) {
    if (FIELD.mode === mode) return;
    FIELD.mode = mode;
    FIELD.modeAt = t;
    FIELD.pins = [];
    FIELD.pinAt = t;
    FIELD.engraved = 0;
    FIELD.packets = {};
    if (mode === 'publish') {
      FIELD.nodes = Array.from({ length: 9 }, (_, index) => ({ angle: (index / 9) * Math.PI * 2 + .3 + (hash(index + 301) - .5) * .4, dist: 2 + hash(index + 311) * .7, litAt: -1e9 }));
    }
  }

  function addRipple(t, color, options = {}) {
    FIELD.ripples.push({ t0: t, rgb: hexToRgb(color), width: options.width || 1.2, life: options.life || 1400, speed: options.speed || 180 });
    if (FIELD.ripples.length > 14) FIELD.ripples.shift();
  }

  function bloom(t, color) {
    FIELD.blooms.push({ t0: t, rgb: hexToRgb(color) });
    if (FIELD.blooms.length > 4) FIELD.blooms.shift();
  }

  function dustTarget(particle) {
    switch (FIELD.mode) {
      case 'void': return particle.home + 2.2;
      case 'birth': return 1.02;
      case 'finale': return 1.45 + particle.tint * .5;
      case 'identity': return particle.home * 1.1 + .4;
      default: return particle.home;
    }
  }

  function drawDust(ctx, t, dt, g) {
    const sinceMode = t - FIELD.modeAt;
    const handoffFade = FIELD.mode === 'handoff' ? clamp(1 - sinceMode / 700, 0, 1) : 1;
    const birthPull = FIELD.mode === 'birth' ? clamp(sinceMode / 900, 0, 1) : 0;
    for (const particle of dust) {
      const target = dustTarget(particle);
      const rate = FIELD.mode === 'birth' ? 2.6 : .7;
      particle.dist += (target - particle.dist) * (1 - Math.exp(-dt * rate));
      if (FIELD.mode === 'birth' && particle.dist < 1.1) particle.dist = particle.home + 2.6 + particle.tint * 1.2;
      const swirl = FIELD.mode === 'birth' ? 1.8 : FIELD.mode === 'evolve' ? .7 : 1;
      particle.angle += particle.speed * dt * swirl * (1 + speech.level * .8);
      const x = g.cx + Math.cos(particle.angle) * particle.dist * g.R * 1.08;
      const y = g.cy + Math.sin(particle.angle) * particle.dist * g.R * .64;
      const depth = (Math.sin(particle.angle) + 1) / 2;
      const twinkle = .55 + .45 * Math.sin(t * .002 + particle.twinkle);
      let alpha = (.14 + depth * .34) * twinkle * handoffFade;
      if (FIELD.mode === 'void') alpha *= clamp((t - local.bootAt - 300) / 1400, 0, 1) * .6;
      if (FIELD.mode === 'birth') alpha *= .6 + birthPull * .9;
      const color = particle.tint > .72 ? [1, .86, .42] : particle.tint > .4 ? [.51, .96, 1] : [.77, .66, 1];
      ctx.fillStyle = rgbToCss(color, clamp(alpha, 0, 1));
      const size = particle.size * (.7 + depth * .6);
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
  }

  function drawRipples(ctx, t, g) {
    FIELD.ripples = FIELD.ripples.filter((ripple) => t - ripple.t0 < ripple.life);
    for (const ripple of FIELD.ripples) {
      const age = t - ripple.t0;
      const p = age / ripple.life;
      const r = g.R * 1.02 + (age / 1000) * ripple.speed;
      ctx.beginPath();
      ctx.ellipse(g.cx, g.cy, r, r * .92, 0, 0, Math.PI * 2);
      ctx.strokeStyle = rgbToCss(ripple.rgb, (1 - p) * .55);
      ctx.lineWidth = ripple.width * (1 - p * .6);
      ctx.stroke();
    }
  }

  function drawIdentity(ctx, t, g) {
    const since = t - FIELD.modeAt;
    const id = (state.globalMetaId || 'idbots-metaid-genesis').toUpperCase();
    const ring = `${id} · ${state.botName.toUpperCase()} · `;
    const chars = Array.from(ring);
    const radius = g.R * 1.34;
    const reveal = clamp(since / 2600, 0, 1);
    const shown = Math.floor(chars.length * reveal);
    if (shown > FIELD.engraved) { FIELD.engraved = shown; sfx('engrave'); }
    const step = (Math.PI * 2) / chars.length;
    const spin = t * .00009;
    const fontSize = clamp(g.R * .085, 9, 13);
    ctx.font = `500 ${fontSize}px "SF Mono", Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let index = 0; index < shown; index += 1) {
      const angle = -Math.PI / 2 + index * step + spin;
      const head = index === shown - 1 && reveal < 1;
      ctx.save();
      ctx.translate(g.cx + Math.cos(angle) * radius, g.cy + Math.sin(angle) * radius);
      ctx.rotate(angle + Math.PI / 2);
      ctx.fillStyle = head ? 'rgba(255,255,255,1)' : `rgba(242,226,168,${.55 + .25 * Math.sin(t * .003 + index)})`;
      if (head) { ctx.shadowColor = 'rgba(255,230,160,.95)'; ctx.shadowBlur = 12; }
      ctx.fillText(chars[index], 0, 0);
      ctx.restore();
    }
    const tickRadius = g.R * 1.52;
    const ticks = 120;
    const tickAlpha = clamp(since / 900, 0, 1);
    for (let index = 0; index < ticks; index += 1) {
      const angle = (index / ticks) * Math.PI * 2 - spin * 1.6;
      const long = index % 10 === 0;
      const inner = tickRadius - (long ? 8 : 3);
      ctx.beginPath();
      ctx.moveTo(g.cx + Math.cos(angle) * inner, g.cy + Math.sin(angle) * inner);
      ctx.lineTo(g.cx + Math.cos(angle) * tickRadius, g.cy + Math.sin(angle) * tickRadius);
      ctx.strokeStyle = `rgba(201,216,255,${(long ? .42 : .16) * tickAlpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.R * 1.66, spin * 3, spin * 3 + Math.PI * .7);
    ctx.strokeStyle = `rgba(232,207,122,${.35 * tickAlpha})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    for (const glint of memory) {
      const p = (t * .00028 + glint.phase) % 1;
      const dist = lerp(2.8, 1.02, ease.inCubic(p));
      const angle = glint.angle + p * 2.4;
      const x = g.cx + Math.cos(angle) * dist * g.R, y = g.cy + Math.sin(angle) * dist * g.R * .8;
      ctx.fillStyle = `rgba(255,240,200,${Math.sin(p * Math.PI) * .8 * tickAlpha})`;
      ctx.beginPath(); ctx.arc(x, y, 1.4 + p * 1.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  function nodePoint(node, g) {
    const scale = Math.min(1, (width / 2 - 34) / (g.R * 2.8), (height / 2 - 34) / (g.R * 2.0));
    return {
      x: g.cx + Math.cos(node.angle) * node.dist * g.R * Math.max(.55, scale) * 1.15,
      y: g.cy + Math.sin(node.angle) * node.dist * g.R * Math.max(.55, scale) * .78,
    };
  }

  function drawPublish(ctx, t, g) {
    const since = t - FIELD.modeAt;
    const alpha = clamp(since / 700, 0, 1);
    const nodes = FIELD.nodes;
    if (since > 500 && t - FIELD.pinAt > 620) {
      FIELD.pinAt = t;
      const target = FIELD.pins.length + Math.floor(t / 620);
      FIELD.pins.push({ node: nodes[target % nodes.length], t0: t, rgb: hexToRgb(['#82F4FF', '#FF7BD5', '#FFD86B'][target % 3]) });
      addRipple(t, '#FF9DE6', { width: 1, life: 1100, speed: 140 });
      sfx('pin');
    }
    for (let index = 0; index < nodes.length; index += 1) {
      const a = nodePoint(nodes[index], g), b = nodePoint(nodes[(index + 1) % nodes.length], g);
      const lit = clamp(1 - (t - nodes[index].litAt) / 4000, 0, 1);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(155,244,255,${(.05 + lit * .2) * alpha})`;
      ctx.lineWidth = 1; ctx.stroke();
    }
    FIELD.pins = FIELD.pins.filter((pin) => t - pin.t0 < 1300);
    for (const pin of FIELD.pins) {
      const p = ease.inOutCubic(clamp((t - pin.t0) / 1100, 0, 1));
      const end = nodePoint(pin.node, g);
      const startAngle = Math.atan2(end.y - g.cy, end.x - g.cx);
      const start = { x: g.cx + Math.cos(startAngle) * g.R, y: g.cy + Math.sin(startAngle) * g.R };
      const control = { x: (start.x + end.x) / 2 + Math.sin(startAngle) * g.R * .6, y: (start.y + end.y) / 2 - Math.cos(startAngle) * g.R * .6 };
      const point = (u) => ({
        x: (1 - u) * (1 - u) * start.x + 2 * (1 - u) * u * control.x + u * u * end.x,
        y: (1 - u) * (1 - u) * start.y + 2 * (1 - u) * u * control.y + u * u * end.y,
      });
      for (let trail = 0; trail < 6; trail += 1) {
        const q = point(Math.max(0, p - trail * .03));
        ctx.fillStyle = rgbToCss(pin.rgb, (1 - trail / 6) * .7);
        ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
      }
      const head = point(p);
      ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = rgbToCss(pin.rgb, 1); ctx.shadowColor = rgbToCss(pin.rgb, 1); ctx.shadowBlur = 10;
      ctx.fillRect(-3.5, -3.5, 7, 7); ctx.restore();
      if (p >= 1 && pin.node.litAt < pin.t0) {
        pin.node.litAt = t;
        sfx('node', { degree: nodes.indexOf(pin.node) % 5 });
      }
    }
    for (const node of nodes) {
      const point = nodePoint(node, g);
      const lit = clamp(1 - (t - node.litAt) / 4000, 0, 1);
      ctx.beginPath(); ctx.arc(point.x, point.y, 2.4 + lit * 2.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(234,244,255,${(.35 + lit * .65) * alpha})`;
      ctx.shadowColor = 'rgba(155,244,255,.9)'; ctx.shadowBlur = 6 + lit * 16; ctx.fill(); ctx.shadowBlur = 0;
      if (lit > .6) {
        ctx.beginPath(); ctx.arc(point.x, point.y, 6 + (1 - lit) * 40, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(155,244,255,${(lit - .6) * 1.2 * alpha})`; ctx.stroke();
      }
    }
  }

  const SATELLITES = [
    { rgb: hexToRgb('#5EF2FF'), offset: 0 },
    { rgb: hexToRgb('#FF7BD5'), offset: 2.094 },
    { rgb: hexToRgb('#FFD86B'), offset: 4.189 },
  ];

  function drawCollab(ctx, t, g) {
    const since = t - FIELD.modeAt;
    const emerge = ease.outBack(clamp(since / 1400, 0, 1));
    const positions = SATELLITES.map((satellite) => {
      const angle = satellite.offset + t * .00032;
      const orbit = g.R * lerp(.6, 2.05, emerge);
      const depth = (Math.sin(angle) + 1) / 2;
      return { ...satellite, angle, depth, x: g.cx + Math.cos(angle) * orbit, y: g.cy + Math.sin(angle) * orbit * .42, r: g.R * .2 * (.7 + depth * .45) * clamp(emerge, 0, 1.2) };
    });
    ctx.lineWidth = 1;
    for (let index = 0; index < positions.length; index += 1) {
      const a = positions[index], b = positions[(index + 1) % positions.length];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(155,244,255,${.08 * emerge})`; ctx.stroke();
    }
    for (const satellite of positions) {
      const angle = Math.atan2(satellite.y - g.cy, satellite.x - g.cx);
      const start = { x: g.cx + Math.cos(angle) * g.R * .98, y: g.cy + Math.sin(angle) * g.R * .98 };
      const control = { x: (start.x + satellite.x) / 2 - Math.sin(angle) * g.R * .35, y: (start.y + satellite.y) / 2 + Math.cos(angle) * g.R * .35 - g.R * .2 };
      ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.quadraticCurveTo(control.x, control.y, satellite.x, satellite.y);
      ctx.strokeStyle = rgbToCss(satellite.rgb, .32 * emerge); ctx.lineWidth = 1.2; ctx.stroke();
      for (let packet = 0; packet < 2; packet += 1) {
        const raw = (t * .00045 + packet * .5 + satellite.offset) % 1;
        const packetKey = `${satellite.offset}:${packet}`;
        if (FIELD.packets[packetKey] !== undefined && raw < FIELD.packets[packetKey]) sfx('packet');
        FIELD.packets[packetKey] = raw;
        const u = packet === 0 ? raw : 1 - raw;
        const x = (1 - u) * (1 - u) * start.x + 2 * (1 - u) * u * control.x + u * u * satellite.x;
        const y = (1 - u) * (1 - u) * start.y + 2 * (1 - u) * u * control.y + u * u * satellite.y;
        ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = rgbToCss(packet === 0 ? [.92, .96, 1] : satellite.rgb, .95 * emerge);
        ctx.shadowColor = rgbToCss(satellite.rgb, 1); ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
      }
      if (satellite.r < 1) continue;
      const sphere = ctx.createRadialGradient(satellite.x - satellite.r * .35, satellite.y - satellite.r * .4, satellite.r * .05, satellite.x, satellite.y, satellite.r);
      sphere.addColorStop(0, 'rgba(255,255,255,.95)');
      sphere.addColorStop(.35, rgbToCss(satellite.rgb, .85));
      sphere.addColorStop(.85, rgbToCss(mixRgb(satellite.rgb, [.05, .07, .15], .6), .9));
      sphere.addColorStop(1, rgbToCss(satellite.rgb, .25));
      ctx.beginPath(); ctx.arc(satellite.x, satellite.y, satellite.r, 0, Math.PI * 2);
      ctx.fillStyle = sphere; ctx.globalAlpha = .55 + satellite.depth * .45;
      ctx.shadowColor = rgbToCss(satellite.rgb, .9); ctx.shadowBlur = satellite.r * .9; ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  function drawEvolve(ctx, t, dt, g) {
    const since = t - FIELD.modeAt;
    const intensity = clamp(since / 900, 0, 1);
    const reach = Math.hypot(width, height) / g.R / 1.6;
    const rgb = hexToRgb(CUE_PALETTES.learn.glowColor);
    for (const streak of streaks) {
      streak.speed += dt * 1.6;
      streak.dist -= streak.speed * dt;
      if (streak.dist < 1.04) {
        streak.dist = reach * (.7 + hash(streak.angle * 10 + t) * .5);
        streak.speed = .35 + hash(streak.angle + t) * .7;
        streak.angle += 1.7;
        speech.level = Math.min(1, speech.level + .05);
      }
      const head = streak.dist, tail = streak.dist + Math.min(1.4, streak.speed * .22);
      const hx = g.cx + Math.cos(streak.angle) * head * g.R, hy = g.cy + Math.sin(streak.angle) * head * g.R * .82;
      const tx = g.cx + Math.cos(streak.angle) * tail * g.R, ty = g.cy + Math.sin(streak.angle) * tail * g.R * .82;
      const gradient = ctx.createLinearGradient(hx, hy, tx, ty);
      gradient.addColorStop(0, rgbToCss(mixRgb(rgb, [1, 1, 1], .5), .85 * intensity));
      gradient.addColorStop(1, rgbToCss(rgb, 0));
      ctx.strokeStyle = gradient; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
    }
    if (t - local.evolveAt > 2300 && local.evolveStep < EVOLVE_STYLES.length - 1) {
      local.evolveStep += 1;
      local.evolveAt = t;
      setOrbStyle(EVOLVE_STYLES[local.evolveStep]);
      bloom(t, ['#9EF1FF', '#E0A3FF', '#FF9BE2', '#B49BFF'][local.evolveStep]);
      sfx('evolve', { degree: [0, 2, 4, 1][local.evolveStep] });
      addRipple(t, '#C2A8FF', { width: 2.2, life: 1500, speed: 300 });
    }
  }

  function drawField(t, dt) {
    const g = geometry();
    fieldCtx.clearRect(0, 0, width, height);
    if (FIELD.mode !== 'evolve') drawDust(fieldCtx, t, dt, g);
    if (FIELD.mode === 'identity') drawIdentity(fieldCtx, t, g);
    else if (FIELD.mode === 'publish') drawPublish(fieldCtx, t, g);
    else if (FIELD.mode === 'collab') drawCollab(fieldCtx, t, g);
    else if (FIELD.mode === 'evolve') drawEvolve(fieldCtx, t, dt, g);
    drawRipples(fieldCtx, t, g);
    return g;
  }

  // ───────────────────────────── fx (in front of the orb) ─────────────────────────────
  const namingFx = { active: false, t0: 0, particles: [] };

  function startNaming(name, t) {
    local.pendingNaming = null;
    text(namingKicker, state.copy.namingKicker);
    text(namingName, name);
    naming.classList.remove('is-on');
    namingFx.active = true;
    namingFx.t0 = t;
    namingFx.particles = [];
    triggerCue('name', t);
    bloom(t, '#FFDC51');
    sfx('naming-gather');
    sfx('naming-reveal', { delay: 1.35 });
    if (reduced()) { naming.classList.add('is-on'); setTimeout(() => naming.classList.remove('is-on'), 4200); namingFx.active = false; return; }
    const rect = namingName.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const style = window.getComputedStyle(namingName);
    const sampler = document.createElement('canvas');
    const w = Math.max(1, Math.ceil(rect.width)), h = Math.max(1, Math.ceil(rect.height));
    sampler.width = w; sampler.height = h;
    const sctx = sampler.getContext('2d');
    sctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    sctx.textAlign = 'center'; sctx.textBaseline = 'middle'; sctx.fillStyle = '#fff';
    sctx.fillText(name, w / 2, h / 2);
    const data = sctx.getImageData(0, 0, w, h).data;
    const stepPx = Math.max(2, Math.round(Math.sqrt((w * h) / 900)));
    const g = geometry();
    for (let y = 0; y < h; y += stepPx) {
      for (let x = 0; x < w; x += stepPx) {
        if (data[(y * w + x) * 4 + 3] < 128) continue;
        const seed = hash(x * 7.1 + y * 3.3);
        namingFx.particles.push({
          sx: g.cx + (seed - .5) * g.R * .8, sy: g.cy + (hash(seed * 91) - .5) * g.R * .8,
          tx: rect.left - stageRect.left + x, ty: rect.top - stageRect.top + y,
          delay: seed * 380, size: 1 + hash(seed * 13) * 1.4,
        });
      }
    }
  }

  function drawFx(t, g) {
    fxCtx.clearRect(0, 0, width, height);
    FIELD.blooms = FIELD.blooms.filter((entry) => t - entry.t0 < 1400);
    for (const entry of FIELD.blooms) {
      const p = (t - entry.t0) / 1400;
      const r = g.R * (1 + ease.outCubic(p) * 1.4);
      const gradient = fxCtx.createRadialGradient(g.cx, g.cy, g.R * .9, g.cx, g.cy, r);
      gradient.addColorStop(0, rgbToCss(entry.rgb, 0));
      gradient.addColorStop(.85, rgbToCss(entry.rgb, .22 * (1 - p)));
      gradient.addColorStop(1, rgbToCss(entry.rgb, 0));
      fxCtx.fillStyle = gradient;
      fxCtx.beginPath(); fxCtx.arc(g.cx, g.cy, r, 0, Math.PI * 2); fxCtx.fill();
    }
    if (!namingFx.active) return;
    const age = t - namingFx.t0;
    if (age > 1350 && !naming.classList.contains('is-on') && age < 4300) naming.classList.add('is-on');
    if (age > 4300) naming.classList.remove('is-on');
    if (age > 5400) { namingFx.active = false; return; }
    for (const particle of namingFx.particles) {
      let x, y, alpha;
      const local01 = clamp((age - particle.delay) / 1100, 0, 1);
      if (age < 3900) {
        const p = ease.outCubic(local01);
        x = lerp(particle.sx, particle.tx, p) + Math.sin(age * .004 + particle.delay) * (1 - p) * 18;
        y = lerp(particle.sy, particle.ty, p);
        alpha = local01 * (age > 1500 ? clamp(1 - (age - 1500) / 900, .15, 1) : 1);
      } else {
        const p = ease.inCubic(clamp((age - 3900 - particle.delay * .5) / 1100, 0, 1));
        x = lerp(particle.tx, g.cx, p); y = lerp(particle.ty, g.cy, p);
        alpha = (1 - p) * .9;
      }
      fxCtx.fillStyle = `rgba(255,${Math.round(214 + particle.size * 20)},${Math.round(90 + particle.size * 40)},${alpha})`;
      fxCtx.fillRect(x - particle.size / 2, y - particle.size / 2, particle.size, particle.size);
    }
  }

  // ───────────────────────────── orb frame (modulation + color) ─────────────────────────────
  const paletteRgbCache = new Map();
  const paletteRgb = (name, palette) => {
    if (!paletteRgbCache.has(name)) paletteRgbCache.set(name, Object.fromEntries(Object.entries(palette).map(([key, hex]) => [key, hexToRgb(hex)])));
    return paletteRgbCache.get(name);
  };
  const AMBIENT = ['base', 'cool', 'dusk', 'base'];

  function computeOrbFrame(t) {
    const modulation = { radius: 0, contourDeform: 0, edgeGlow: 0, exposure: 0, warp: 0 };
    if (local.boot === 'birth') {
      const p = clamp((t - local.birthAt) / 1500, 0, 1);
      const grown = .05 + (orb.params.radius - .05) * ease.outBack(p);
      modulation.radius = grown - orb.params.radius;
      modulation.contourDeform = 2.6 * Math.pow(1 - p, 1.4);
      modulation.warp = 2 * (1 - p);
    }
    modulation.radius += speech.level * .014;
    modulation.contourDeform += speech.level * .45;
    modulation.edgeGlow += speech.level * .1;
    modulation.exposure += speech.level * .14;
    if (orb.look === 'home' || orb.look === 'finale') modulation.contourDeform += .14 * Math.sin(t * .00041) + .08 * Math.sin(t * .00097 + 1.3);
    if (orb.look === 'listening') modulation.edgeGlow += .06 * (1 + Math.sin(t * .004));

    let paletteName = orb.paletteName;
    if (paletteName === 'base' && (orb.look === 'home') && !local.handoff) {
      if (t - local.ambientAt > 9000) { local.ambientAt = t; local.ambientIndex = (local.ambientIndex + 1) % AMBIENT.length; }
      paletteName = AMBIENT[local.ambientIndex];
    }
    const colors = { ...paletteRgb(paletteName, PALETTES[paletteName] || PALETTES.base) };
    for (let index = flashes.length - 1; index >= 0; index -= 1) {
      const flash = flashes[index];
      const age = t - flash.t0;
      if (age > 1500) { flashes.splice(index, 1); continue; }
      const envelope = age < 160 ? age / 160 : Math.exp(-(age - 160) / 520);
      modulation.edgeGlow += envelope * .2;
      modulation.exposure += envelope * .16;
      const flashColors = paletteRgb(`cue:${flash.kind}`, CUE_PALETTES[flash.kind] || {});
      for (const [key, value] of Object.entries(flashColors)) colors[key] = mixRgb(colors[key] || value, value, envelope * .85);
    }
    return { modulation, colors };
  }

  // ───────────────────────────── boot / intro ─────────────────────────────
  // The CRT power-on lasts at least crtEnd; the birth waits for the orb's
  // first frame (the WGSL compile can take ~2s cold) for up to orbWait more,
  // then falls back to the Canvas2D orb rather than stalling.
  const BOOT = { crtEnd: 2150, orbWait: 2600, plasmaAt: 800, homeAt: 1450, birthLength: 1850 };

  function boot(t) {
    local.bootAt = t;
    if (state.intro === 'skip' || reduced()) {
      local.boot = 'done';
      body.dataset.boot = 'done';
      local.introDone = true;
      morph('home');
      setFieldMode('idle', t);
      replayLatest(t);
      sound?.setBed(1);
      return;
    }
    local.boot = 'crt';
    body.dataset.boot = 'crt';
    // Timed to the CSS power-on keyframes (dot .3s, line .95s, flash 1.5s, drop 1.5s).
    sfx('crt-dot', { delay: 0.32 });
    sfx('crt-line', { delay: 0.95 });
    sfx('crt-flash', { delay: 1.52 });
    sfx('drop', { delay: 1.82 });
    orb.params = lookParams('birth');
    orb.paletteName = 'birth';
    orb.look = 'birth';
    orb.style = LOOKS.birth.style;
    mountLayer(orb.style, true);
    setFieldMode('void', t);
  }

  function updateBoot(t) {
    if (local.boot === 'crt' && t - local.bootAt >= BOOT.crtEnd) {
      if (!orb.ready && t - local.bootAt < BOOT.crtEnd + BOOT.orbWait) {
        sfx('drop-wait');
        return;
      }
      if (!orb.ready) switchToCanvas(new Error('The WebGPU orb was not ready in time'));
      local.boot = 'birth';
      local.birthAt = t;
      body.dataset.boot = 'birth';
      setFieldMode('birth', t);
      addRipple(t, '#9BE7FF', { width: 2, life: 1600, speed: 320 });
      sound?.setBed(1);
      sfx('birth');
    }
    if (local.boot === 'birth') {
      if (!local.shiftedPlasma && t - local.birthAt >= BOOT.plasmaAt) { local.shiftedPlasma = true; morph('plasma'); sfx('morph', { degree: 4 }); }
      if (!local.shiftedHome && t - local.birthAt >= BOOT.homeAt) { local.shiftedHome = true; morph('home'); bloom(t, '#82F4FF'); sfx('morph', { degree: 2 }); }
      if (t - local.birthAt >= BOOT.birthLength) {
        local.boot = 'done';
        body.dataset.boot = 'done';
        local.introDone = true;
        setFieldMode('idle', t);
        handleTurnChange(t);
      }
    }
  }

  /** A reloaded tab: show where the conversation is without replaying it. */
  function replayLatest(t) {
    handleTurnChange(t);
    const turn = currentTurn();
    if (!turn) return;
    if (turn.kind === 'tour' && turn.tour) {
      const all = [...turn.tour.intro, ...turn.tour.parts.flatMap((part) => part.body), ...turn.tour.outro];
      all.forEach((segment) => local.played.add(segment.id));
      if (turn.complete) { local.sceneIndex = 4; morph('finale'); setFieldMode('finale', t); }
      const last = all[all.length - 1];
      if (last) startSegment(last, t, { instant: true });
      return;
    }
    turn.segments.forEach((segment) => local.played.add(segment.id));
    const last = turn.segments[turn.segments.length - 1];
    if (last) startSegment(last, t, { instant: true });
  }

  // ───────────────────────────── handoff ─────────────────────────────
  function startHandoff(t) {
    if (local.handoff) return;
    sfx('handoff');
    if (sound) {
      sound.setBed(0);
      setTimeout(() => sound.fadeOut(1.6), 1300);
    }
    local.handoff = true;
    invite.classList.remove('is-on');
    scene.classList.remove('is-on');
    progress.classList.remove('is-on');
    speech.level = 0;
    flashes.length = 0;
    setFieldMode('handoff', t);
    morph('handoff');
    // Land exactly on the Live Stage orb: a 340px canvas centered at 67% / 45%
    // (72% below 900px), so its first frame continues this one.
    const size = orbBox.offsetWidth || 340;
    stage.style.setProperty('--orb-x', window.innerWidth <= 900 ? '72%' : '67%');
    stage.style.setProperty('--orb-y', '45%');
    stage.style.setProperty('--orb-scale', String(340 / size));
  }

  // ───────────────────────────── state intake ─────────────────────────────
  function onState(t) {
    body.dataset.phase = state.phase;
    body.dataset.enabled = String(state.enabled !== false);
    if (local.introDone) handleTurnChange(t);
    if (state.naming && state.naming.eventId !== local.namingEventId) {
      local.namingEventId = state.naming.eventId;
      local.pendingNaming = state.naming.name;
    }
    if (state.phase === 'handoff') startHandoff(t);
    if (state.listening && !local.wasListening) silenceTurn(t);
    local.wasListening = state.listening;
    updateSceneTitle();
    syncReduced();
    syncSoundButton();
  }

  let lastReduced = null;
  function syncReduced() {
    const value = reduced();
    if (value === lastReduced) return;
    lastReduced = value;
    body.dataset.motion = value ? 'reduced' : 'full';
    orb.layers.forEach((layer) => layer.controller?.setReduced(value));
    if (value && !local.introDone) {
      local.boot = 'done';
      body.dataset.boot = 'done';
      local.introDone = true;
      morph('home');
      setFieldMode('idle', performance.now());
      handleTurnChange(performance.now());
    }
    if (!value) { clearTimeout(slowTimer); schedule(); }
  }

  // ───────────────────────────── loop ─────────────────────────────
  let raf = 0, lastFrame = null, slowTimer = 0;

  function frame(t) {
    raf = 0;
    const dt = lastFrame === null ? 0 : Math.min(.08, Math.max(0, (t - lastFrame) / 1000));
    lastFrame = t;
    updateBoot(t);
    advance(t);
    updateSpeech(t, dt);
    const { modulation, colors } = computeOrbFrame(t);
    orbFrame(modulation, colors);
    sound?.frame({ speech: speech.level, glow: Math.min(1, modulation.edgeGlow * 2.5) });
    halo.style.setProperty('--halo', rgbToCss(colors.glowColor || [.58, .42, 1], .34 + Math.min(.3, modulation.edgeGlow)));
    const g = drawField(t, dt);
    drawFx(t, g);
    updateHud(t);
    schedule();
  }

  function schedule() {
    if (reduced()) {
      clearTimeout(slowTimer);
      slowTimer = setTimeout(() => { lastFrame = null; frame(performance.now()); }, 400);
      return;
    }
    if (!raf) raf = requestAnimationFrame(frame);
  }

  window.IDBotsGenesisStage = {
    applyPatch(patch) {
      if (!patch || patch.protocol !== PROTOCOL || patch.sessionId !== state.sessionId) return false;
      if (typeof patch.revision !== 'number' || patch.revision <= state.revision) return false;
      state = patch;
      onState(performance.now());
      return true;
    },
    // Session-scoped: after a renderer reload tab ids are reused, so a stale
    // host run may poll this page; only the owning session drains its clicks.
    drainActions(sessionId) {
      if (sessionId !== undefined && sessionId !== state.sessionId) return [];
      return actionQueue.splice(0, actionQueue.length);
    },
    getState: () => state,
  };
  window.__getGenesisState = () => state;
  // Read-only diagnostics for dev tooling (demo player, E2E probes).
  window.__genesisDebug = () => {
    const t = performance.now();
    return {
      boot: local.boot,
      introDone: local.introDone,
      turnId: local.turnId,
      played: [...local.played],
      sceneIndex: local.sceneIndex,
      inviteAnswered: local.inviteAnswered,
      blockUntil: local.blockUntil - t,
      speech: speech.segment ? { id: speech.segment.id, typing: speech.typing, typed: speech.typed, length: speech.chars.length, holdLeft: speech.holdUntil - t } : null,
      next: nextItem(t),
      inviteReady: inviteReady(t),
      look: orb.look,
      backend: orb.backend,
      sound: sound ? { ...sound.stats(), enabled: sound.isEnabled() } : null,
    };
  };

  reducedMedia.addEventListener('change', syncReduced);
  document.addEventListener('visibilitychange', () => {
    lastFrame = null;
    syncReduced();
    if (sound) { if (document.hidden) sound.suspend(); else sound.resume(); }
  });
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(raf);
    clearTimeout(slowTimer);
    [...orb.layers].forEach((layer) => disposeLayer(layer, true));
    sound?.dispose();
  });
  new ResizeObserver(resizeCanvases).observe(stage);
  resizeCanvases();
  body.dataset.phase = state.phase;
  body.dataset.invite = 'off';
  lastReduced = reduced();
  body.dataset.motion = lastReduced ? 'reduced' : 'full';
  text(hudName, state.botName);
  syncSoundButton();
  boot(performance.now());
  onState(performance.now());
  schedule();
  window.__genesisReady = true;
})();
