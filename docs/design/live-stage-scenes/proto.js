/* Live Stage scene-system prototype — runtime.
   State machine, orb control, place crossfade engine, copy typing (ported
   from stage.js), companions wiring, scenario player, prototype chrome,
   transient effects. All copy comes from catalog.js (zh/en). */
(() => {
  const C = window.LS_CATALOG;
  const LS = window.LS;
  LS.catalog = C;
  const $ = (sel) => document.querySelector(sel);
  const { W, H, R } = LS;
  const tr = (v, lang) => (v == null ? '' : typeof v === 'string' ? v : v[lang] || v.zh || '');

  /* ------------------------------- tweaks ------------------------------- */
  const T = {
    lang: 'zh',
    variants: { web: 'A', chain: 'A' },
    intensity: 1,
    tintFollow: true,
    comp: { workers: 0, peers: 0, groups: 0, ot: true },
    compOverride: false,
    reduced: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };

  /* ------------------------------ DOM refs ------------------------------ */
  const frame = $('[data-stage-frame]');
  const wrap = $('[data-stagewrap]');
  const placeCanvas = $('[data-place-canvas]');
  const compBack = $('[data-companion-back]');
  const compFront = $('[data-companion-front]');
  const entity = $('[data-core-entity]');
  const membrane = $('.membrane');
  const chip = $('[data-transient-chip]');
  const titleEl = $('[data-core-title]');
  const captionEl = $('[data-core-caption]');
  const verbEl = $('[data-core-verb]');
  const familyEl = $('[data-core-family]');
  const cardEl = $('[data-interaction-card]');
  const reportBtn = $('[data-report-open]');
  const botName = 'AI_Sunny';
  $('[data-bot-name]').textContent = botName;

  /* ------------------------------ canvases ------------------------------ */
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const ctxs = {};
  for (const [key, cv] of [['place', placeCanvas], ['back', compBack], ['front', compFront]]) {
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    const g = cv.getContext('2d');
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctxs[key] = g;
  }

  function fitStage() {
    const r = wrap.getBoundingClientRect();
    const s = Math.min(r.width / W, r.height / H);
    frame.style.transform = `scale(${Math.max(0.1, s)})`;
  }
  window.addEventListener('resize', fitStage);

  /* --------------------------- orb centre (O) --------------------------- */
  const O_N = { x: 0.67 * W, y: 0.45 * H };
  const O_H = { x: 0.56 * W, y: 0.45 * H };
  const O = { x: O_N.x, y: O_N.y };
  let oAnim = null;
  function cubicBezier(x1, y1, x2, y2) {
    // returns eased t for progress t — solve u: X(u)=t by bisection, return Y(u)
    const X = (v) => 3 * v * (1 - v) * (1 - v) * x1 + 3 * v * v * (1 - v) * x2 + v * v * v;
    const Y = (v) => 3 * v * (1 - v) * (1 - v) * y1 + 3 * v * v * (1 - v) * y2 + v * v * v;
    return (t) => {
      let lo = 0, hi = 1, u = t;
      for (let i = 0; i < 20; i += 1) {
        const xm = X(u);
        if (Math.abs(xm - t) < 1e-4) break;
        if (xm < t) lo = u; else hi = u;
        u = (lo + hi) / 2;
      }
      return Y(u);
    };
  }
  const O_EASE = cubicBezier(0.16, 1, 0.3, 1);
  function setHeroLayout(on, now) {
    const target = on ? O_H : O_N;
    if (Math.abs(target.x - O.x) < 0.5 && !oAnim) return;
    oAnim = { from: { ...O }, to: target, t0: now };
    entity.style.left = `${(target.x / W) * 100}%`;
    if (T.reduced) { O.x = target.x; O.y = target.y; oAnim = null; }
  }
  function tickO(now) {
    if (!oAnim) return;
    const p = LS.clamp((now - oAnim.t0) / 0.6, 0, 1);
    const e = O_EASE(p);
    O.x = LS.lerp(oAnim.from.x, oAnim.to.x, e);
    O.y = LS.lerp(oAnim.from.y, oAnim.to.y, e);
    if (p >= 1) oAnim = null;
  }

  /* --------------------------------- orb -------------------------------- */
  let orbCtl = null;
  let curOrb = { speed: 0.3 };
  function mountOrb() {
    const cv = document.createElement('canvas');
    cv.className = 'liquid-orb-canvas';
    cv.setAttribute('aria-hidden', 'true');
    membrane.appendChild(cv);
    let settled = false;
    window.createLiquidOrbRenderer(cv, {
      initialFamily: 'idle',
      fixedStyle: 9,
      onReady: () => {
        cv.dataset.active = 'true';
        document.body.dataset.orbBackend = cv.dataset.orbBackend || 'webgpu';
      },
      onError: () => {
        if (settled) return;
        settled = true;
        document.body.dataset.orbBackend = 'canvas';
      },
    }).then((ctl) => {
      settled = true;
      orbCtl = ctl;
      ctl.setReduced(T.reduced);
      applyOrbParams(true);
    }).catch(() => {
      if (!settled) { settled = true; document.body.dataset.orbBackend = 'canvas'; }
    });
  }
  function tintFor(state, placeId) {
    if (state.orb && state.orb.glowColor) return state.orb.glowColor;
    if (!T.tintFollow) return '#956CFF';
    const p = C.places[placeId];
    return (p && p.glow) || '#956CFF';
  }
  function applyOrbParams(immediate, state, placeId) {
    if (!orbCtl) return;
    const s = state || current.state;
    const pid = placeId || current.placeBase;
    const params = { ...s.orb, glowColor: tintFor(s, pid) };
    curOrb = params;
    orbCtl.setParams(params, immediate ? { immediate: true } : {});
  }

  /* modulation: voice + transient envelopes, recomputed per frame */
  const modEvents = { inhaleT: -9, compressT: -9, shimmerT: -9 };
  function orbModulation(now, voiceEnergy) {
    const m = {
      radius: voiceEnergy * 0.008,
      contourDeform: voiceEnergy * 0.025,
      edgeGlow: 0,
      exposure: 0,
    };
    const quiet = current.activity === 'speaking' || current.activity === 'resting';
    if (quiet) { m.edgeGlow += voiceEnergy * 0.07; m.exposure += voiceEnergy * 0.08; }
    const ei = (now - modEvents.inhaleT) * 1000;
    if (ei >= 0 && ei < 400) m.radius += 0.012 * (1 - ei / 400);
    const ec = (now - modEvents.compressT) * 1000;
    if (ec >= 0 && ec < 480) {
      if (ec < 180) m.radius -= 0.03 * (ec / 180);
      else m.radius -= 0.03 * (1 - (ec - 180) / 300);
    }
    const es = (now - modEvents.shimmerT) * 1000;
    if (es >= 0 && es < 900) {
      const p = es / 900;
      m.exposure += p < 0.5 ? LS.lerp(-0.18, 0.12, p * 2) : LS.lerp(0.12, 0, (p - 0.5) * 2);
      m.edgeGlow += 0.08 * Math.sin(Math.PI * p);
    }
    return m;
  }

  /* --------------------------- env for places --------------------------- */
  const textMotion = { energy: 0, voiceUntil: 0 };
  const env = {
    get O() { return O; },
    rand: () => Math.random(),
    voice: () => textMotion.energy,
    activity: () => current.activity,
    orbSpeed: () => curOrb.speed || 0.5,
    chainApi: null,
    /* report button centre in logical stage coords (for settle drifters) */
    reportPos() {
      return { x: reportBtn.offsetLeft + reportBtn.offsetWidth / 2, y: reportBtn.offsetTop + reportBtn.offsetHeight / 2 };
    },
    emit(name, arg) {
      const now = perfNow();
      if (name === 'inhale') modEvents.inhaleT = now;
      else if (name === 'compress') modEvents.compressT = now;
      else if (name === 'lean') {
        entity.style.translate = `${arg ? arg.x : 6}px 0`;
        setTimeout(() => { entity.style.translate = '0px 0'; }, (arg && arg.ms) || 500);
      }
    },
  };

  /* ---------------------------- place engine ---------------------------- */
  const MOTIF_MAP = {
    waiting: { machine: 'workers', chain: 'private', web: 'search', mind: 'idle' },
  };
  const INHERIT_FX = {
    'owner-needed': { freeze: true, dim: 0.35 },
    problem: { slate: true, dim: 0.5, slow: 0.2 },
    verification: {},
  };

  let placeCur = null, placePrev = null;
  let lastPlaceKey = 'machine';
  const fxMods = { dipUntil: -9, dipAmt: 0.6, slateUntil: -9 };

  function placeKeyFor(state, spec) {
    if (state.place === 'inherit') return lastPlaceKey;
    if (state.place === 'hero') {
      const ht = spec && spec.hero && spec.hero.type;
      const base = ht === 'workers' ? 'machine' : ht === 'peers' || ht === 'groups' ? 'chain' : 'mind';
      return base;
    }
    return state.place;
  }
  function variantKey(base) {
    if (base === 'web' || base === 'chain') return `${base}-${T.variants[base].toLowerCase()}`;
    return base;
  }
  function resolvePlace(state, spec, now) {
    const base = placeKeyFor(state, spec);
    if (state.place !== 'inherit') lastPlaceKey = base;
    const key = variantKey(base);
    let motif = state.motif;
    if (state.place === 'inherit') motif = null; // keep previous motif
    if (MOTIF_MAP[state.motif]) motif = MOTIF_MAP[state.motif][base] || state.motif;
    const extra = INHERIT_FX[state.id] || {};
    return { key, base, motif, ...extra };
  }

  function ensurePlace(resolved, now) {
    if (placeCur && placeCur.key === resolved.key) {
      if (resolved.motif) placeCur.inst.setMotif(resolved.motif);
    } else {
      const inst = LS.placeFactories[resolved.key](env);
      inst.build();
      if (inst.statics && inst.statics.renderOff) inst.statics.renderOff(DPR);
      if (resolved.motif) inst.setMotif(resolved.motif);
      if (placeCur) placePrev = { ...placeCur, fadeT0: now };
      placeCur = { key: resolved.key, inst, revealT0: T.reduced ? now - 2 : now };
    }
    placeCur.resolved = resolved;
  }

  function copyMask(x) {
    return 0.15 + 0.85 * LS.smoothstep(0.3 * W, 0.55 * W, x);
  }

  function fxFor(entry, resolved, now) {
    const e = (now - entry.revealT0) * 1000;
    const dim = resolved.dim != null ? resolved.dim : 1;
    const dip = now < fxMods.dipUntil ? fxMods.dipAmt : 1;
    const aMul = dim * dip;
    const revealDone = e > 1400;
    const slate = Boolean(resolved.slate) || now < fxMods.slateUntil;
    return {
      aMul,
      slate,
      freeze: Boolean(resolved.freeze),
      slow: resolved.slow || 1,
      revealDone,
      forceElements: !revealDone || Math.abs(T.intensity - 1) > 0.001,
      elA: (x, y, d) => {
        const dist = d != null ? d : Math.hypot(x - O.x, y - O.y);
        const rv = revealDone ? 1 : LS.clamp((e - dist / 1.2) / 300, 0, 1);
        return aMul * T.intensity * copyMask(x) * rv;
      },
    };
  }

  function drawPlaces(g, dt, now) {
    if (placePrev) {
      const fe = (now - placePrev.fadeT0) * 1000;
      if (fe > 500) { placePrev = null; }
      else {
        const fade = 1 - fe / 500;
        const fx = fxFor(placePrev, placePrev.resolved || {}, now);
        fx.aMul *= fade;
        placePrev.inst.draw(g, dt, now, fx);
      }
    }
    if (placeCur) {
      const fx = fxFor(placeCur, placeCur.resolved || {}, now);
      placeCur.inst.draw(g, dt, now, fx);
    }
    // soft radial vignette centred on O
    const grad = g.createRadialGradient(O.x, O.y, R * 0.8, O.x, O.y, W * 0.62);
    grad.addColorStop(0, 'rgba(7,12,24,0)');
    grad.addColorStop(1, 'rgba(7,12,24,.28)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  }

  /* --------------------------- text channels ---------------------------- */
  const TEXT_PAUSES = { '，': 160, '、': 140, ',': 120, '；': 220, ';': 200, '：': 180, ':': 160, '。': 360, '！': 360, '？': 360, '.': 300, '!': 300, '?': 300, '…': 260, '—': 160 };
  const channels = [
    { el: titleEl, value: '', chars: [], typed: 0, nextAt: 0, typing: false, delay: 80, zhRate: 30, enRate: 58 },
    { el: captionEl, value: '', chars: [], typed: 0, nextAt: 0, typing: false, delay: 220, zhRate: 38, enRate: 72 },
  ];
  function renderChannel(ch) {
    const nodes = [];
    const settled = ch.chars.slice(0, ch.typed).join('');
    if (settled) nodes.push(document.createTextNode(settled));
    if (ch.typing) {
      const caret = document.createElement('span');
      caret.className = 'core-caret';
      caret.setAttribute('aria-hidden', 'true');
      nodes.push(caret);
    }
    ch.el.replaceChildren(...nodes);
  }
  function setChannel(ch, value, now) {
    const next = typeof value === 'string' ? value : '';
    if (ch.value === next) return;
    ch.value = next;
    ch.chars = Array.from(next);
    ch.typed = 0;
    ch.typing = !T.reduced && ch.chars.length > 0;
    if (T.reduced) ch.typed = ch.chars.length;
    ch.nextAt = now + ch.delay;
    renderChannel(ch);
  }
  function tickText(now) {
    textMotion.energy *= 0.94;
    if (T.reduced) {
      for (const ch of channels) { if (ch.typing) { ch.typing = false; ch.typed = ch.chars.length; renderChannel(ch); } }
    } else {
      for (const ch of channels) {
        if (!ch.typing) continue;
        let changed = false;
        while (ch.typing && now >= ch.nextAt) {
          const char = ch.chars[ch.typed];
          ch.typed += 1;
          changed = true;
          if (/[\p{L}\p{N}]/u.test(char)) textMotion.energy = Math.min(1, textMotion.energy + (T.lang === 'zh' ? 0.42 : 0.24));
          textMotion.voiceUntil = now + 150;
          ch.nextAt += 1000 / (T.lang === 'zh' ? ch.zhRate : ch.enRate) + (TEXT_PAUSES[char] || 0);
          if (ch.typed >= ch.chars.length) ch.typing = false;
        }
        if (changed) renderChannel(ch);
      }
    }
    document.body.dataset.voice = !T.reduced && now < textMotion.voiceUntil ? 'on' : 'off';
  }

  /* ------------------------------ transients ---------------------------- */
  const transFx = { active: null, chipT0: 0 };
  function trigger(id) {
    const spec = C.transients[id];
    if (!spec) return;
    const now = perfNow();
    transFx.active = { id, spec, t0: now };
    chip.hidden = false;
    chip.textContent = tr(spec.chip, T.lang);
    chip.style.left = `${O.x - R}px`;
    chip.style.top = `${O.y + R + 28}px`;
    chip.classList.remove('is-out');
    requestAnimationFrame(() => chip.classList.add('is-in'));
    if (id === 'retry') { fxMods.dipUntil = now + 0.6; fxMods.dipAmt = 0.6; }
    if (id === 'tool-error') fxMods.slateUntil = now + 0.4;
    if (id === 'model-switch') modEvents.shimmerT = now;
    if (id === 'steer') env.emit('inhale');
  }
  function drawTransients(g, now) {
    const a = transFx.active;
    if (!a) return;
    const e = (now - a.t0) * 1000;
    const ms = a.spec.ms || 2000;
    if (e > ms) {
      transFx.active = null;
      chip.classList.add('is-out');
      setTimeout(() => { if (!transFx.active) chip.hidden = true; }, 240);
      return;
    }
    const gold = '255,220,81', hi = '190,250,255';
    if (a.id === 'steer') {
      const from = { x: 0.3 * W, y: O.y };
      const to = { x: O.x - R, y: O.y };
      const p = LS.easeInOutCubic(LS.clamp(e / 900, 0, 1));
      const x = LS.lerp(from.x, to.x, p), y = LS.lerp(from.y, to.y, p);
      const grad = g.createLinearGradient(x - 60, y, x, y);
      grad.addColorStop(0, LS.rgba(hi, 0));
      grad.addColorStop(1, LS.rgba(hi, 0.7));
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = grad;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x - 60, y); g.lineTo(x, y); g.stroke();
      g.shadowColor = LS.rgba(hi, 0.8); g.shadowBlur = 8;
      g.fillStyle = LS.rgba(hi, 0.8);
      g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
      g.restore();
      if (e >= 900) {
        const re = (e - 900) / 500;
        if (re < 1) {
          g.strokeStyle = LS.rgba(hi, 0.28 * (1 - re));
          g.lineWidth = 1;
          g.beginPath(); g.arc(O.x, O.y, R + re * 46, 0, Math.PI * 2); g.stroke();
        }
      }
    } else if (a.id === 'retry') {
      const p = LS.clamp(e / 1200, 0, 1);
      g.save();
      g.translate(O.x, O.y);
      g.rotate(p * Math.PI * 2);
      g.setLineDash([6, 8]);
      g.strokeStyle = LS.rgba(gold, 0.35 * (1 - p * 0.6));
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(0, 0, R * 1.18, 0, Math.PI * 2); g.stroke();
      g.restore();
    } else if (a.id === 'chain-confirmed') {
      const pos = (env.chainApi && env.chainApi.newestPos && env.chainApi.newestPos())
        || { x: O.x + R * 0.7, y: O.y + R * 0.7 };
      const rot = LS.clamp(e / 600, 0, 1);
      const fade = e < 1200 ? 1 : LS.clamp(1 - (e - 1200) / 600, 0, 1);
      g.save();
      g.translate(pos.x + 20, pos.y - 20);
      g.rotate((1 - LS.easeOutCubic(rot)) * -0.6);
      g.globalAlpha = fade;
      g.strokeStyle = LS.rgba(gold, 0.75);
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(0, 0, 14, 0, Math.PI * 2); g.stroke();
      for (let i = 0; i < 8; i += 1) {
        const aa = (i / 8) * Math.PI * 2;
        g.beginPath();
        g.moveTo(Math.cos(aa) * 15.5, Math.sin(aa) * 15.5);
        g.lineTo(Math.cos(aa) * 18, Math.sin(aa) * 18);
        g.stroke();
      }
      g.strokeStyle = LS.rgba(gold, 0.85);
      g.beginPath();
      g.moveTo(-4, 0.5); g.lineTo(-1, 3.5); g.lineTo(4.5, -2.5);
      g.stroke();
      g.restore();
    }
    // model-switch / tool-error / retry dip handled via modulation/fx flags
  }

  /* ------------------------ verification scan overlay ----------------------
     Gold scan arc (70°) circles the orb once per 1.6s; three ticks on the
     right at −30°/0°/+30° light a check as the arc passes on the first loop. */
  let verifyT0 = -9;
  function drawVerification(g, now) {
    if (current.id !== 'verification' || verifyT0 < 0) return;
    const e = now - verifyT0;
    const gold = '255,220,81';
    const rr = 1.22 * R;
    // starts at the bottom (−90°) so the sweep climbs the right side in order
    const scan = -Math.PI / 2 + (e / 1.6) * Math.PI * 2;
    g.save();
    g.strokeStyle = LS.rgba(gold, 0.45);
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(O.x, O.y, rr, scan - (70 * Math.PI) / 180, scan);
    g.stroke();
    for (const deg of [-30, 0, 30]) {
      const ang = (deg * Math.PI) / 180;
      const tx = O.x + Math.cos(ang) * (rr + 14), ty = O.y + Math.sin(ang) * (rr + 14);
      g.strokeStyle = LS.rgba(gold, 0.25);
      g.lineWidth = 1;
      g.beginPath(); g.arc(tx, ty, 2, 0, Math.PI * 2); g.stroke();
      if (scan >= ang) {
        g.strokeStyle = LS.rgba(gold, 0.7);
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(tx - 3.5, ty);
        g.lineTo(tx - 1, ty + 3);
        g.lineTo(tx + 4, ty - 3.5);
        g.stroke();
      }
    }
    g.restore();
  }

  /* ----------------------------- interaction ---------------------------- */
  const CARD_Q = { zh: '这 3 个问题里，你想先看哪一个？', en: 'Which of these 3 questions should I start with?' };
  function renderCard(stateId) {
    if (stateId !== 'owner-needed') { cardEl.hidden = true; return; }
    const options = T.lang === 'en'
      ? ['Wallet NFT list', 'APEC attendees', 'On-chain questions']
      : ['钱包 NFT 清单', 'APEC 出席名单', '链上待回答问题'];
    cardEl.innerHTML = `
      <div class="interaction-kicker">${T.lang === 'en' ? 'Input needed' : '需要你定一下'}</div>
      <p class="interaction-title">${tr(CARD_Q, T.lang)}</p>
      <div class="interaction-options">
        ${options.map((o) => `<button class="interaction-option" type="button">${o}</button>`).join('')}
      </div>`;
    cardEl.hidden = false;
  }

  /* --------------------------- state application ------------------------- */
  const current = { state: C.states.idle, id: 'idle', activity: 'resting', placeBase: 'mind' };

  function genCompSpec() {
    if (!T.compOverride) return null;
    const spec = { workers: [], peers: [], groups: [] };
    const wPool = ['pixel', 'lumen', 'kite'];
    const pPool = ['xin', 'bob', 'mira'];
    for (let i = 0; i < Math.min(3, T.comp.workers); i += 1) spec.workers.push({ who: wPool[i], status: i === 0 ? 'working' : 'working' });
    for (let i = 0; i < Math.min(3, T.comp.peers); i += 1) spec.peers.push({ who: pPool[i], status: 'awaiting' });
    const gdefs = [
      { id: 'apec', title: { zh: 'APEC 简报', en: 'APEC brief' }, members: ['twin', 'pixel', 'xin', 'mira', 'kite', 'ren'], chair: 'twin', status: 'active' },
      { id: 'meta', title: { zh: '链上讨论', en: 'MetaWeb thread' }, members: ['twin', 'ren', 'bob'], chair: 'ren', status: 'active' },
    ];
    for (let i = 0; i < Math.min(2, T.comp.groups); i += 1) {
      const g = { ...gdefs[i], members: [...gdefs[i].members] };
      if (!T.comp.ot) g.members = g.members.filter((m) => !C.people[m]?.openteam);
      spec.groups.push(g);
    }
    spec.hero = spec.groups.length ? { type: 'groups', id: spec.groups[0].id }
      : spec.peers.length ? { type: 'peers', id: spec.peers[0].who }
        : spec.workers.length ? { type: 'workers', id: spec.workers[0].who } : null;
    return spec;
  }

  function companionsFor(stateId, stepCompanions) {
    if (stepCompanions) return stepCompanions;
    const gen = genCompSpec();
    if (gen) return gen;
    return C.defaultCompanions[stateId] || {};
  }

  function applyState(id, opts = {}) {
    const state = C.states[id];
    if (!state) return;
    const now = perfNow();
    current.state = state;
    current.id = id;
    current.activity = state.activity;
    if (id === 'verification') verifyT0 = now;

    // companions first (hero decides orb layout + 'hero' place)
    const spec = companionsFor(id, opts.companions);
    LS.companions.apply(spec);
    setHeroLayout(Boolean(spec && spec.hero), now);

    // place
    const resolved = resolvePlace({ ...state, id }, spec, now);
    ensurePlace(resolved, now);
    current.placeBase = resolved.base;

    // body datasets
    const body = document.body;
    body.dataset.activity = state.activity;
    body.dataset.family = id === 'speaking' ? 'speaking' : id;
    body.dataset.motion = T.reduced ? 'reduced' : 'full';
    body.dataset.hasReport = id === 'report-ready' ? 'true' : 'false';
    reportBtn.hidden = id !== 'report-ready';

    // copy
    const headline = opts.headline != null ? tr(opts.headline, T.lang) : tr(state.headline, T.lang);
    const caption = opts.caption != null ? tr(opts.caption, T.lang) : tr(state.caption, T.lang);
    const kicker = tr(state.kicker, T.lang) || botName;
    verbEl.textContent = kicker;
    familyEl.textContent = id === 'speaking' ? (T.lang === 'en' ? 'Speaking' : '说话中') : kicker;
    setChannel(channels[0], headline, performance.now());
    setChannel(channels[1], caption, performance.now());
    if (id !== 'speaking') {
      const len = Array.from(headline).length;
      titleEl.dataset.length = len <= 16 ? 'short' : len <= 40 ? 'medium' : 'long';
    } else titleEl.removeAttribute('data-length');

    renderCard(id);
    applyOrbParams(false, state, resolved.base);
    renderInspector(opts);
    markSidebar(id);
    if (opts.transient) setTimeout(() => trigger(opts.transient), 400);
    if (T.reduced) drawFrame(perfNow(), 0);
  }

  /* ----------------------------- scenario ------------------------------- */
  const scn = { id: null, idx: 0, playing: false, t0: 0, speed: 1 };
  function applyStep(i) {
    const steps = C.scenarios[scn.id].steps;
    scn.idx = LS.clamp(i, 0, steps.length - 1);
    const step = steps[scn.idx];
    scn.t0 = perfNow();
    applyState(step.state, {
      headline: step.headline, caption: step.caption,
      companions: step.companions, transient: step.transient,
      stepInfo: { n: scn.idx + 1, total: steps.length, tool: step.tool },
    });
    updatePlayUi();
  }
  function playScenario(id) {
    scn.id = id;
    scn.playing = true;
    applyStep(0);
  }
  function step(n) {
    if (!scn.id) scn.id = 'session';
    scn.playing = false;
    applyStep(n);
  }
  function tickScenario(now) {
    if (!scn.playing || !scn.id) return;
    const steps = C.scenarios[scn.id].steps;
    const ms = steps[scn.idx].ms / scn.speed;
    if (now - scn.t0 > ms) {
      if (scn.idx >= steps.length - 1) { scn.playing = false; updatePlayUi(); return; }
      applyStep(scn.idx + 1);
    }
  }

  /* ------------------------------ transient env --------------------------- */
  let raf = 0, lastT = 0;
  const perfNow = () => performance.now() / 1000;

  function drawFrame(now, dt) {
    tickO(now);
    tickScenario(now);
    tickText(performance.now());
    // canvases
    ctxs.place.clearRect(0, 0, W, H);
    ctxs.back.clearRect(0, 0, W, H);
    ctxs.front.clearRect(0, 0, W, H);
    drawPlaces(ctxs.place, dt, now);
    LS.companions.layoutMembers();
    const fx = { aMul: 1, slate: false };
    LS.companions.draw(ctxs.back, ctxs.front, dt, now, fx);
    drawVerification(ctxs.front, now);
    drawTransients(ctxs.front, now);
    if (orbCtl) orbCtl.setModulation(orbModulation(now, textMotion.energy));
  }

  function loop(ts) {
    raf = 0;
    const now = ts / 1000;
    const dt = Math.min(0.08, lastT ? now - lastT : 0.016);
    lastT = now;
    drawFrame(now, dt);
    tickText(performance.now());
    if (!document.hidden && !T.reduced) raf = requestAnimationFrame(loop);
  }
  function ensureLoop() {
    if (T.reduced || document.hidden) { drawFrame(perfNow(), 0); return; }
    if (!raf) raf = requestAnimationFrame(loop);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { lastT = 0; ensureLoop(); }
  });

  /* ------------------------------- chrome -------------------------------- */
  const STATUS_L = { existing: ['现有', 'existing'], changed: ['调整', 'changed'], new: ['新增', 'new'] };

  function buildSidebar() {
    const nav = $('[data-catalog]');
    nav.innerHTML = '';
    for (const grp of C.groups) {
      const h = document.createElement('div');
      h.className = 'proto-group';
      h.textContent = T.lang === 'en' ? grp.en : grp.zh;
      nav.appendChild(h);
      for (const id of grp.states) {
        const s = C.states[id];
        const btn = document.createElement('button');
        btn.className = 'proto-row';
        btn.dataset.state = id;
        const place = s.place === 'inherit' || s.place === 'hero' ? null : C.places[s.place];
        const st = STATUS_L[s.status] || STATUS_L.existing;
        btn.innerHTML = `
          <span class="proto-dot" style="background:${place ? place.glow : '#5c6b80'}"></span>
          <span class="proto-row-names"><span class="proto-row-zh">${tr(s.name, T.lang)}</span><span class="proto-row-en">${tr(s.name, T.lang === 'en' ? 'zh' : 'en')}</span></span>
          <span class="proto-badge" data-status="${s.status}">${st[T.lang === 'en' ? 1 : 0]}</span>`;
        btn.addEventListener('click', () => { scn.id = null; applyState(id); });
        nav.appendChild(btn);
      }
    }
  }
  function markSidebar(id) {
    document.querySelectorAll('.proto-row').forEach((el) => {
      el.classList.toggle('is-selected', el.dataset.state === id);
    });
  }

  function renderInspector(opts = {}) {
    const el = $('[data-inspector]');
    const s = current.state;
    const st = STATUS_L[s.status] || STATUS_L.existing;
    const place = s.place === 'inherit' || s.place === 'hero'
      ? (T.lang === 'en' ? `${s.place} → ${current.placeBase}` : `${s.place} → ${current.placeBase}`)
      : tr(C.places[s.place] && { zh: C.places[s.place].zh, en: C.places[s.place].en }, T.lang);
    const orb = s.orb || {};
    const orbRows = ['radius', 'speed', 'exposure', 'warp', 'contourDeform', 'edgeGlow', 'glassOpacity']
      .map((k) => `<tr><td>${k}</td><td>${orb[k] != null ? orb[k] : '—'}</td></tr>`).join('');
    const stepHtml = opts.stepInfo
      ? `<div class="insp-step">${T.lang === 'en' ? 'step' : '步骤'} ${opts.stepInfo.n} / ${opts.stepInfo.total}<br><span class="insp-tool">${opts.stepInfo.tool || ''}</span></div>`
      : '';
    el.innerHTML = `
      <div>
        <div class="insp-name">${tr(s.name, T.lang)} <span class="en">${tr(s.name, T.lang === 'en' ? 'zh' : 'en')} · ${current.id}</span>
          <span class="proto-badge" data-status="${s.status}">${st[T.lang === 'en' ? 1 : 0]}</span>
          <span class="insp-place">${place || ''}</span></div>
        <div class="insp-note">${tr(s.note, T.lang)}</div>
        ${stepHtml}
      </div>
      <div><div class="insp-sec">${T.lang === 'en' ? 'Triggers' : '触发'}</div>
        <div class="insp-trigs">${(s.triggers || []).map((x) => `<span class="insp-trig">${x}</span>`).join('')}</div></div>
      <div><div class="insp-sec">${T.lang === 'en' ? 'Orb params' : '球体参数'}</div>
        <table class="insp-orb">${orbRows}</table></div>`;
  }

  function buildTweaks() {
    const body = $('[data-tweaks-body]');
    const seg = (label, options, val, cb) => `
      <div class="tw-row"><span class="tw-label">${label}</span>
        <div class="tw-seg">${options.map(([v, l]) => `<button class="proto-btn ${v === val ? 'is-active' : ''}" data-seg="${label}|${v}">${l}</button>`).join('')}</div></div>`;
    body.innerHTML = `
      ${seg(T.lang === 'en' ? 'Language' : '语言', [['zh', '中文'], ['en', 'English']], T.lang, null)}
      ${seg('Web', [['A', 'A · mesh'], ['B', 'B · globe']], T.variants.web)}
      ${seg('Chain', [['A', 'A · ribbon'], ['B', 'B · hex']], T.variants.chain)}
      <div class="tw-row"><span class="tw-label">${T.lang === 'en' ? 'Background intensity' : '背景强度'}</span>
        <div class="tw-slider"><input type="range" min="0.5" max="1.6" step="0.05" value="${T.intensity}" data-tw="intensity"><output>${T.intensity.toFixed(2)}</output></div></div>
      <div class="tw-row"><label class="tw-check"><input type="checkbox" ${T.tintFollow ? 'checked' : ''} data-tw="tint"> ${T.lang === 'en' ? 'Orb tint follows place' : '球体光色跟随场所'}</label></div>
      <div class="tw-row"><label class="tw-check"><input type="checkbox" ${T.reduced ? 'checked' : ''} data-tw="reduced"> ${T.lang === 'en' ? 'Reduced motion' : '减弱动态'}</label></div>
      <div class="tw-hr"></div>
      <div class="tw-row"><span class="tw-label">${T.lang === 'en' ? 'Companions (override)' : '协作线程（覆盖）'}</span>
        ${['workers', 'peers', 'groups'].map((k) => `
          <div class="tw-step" style="margin:6px 0">
            <span style="width:64px;font-size:11px;color:#aab6c6">${{ workers: 'Workers', peers: 'Peers', groups: 'Groups' }[k]}</span>
            <button class="proto-btn" data-tw-dec="${k}">−</button>
            <output data-tw-count="${k}">${T.comp[k]}</output>
            <button class="proto-btn" data-tw-inc="${k}">+</button>
          </div>`).join('')}
        <label class="tw-check" style="margin-top:8px"><input type="checkbox" ${T.comp.ot ? 'checked' : ''} data-tw="ot"> OpenTeam guest</label>
      </div>
      <div class="tw-hr"></div>
      <div class="tw-row"><span class="tw-label">${T.lang === 'en' ? 'Transient events' : '瞬时事件'}</span>
        <div class="tw-trigs">${Object.keys(C.transients).map((id) => `<button class="proto-btn" data-transient="${id}">${tr(C.transients[id].name, T.lang)}</button>`).join('')}</div>
      </div>`;
    // wire
    body.querySelectorAll('[data-seg]').forEach((b) => {
      b.addEventListener('click', () => {
        const [label, v] = b.dataset.seg.split('|');
        if (label === '语言' || label === 'Language') setLanguage(v);
        else if (label === 'Web') setVariant('web', v);
        else if (label === 'Chain') setVariant('chain', v);
      });
    });
    body.querySelectorAll('[data-tw]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.tw;
        if (k === 'intensity') { T.intensity = parseFloat(inp.value); inp.nextElementSibling.textContent = T.intensity.toFixed(2); }
        if (k === 'tint') { T.tintFollow = inp.checked; applyOrbParams(); }
        if (k === 'ot') { T.comp.ot = inp.checked; T.compOverride = true; refresh(); }
        if (k === 'reduced') { T.reduced = inp.checked; document.body.dataset.motion = T.reduced ? 'reduced' : 'full'; if (orbCtl) orbCtl.setReduced(T.reduced); ensureLoop(); refresh(); }
      });
    });
    body.querySelectorAll('[data-tw-inc],[data-tw-dec]').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.twInc || b.dataset.twDec;
        const max = k === 'groups' ? 2 : 3;
        T.comp[k] = LS.clamp(T.comp[k] + (b.dataset.twInc ? 1 : -1), 0, max);
        T.compOverride = true;
        body.querySelector(`[data-tw-count="${k}"]`).textContent = T.comp[k];
        refresh();
      });
    });
    body.querySelectorAll('[data-transient]').forEach((b) => {
      b.addEventListener('click', () => trigger(b.dataset.transient));
    });
  }

  function buildTable() {
    const body = $('[data-table-body]');
    const rows = Object.keys(C.states).map((id) => {
      const s = C.states[id];
      const st = STATUS_L[s.status];
      return `<tr><td><strong>${tr(s.name, T.lang)}</strong><br><span class="mono" style="color:#8e9baf">${id}</span></td>
        <td>${st[T.lang === 'en' ? 1 : 0]}</td><td>${s.place}</td>
        <td class="mono">${(s.triggers || []).join('<br>')}</td>
        <td>${tr(s.note, T.lang)}</td>
        <td class="mono">r${s.orb.radius} s${s.orb.speed} e${s.orb.exposure} w${s.orb.warp} c${s.orb.contourDeform}</td></tr>`;
    }).join('');
    const trows = Object.keys(C.transients).map((id) => {
      const x = C.transients[id];
      return `<tr><td><strong>${tr(x.name, T.lang)}</strong><br><span class="mono" style="color:#8e9baf">${id} · ${x.ms}ms</span></td>
        <td colspan="2">${x.trigger}</td><td class="mono">${tr(x.chip, T.lang)}</td><td>${tr(x.note, T.lang)}</td><td></td></tr>`;
    }).join('');
    body.innerHTML = `<table class="proto-table"><thead><tr>
      <th>${T.lang === 'en' ? 'State' : '状态'}</th><th>${T.lang === 'en' ? 'Status' : '属性'}</th><th>${T.lang === 'en' ? 'Place' : '场所'}</th><th>${T.lang === 'en' ? 'Triggers' : '触发'}</th><th>${T.lang === 'en' ? 'Note' : '说明'}</th><th>orb</th>
      </tr></thead><tbody>${rows}${trows}</tbody></table>`;
  }

  function setLanguage(l) {
    T.lang = l;
    document.documentElement.lang = l;
    LS.companions.setLanguage(l);
    buildSidebar();
    buildTweaks();
    buildTable();
    applyState(current.id, scn.id ? { stepInfo: { n: scn.idx + 1, total: C.scenarios[scn.id].steps.length, tool: C.scenarios[scn.id].steps[scn.idx].tool }, companions: C.scenarios[scn.id].steps[scn.idx].companions } : {});
  }
  function setVariant(place, v) {
    T.variants[place] = v === 'B' ? 'B' : 'A';
    buildTweaks();
    refresh();
  }
  function setCompanions(obj) {
    Object.assign(T.comp, obj || {});
    T.compOverride = true;
    buildTweaks();
    refresh();
  }
  function refresh() {
    // re-apply current state/step without restarting the place
    if (scn.id) applyStep(scn.idx);
    else applyState(current.id);
  }
  function select(id, opts) {
    scn.id = null;
    scn.playing = false;
    updatePlayUi();
    applyState(id, opts);
  }

  /* ------------------------------- top bar ------------------------------- */
  function buildTopbar() {
    const box = $('[data-scenario-buttons]');
    box.innerHTML = '';
    for (const id of Object.keys(C.scenarios)) {
      const b = document.createElement('button');
      b.className = 'proto-btn';
      b.dataset.scenario = id;
      b.textContent = tr(C.scenarios[id].name, T.lang);
      b.addEventListener('click', () => playScenario(id));
      box.appendChild(b);
    }
    $('[data-play-pause]').addEventListener('click', togglePlay);
    $('[data-step-prev]').addEventListener('click', () => { if (scn.id) step(scn.idx - 1); });
    $('[data-step-next]').addEventListener('click', () => { if (scn.id) step(scn.idx + 1); });
    $('[data-speed]').addEventListener('click', () => {
      scn.speed = scn.speed === 1 ? 0.5 : 1;
      $('[data-speed]').textContent = `${scn.speed}×`;
    });
    $('[data-open-table]').addEventListener('click', () => { buildTable(); $('[data-table-overlay]').hidden = false; });
    $('[data-close-table]').addEventListener('click', () => { $('[data-table-overlay]').hidden = true; });
    $('[data-open-tweaks]').addEventListener('click', () => { $('[data-tweaks]').hidden = false; });
    $('[data-close-tweaks]').addEventListener('click', () => { $('[data-tweaks]').hidden = true; });
    updatePlayUi();
  }
  function togglePlay() {
    if (!scn.id) { playScenario('session'); return; }
    scn.playing = !scn.playing;
    if (scn.playing) scn.t0 = perfNow();
    updatePlayUi();
  }
  function updatePlayUi() {
    $('[data-play-pause]').textContent = scn.playing ? '⏸' : '▶';
    document.querySelectorAll('[data-scenario]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.scenario === scn.id);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const ids = Object.keys(C.states);
    const cur = ids.indexOf(current.id);
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { if (scn.id) step(scn.idx + 1); else select(ids[Math.min(ids.length - 1, cur + 1)]); }
    else if (e.key === 'ArrowLeft') { if (scn.id) step(scn.idx - 1); else select(ids[Math.max(0, cur - 1)]); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); select(ids[Math.min(ids.length - 1, cur + 1)]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(ids[Math.max(0, cur - 1)]); }
  });

  /* --------------------------------- boot -------------------------------- */
  LS.companions.init(env);
  buildSidebar();
  buildTopbar();
  buildTweaks();
  fitStage();
  requestAnimationFrame(() => fitStage());
  mountOrb();
  applyState('idle');
  ensureLoop();

  window.LS_PROTO = {
    select,
    setVariant,
    playScenario,
    step,
    trigger,
    setCompanions,
    setLanguage,
    _state: () => ({ id: current.id, scenario: scn.id, idx: scn.idx, backend: document.body.dataset.orbBackend }),
    _debug: () => ({
      hero: LS.companions.hero(),
      members: document.querySelectorAll('.group-member').length,
      ringA: LS.companions._ringA ? LS.companions._ringA() : null,
      peerArc: LS.companions._peerArcStart ? LS.companions._peerArcStart() : null,
      chainHeadX: env.chainApi && env.chainApi.headX ? env.chainApi.headX() : null,
      O: { ...O },
    }),
  };
})();
