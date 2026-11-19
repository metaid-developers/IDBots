/* Live Stage scene engine — production port of the approved prototype in
   docs/design/live-stage-scenes (Mind / Machine / Web-A mesh / Chain-A
   ribbon, companion rail + hero connectors, transients, verification
   overlay). Loaded before stage.js; exposes window.IDBotsLiveStageScenes.
   Places register into window.LS.placeFactories; the engine at the bottom
   owns the single rAF loop and calls the stage's per-frame hook. */
(() => {
  const LS = (window.LS = window.LS || {});
  LS.W = 0;
  LS.H = 0;
  LS.R = 1;
  LS.O_BASE = LS.O_BASE || { x: 0, y: 0 };
  LS.__geomSyncs = LS.__geomSyncs || [];
  /* Owner feedback 2026-11-18: every scene animation added with the scene
     system runs at 0.6×. Applied to the clock/dt fed to web/chain places,
     peer/group connectors, transients, the verification arc and place
     reveal/crossfade durations. Exempt: the particle field, the original
     worker curves, the orb renderer and the rail's DOM transitions. */
  LS.SCENE_TIME_SCALE = 0.6;
  /* Web/Chain dim: resting/base alphas ×0.6, moving highlights ×0.75. */
  LS.SCENE_ALPHA_BASE = 0.6;
  LS.SCENE_ALPHA_HI = 0.75;
  LS.VALID_AVATAR = /^(?:data:image\/|https?:\/\/|avatars\/)/i;
})();
/* Live Stage prototype — shared helpers + Mind place renderer.
   Place factories return { id, build(), setMotif(m), draw(g, dt, t, fx) }.
   fx = { aMul, slate, freeze, reduced, elA(x,y), revealDone }
   All drawing in logical stage coords (1280×760); ctx already has the DPR
   transform. Geometry is defined relative to O_BASE and drawn translated by
   (env.O − O_BASE) so it follows the orb's hero/no-hero position. */
(() => {
  const LS = (window.LS = window.LS || {});

  LS.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  LS.lerp = (a, b, t) => a + (b - a) * t;
  LS.smoothstep = (a, b, x) => { const u = LS.clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
  LS.easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  LS.easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  LS.easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
  LS.rgba = (hue, a) => `rgba(${hue},${LS.clamp(a, 0, 1)})`;
  LS.mulberry32 = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  LS.cubic = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  };
  LS.quad = (p0, c, p1, t) => {
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
  };
  LS.sampleCubic = (p0, p1, p2, p3, n = 200) => {
    const pts = [];
    for (let i = 0; i <= n; i += 1) pts.push(LS.cubic(p0, p1, p2, p3, i / n));
    return pts;
  };
  LS.sampleQuadratic = (p0, c, p1, n = 24) => {
    const pts = [];
    for (let i = 0; i <= n; i += 1) pts.push(LS.quad(p0, c, p1, i / n));
    return pts;
  };
  /* Arc-length table over a polyline; pointAt(s) → {x,y,tx,ty} (unit tangent). */
  LS.arcTable = (pts) => {
    const cum = [0];
    let L = 0;
    for (let i = 1; i < pts.length; i += 1) {
      L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      cum.push(L);
    }
    const pointAt = (s) => {
      const ss = LS.clamp(s, 0, L);
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < ss) lo = m + 1; else hi = m; }
      const i = Math.max(1, lo);
      const seg = cum[i] - cum[i - 1] || 1;
      const f = (ss - cum[i - 1]) / seg;
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: pts[i - 1].x + dx * f, y: pts[i - 1].y + dy * f, tx: dx / len, ty: dy / len };
    };
    return { L, pts, pointAt };
  };
  LS.roundRect = (g, x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };

  /* Static-element registry: records the anchor (base coords, for the radial
   * reveal) plus a draw closure taking (g, m). Places render statics into an
   * offscreen canvas at build; per frame they either blit (steady state) or
   * redraw element-by-element while a multiplier is active (reveal / fade /
   * dim / dip / intensity ≠ 1). */
  LS.makeStatics = (env) => {
    const els = [];
    let off = null;
    const api = {
      els,
      add(x, y, draw) {
        els.push({ x, y, d: Math.hypot(x - LS.O_BASE.x, y - LS.O_BASE.y), draw });
      },
      renderOff(ratio) {
        off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(LS.W * ratio));
        off.height = Math.max(1, Math.round(LS.H * ratio));
        const g = off.getContext('2d');
        g.setTransform(ratio, 0, 0, ratio, 0, 0);
        for (const el of els) el.draw(g, 1);
      },
      /* aMul = flat multiplier (fade·dim·dip); elM(x,y) = per-element multiplier
       * incl. reveal + intensity. Returns false when nothing drawn. */
      draw(g, fx) {
        if (!els.length) return;
        const dx = env.O.x - LS.O_BASE.x, dy = env.O.y - LS.O_BASE.y;
        g.save();
        g.translate(dx, dy);
        const flat = fx.aMul;
        if (off && fx.revealDone && Math.abs(flat - 1) < 0.001 && !fx.forceElements) {
          g.drawImage(off, 0, 0, LS.W, LS.H);
        } else {
          for (const el of els) {
            const m = fx.elA(el.x + dx, el.y + dy, el.d);
            if (m <= 0.002) continue;
            el.draw(g, m);
          }
        }
        g.restore();
      },
    };
    return api;
  };

  LS.placeFactories = LS.placeFactories || {};
})();

/* Live Stage prototype — the shared rotating-particle place (Mind + Machine).
   Verbatim port of the pre-scene-system drawParticles field (stage.js @
   36ff3c60d). One persistent instance backs both the mind and machine place
   keys, so the integrated phase stays continuous across mind↔machine family
   moves; the engine fades the field in/out when the place switches to or
   from web/chain. The particle field is exempt from SCENE_TIME_SCALE. */
(() => {
  const LS = window.LS;

  /* Particles integrate their own phase (phase += dt × speed × energy ×
     activity) so family/energy changes retune the drift without teleporting
     the field. The activity multiplier follows the orb's activity bucket —
     working speeds up, speaking and resting slow down — and eases toward its
     target with a ~0.8 s time constant. */
  const PARTICLE_ACTIVITY = { working: 1.75, speaking: .6, resting: .5 };
  /* The gather pull applies to the recall/run/read families — bash/read were
     the old local-recall, which gathered. */
  const GATHER_FAMILIES = new Set(['local-recall', 'local-run', 'local-read']);
  const ARC_FAMILIES = new Set(['report-ready', 'complete']);

  LS.placeFactories.particles = (env) => {
    const particles = Array.from({ length: 42 }, (_, index) => {
      const random = (salt) => {
        const value = Math.sin(index * 91.731 + salt * 17.17) * 43758.5453;
        return value - Math.floor(value);
      };
      return {
        angle: random(1) * Math.PI * 2, radius: 110 + random(2) * 250,
        speed: .12 + random(3) * .35, size: .7 + random(4) * 1.8,
        drift: random(5), phase: 0, sx: 1.1, sy: .62, aw: 0,
      };
    });
    const clock = { last: 0, activity: 1 };
    let familyNow = 'idle', heroNow = false, tNow = 0, arcNow = false;

    /* Orbit ellipse scale per mode in the original branch order — gather
       pull (recall/run/read) first, then the compressed structured orbit
       (×.65/×.45 while a hero companion is active), which outranks the
       report-ready/complete arc just as topology.mode === 'structured' did.
       The arc itself is a fixed formation, blended in via p.aw below.
       The switch eases (~0.18 s constant) so particles glide between modes
       instead of teleporting. */
    function targetScale(p) {
      if (GATHER_FAMILIES.has(familyNow)) {
        const pull = .68 + Math.sin(tNow * .8 + p.drift * 6) * .18;
        return { x: pull * 1.2, y: pull * .65 };
      }
      if (heroNow) return { x: .65, y: .45 };
      return { x: 1.1, y: .62 };
    }

    function step(now, reduced) {
      /* Original order: gather → structured (hero) → arc. The arc only
         applies when neither the gather families nor hero mode claim the
         field; p.aw eases the blend in/out over ~0.18 s. */
      arcNow = !heroNow && ARC_FAMILIES.has(familyNow);
      const dt = clock.last === 0 ? 0 : Math.min(.1, Math.max(0, now - clock.last));
      clock.last = now;
      const bucket = env.activity();
      const target = bucket === 'waiting' ? .95 : (PARTICLE_ACTIVITY[bucket] ?? 1);
      clock.activity += (target - clock.activity) * (1 - Math.exp(-dt / .8));
      if (!reduced && dt > 0) {
        // Integrated phase must never see a non-finite energy: one NaN step
        // would poison the accumulator for the rest of the session.
        const energy = env.energy();
        const rate = energy * clock.activity;
        const k = 1 - Math.exp(-dt / .18);
        const aw = arcNow ? 1 : 0;
        for (const p of particles) {
          p.phase += dt * p.speed * rate;
          const ts = targetScale(p);
          p.sx += (ts.x - p.sx) * k;
          p.sy += (ts.y - p.sy) * k;
          p.aw += (aw - p.aw) * k;
        }
      } else if (reduced) {
        const aw = arcNow ? 1 : 0;
        for (const p of particles) {
          const ts = targetScale(p);
          p.sx = ts.x; p.sy = ts.y; p.aw = aw;
        }
      }
    }

    function draw(g, dt, now, fx) {
      const reduced = env.reduced();
      familyNow = env.family();
      heroNow = env.hero();
      tNow = reduced ? env.seed() * .01 : now;
      const arcFam = ARC_FAMILIES.has(familyNow);
      step(now, reduced);
      const cx = env.O.x, cy = env.O.y;
      const seed = env.seed();
      for (let index = 0; index < particles.length; index += 1) {
        const p = particles[index];
        const angle = p.angle + p.phase + seed * .0001;
        const ox = cx + Math.cos(angle) * p.radius * p.sx;
        const oy = cy + Math.sin(angle) * p.radius * p.sy;
        let x = ox, y = oy;
        if (p.aw > 0) {
          const a = -Math.PI * .85 + (index / particles.length) * Math.PI * 1.7;
          x = LS.lerp(ox, cx + Math.cos(a) * 190, p.aw);
          y = LS.lerp(oy, cy + Math.sin(a) * 125, p.aw);
        }
        const base = arcFam ? .18 : .18 + p.drift * .35;
        const m = (fx.elAFree || fx.elA)(x, y);
        if (m <= 0.002) continue;
        const alpha = base * m;
        g.beginPath();
        g.fillStyle = index % 7 === 0
          ? LS.rgba('155,244,255', alpha + .12 * m)
          : LS.rgba('197,169,255', alpha);
        g.arc(x, y, p.size, 0, Math.PI * 2);
        g.fill();
      }
    }

    return {
      id: 'particles',
      build() {}, setMotif() {}, draw,
      statics: { renderOff() {}, draw() {} },
      __sim: {
        particles, clock, PARTICLE_ACTIVITY, GATHER_FAMILIES, ARC_FAMILIES, step, targetScale,
        setContext(family, hero, t) { familyNow = family; heroNow = hero; tNow = t; },
      },
    };
  };
})();

/* Live Stage prototype — Web place renderers.
   Variant A: irregular hyperlink mesh with hub "sites".
   Read = scan band; search = query sweep; packet arcs home to the orb. */
(() => {
  const LS = window.LS;
  let { W, H, R } = LS; (LS.__geomSyncs = LS.__geomSyncs || []).push(() => { W = LS.W; H = LS.H; R = LS.R; });
  const O = LS.O_BASE;
  const line = '120,168,255', node = '160,196,255', hit = '210,228,255';

  /* A page silhouette that scans and sheds text-bar dots toward the orb. */
  function makePageReader(env) {
    let active = null; // {x,y,t0,dots:[]}
    const bars = [0.9, 0.62, 0.78, 0.45, 0.83, 0.56, 0.7];
    function start(x, y, now) {
      const w = 132, h = 168;
      const anchor = { x, y };
      // keep the page inside the visible band and clear of the topline
      x = LS.clamp(x, 0.28 * W, 0.95 * W - w);
      y = LS.clamp(y, 0.14 * H, 0.86 * H - h);
      active = { x, y, w, h, t0: now, dots: [], spawned: new Set(), anchor };
    }
    function draw(g, fx, t, hueHit) {
      if (!active) return;
      const a = active;
      const e = t - a.t0;
      const m = fx.elA(a.x + a.w / 2, a.y + a.h / 2, 0);
      // when the hub sat outside the page box, a hairline ties the page to it
      if (a.anchor && (a.anchor.x > a.x + a.w || a.anchor.x < a.x || a.anchor.y > a.y + a.h || a.anchor.y < a.y)) {
        const corners = [
          { x: a.x, y: a.y }, { x: a.x + a.w, y: a.y },
          { x: a.x, y: a.y + a.h }, { x: a.x + a.w, y: a.y + a.h },
        ];
        const c = corners.reduce((b, p) => (Math.hypot(p.x - a.anchor.x, p.y - a.anchor.y) < Math.hypot(b.x - a.anchor.x, b.y - a.anchor.y) ? p : b));
        g.save();
        g.strokeStyle = LS.rgba(hueHit, 0.14 * m);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(a.anchor.x, a.anchor.y);
        g.lineTo(c.x, c.y);
        g.stroke();
        g.restore();
      }
      const cycleIdx = Math.floor(e / 2.6);
      if (cycleIdx !== a.lastCycle) { a.lastCycle = cycleIdx; a.spawned.clear(); }
      const cycle = e % 2.6;
      const scanY = a.y + LS.clamp(cycle / 1.6, 0, 1) * a.h;
      // silhouette
      g.save();
      LS.roundRect(g, a.x, a.y, a.w, a.h, 6);
      g.fillStyle = 'rgba(10,18,32,.55)';
      g.globalAlpha = Math.min(1, m);
      g.fill();
      g.strokeStyle = LS.rgba(hueHit, 0.22 * m);
      g.lineWidth = 1;
      g.stroke();
      // header
      g.fillStyle = LS.rgba(hueHit, 0.14 * m);
      g.fillRect(a.x + 8, a.y + 8, a.w - 16, 10);
      // text bars (shed as dots once scanned)
      for (let i = 0; i < bars.length; i += 1) {
        const by = a.y + 30 + i * 18;
        const bw = (a.w - 20) * bars[i];
        const gone = a.spawned.has(i);
        if (!gone) {
          g.fillStyle = LS.rgba(hueHit, 0.2 * m);
          g.fillRect(a.x + 10, by, bw, 5);
        }
        if (!gone && scanY > by && cycle < 1.8) {
          a.spawned.add(i);
          a.dots.push({ x: a.x + 10 + bw / 2, y: by + 2, t0: t + i * 0.12 });
        }
      }
      // scan band
      if (cycle < 1.6) {
        const grad = g.createLinearGradient(0, scanY - 12, 0, scanY + 2);
        grad.addColorStop(0, LS.rgba(hueHit, 0));
        grad.addColorStop(1, LS.rgba(hueHit, 0.25 * m));
        g.fillStyle = grad;
        g.fillRect(a.x + 2, scanY - 12, a.w - 4, 14);
      }
      // dots flying to the orb
      g.globalCompositeOperation = 'lighter';
      a.dots = a.dots.filter((d) => t - d.t0 < 0.75);
      for (const d of a.dots) {
        const p = LS.easeInOutCubic(LS.clamp((t - d.t0) / 0.7, 0, 1));
        if (p <= 0) continue;
        const gx = LS.lerp(d.x, env.O.x, p), gy = LS.lerp(d.y, env.O.y, p);
        g.fillStyle = LS.rgba(hueHit, 0.55 * m);
        g.beginPath();
        g.arc(gx, gy, 2, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
    return { start, draw, get active() { return active; } };
  }

  /* ============================ Web A — mesh ============================ */
  LS.placeFactories['web-a'] = (env) => {
    const statics = LS.makeStatics(env);
    let motif = 'search';
    let t = 0;
    let nodes = [], links = [], hubs = new Set(), uplinks = [], pathToOrb = [];
    let waves = [], waveNext = 0;
    let glints = [], uplinkFlash = new Map();
    const reader = makePageReader(env);
    let readStarted = false;

    function build() {
      const rng = LS.mulberry32(303);
      nodes = []; links = []; hubs = new Set(); uplinks = []; pathToOrb = [];
      waves = []; glints = []; uplinkFlash = new Map(); waveNext = 0;
      const excl = 1.25 * R;
      let attempts = 0;
      while (nodes.length < 65 && attempts < 6000) {
        attempts += 1;
        const x = 0.28 * W + rng() * (W + 20 - 0.28 * W);
        const y = -20 + rng() * (H + 40);
        if (Math.hypot(x - O.x, y - O.y) < excl) continue;
        let ok = true;
        for (const n of nodes) {
          if (Math.hypot(n.x - x, n.y - y) < 62) { ok = false; break; }
        }
        if (ok) nodes.push({ x, y, ph: rng() * 6.28, deg: 0 });
      }
      // 3-nearest links, dedupe, skip >150px
      const seen = new Set();
      for (let i = 0; i < nodes.length; i += 1) {
        const dists = nodes
          .map((n, j) => ({ j, d: Math.hypot(n.x - nodes[i].x, n.y - nodes[i].y) }))
          .filter((e) => e.j !== i && e.d <= 150)
          .sort((a, b) => a.d - b.d)
          .slice(0, 3);
        for (const e of dists) {
          const key = i < e.j ? `${i}-${e.j}` : `${e.j}-${i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push([i, e.j]);
          nodes[i].deg += 1;
          nodes[e.j].deg += 1;
        }
      }
      nodes
        .map((n, i) => ({ i, d: n.deg }))
        .sort((a, b) => b.d - a.d)
        .slice(0, 9)
        .forEach((e) => hubs.add(e.i));
      // 5 uplinks from the orb edge to the 5 nearest nodes
      uplinks = nodes
        .map((n, i) => ({ i, d: Math.hypot(n.x - O.x, n.y - O.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map((e) => e.i);
      // BFS from uplink nodes → next hop toward the orb
      const adj = nodes.map(() => []);
      for (const [a, b] of links) { adj[a].push(b); adj[b].push(a); }
      pathToOrb = new Array(nodes.length).fill(-1);
      const prev = new Array(nodes.length).fill(-1);
      const queue = [...uplinks];
      const seenB = new Set(uplinks);
      while (queue.length) {
        const cur = queue.shift();
        for (const nb of adj[cur]) {
          if (seenB.has(nb)) continue;
          seenB.add(nb);
          prev[nb] = cur;
          queue.push(nb);
        }
      }
      for (let i = 0; i < nodes.length; i += 1) {
        // walk from i to an uplink node
        const path = [i];
        let cur = i;
        let guard = 0;
        while (!uplinks.includes(cur) && prev[cur] !== -1 && guard < 80) {
          cur = prev[cur];
          path.push(cur);
          guard += 1;
        }
        pathToOrb[i] = uplinks.includes(cur) ? path : null;
      }
      // statics: mesh lines + hub rings + uplinks
      statics.add(O.x + 0.25 * W, O.y, (g, m) => {
        const h = fxHue();
        g.strokeStyle = LS.rgba(h, 0.065 * m);
        g.lineWidth = 0.8;
        g.beginPath();
        for (const [a, b] of links) {
          g.moveTo(nodes[a].x, nodes[a].y);
          g.lineTo(nodes[b].x, nodes[b].y);
        }
        g.stroke();
      });
      statics.add(O.x + 0.25 * W, O.y, (g, m) => {
        const h = fxHue();
        g.strokeStyle = LS.rgba(h, 0.08 * m);
        g.lineWidth = 1;
        for (const i of hubs) {
          g.beginPath();
          g.arc(nodes[i].x, nodes[i].y, 6, 0, Math.PI * 2);
          g.stroke();
        }
      });
      statics.add(O.x + R, O.y, (g, m) => {
        const h = fxHue();
        g.strokeStyle = LS.rgba(h, 0.08 * m);
        g.lineWidth = 1;
        for (const i of uplinks) {
          const n = nodes[i];
          const d = Math.hypot(n.x - O.x, n.y - O.y) || 1;
          g.beginPath();
          g.moveTo(O.x + ((n.x - O.x) / d) * R, O.y + ((n.y - O.y) / d) * R);
          g.lineTo(n.x, n.y);
          g.stroke();
        }
      });
    }

    let fxHue = () => line;
    let fxNode = () => node;
    let fxHit = () => hit;

    function spawnWave() {
      const cands = [...hubs].filter((i) => {
        const d = Math.hypot(nodes[i].x - O.x, nodes[i].y - O.y);
        return d > 200 && d < 600 && pathToOrb[i];
      });
      const picks = [];
      const k = 2 + Math.floor(env.rand() * 2);
      while (picks.length < k && cands.length) {
        const idx = Math.floor(env.rand() * cands.length);
        picks.push({ hub: cands.splice(idx, 1)[0], fired: false });
      }
      waves.push({ t0: t, hits: picks });
    }

    function draw(g, dt, tNow, fx) {
      fxHue = () => (fx.slate ? '148,163,184' : line);
      fxNode = () => (fx.slate ? '148,163,184' : node);
      fxHit = () => (fx.slate ? '148,163,184' : hit);
      const sdt = fx.freeze ? 0 : dt * (fx.slow || 1);
      t += sdt;
      const aBase = LS.SCENE_ALPHA_BASE, aHi = LS.SCENE_ALPHA_HI;
      g.save();
      g.globalAlpha *= aBase; // resting mesh statics ×0.6
      statics.draw(g, fx);
      g.restore();
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      g.save();
      g.translate(dx, dy);

      // node dots (twinkle + wave glow decay)
      for (let i = 0; i < nodes.length; i += 1) {
        const n = nodes[i];
        const m = fx.elA(n.x + dx, n.y + dy, 0);
        if (m <= 0.002) continue;
        const tw = 1 + 0.45 * Math.sin(t * 1.4 + n.ph);
        let a = 0.16 * tw;
        const hub = hubs.has(i);
        if (hub) a *= 1.35;
        if (n.glowT != null) {
          const ge = (t - n.glowT) * 1000;
          if (ge < 450) a = Math.max(a, 0.6 * (1 - ge / 450));
        }
        g.fillStyle = LS.rgba(fxNode(), a * m * aBase);
        g.beginPath();
        g.arc(n.x, n.y, hub ? 2.2 : 1.1, 0, Math.PI * 2);
        g.fill();
      }

      if (motif === 'search') {
        if (t >= waveNext && sdt > 0) { waveNext = t + 1.5; spawnWave(); }
        waves = waves.filter((w) => (t - w.t0) * 300 < W * 0.85);
        for (const w of waves) {
          const rr = R + (t - w.t0) * 300;
          const fade = LS.clamp(1 - rr / (0.85 * W), 0, 1);
          const m = fx.elA(env.O.x + dx * 0, env.O.y, 0);
          g.strokeStyle = LS.rgba(fxHit(), 0.12 * fade * m * aHi);
          g.lineWidth = 1;
          g.beginPath();
          g.arc(O.x, O.y, rr, 0, Math.PI * 2);
          g.stroke();
          // nodes the ring passes glow, decaying over 450ms
          for (const n of nodes) {
            const d = Math.hypot(n.x - O.x, n.y - O.y);
            if (Math.abs(d - rr) < 14) n.glowT = t;
          }
          // hub hits
          for (const h of w.hits) {
            const n = nodes[h.hub];
            const d = Math.hypot(n.x - O.x, n.y - O.y);
            if (!h.fired && rr >= d) { h.fired = true; h.t0 = t; }
            if (!h.fired) continue;
            const e = (t - h.t0) * 1000;
            const gm = fx.elA(n.x + dx, n.y + dy, 0);
            if (e < 1200) {
              // page glyph: scale-in 200ms, hold 700ms, fade 300ms
              const sc = e < 200 ? LS.easeOutCubic(e / 200) : 1;
              const fadeG = e < 900 ? 1 : 1 - (e - 900) / 300;
              g.save();
              g.translate(n.x + 12, n.y - 20);
              g.scale(sc, sc);
              LS.roundRect(g, -4.5, -5.5, 9, 11, 1.5);
              g.strokeStyle = LS.rgba(fxHit(), 0.7 * fadeG * gm * aHi);
              g.lineWidth = 1;
              g.stroke();
              g.strokeStyle = LS.rgba(fxHit(), 0.5 * fadeG * gm * aHi);
              g.beginPath();
              g.moveTo(-2, -1.5); g.lineTo(2, -1.5);
              g.moveTo(-2, 1.5); g.lineTo(1, 1.5);
              g.stroke();
              g.restore();
            }
            if (e >= 1200 && !h.glintDone) {
              const path = (pathToOrb[h.hub] || []).map((i) => nodes[i]);
              if (path.length >= 2) {
                // append the orb edge point
                const last = path[path.length - 1];
                const dd = Math.hypot(last.x - O.x, last.y - O.y) || 1;
                const edge = { x: O.x + ((last.x - O.x) / dd) * R, y: O.y + ((last.y - O.y) / dd) * R };
                const at = LS.arcTable([...path, edge]);
                const ge = (e - 1200) / 1000;
                const s = ge * 260;
                if (s >= at.L) {
                  h.glintDone = true;
                  uplinkFlash.set(path[path.length - 1], t);
                  env.emit('inhale');
                } else {
                  const head = at.pointAt(s);
                  const tail = at.pointAt(Math.max(0, s - 18));
                  g.save();
                  g.globalCompositeOperation = 'lighter';
                  const grad = g.createLinearGradient(tail.x, tail.y, head.x, head.y);
                  grad.addColorStop(0, LS.rgba(fxHit(), 0));
                  grad.addColorStop(1, LS.rgba(fxHit(), 0.6 * gm * aHi));
                  g.strokeStyle = grad;
                  g.lineWidth = 2;
                  g.beginPath(); g.moveTo(tail.x, tail.y); g.lineTo(head.x, head.y); g.stroke();
                  g.shadowColor = LS.rgba(fxHit(), 0.8 * gm * aHi);
                  g.shadowBlur = 6;
                  g.fillStyle = LS.rgba(fxHit(), 0.7 * gm * aHi);
                  g.beginPath(); g.arc(head.x, head.y, 2, 0, Math.PI * 2); g.fill();
                  g.restore();
                }
              } else h.glintDone = true;
            }
          }
        }
        // uplink flashes on glint arrival
        for (const [n, t0] of uplinkFlash) {
          const e = (t - t0) * 1000;
          if (e > 500) { uplinkFlash.delete(n); continue; }
          const a = 0.3 * (1 - e / 500) * fx.aMul * aHi;
          const d = Math.hypot(n.x - O.x, n.y - O.y) || 1;
          g.strokeStyle = LS.rgba(fxHit(), a);
          g.lineWidth = 1.4;
          g.beginPath();
          g.moveTo(O.x + ((n.x - O.x) / d) * R, O.y + ((n.y - O.y) / d) * R);
          g.lineTo(n.x, n.y);
          g.stroke();
        }
      }

      if (motif === 'read') {
        if (!readStarted) {
          readStarted = true;
          const target = { x: O.x + 0.2 * W, y: O.y - 0.2 * H };
          let best = -1, bd = 1e9;
          for (const i of hubs) {
            const d = Math.hypot(nodes[i].x - target.x, nodes[i].y - target.y);
            if (d < bd) { bd = d; best = i; }
          }
          const n = best >= 0 ? nodes[best] : { x: target.x, y: target.y };
          reader.start(n.x + 16, n.y - 190, t);
        }
        reader.draw(g, { ...fx, elA: (x, y, d) => fx.elA(x, y, d) * aHi }, t, fxHit());
      }

      g.restore();
    }

    return {
      id: 'web', variant: 'A',
      build,
      setMotif(m) {
        motif = m;
        if (m === 'read') readStarted = false;
        waves = []; waveNext = t + 0.2;
      },
      draw,
      statics,
    };
  };

})();
/* Live Stage prototype — Chain place renderers.
   Variant A: block ribbon (front + back), hash links, pending head slot,
   read scan/pin, write packet→unfold→seal→ripple, transfer exchange packets
   + interlocking rings (no money, no gold). */
(() => {
  const LS = window.LS;
  let { W, H, R } = LS; (LS.__geomSyncs = LS.__geomSyncs || []).push(() => { W = LS.W; H = LS.H; R = LS.R; });
  const O = LS.O_BASE;
  const block = '96,226,236', glint = '190,250,255', seal = '255,220,81';

  /* ========================= Chain A — block ribbon ========================= */
  LS.placeFactories['chain-a'] = (env) => {
    let motif = 'read';
    let t = 0;
    let front = null, back = null;
    let blocks = [], backBlocks = [];
    let backScroll = 0, shiftAnim = null, pendingT0 = 0;
    let cycle = null, cycleNext = 0;
    let glintNext = 0;
    let fxHue = () => block, fxGlint = () => glint, fxSeal = () => seal;
    let headS = 0; // arc-length of the pending head (x = 0.90W on the ribbon)

    /* arc-length where the ribbon crosses x = 0.90W — the visible head */
    function headArcS(at) {
      const target = 0.9 * W;
      let s = 0;
      for (let i = 1; i < at.pts.length; i += 1) {
        const seg = Math.hypot(at.pts[i].x - at.pts[i - 1].x, at.pts[i].y - at.pts[i - 1].y);
        if (at.pts[i].x >= target && seg > 0) {
          const f = LS.clamp((target - at.pts[i - 1].x) / (at.pts[i].x - at.pts[i - 1].x || 1), 0, 1);
          return s + seg * f;
        }
        s += seg;
      }
      return at.L - 20;
    }

    function frontPts() {
      const pts = LS.sampleCubic(
        { x: 0.26 * W, y: 0.9 * H }, { x: 0.52 * W, y: 0.74 * H },
        { x: 0.8 * W, y: 0.8 * H }, { x: 1.04 * W, y: 0.7 * H }, 220,
      );
      return LS.arcTable(pts);
    }
    function backPts() {
      const pts = LS.sampleCubic(
        { x: 0.4 * W, y: 0.12 * H }, { x: 0.62 * W, y: 0.24 * H },
        { x: 0.84 * W, y: 0.1 * H }, { x: 1.04 * W, y: 0.2 * H }, 200,
      );
      return LS.arcTable(pts);
    }

    function build() {
      front = frontPts();
      back = backPts();
      headS = headArcS(front);
      blocks = []; backBlocks = [];
      backScroll = 0; shiftAnim = null; pendingT0 = t - 9; cycle = null;
      cycleNext = t + 0.8; glintNext = t + 2;
      for (let s = headS - 46; s > -40; s -= 46) blocks.push({ s, baseS: s });
      for (let s = back.L - 10 - 30; s > -30; s -= 30) backBlocks.push({ s, baseS: s });
      env.chainApi = api;
    }

    function blockDraw(g, at, s, size, a, hue, lift) {
      const p = at.pointAt(s);
      const half = size / 2;
      const y = p.y - (lift || 0);
      // main square
      LS.roundRect(g, p.x - half, y - half, size, size, 6);
      g.strokeStyle = LS.rgba(hue, a.stroke);
      g.lineWidth = 1;
      g.stroke();
      // 5px up-right offset edge
      g.strokeStyle = LS.rgba(hue, a.edge);
      g.beginPath();
      g.moveTo(p.x - half + 5, y - half - 5);
      g.lineTo(p.x + half + 5, y - half - 5);
      g.lineTo(p.x + half + 5, y + half - 5);
      g.stroke();
      // hash lines
      g.strokeStyle = LS.rgba(hue, a.hash);
      g.beginPath();
      g.moveTo(p.x - half + 6, y - 4); g.lineTo(p.x - half + 18, y - 4);
      g.moveTo(p.x - half + 6, y + 1); g.lineTo(p.x - half + 14, y + 1);
      g.moveTo(p.x - half + 6, y + 6); g.lineTo(p.x - half + 20, y + 6);
      g.stroke();
      return p;
    }

    function linkDraw(g, at, s0, s1, a, hue) {
      for (const off of [-1.5, 1.5]) {
        g.strokeStyle = LS.rgba(hue, a);
        g.lineWidth = 1;
        g.beginPath();
        const steps = Math.max(2, Math.ceil((s1 - s0) / 10));
        for (let i = 0; i <= steps; i += 1) {
          const p = at.pointAt(s0 + ((s1 - s0) * i) / steps);
          const nx = -p.ty, ny = p.tx;
          if (i === 0) g.moveTo(p.x + nx * off, p.y + ny * off);
          else g.lineTo(p.x + nx * off, p.y + ny * off);
        }
        g.stroke();
      }
    }

    function newCycle() {
      const isWrite = motif === 'write' || motif === 'transfer';
      if (isWrite) {
        cycle = { kind: motif, t0: t };
        env.emit('compress');
      } else if (motif === 'read') {
        const idx = 4 + Math.floor(env.rand() * 6);
        const target = blocks[Math.min(idx, blocks.length - 1)];
        cycle = { kind: 'read', t0: t, targetS: target ? target.s : headS * 0.6, lifted: false, pinned: false, inhaled: false };
      }
    }

    function drawReadCycle(g, fx, m) {
      /* all elements here are moving highlights — caller passes m×HI */
      if (!cycle || cycle.kind !== 'read') return;
      const e = t - cycle.t0;
      const h = fxGlint();
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      // scan band: 40px glow travelling head → backward at 420px/s
      const bandS = headS - e * 420;
      if (!cycle.lifted && bandS <= cycle.targetS) cycle.lifted = true;
      if (!cycle.lifted && bandS > 0) {
        g.save();
        g.globalCompositeOperation = 'lighter';
        for (let s = bandS - 20; s <= bandS + 20; s += 4) {
          const p = front.pointAt(s);
          const fall = 1 - Math.abs(s - bandS) / 22;
          g.fillStyle = LS.rgba(h, 0.14 * Math.max(0, fall) * m);
          g.beginPath(); g.arc(p.x, p.y, 9, 0, Math.PI * 2); g.fill();
        }
        g.restore();
      }
      if (cycle.lifted && !cycle.inhaled) {
        const le = e - (headS - cycle.targetS) / 420;
        const bp = front.pointAt(cycle.targetS);
        // pin rises after the block lifts (250ms)
        const pinT = le - 0.25;
        if (pinT > 0) {
          const pe = LS.clamp(pinT / 0.9, 0, 1);
          const ddx = env.O.x - (bp.x + dx), ddy = env.O.y - (bp.y + dy - 8);
          const dd = Math.hypot(ddx, ddy) || 1;
          const edge = { x: env.O.x - (ddx / dd) * R, y: env.O.y - (ddy / dd) * R };
          const from = { x: bp.x + dx, y: bp.y + dy - 8 };
          const ctrl = { x: (from.x + edge.x) / 2, y: Math.min(from.y, edge.y) - 90 };
          const pt = LS.quad(from, ctrl, edge, LS.easeInOutCubic(pe));
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.translate(pt.x, pt.y);
          g.rotate(Math.PI / 4);
          g.shadowColor = LS.rgba(h, 0.8 * m);
          g.shadowBlur = 8;
          g.strokeStyle = LS.rgba(h, 0.8 * m);
          g.lineWidth = 1.4;
          g.strokeRect(-3.5, -3.5, 7, 7);
          g.restore();
          if (pe >= 1 && !cycle.inhaled) {
            cycle.inhaled = true;
            env.emit('inhale');
          }
        }
      }
    }

    function drawWriteCycle(g, fx, m, mBase) {
      /* m = highlight alpha (×HI); mBase = resting alpha (×BASE) for the
         just-written block that reads as a normal block. */
      if (!cycle || (cycle.kind !== 'write' && cycle.kind !== 'transfer')) return;
      const isTransfer = cycle.kind === 'transfer';
      const e = (t - cycle.t0) * 1000;
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      const hG = fxGlint(); // cyan for both kinds — transfer never uses gold
      const hp = front.pointAt(headS);
      const head = { x: hp.x + dx, y: hp.y + dy };
      // packets 0–900ms. Write: one glint packet orb → head on a low arc.
      // Transfer: packet A (cyan glint) orb → head bulging up, packet B
      // (violet) head → orb bulging down; they cross midway. No money.
      if (e < 900) {
        const p = LS.easeInOutCubic(e / 900);
        const edge = { x: env.O.x + R * 0.7, y: env.O.y + R * 0.4 };
        const packet = (pt, hue) => {
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.shadowColor = LS.rgba(hue, 0.8 * m);
          g.shadowBlur = 8;
          g.fillStyle = LS.rgba(hue, 0.8 * m);
          g.translate(pt.x, pt.y);
          LS.roundRect(g, -4, -4, 8, 8, 2);
          g.fill();
          g.restore();
        };
        if (isTransfer) {
          const ctrlUp = { x: (edge.x + head.x) / 2, y: Math.min(edge.y, head.y) - 60 };
          const ctrlDown = { x: (edge.x + head.x) / 2, y: Math.max(edge.y, head.y) + 60 };
          packet(LS.quad(edge, ctrlUp, head, p), hG);
          packet(LS.quad(head, ctrlDown, edge, p), '197,169,255');
        } else {
          const ctrl = { x: (edge.x + head.x) / 2, y: Math.max(edge.y, head.y) + 60 };
          packet(LS.quad(edge, ctrl, head, p), hG);
        }
      }
      // transfer: two interlocking rings (r12, centres ±7px, cyan+violet)
      // rotate toward each other 180° over 700ms, then fade — no gold
      if (isTransfer && e >= 900 && e < 2000) {
        const p = LS.clamp((e - 900) / 700, 0, 1);
        const fade = e < 1600 ? 1 : LS.clamp(1 - (e - 1600) / 400, 0, 1);
        g.save();
        g.translate(head.x, head.y);
        g.globalAlpha = fade;
        for (const [off, hue, dir] of [[-7, hG, 1], [7, '197,169,255', -1]]) {
          g.save();
          g.translate(off, 0);
          g.strokeStyle = LS.rgba(hue, 0.75 * m);
          g.lineWidth = 1.2;
          g.beginPath(); g.arc(0, 0, 12, 0, Math.PI * 2); g.stroke();
          const a0 = dir * p * Math.PI;
          g.beginPath();
          g.moveTo(Math.cos(a0) * 12, Math.sin(a0) * 12);
          g.lineTo(Math.cos(a0) * 16, Math.sin(a0) * 16);
          g.stroke();
          g.restore();
        }
        g.restore();
      }
      // unfold into a block 900–1250ms
      if (e >= 900 && e < 1600) {
        const p = LS.clamp((e - 900) / 350, 0, 1);
        g.save();
        g.translate(head.x, head.y);
        g.scale(0.5 + 0.5 * p, 0.5 + 0.5 * p);
        LS.roundRect(g, -15, -15, 30, 30, 6);
        g.strokeStyle = LS.rgba(fxHue(), 0.5 * p * m);
        g.lineWidth = 1;
        g.setLineDash([94 * p, 200]);
        g.stroke();
        g.restore();
      }
      // gold 12-tick seal 1250–1950ms — write only; transfer uses the rings
      if (!isTransfer && e >= 1250 && e < 2200) {
        const p = LS.clamp((e - 1250) / 700, 0, 1);
        const peak = Math.sin(Math.PI * LS.clamp(p, 0, 1));
        const a = (isTransfer ? 0.85 : 0.65) * Math.min(1, peak * 1.6) * m;
        g.save();
        g.translate(head.x, head.y);
        g.strokeStyle = LS.rgba(fxSeal(), a);
        g.lineWidth = 1.2;
        g.beginPath();
        g.arc(0, 0, 20, 0, Math.PI * 2);
        g.stroke();
        const rings = isTransfer ? [[20, 1], [26, -1]] : [[20, 1]];
        for (const [rr, dir] of rings) {
          g.save();
          g.rotate(dir * p * Math.PI * 2);
          for (let i = 0; i < 12; i += 1) {
            const aa = (i / 12) * Math.PI * 2;
            g.beginPath();
            g.moveTo(Math.cos(aa) * (rr - 3), Math.sin(aa) * (rr - 3));
            g.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr);
            g.stroke();
          }
          if (isTransfer && rr === 26) {
            g.beginPath(); g.arc(0, 0, rr, 0, Math.PI * 2); g.stroke();
          }
          g.restore();
        }
        g.restore();
      }
      // the just-written block reads as a normal block until it joins the pack
      if (e >= 1600 && e < 2400) {
        blockDraw(g, front, headS, 30, { stroke: 0.13 * mBase, edge: 0.07 * mBase, hash: 0.07 * mBase }, fxHue(), 0);
      }
      // confirmation ripple head → tail: brighten each block's own
      // stroke + hash in glint colour, 35ms stagger, decaying over 400ms
      if (e >= 1950) {
        for (let i = 0; i < Math.min(blocks.length, 14); i += 1) {
          const be = e - 1950 - i * 35;
          if (be < 0 || be > 400) continue;
          const k = 0.3 * (1 - be / 400) * m;
          blockDraw(g, front, blocks[i].s, 30, { stroke: k, edge: k * 0.5, hash: k * 0.8 }, fxGlint(), 0);
        }
      }
      // ribbon shifts exactly one slot over 600ms; the unfolded block joins
      // the chain at slot 0 and every block moves one pitch (p: 0→1)
      if (e >= 2400 && !cycle.shifted) {
        cycle.shifted = true;
        blocks.unshift({ s: headS });
        shiftAnim = { t0: t };
      }
    }

    function drawRibbon(g, fx, m, dimMul, mHi) {
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      const h = fxHue();
      g.save();
      g.translate(dx, dy);
      // back ribbon
      for (const b of backBlocks) {
        blockDraw(g, back, b.s, 18, { stroke: 0.13 * 0.45 * m * dimMul, edge: 0.07 * 0.45 * m * dimMul, hash: 0.07 * 0.45 * m * dimMul }, h, 0);
      }
      // links + front blocks
      for (let i = 0; i < blocks.length - 1; i += 1) {
        linkDraw(g, front, blocks[i + 1].s + 16, blocks[i].s - 16, 0.09 * m * dimMul, h);
      }
      for (let i = 0; i < blocks.length; i += 1) {
        const b = blocks[i];
        if (b.s < -30 || b.s > headS) continue; // nothing past the pending head
        let lift = 0, boost = 0;
        if (cycle && cycle.kind === 'read' && cycle.lifted && Math.abs(b.s - cycle.targetS) < 20) {
          const liftMs = ((headS - cycle.targetS) / 420) * 1000;
          const eMs = (t - cycle.t0) * 1000 - liftMs;
          const up = LS.clamp(eMs / 250, 0, 1);
          const settle = LS.clamp((eMs - 1150) / 400, 0, 1);
          lift = 8 * Math.min(up, 1 - settle);
          boost = up * LS.clamp(1 - settle, 0, 1);
        }
        let flash = 0;
        if (b.flashT != null) {
          const fe = (t - b.flashT) * 1000;
          if (fe < 600) flash = 0.5 * (1 - fe / 600);
        }
        blockDraw(g, front, b.s, 30, {
          stroke: 0.13 * m * dimMul + (boost * 0.42 + flash) * mHi * dimMul,
          edge: 0.07 * m * dimMul + flash * 0.5 * mHi * dimMul,
          hash: 0.07 * m * dimMul + (boost * 0.23 + flash * 0.4) * mHi * dimMul,
        }, h, lift);
      }
      // pending head slot (dashed, breathing) at x = 0.90W — hidden while a
      // write unfolds in slot 0; fades back in once the shift completes
      const writing = (cycle && (cycle.kind === 'write' || cycle.kind === 'transfer')) || shiftAnim;
      const pendA = writing ? 0 : LS.clamp((t - pendingT0) / 0.35, 0, 1);
      if (pendA > 0.01) {
        const hp = front.pointAt(headS);
        const breathe = 0.7 + 0.3 * Math.sin(t * 2.6);
        g.setLineDash([3, 3]);
        LS.roundRect(g, hp.x - 15, hp.y - 15, 30, 30, 6);
        g.strokeStyle = LS.rgba(h, 0.18 * breathe * m * dimMul * pendA);
        g.lineWidth = 1;
        g.stroke();
      }
      // past the head the ribbon continues only as a faint dashed future line
      g.strokeStyle = LS.rgba(h, 0.05 * m * dimMul);
      g.setLineDash([2, 6]);
      g.beginPath();
      for (let s = headS; s <= front.L; s += 12) {
        const p = front.pointAt(s);
        if (s === headS) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
      g.stroke();
      g.setLineDash([]);
      // ambient glint along the front ribbon every 6s
      const ge = t % 6;
      if (ge < 2.6) {
        const gs = (ge / 2.6) * front.L;
        const p = front.pointAt(gs);
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = LS.rgba(fxGlint(), 0.25 * mHi * dimMul);
        g.beginPath(); g.arc(p.x, p.y, 6, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      g.restore();
    }

    const api = {
      /* nearest front-ribbon block to a point (stage coords) → flash + pos */
      flashNearest(x, y) {
        const dx = env.O.x - O.x, dy = env.O.y - O.y;
        let best = null, bd = 1e9;
        for (const b of blocks) {
          const p = front.pointAt(b.s);
          const d = Math.hypot(p.x + dx - x, p.y + dy - y);
          if (d < bd) { bd = d; best = b; }
        }
        if (!best) return null;
        best.flashT = t;
        const p = front.pointAt(best.s);
        return { x: p.x + dx, y: p.y + dy };
      },
      newestPos() {
        const dx = env.O.x - O.x, dy = env.O.y - O.y;
        const p = front.pointAt(headS - 30);
        return { x: p.x + dx, y: p.y + dy };
      },
      pendingPos() {
        const dx = env.O.x - O.x, dy = env.O.y - O.y;
        const p = front.pointAt(headS);
        return { x: p.x + dx, y: p.y + dy };
      },
      headX() {
        const dx = env.O.x - O.x;
        return front.pointAt(headS).x + dx;
      },
    };

    function draw(g, dt, tNow, fx) {
      fxHue = () => (fx.slate ? '148,163,184' : block);
      fxGlint = () => (fx.slate ? '148,163,184' : glint);
      fxSeal = () => (fx.slate ? '148,163,184' : seal);
      const sdt = fx.freeze ? 0 : dt * (fx.slow || 1);
      t += sdt;
      const dimMul = motif === 'private' || motif === 'group' ? 0.7 : 1;
      const m = fx.aMul * LS.SCENE_ALPHA_BASE;
      const mHi = fx.aMul * LS.SCENE_ALPHA_HI;
      // Front ribbon is slot-quantized: block i sits at pos(i,p) = headS −
      // (i+p)·pitch with slot 0 the pending head. No ambient scroll — life
      // comes from the propagation glint, the read scan and write shifts.
      backScroll += sdt * 5;
      let shiftP = 1;
      if (shiftAnim) {
        const p = LS.clamp((t - shiftAnim.t0) / 0.6, 0, 1);
        shiftP = LS.easeInOutCubic(p);
        if (p >= 1) { shiftAnim = null; pendingT0 = t; }
      }
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        blocks[i].s = headS - (i + shiftP) * 46;
        if (blocks[i].s < -40) blocks.splice(i, 1); // past the visible tail → dropped
      }
      for (const b of backBlocks) {
        if (b.s < -30) b.baseS += 30 * backBlocks.length;
        b.s = b.baseS - backScroll;
      }
      drawRibbon(g, fx, m, dimMul, mHi);

      if (motif === 'read' || motif === 'write' || motif === 'transfer') {
        if (!cycle && t >= cycleNext && sdt > 0) { cycleNext = t + (motif === 'read' ? 2.4 : 3); newCycle(); }
        drawReadCycle(g, fx, mHi * dimMul);
        drawWriteCycle(g, fx, mHi * dimMul, m * dimMul);
        if (cycle) {
          const maxE = cycle.kind === 'read' ? 4 : 3.2;
          if (t - cycle.t0 > maxE) cycle = null;
        }
      }
    }

    return {
      id: 'chain', variant: 'A',
      build,
      setMotif(m) { motif = m; cycle = null; cycleNext = t + 0.8; },
      draw,
      statics: { els: [], draw() {} },
    };
  };

})();
/* Live Stage prototype — companions layer.
   Rail DOM (right column), hero connectors (worker PCB route, peer dashed
   arc + capsule, group "Saturn" ring), group member avatars on the ring. */
(() => {
  const LS = window.LS;
  let { W, H, R } = LS; (LS.__geomSyncs = LS.__geomSyncs || []).push(() => { W = LS.W; H = LS.H; R = LS.R; });
  const O = LS.O_BASE;
  const AMBER = '255,220,81';
  const CYAN = '96,226,236', CYAN_HI = '190,250,255', OT = '197,169,255';
  /* Worker/peer connectors anchor just inside the rendered ball edge: R tracks
     the active orb's live rect (.72 of the canvas half-width, matching the
     liquid-orb family `radius: .72`), so the anchor kisses that edge ~4%
     inside — the same inset the pre-scene port had (membrane width × .48 = 94
     against the 98px membrane edge) — and contour deform / edge glow can never
     leave a visible gap between the ball and the line. */
  const ORB_EDGE_INSET = 0.96;

  const STATUS_RANK = {
    dispatch: 0, return: 0, sending: 0, incoming: 0, posting: 0,
    working: 1, active: 1, verifying: 1,
    awaiting: 2, delivered: 2, waiting: 2,
  };
  const CHIP = {
    worker: {
      dispatch: ['派发中', 'Dispatching'], working: ['执行中', 'Working'],
      waiting: ['等待交回', 'Awaiting return'],
      return: ['交回核验', 'Returning'], verifying: ['后台核验中', 'Verifying'],
    },
    peer: {
      sending: ['发送中', 'Sending'], delivered: ['已送达', 'Delivered'],
      awaiting: ['等回复', 'Awaiting reply'], incoming: ['新消息', 'New message'],
      open: ['会话中', 'Open'],
    },
    group: {
      posting: ['发言中', 'Posting'], active: ['进行中', 'In progress'],
      incoming: ['新发言', 'New post'],
    },
  };
  const SECTIONS = { workers: ['本地协作', 'Local'], peers: ['私聊', 'Private'], groups: ['群任务', 'Group'] };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GLYPHS = {
    worker: { attrs: { viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2' }, kids: [
      ['path', { d: 'M1 9h4l2-2h4' }],
      ['circle', { cx: '10.5', cy: '7', r: '1' }],
    ] },
    peer: { attrs: { viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-dasharray': '2 1.6' }, kids: [
      ['path', { d: 'M2 10Q6 1 10 6' }],
    ] },
    group: { attrs: { viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1' }, kids: [
      ['ellipse', { cx: '6', cy: '6', rx: '5', ry: '2.4', transform: 'rotate(-12 6 6)' }],
      ['circle', { cx: '6', cy: '6', r: '1.1', fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: '2', cy: '4.4', r: '.7', fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: '10', cy: '5', r: '.7', fill: 'currentColor', stroke: 'none' }],
    ] },
  };
  function buildGlyph(kind) {
    const spec = GLYPHS[kind];
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries(spec.attrs)) svg.setAttribute(k, v);
    for (const [tag, attrs] of spec.kids) {
      const kid = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) kid.setAttribute(k, v);
      svg.appendChild(kid);
    }
    return svg;
  }

  const M = {
    env: null, rail: null, memberLayer: null,
    spec: { workers: [], peers: [], groups: [] },
    hero: null,
    lang: 'zh', density: 'full',
    items: new Map(), shown: 0, lastCap: 0, railUnits: null,
    memberEls: new Map(), membersDirty: false, layoutCount: 0,
    memberGrp: null, moreEl: null, ringA: 0, rx: 0,
    t: 0, fadeT: -9,
    pulses: [],
    peerCycle: { t0: -9, dropped: false, leanAt: -9, dropAt: -9 },
    ringSweep: { t0: -9, senderAngle: null, done: false },
    ringSpin: 0,
  };

  function person(id) {
    return (LS.catalog && LS.catalog.people && LS.catalog.people[id]) || { id, name: id, avatar: '' };
  }

  function tr(pair) { return M.lang === 'en' ? pair[1] : pair[0]; }
  /* catalog values are {zh,en} objects (or plain strings) */
  function trv(v) { return v == null ? '' : typeof v === 'string' ? v : (v[M.lang] || v.zh || ''); }

  /* ------------------------------ rail DOM ------------------------------ */
  const RAIL_ORDER = ['workers', 'peers', 'groups'];
  const rankOf = (c) => STATUS_RANK[c.status] ?? 1;
  const isHeroItem = (type, c) => Boolean(M.hero && M.hero.type === type && M.hero.id === (type === 'groups' ? c.id : c.who));
  /* globally ordered candidates: the hero is pinned first, then active-now →
     working → waiting; trimming from the tail can never unpin the hero. */
  function railCandidates() {
    return RAIL_ORDER
      .flatMap((type) => (M.spec[type] || []).map((c) => ({ type, c })))
      .sort((a, b) => (isHeroItem(b.type, b.c) - isHeroItem(a.type, a.c)) || (rankOf(a.c) - rankOf(b.c)));
  }
  // full: 4 items + "+N" when overflowing; mini: ≤3 items + "+N"
  function railCountCap(total) {
    return M.density === 'mini' ? Math.min(3, total) : (total > 5 ? 4 : 5);
  }
  /* Height budget: the rail lives in a fixed band (top 14%, max-height 46%)
     so a count cap alone can still clip the last card at small stage sizes.
     Units are measured once per density in measureRailUnits(); until then the
     count cap applies and the first build refits itself. The "+N" row's space
     is always reserved whenever items would be hidden. */
  const RAIL_KIND = { workers: 'worker', peers: 'peer', groups: 'group' };
  function railAvail() {
    const holder = M.rail.parentElement;
    const band = holder ? holder.clientHeight : Infinity;
    const css = getComputedStyle(M.rail).maxHeight;
    // 4px safety: measured offsetHeights round, sub-pixel gaps accumulate
    if (css.endsWith('%')) return band * (parseFloat(css) / 100) - 4;
    const px = parseFloat(css);
    if (Number.isFinite(px)) return px - 4;
    return band * 0.46 - 4;
  }
  /* Item heights differ per kind (a hero group card with the member line is
     ~1.7x a plain worker row), so units are kept per kind. Kinds hidden by
     the cap are measured once via a throwaway probe; buildItem registers the
     probe into M.items, so the previous entry is restored afterwards. */
  function measureRailUnits(cand) {
    const items = M.rail.querySelectorAll('.rail-item');
    if (!items.length) return;
    const head = M.rail.querySelector('.rail-heading');
    const more = M.rail.querySelector('.rail-more');
    const gap = parseFloat(getComputedStyle(M.rail).rowGap) || 8;
    const item = {};
    let maxItem = 0;
    for (const el of items) {
      const h = el.offsetHeight;
      const kind = el.dataset.kind || 'worker';
      item[kind] = Math.max(item[kind] || 0, h);
      if (h > maxItem) maxItem = h;
    }
    for (const type of RAIL_ORDER) {
      const kind = RAIL_KIND[type];
      if (item[kind]) continue;
      const c = (cand || []).find((e) => e.type === type);
      if (!c) continue;
      const key = `${type}:${type === 'groups' ? c.c.id : c.c.who}`;
      const prev = M.items.has(key) ? M.items.get(key) : undefined;
      const probe = buildItem(type, c.c);
      M.rail.appendChild(probe);
      const h = probe.offsetHeight;
      probe.remove();
      if (prev !== undefined) M.items.set(key, prev); else M.items.delete(key);
      item[kind] = h;
      if (h > maxItem) maxItem = h;
    }
    M.railUnits = {
      density: M.density,
      item, maxItem,
      head: head ? head.offsetHeight : 14,
      more: more ? more.offsetHeight : 22,
      gap,
    };
  }
  function railFitCap(countCap, cand, total) {
    const u = M.railUnits;
    if (!u || u.density !== M.density) return countCap;
    const avail = railAvail();
    for (let c = Math.min(countCap, total); c >= 1; c -= 1) {
      const picked = cand.slice(0, c);
      const secs = new Set(picked.map((e) => e.type)).size;
      let est = secs * (u.head + u.gap) + (c < total ? u.more + u.gap : 0);
      for (const e of picked) est += (u.item[RAIL_KIND[e.type]] || u.maxItem) + u.gap;
      if (est <= avail) return c;
    }
    return Math.min(1, total);
  }

  function renderRail(cap, cand, total) {
    const rail = M.rail;
    rail.replaceChildren();
    M.items.clear();
    const picked = new Set(cand.slice(0, cap).map((entry) => entry.c));
    let shown = 0;
    for (const type of RAIL_ORDER) {
      const list = M.spec[type] || [];
      const sorted = [...list].sort((a, b) => rankOf(a) - rankOf(b));
      const visible = sorted.filter((c) => picked.has(c));
      if (!visible.length) continue; // heading only when ≥1 item shows
      const sec = document.createElement('div');
      sec.className = 'rail-section';
      const head = document.createElement('div');
      head.className = 'rail-heading';
      head.textContent = tr(SECTIONS[type]);
      sec.appendChild(head);
      for (const c of visible) sec.appendChild(buildItem(type, c));
      rail.appendChild(sec);
      shown += visible.length;
    }
    const hidden = total - shown;
    if (hidden > 0) {
      const more = document.createElement('div');
      more.className = 'rail-more';
      more.textContent = M.lang === 'en' ? `+${hidden} threads` : `+${hidden} 个线程`;
      rail.appendChild(more);
    }
    M.shown = shown;
    M.lastCap = cap;
    rail.setAttribute('aria-hidden', shown === 0 ? 'true' : 'false');
    // stagger-in
    requestAnimationFrame(() => {
      let i = 0;
      for (const el of rail.querySelectorAll('.rail-item')) {
        el.style.transitionDelay = `${i * 60}ms`;
        el.classList.add('is-in');
        i += 1;
      }
      setTimeout(() => {
        for (const el of rail.querySelectorAll('.rail-item')) el.style.transitionDelay = '';
      }, shown * 60 + 400);
    });
  }

  function buildRail() {
    if (!M.rail) return; // measure() runs before companions.init on small boots
    const cand = railCandidates();
    const total = cand.length;
    const countCap = railCountCap(total);
    const cap = railFitCap(countCap, cand, total);
    renderRail(cap, cand, total);
    // heights shift with density and hero state, so units are re-measured on
    // each rebuild (spec/density/resize — never per frame) and the cap refits
    // once if the fresh numbers draw a tighter budget
    measureRailUnits(cand);
    const refit = railFitCap(countCap, cand, total);
    if (refit !== cap) renderRail(refit, cand, total);
  }

  function buildItem(type, c) {
    const kind = type === 'workers' ? 'worker' : type === 'peers' ? 'peer' : 'group';
    const el = document.createElement('div');
    el.className = 'rail-item';
    el.dataset.status = c.status;
    el.dataset.kind = kind;
    const isHero = M.hero && M.hero.type === type && M.hero.id === (kind === 'group' ? c.id : c.who);
    if (isHero) el.dataset.hero = kind;
    if (kind === 'group') {
      const stack = document.createElement('div');
      stack.className = 'rail-stack';
      c.members.slice(0, 3).forEach((pid, i) => {
        const img = document.createElement('img');
        setAvatar(img, person(pid).avatar);
        img.alt = '';
        stack.appendChild(img);
      });
      if (c.members.length > 3) {
        const n = document.createElement('span');
        n.className = 'rail-more-n';
        n.textContent = `+${c.members.length - 3}`;
        stack.appendChild(n);
      }
      el.appendChild(stack);
    } else {
      const img = document.createElement('img');
      img.className = 'rail-avatar';
      setAvatar(img, person(c.who).avatar);
      img.alt = '';
      el.appendChild(img);
    }
    const meta = document.createElement('div');
    meta.className = 'rail-meta';
    const head = document.createElement('div');
    head.className = 'rail-head';
    const name = document.createElement('span');
    name.className = 'rail-name';
    name.textContent = kind === 'group' ? trv(c.title) : person(c.who).name;
    head.appendChild(name);
    const chip = document.createElement('span');
    chip.className = 'rail-chip';
    chip.textContent = tr(CHIP[kind][c.status] || [c.status, c.status]);
    head.appendChild(chip);
    const hasOT = kind === 'group'
      ? c.members.some((m) => person(m).openteam)
      : person(c.who).openteam;
    if (hasOT) {
      const ot = document.createElement('span');
      ot.className = 'rail-ot';
      ot.textContent = 'OpenTeam';
      head.appendChild(ot);
    }
    const sub = document.createElement('span');
    sub.className = 'rail-sub';
    sub.textContent = kind === 'group'
      ? (M.lang === 'en' ? `${c.memberCount ?? c.members.length} members` : `${c.memberCount ?? c.members.length} 位成员`)
      : kind === 'worker'
        ? (trv(person(c.who).task) || (M.lang === 'en' ? 'sub-thread' : '子线程'))
        : (trv(person(c.who).last) || (M.lang === 'en' ? 'private chat' : '私聊'));
    const glyph = document.createElement('span');
    glyph.className = 'rail-glyph';
    glyph.appendChild(buildGlyph(kind));
    meta.appendChild(head);
    meta.appendChild(sub);
    el.appendChild(meta);
    el.appendChild(glyph);
    M.items.set(`${type}:${kind === 'group' ? c.id : c.who}`, el);
    return el;
  }

  /* Missing or invalid avatars fall back to the shipped default Bot avatar;
     the error listener swaps once ({ once:true }) — no retry loop. */
  function setAvatar(img, src) {
    const fb = typeof window.__FALLBACK_AVATAR__ === 'string' && window.__FALLBACK_AVATAR__
      ? window.__FALLBACK_AVATAR__ : '';
    const ok = typeof src === 'string' && LS.VALID_AVATAR.test(src);
    img.src = ok ? src : fb;
    if (fb) {
      img.addEventListener('error', () => {
        if (img.src !== fb) img.src = fb;
      }, { once: true });
    }
  }

  /* logical position helpers (offset* coords are unscaled stage px) */
  function itemRect(el) {
    const stage = M.rail.offsetParent; // .live-stage
    let x = el.offsetLeft, y = el.offsetTop, p = el.offsetParent;
    while (p && p !== stage) { x += p.offsetLeft; y += p.offsetTop; p = p.offsetParent; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  function heroItem() {
    if (!M.hero) return null;
    const id = M.hero.type === 'groups' ? M.hero.id : M.hero.id;
    return M.items.get(`${M.hero.type}:${id}`) || null;
  }

  function avatarAnchor(el) {
    const img = el.querySelector('.rail-avatar');
    const r = itemRect(el);
    if (!img) return { x: r.x + 14, y: r.y + r.h / 2 };
    return { x: r.x + img.offsetLeft + img.offsetWidth / 2, y: r.y + img.offsetTop + img.offsetHeight / 2 };
  }

  /* Worker connector — verbatim port of the pre-scene-system drawParticles
     constellation block (stage.js @ 36ff3c60d): a quadratic curve from the
     orb-edge anchor to the card's left-middle anchor, chevron arrowhead at
     the destination and heartbeat pulse dots. Every visible worker rail
     item gets one; the hero is emphasised by the card styling only. This is
     an original-speed animation — SCENE_TIME_SCALE does not apply. */
  function drawWorker(g, item, status, fx, t, index, reduced) {
    const orbCenter = { x: M.env.O.x, y: M.env.O.y };
    const orbRadius = Math.max(44, R * ORB_EDGE_INSET);
    const r = itemRect(item);
    if (r.w < 4 || r.h < 4) return;
    const cardAnchor = { x: r.x - 4, y: r.y + r.h / 2 };
    const dx = cardAnchor.x - orbCenter.x;
    const dy = cardAnchor.y - orbCenter.y;
    const dist = Math.hypot(dx, dy) || 1;
    const orbAnchor = {
      x: orbCenter.x + (dx / dist) * orbRadius,
      y: orbCenter.y + (dy / dist) * orbRadius,
    };
    const dir = status;
    const returning = dir === 'return' || dir === 'verifying';
    const lowFreqWait = M.env.family() === 'waiting' || dir === 'waiting' || dir === 'verifying';
    const fromPt = returning ? cardAnchor : orbAnchor;
    const toPt = returning ? orbAnchor : cardAnchor;
    const midY = (fromPt.y + toPt.y) / 2;
    const bend = Math.min(34, Math.max(12, Math.abs(dx) * .12));
    const ctrl = { x: (fromPt.x + toPt.x) / 2, y: midY - bend };
    const cyan = fx.slate ? '148,163,184' : '155,244,255';
    const gold = fx.slate ? '148,163,184' : '255,220,81';
    const m = fx.aMul;
    g.save();
    if (lowFreqWait) g.setLineDash([5, 7]);
    g.beginPath();
    g.moveTo(fromPt.x, fromPt.y);
    g.quadraticCurveTo(ctrl.x, ctrl.y, toPt.x, toPt.y);
    g.strokeStyle = LS.rgba(returning ? gold : cyan, (returning ? .44 : .38) * m);
    g.lineWidth = lowFreqWait ? 1.35 : 1.45;
    g.stroke();
    g.setLineDash([]);

    // Directional chevron arrowhead at destination endpoint (`toPt`):
    const tanX = toPt.x - ctrl.x;
    const tanY = toPt.y - ctrl.y;
    const angle = Math.atan2(tanY, tanX);
    const headLen = 7;
    g.beginPath();
    g.moveTo(toPt.x, toPt.y);
    g.lineTo(toPt.x - headLen * Math.cos(angle - .46), toPt.y - headLen * Math.sin(angle - .46));
    g.moveTo(toPt.x, toPt.y);
    g.lineTo(toPt.x - headLen * Math.cos(angle + .46), toPt.y - headLen * Math.sin(angle + .46));
    g.strokeStyle = LS.rgba(returning ? gold : cyan, (returning ? .88 : .85) * m);
    g.lineWidth = 1.6;
    g.stroke();
    g.restore();

    // Low-frequency calm heartbeat pulse when waiting; brisk pulse when dispatching:
    const speed = lowFreqWait ? .11 : .32;
    const pulseCount = lowFreqWait ? 2 : 1;
    for (let pIdx = 0; pIdx < pulseCount; pIdx += 1) {
      const prog = reduced ? (.35 + pIdx * .35) : (t * speed + index * .23 + pIdx * .5) % 1;
      const inv = 1 - prog;
      const px = inv * inv * fromPt.x + 2 * inv * prog * ctrl.x + prog * prog * toPt.x;
      const py = inv * inv * fromPt.y + 2 * inv * prog * ctrl.y + prog * prog * toPt.y;
      g.beginPath();
      g.arc(px, py, lowFreqWait ? 2.8 : 3.5, 0, Math.PI * 2);
      g.fillStyle = LS.rgba(returning ? gold : cyan, (returning ? .92 : .9) * m);
      g.fill();
    }
  }

  /* ---------------------------- peer connector ---------------------------- */
  function peerArc(to) {
    const o = M.env.O;
    const d = Math.hypot(to.x - o.x, to.y - o.y) || 1;
    const edgeR = R * ORB_EDGE_INSET;
    const from = { x: o.x + ((to.x - o.x) / d) * edgeR, y: o.y + ((to.y - o.y) / d) * edgeR };
    const ctrl = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 40 };
    return { from, ctrl, to, table: LS.arcTable(LS.sampleQuadratic(from, ctrl, to, 24)) };
  }

  function drawPeer(g, item, status, hero, fx, t, dt) {
    const to = avatarAnchor(item);
    const arc = peerArc(to);
    const m = fx.aMul;
    const h = fx.slate ? '148,163,184' : CYAN;
    const a = hero ? 0.38 : 0.24;
    // Every visible private-chat thread keeps its dashed arc from the orb
    // edge to the card avatar — like the worker connectors — with the hero
    // emphasised by opacity plus the travelling-capsule effects below.
    g.save();
    g.strokeStyle = LS.rgba(h, a * m);
    g.lineWidth = hero ? 1.1 : 1;
    g.setLineDash([3, 5]);
    g.beginPath();
    arc.table.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.stroke();
    g.setLineDash([]);
    g.restore();
    if (!hero) {
      // non-hero: a stateless pulse rides the arc while a message is in
      // flight (the shared peerCycle state stays hero-only)
      if (status === 'sending' || status === 'incoming') {
        const local = t % 2.6;
        if (local < 1.3) {
          const raw = M.env.reduced && M.env.reduced() ? 0.35 : local / 1.3;
          const e = LS.easeInOutCubic(raw);
          const pt = arc.table.pointAt((status === 'sending' ? e : 1 - e) * arc.table.L);
          g.beginPath();
          g.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2);
          g.fillStyle = LS.rgba(fx.slate ? '148,163,184' : CYAN_HI, 0.8 * m);
          g.fill();
        }
      }
      return;
    }

    const hi = fx.slate ? '148,163,184' : CYAN_HI;
    if (status === 'sending' || status === 'incoming') {
      const period = 2.6;
      const local = t % period;
      const dur = 1.3;
      if (local < dur) {
        const raw = local / dur;
        const p = status === 'sending' ? LS.easeInOutCubic(raw) : 1 - LS.easeInOutCubic(raw);
        const pt = arc.table.pointAt(p * arc.table.L);
        const pt2 = arc.table.pointAt((p - 0.03) * arc.table.L);
        // capsule: 16×8 pill along the arc
        const ang = Math.atan2(pt.y - pt2.y, pt.x - pt2.x);
        g.save();
        g.translate(pt.x, pt.y);
        g.rotate(ang);
        g.globalCompositeOperation = 'lighter';
        g.shadowColor = LS.rgba(hi, 0.7 * m);
        g.shadowBlur = 8;
        g.fillStyle = LS.rgba(hi, 0.85 * m);
        LS.roundRect(g, -8, -4, 16, 8, 4);
        g.fill();
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(10,18,32,.9)';
        g.fillRect(-2, -1.5, 4, 3);
        g.restore();
        // at 50%: dotted drop to the nearest chain block
        if (status === 'sending' && raw >= 0.5 && !M.peerCycle.dropped) {
          M.peerCycle.dropped = true;
          const pos = M.env.chainApi && M.env.chainApi.flashNearest(pt.x, pt.y);
          if (pos) M.peerCycle.drop = { from: { x: pt.x, y: pt.y }, to: pos, t0: t };
          M.env.emit('lean', { x: 6, ms: 300 });
        }
        if (status === 'incoming' && p < 0.05 && !M.peerCycle.landed) {
          M.peerCycle.landed = true;
          M.env.emit('inhale');
        }
      } else {
        M.peerCycle.dropped = false;
        M.peerCycle.landed = false;
      }
      // drop line persists ~800ms so the anchor reads in stills too
      if (M.peerCycle.drop && t - M.peerCycle.drop.t0 < 0.8) {
        const d = M.peerCycle.drop;
        const de = (t - d.t0) / 0.8;
        g.save();
        g.setLineDash([2, 4]);
        g.strokeStyle = LS.rgba(hi, 0.2 * (1 - de) * m);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(d.from.x, d.from.y);
        g.lineTo(d.to.x, d.to.y);
        g.stroke();
        g.restore();
      }
    }
    if (status === 'delivered' || status === 'awaiting') {
      // check at the peer end
      g.save();
      g.strokeStyle = LS.rgba(hi, 0.6 * m);
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(to.x - 14, to.y + 6);
      g.lineTo(to.x - 11, to.y + 9);
      g.lineTo(to.x - 5, to.y + 2);
      g.stroke();
      g.restore();
    }
    if (status === 'awaiting') {
      for (let i = 0; i < 3; i += 1) {
        const ph = (t * 1.6 + i * 0.6) % 1.8;
        const a2 = 0.2 + 0.4 * Math.sin(Math.PI * Math.min(1, ph / 0.6));
        g.fillStyle = LS.rgba(hi, Math.max(0.12, a2) * m);
        g.beginPath();
        g.arc(to.x - 20 - i * 7, to.y + 12, 2, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  /* ------------------------------ group ring ------------------------------ */
  const RING_TILT = (-8 * Math.PI) / 180;
  /* members live only on the right arc: |θ| ≤ 50°, outside the orb disc */
  const RING_ANGLES = [-45, -15, 15, 45].map((d) => (d * Math.PI) / 180);
  const MORE_ANGLE = (60 * Math.PI) / 180;

  /* the ring exists only while a group is the hero thread */
  function heroGroup() {
    if (!M.hero || M.hero.type !== 'groups') return null;
    return (M.spec.groups || []).find((g) => g.id === M.hero.id) || null;
  }

  /* clamp rx so the ring's right extremity stays 24px clear of the rail */
  function ringRx() {
    const o = M.env.O;
    const railLeft = M.rail && M.rail.offsetWidth ? M.rail.offsetLeft : 0.762 * W;
    const limit = (railLeft - 24 - o.x) / Math.cos(RING_TILT);
    return LS.clamp(limit, 1.2 * R, 1.8 * R);
  }

  function ringPt(theta) {
    const o = M.env.O;
    const rx = M.rx || 1.8 * R, ry = 0.58 * R;
    const u = rx * Math.cos(theta), v = ry * Math.sin(theta);
    return {
      x: o.x + u * Math.cos(RING_TILT) - v * Math.sin(RING_TILT),
      y: o.y + u * Math.sin(RING_TILT) + v * Math.cos(RING_TILT),
      back: Math.sin(theta) < 0,
    };
  }

  function drawRingHalf(g, back, alpha, hi, m) {
    const N = 72;
    g.strokeStyle = LS.rgba(hi, alpha * m);
    g.lineWidth = 1;
    g.beginPath();
    let started = false;
    for (let i = 0; i <= N; i += 1) {
      const th = (i / N) * Math.PI * 2;
      const p = ringPt(th);
      const isBack = Math.sin(th) < 0;
      if (isBack === back) {
        if (!started) { g.moveTo(p.x, p.y); started = true; }
        else g.lineTo(p.x, p.y);
      } else started = false;
    }
    g.stroke();
  }

  function drawRingArc(g, thetaFrom, thetaTo, hi, a, m) {
    const N = Math.max(3, Math.ceil(Math.abs(thetaTo - thetaFrom) / 0.08));
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = LS.rgba(hi, a * m);
    g.lineWidth = 1.4;
    g.beginPath();
    for (let i = 0; i <= N; i += 1) {
      const th = thetaFrom + ((thetaTo - thetaFrom) * i) / N;
      const p = ringPt(th);
      if (i === 0) g.moveTo(p.x, p.y);
      else g.lineTo(p.x, p.y);
    }
    g.stroke();
    g.restore();
  }

  function groupMembers(grp) {
    return grp.members.filter((pid) => pid !== 'twin');
  }

  /* sender and chair are always among the ≤4 members placed on the ring */
  function orderedMembers(grp) {
    const list = groupMembers(grp);
    const out = [];
    if (grp.sender && list.includes(grp.sender)) out.push(grp.sender);
    if (grp.chair && list.includes(grp.chair)) out.push(grp.chair);
    for (const pid of list) if (!out.includes(pid)) out.push(pid);
    return out;
  }

  function memberAngles(grp) {
    const map = new Map();
    orderedMembers(grp).slice(0, RING_ANGLES.length)
      .forEach((pid, i) => map.set(pid, RING_ANGLES[i]));
    return map;
  }

  function memberAngle(grp, pid) {
    const a = memberAngles(grp).get(pid);
    return a == null ? 0 : a;
  }

  function buildMemberLayer(grp) {
    const layer = M.memberLayer;
    layer.replaceChildren();
    M.memberEls.clear();
    M.moreEl = null;
    M.memberGrp = grp || null;
    if (!grp) return;
    const ordered = orderedMembers(grp);
    for (const pid of ordered.slice(0, RING_ANGLES.length)) {
      const el = document.createElement('div');
      el.className = 'group-member';
      const p = person(pid);
      const img = document.createElement('img');
      setAvatar(img, p.avatar);
      img.alt = '';
      el.appendChild(img);
      if (grp.chair === pid) {
        const c = document.createElement('span');
        c.className = 'gm-chair';
        el.appendChild(c);
      }
      if (p.openteam) {
        const ring = document.createElement('span');
        ring.className = 'gm-ot';
        const badge = document.createElement('span');
        badge.className = 'gm-ot-badge';
        badge.textContent = 'OT';
        el.appendChild(ring);
        el.appendChild(badge);
      }
      layer.appendChild(el);
      M.memberEls.set(pid, el);
    }
    const extra = ordered.length - RING_ANGLES.length;
    if (extra > 0) {
      const el = document.createElement('div');
      el.className = 'group-member gm-more';
      el.textContent = `+${extra}`;
      layer.appendChild(el);
      M.moreEl = el;
    }
  }

  /* keep the DOM member layer in sync with the hero group */
  function syncMemberLayer() {
    const grp = heroGroup();
    if (grp && M.memberGrp !== grp) {
      buildMemberLayer(grp);
      layoutMembers();
    }
  }

  function clearMemberLayer() {
    M.memberLayer.replaceChildren();
    M.memberEls.clear();
    M.moreEl = null;
    M.memberGrp = null;
  }

  function layoutMembers() {
    const grp = M.memberGrp;
    M.layoutCount += 1;
    M.membersDirty = false;
    if (!grp) return;
    M.rx = ringRx();
    const angles = memberAngles(grp);
    const a = M.ringA;
    for (const [pid, el] of M.memberEls) {
      const th = angles.get(pid);
      if (th == null) { el.style.opacity = '0'; continue; }
      const p = ringPt(th);
      const back = Math.sin(th) < 0;
      const size = back ? 20 : 26;
      el.dataset.side = back ? 'back' : 'front';
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.left = `${p.x - size / 2}px`;
      el.style.top = `${p.y - size / 2}px`;
      let op = (back ? 0.6 : 1) * a;
      // copy-column protection: fade members entering the left 30%
      if (p.x < 0.34 * W) op = Math.max(0, op - 0.5);
      el.style.opacity = String(op);
    }
    if (M.moreEl) {
      const p = ringPt(MORE_ANGLE);
      M.moreEl.dataset.side = 'front';
      M.moreEl.style.left = `${p.x - 9}px`;
      M.moreEl.style.top = `${p.y - 9}px`;
      M.moreEl.style.opacity = String(0.9 * a);
    }
  }

  function drawGroupRing(gBack, gFront, dt, t, fx) {
    const grp = M.memberGrp;
    if (!grp || M.ringA <= 0.001) return;
    const m = fx.aMul * M.ringA;
    M.rx = ringRx();
    const h = fx.slate ? '148,163,184' : CYAN;
    const hi = fx.slate ? '148,163,184' : CYAN_HI;
    M.ringSpin += dt * ((25 * Math.PI) / 180);

    // base ellipse: back half → back canvas, front half → front canvas
    drawRingHalf(gBack, true, 0.16, h, m);
    drawRingHalf(gFront, false, 0.22, h, m);

    // ambient 40° highlight flowing along the front half
    const head = M.ringSpin % (Math.PI * 2);
    drawRingArc(gFront, head, head + (40 * Math.PI) / 180, hi, 0.35, m);

    // chair dot: on orb top edge when twin chairs
    if (grp.chair === 'twin') {
      const o = M.env.O;
      gFront.fillStyle = LS.rgba(AMBER, 0.85 * m);
      gFront.beginPath();
      gFront.arc(o.x, o.y - R - 7, 1.5, 0, Math.PI * 2);
      gFront.fill();
    }

    // posting/incoming sweeps only while this group is the live hero
    const live = heroGroup() === grp;
    const isPosting = live && grp.status === 'posting';
    const isIncoming = live && grp.status === 'incoming';
    if ((isPosting || isIncoming) && M.ringSweep.t0 < 0) {
      M.ringSweep.t0 = t;
      M.ringSweep.senderAngle = isIncoming ? memberAngle(grp, grp.sender) : Math.PI / 2;
      M.ringSweep.done = false;
      if (isPosting) {
        const bp = ringPt(Math.PI / 2);
        const pos = M.env.chainApi && M.env.chainApi.flashNearest(bp.x, bp.y);
        if (pos) M.ringSweep.drop = { from: bp, to: pos, t0: t };
      }
    }
    if (!isPosting && !isIncoming) {
      M.ringSweep.t0 = -9;
      M.ringSweep.drop = null;
    }
    if (M.ringSweep.t0 >= 0) {
      const e = t - M.ringSweep.t0;
      const from = M.ringSweep.senderAngle;
      const sweep = e * ((160 * Math.PI) / 180);
      if (e < 2) {
        drawRingArc(gFront, from, from + sweep, hi, 0.4, m);
        drawRingArc(gFront, from, from - sweep, hi, 0.4, m);
        // member pulses
        for (const pid of groupMembers(grp)) {
          const a = memberAngle(grp, pid);
          let d = Math.abs(a - from);
          d = Math.min(d, Math.PI * 2 - d);
          const el = M.memberEls.get(pid);
          if (el) el.dataset.lit = sweep >= d && e < 1.6 ? '1' : '0';
        }
      } else {
        for (const el of M.memberEls.values()) el.dataset.lit = '0';
      }
      // dotted drop line (posting) to the chain block
      if (M.ringSweep.drop && e < 0.9) {
        const d = M.ringSweep.drop;
        gFront.save();
        gFront.setLineDash([2, 4]);
        gFront.strokeStyle = LS.rgba(hi, 0.25 * (1 - e / 0.9) * m);
        gFront.beginPath();
        gFront.moveTo(d.from.x, d.from.y);
        gFront.lineTo(d.to.x, d.to.y);
        gFront.stroke();
        gFront.restore();
      }
      // incoming: glint from sender to orb
      if (isIncoming && !M.ringSweep.done && e > 0.4) {
        const ge = LS.clamp((e - 0.4) / 0.8, 0, 1);
        const sp = ringPt(from);
        const o = M.env.O;
        const dd = Math.hypot(sp.x - o.x, sp.y - o.y) || 1;
        const edge = { x: o.x + ((sp.x - o.x) / dd) * R, y: o.y + ((sp.y - o.y) / dd) * R };
        const ctrl = { x: (sp.x + edge.x) / 2, y: Math.min(sp.y, edge.y) - 40 };
        const pt = LS.quad(sp, ctrl, edge, LS.easeInOutCubic(ge));
        gFront.save();
        gFront.globalCompositeOperation = 'lighter';
        gFront.shadowColor = LS.rgba(hi, 0.8 * m);
        gFront.shadowBlur = 7;
        gFront.fillStyle = LS.rgba(hi, 0.7 * m);
        gFront.beginPath();
        gFront.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2);
        gFront.fill();
        gFront.restore();
        if (ge >= 1) {
          M.ringSweep.done = true;
          M.env.emit('inhale');
        }
      }
    }
  }

  /* ------------------------------- public ------------------------------- */
  LS.companions = {
    init(env) {
      M.env = env;
      M.rail = document.querySelector('[data-companion-rail]');
      M.memberLayer = document.querySelector('[data-group-members]');
    },
    apply(spec) {
      const prev = { ...M.spec };
      M.spec = spec && Object.keys(spec).length ? spec : { workers: [], peers: [], groups: [] };
      M.hero = M.spec.hero || null;
      M.fadeT = M.t;
      M.peerCycle = { t0: -9, dropped: false, leanAt: -9, dropAt: -9, drop: null };
      M.ringSweep = { t0: -9, senderAngle: null, done: false };
      buildRail();
      syncMemberLayer();
      layoutMembers();
      return prev;
    },
    setLanguage(l) {
      M.lang = l;
      buildRail();
      layoutMembers();
    },
    hero() { return M.hero; },
    relayout() {
      // the rail's % max-height tracks the stage — refit when it could change
      if (M.rail) {
        const cand = railCandidates();
        const total = cand.length;
        if (railFitCap(railCountCap(total), cand, total) !== M.lastCap) buildRail();
      }
      layoutMembers();
    },
    setDensity(d) { if (d === M.density) return; M.density = d; M.membersDirty = true; buildRail(); },
    hasItems() { return M.shown > 0; },
    groupActive() { return Boolean(M.memberGrp); },
    /* true when members need a per-frame re-layout: a rebuild is pending or
       the ring fade still animates member opacity */
    needsLayout() {
      if (M.membersDirty) return true;
      return Boolean(M.memberGrp) && M.ringA > 0 && M.ringA < 1;
    },
    _layoutCount() { return M.layoutCount; },
    /* verification hook: distance of the hero peer arc's start from the orb edge */
    _peerArcStart() {
      if (!M.hero || M.hero.type !== 'peers') return null;
      const el = M.items.get(`peers:${M.hero.id}`);
      if (!el) return null;
      const arc = peerArc(avatarAnchor(el));
      const o = M.env.O;
      const d = Math.hypot(arc.from.x - o.x, arc.from.y - o.y);
      return { x: arc.from.x, y: arc.from.y, d, edge: d - R };
    },
    /* called by the engine once per frame with both companion canvases.
       t = real clock (original-speed worker curves, DOM-facing fades);
       ts = scene clock slowed by SCENE_TIME_SCALE (peer capsule, ring flow). */
    draw(gBack, gFront, dt, t, ts, fx) {
      M.t = t;
      syncMemberLayer();
      // ring + members fade over 400ms when the hero gains/leaves a group
      if (dt === 0) M.ringA = heroGroup() ? 1 : 0;
      else M.ringA = LS.clamp(M.ringA + (heroGroup() ? dt / 0.4 : -dt / 0.4), 0, 1);
      if (!heroGroup() && M.ringA <= 0 && M.memberGrp) clearMemberLayer();
      const reduced = M.env.reduced ? M.env.reduced() : false;
      drawGroupRing(gBack, gFront, dt * LS.SCENE_TIME_SCALE, ts, fx);
      (M.spec.workers || []).forEach((c, i) => {
        const el = M.items.get(`workers:${c.who}`);
        if (!el) return;
        drawWorker(gFront, el, c.status, fx, t, i, reduced);
      });
      for (const c of M.spec.peers || []) {
        const el = M.items.get(`peers:${c.who}`);
        if (!el) continue;
        const hero = M.hero && M.hero.type === 'peers' && M.hero.id === c.who;
        drawPeer(gFront, el, c.status, hero, fx, ts, dt);
      }
    },
    layoutMembers,
  };
})();

/* ============================ scene engine ============================
   Owns the single rAF loop, the place crossfade/reveal engine, companion
   spec building from LiveStageState, transients and the verification
   overlay. stage.js drives it via IDBotsLiveStageScenes.update(state)
   from applyState() and supplies frame hooks via init(opts). */
(() => {
  const LS = window.LS;
  const perfNow = () => performance.now() / 1000;

  /* mind and machine share one persistent particle field — phase stays
     continuous across mind↔machine family moves (owner feedback 2026-11-18). */
  const PLACE_KEYS = { mind: 'particles', machine: 'particles', web: 'web-a', chain: 'chain-a' };
  const PLACE_GLOW = { mind: '#956CFF', machine: '#956CFF', web: '#6FA0FF', chain: '#46D6E6' };
  const FAMILY_MOTIF = {
    received: 'received', reasoning: 'reasoning', 'local-recall': 'recall',
    speaking: 'speaking', idle: 'idle', 'report-ready': 'settle', complete: 'still',
    'local-run': 'run', 'local-read': 'read', making: 'write',
    'desktop-control': 'desktop', 'browser-action': 'screen', projecting: 'project',
    delegation: 'workers', 'worker-report': 'workers',
    'web2-research': 'search', 'web-read': 'read',
    'metaweb-research': 'read', 'chain-write': 'write', 'chain-transfer': 'transfer',
    'private-chat': 'private', 'group-task': 'group',
  };
  const WAITING_MOTIF = { machine: 'workers', chain: 'private', web: 'search', mind: 'idle' };
  const WORKER_STATUS = new Set(['dispatch', 'working', 'waiting', 'return', 'verifying']);
  const RESTING = new Set(['idle', 'complete', 'report-ready']);
  const VALID_AVATAR = LS.VALID_AVATAR;
  const TRANSIENT_MS = { steer: 2400, retry: 2400, 'model-switch': 2200, 'chain-confirmed': 1800, 'tool-error': 1600 };

  /* --------------------------- pure helpers --------------------------- */
  function resolveSceneModifiers(family) {
    switch (family) {
      case 'speaking': return { dim: 0.4, eventsPaused: true };
      case 'owner-needed': return { freeze: true, dim: 0.35 };
      case 'problem': return { slate: true, dim: 0.5, slow: 0.2 };
      case 'waiting': return { dim: 0.55 };
      default: return {};
    }
  }
  function itemId(type, c) { return type === 'groups' ? c.id : c.who; }
  function pickHero(focus, spec) {
    if (!focus || !spec) return null;
    const type = focus.type;
    const list = spec[type] || [];
    if (!list.length) return null;
    if (focus.id) {
      const found = list.find((c) => itemId(type, c) === focus.id);
      if (found) return { type, id: focus.id };
    }
    if (type === 'workers') {
      const hot = list.find((c) => c.status === 'dispatch' || c.status === 'return' || c.status === 'verifying');
      return { type, id: (hot || list[0]).who };
    }
    if (type === 'peers') {
      const hot = list.find((c) => c.status === 'sending' || c.status === 'incoming');
      return { type, id: (hot || list[0]).who };
    }
    return { type, id: list[0].id };
  }
  const STATUS_RANK = {
    dispatch: 0, return: 0, sending: 0, incoming: 0, posting: 0,
    working: 1, active: 1, verifying: 1,
    awaiting: 2, delivered: 2, waiting: 2,
  };
  function railOrder(spec, hero, max = 5) {
    const order = ['workers', 'peers', 'groups'];
    const total = order.reduce((n, t) => n + (spec[t] || []).length, 0);
    const cap = total > max ? max - 1 : max;
    const rank = (c) => STATUS_RANK[c.status] ?? 1;
    const isHero = (type, c) => Boolean(hero && hero.type === type && hero.id === itemId(type, c));
    const picked = new Set(order
      .flatMap((type) => (spec[type] || []).map((c) => ({ type, c })))
      .sort((a, b) => (isHero(b.type, b.c) - isHero(a.type, a.c)) || (rank(a.c) - rank(b.c)))
      .slice(0, cap)
      .map((entry) => entry.c));
    const sections = [];
    let shown = 0;
    for (const type of order) {
      const visible = [...(spec[type] || [])].sort((a, b) => rank(a) - rank(b)).filter((c) => picked.has(c));
      if (!visible.length) continue;
      sections.push({ type, items: visible });
      shown += visible.length;
    }
    return { sections, shown, more: total - shown };
  }
  /* Transient dedupe memory. The stage iframe is a persistent page (new
     sessions are adopted without reload), so this Set would otherwise grow
     for the page's whole lifetime. Capped LRU-style: insertion order evicts
     the oldest id past the cap. Beats older than 6s are dropped by the
     freshness check anyway, so a re-add of an evicted id can only replay a
     stale beat, never a live one. */
  var TRANSIENT_SEEN_CAP = 200;
  function shouldPlayTransient(seen, transient, nowMs) {
    if (!transient || typeof transient.id !== 'string' || !transient.id) return false;
    if (seen.has(transient.id)) return false;
    const at = typeof transient.at === 'number' ? transient.at : 0;
    if (at > 0 && nowMs - at >= 6000) return false;
    seen.add(transient.id);
    if (seen.size > TRANSIENT_SEEN_CAP) {
      seen.delete(seen.values().next().value);
    }
    return true;
  }
  function placeGlow(place) { return PLACE_GLOW[place] || PLACE_GLOW.mind; }
  /* pos(k, p) = headS − (k + p)·pitch — the slot-quantized front ribbon. */
  function chainSlotLayout(k, p, pitch, headS) { return headS - (k + p) * pitch; }
  /* Centres actually drawn on the front ribbon for cycle phase:
     'idle'     → pending slot 0 + blocks at slots 1..n
     'unfold'   → unfolding block at slot 0 (pending hidden) + blocks 1..n
     'shift'    → all n blocks (new one included) at pos(k, p), pending hidden
     'settled'  → pending at 0 fading in + blocks at slots 1..n            */
  function chainFrontSlots(n, p, phase, pitch, headS) {
    const slots = [];
    if (phase === 'idle' || phase === 'settled') slots.push({ kind: 'pending', s: chainSlotLayout(0, 0, pitch, headS) });
    if (phase === 'unfold') slots.push({ kind: 'unfolding', s: chainSlotLayout(0, 0, pitch, headS) });
    if (phase === 'shift') {
      for (let k = 0; k < n; k += 1) slots.push({ kind: 'block', s: chainSlotLayout(k, p, pitch, headS) });
    } else {
      for (let k = 1; k <= n; k += 1) slots.push({ kind: 'block', s: chainSlotLayout(k, 0, pitch, headS) });
    }
    return slots.sort((a, b) => b.s - a.s);
  }

  /* ------------------------------- state ------------------------------- */
  const S = {
    inited: false, opts: null, els: {},
    ctxs: {}, dpr: 1, W: 0, H: 0,
    O: { x: 0, y: 0 }, oAnim: null,
    placeCur: null, placePrev: null, placeSince: -9, queued: null,
    mods: {}, specKey: '', heroOn: false, lastFamily: '',
    verifyT0: -9, transSeen: new Set(), transFx: { active: null },
    dipUntil: -9, dipAmt: 0.6, slateUntil: -9,
    modEvents: { inhaleT: -9, compressT: -9, shimmerT: -9 },
    raf: 0, lastT: 0, disposed: false, frames: 0,
    density: 'full',
    /* tScene advances at SCENE_TIME_SCALE — the slowed clock for everything
       except particles, original worker curves, the orb and rail DOM. */
    tScene: 0,
  };

  const reduced = () => (S.opts && S.opts.reduced ? Boolean(S.opts.reduced()) : false);
  const cubicBezier = (x1, y1, x2, y2) => {
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
  };
  const O_EASE = cubicBezier(0.16, 1, 0.3, 1);

  /* ----------------------------- environment --------------------------- */
  const env = {
    get O() { return S.O; },
    rand: () => Math.random(),
    voice: () => (S.opts && S.opts.voice ? S.opts.voice() : 0),
    activity: () => (S.opts && S.opts.activity ? S.opts.activity() : 'resting'),
    family: () => (S.state ? S.state.family : 'idle'),
    hero: () => S.heroOn,
    energy: () => {
      const e = S.state && S.state.motion && S.state.motion.energy;
      return Number.isFinite(e) ? e : 0;
    },
    seed: () => {
      const s = S.state && S.state.motion && S.state.motion.seed;
      return Number.isFinite(s) ? s : 0;
    },
    reduced: () => reduced(),
    orbSpeed: () => (S.opts && S.opts.orbSpeed ? S.opts.orbSpeed() : 0.5),
    chainApi: null,
    reportPos() {
      const b = S.opts && S.opts.reportEl ? S.opts.reportEl : null;
      if (!b || b.hidden) return { x: S.W * 0.1, y: S.H * 0.92 };
      return { x: b.offsetLeft + b.offsetWidth / 2, y: b.offsetTop + b.offsetHeight / 2 };
    },
    emit(name, arg) {
      const now = S.tScene;
      if (name === 'inhale') S.modEvents.inhaleT = now;
      else if (name === 'compress') S.modEvents.compressT = now;
      else if (name === 'lean' && S.els.entity) {
        S.els.entity.style.translate = `${arg ? arg.x : 6}px 0`;
        setTimeout(() => { S.els.entity.style.translate = '0px 0'; }, (arg && arg.ms) || 500);
      }
    },
  };

  /* ------------------------------ geometry ------------------------------ */
  /* Visible ball radius from the live rect: the WebGPU/WebGL canvas draws the
     ball at .72 of its half-width (liquid-orb.js family `radius: .72`), while
     the CSS membrane fallback's own border IS the visible edge. */
  function orbRadiusFromRect(width, isOrbCanvas) {
    return Math.max(30, (width / 2) * (isOrbCanvas ? 0.72 : 1));
  }
  function measure() {
    const stage = S.els.stage;
    if (!stage) return;
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.W = stage.clientWidth || 1;
    S.H = stage.clientHeight || 1;
    const stageRect = stage.getBoundingClientRect();
    const orbCv = (S.els.entity || document).querySelector('.liquid-orb-canvas[data-active="true"]');
    const orbEl = orbCv || S.els.membrane;
    let r = 0;
    if (orbEl) {
      const rect = orbEl.getBoundingClientRect();
      r = orbRadiusFromRect(rect.width, Boolean(orbCv));
      if (!S.oAnim && rect.width > 4) {
        S.O.x = rect.left + rect.width / 2 - stageRect.left;
        S.O.y = rect.top + rect.height / 2 - stageRect.top;
      }
    }
    LS.W = S.W; LS.H = S.H; LS.R = r || Math.max(60, S.H * 0.1);
    LS.O_BASE.x = 0.67 * S.W; LS.O_BASE.y = 0.45 * S.H;
    for (const sync of LS.__geomSyncs) sync();
    for (const cv of [S.els.place, S.els.back, S.els.front]) {
      cv.width = Math.max(1, Math.round(S.W * S.dpr));
      cv.height = Math.max(1, Math.round(S.H * S.dpr));
      cv.getContext('2d').setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    }
    // statics baked at the old size are stale — rebuild the current place
    if (S.placeCur) {
      S.placeCur.inst.build();
      if (S.placeCur.inst.statics && S.placeCur.inst.statics.renderOff) S.placeCur.inst.statics.renderOff(S.dpr);
      if (S.placeCur.motif) S.placeCur.inst.setMotif(S.placeCur.motif);
    }
    applyDensityRank(widthDensity()); // conflict-driven drops re-derive in resolveHeroLayout
    LS.companions.relayout();
    if (S.heroOn) {
      const tx = resolveHeroLayout();
      if (tx != null) {
        if (S.els.entity) S.els.entity.style.left = `${tx}px`;
        S.O.x = tx;
      }
    }
  }

  /* Rail density is driven by the measured stage width (the stage runs in an
     iframe of variable size, so viewport media queries cannot cover this):
     full ≥1180, compact ≥900, mini below. A hero-vs-rail conflict can drop the
     density one level further (see resolveHeroLayout). */
  const DENSITIES = ['full', 'compact', 'mini'];
  const widthDensity = () => (S.W < 900 ? 2 : S.W < 1180 ? 1 : 0);
  const densityRank = () => DENSITIES.indexOf(S.density);
  function applyDensityRank(rank) {
    const d = DENSITIES[LS.clamp(rank, 0, 2)];
    if (d === S.density) return false;
    S.density = d;
    document.body.dataset.railDensity = d;
    if (LS.companions && LS.companions.setDensity) LS.companions.setDensity(d);
    return true;
  }

  function railLeftPx() {
    const rail = S.els.rail;
    if (!rail || rail.getAttribute('aria-hidden') !== 'false') return Infinity;
    const stageRect = S.els.stage.getBoundingClientRect();
    return rail.getBoundingClientRect().left - stageRect.left;
  }
  function copyRightPx() {
    const copy = S.els.copy;
    if (!copy) return 0;
    const stageRect = S.els.stage.getBoundingClientRect();
    return copy.getBoundingClientRect().right - stageRect.left;
  }
  /* Hero orb centre: disc right edge ≤ rail.left − 24, and never left of
     copyRight + 0.5r. With a group hero the ring (+ member chips) is the
     effective orb extent — the ring self-clamps at 1.2R minimum. */
  function heroTargetX() {
    const R = LS.R;
    const rEff = LS.companions.groupActive() ? 1.2 * R + 16 : R;
    const maxX = railLeftPx() - 24 - rEff;
    const minX = copyRightPx() + 0.5 * R;
    if (maxX < minX) return { x: (minX + maxX) / 2, blocked: true };
    return { x: LS.clamp(0.56 * S.W, minX, maxX), blocked: false };
  }
  /* When the two constraints cannot both hold, narrow the rail (drop a
     density level) and retry — the rail wins the space, the orb slides. */
  function resolveHeroLayout() {
    if (!S.heroOn) return null;
    let guard = 0;
    for (;;) {
      const t = heroTargetX();
      if (!t.blocked || densityRank() >= 2 || guard++ > 2) return t.x;
      applyDensityRank(densityRank() + 1);
    }
  }

  function setHero(on, now) {
    if (on === S.heroOn) return;
    S.heroOn = on;
    document.body.dataset.hero = on ? 'true' : 'false';
    if (!on) {
      applyDensityRank(widthDensity());
      if (S.els.entity) S.els.entity.style.left = '';
    }
    const tx = on ? resolveHeroLayout() : 0.67 * S.W;
    if (on && S.els.entity) S.els.entity.style.left = `${tx}px`;
    if (Math.abs(tx - S.O.x) > 0.5) S.oAnim = { from: { ...S.O }, to: { x: tx, y: 0.45 * S.H }, t0: now };
    if (reduced()) { S.O.x = tx; S.O.y = 0.45 * S.H; S.oAnim = null; }
    setTimeout(measure, 700); // correct O/R to the measured rect once CSS settles
  }
  function tickO(now) {
    if (!S.oAnim) return;
    const p = LS.clamp((now - S.oAnim.t0) / 0.6, 0, 1);
    const e = O_EASE(p);
    S.O.x = LS.lerp(S.oAnim.from.x, S.oAnim.to.x, e);
    S.O.y = LS.lerp(S.oAnim.from.y, S.oAnim.to.y, e);
    if (p >= 1) S.oAnim = null;
  }
  /* Connectors must follow the RENDERED ball, not the last measured snapshot:
     .core-entity's left transitions (hero slide, window resize) and the family
     lift translate .membrane-wrap continuously, so re-sync the orb centre and
     visible radius from the live rect every frame. Two getBoundingClientRect
     reads per frame; layout stays clean because the orb animates through
     compositor transforms, so this stays cheap. */
  function syncOrb() {
    const root = S.els.entity;
    if (!root) return;
    const orbCv = root.querySelector('.liquid-orb-canvas[data-active="true"]');
    const orbEl = orbCv || S.els.membrane;
    if (!orbEl) return;
    const rect = orbEl.getBoundingClientRect();
    if (rect.width < 4 || !S.els.stage) return;
    const stageRect = S.els.stage.getBoundingClientRect();
    S.O.x = rect.left + rect.width / 2 - stageRect.left;
    S.O.y = rect.top + rect.height / 2 - stageRect.top;
    const r = orbRadiusFromRect(rect.width, Boolean(orbCv));
    if (Math.abs(r - LS.R) > 0.25) {
      LS.R = r;
      for (const sync of LS.__geomSyncs) sync();
    }
  }

  /* ------------------------------ spec build ---------------------------- */
  function buildSpec(state) {
    const people = {};
    people.twin = { id: 'twin', name: state.botName || 'Twin', avatar: typeof state.botAvatar === 'string' && VALID_AVATAR.test(state.botAvatar) ? state.botAvatar : '' };
    const rawWorkers = Array.isArray(state.activeWorkers) ? state.activeWorkers : [];
    const resting = RESTING.has(state.family);
    const workers = [];
    for (const w of rawWorkers) {
      const dir = WORKER_STATUS.has(w.direction) ? w.direction : 'working';
      if (resting && dir === 'return') continue;
      const status = state.family === 'waiting' && dir === 'working' ? 'waiting' : dir;
      const who = String(w.id || w.name || 'w');
      people[who] = { id: who, name: w.name || who, avatar: VALID_AVATAR.test(w.avatar || '') ? w.avatar : '', task: w.title || '' };
      workers.push({ who, status });
    }
    const peers = [];
    for (const p of Array.isArray(state.activePeers) ? state.activePeers : []) {
      const who = String(p.id || p.name || 'p');
      people[who] = { id: who, name: p.name || who, avatar: VALID_AVATAR.test(p.avatar || '') ? p.avatar : '', last: p.preview || '' };
      peers.push({ who, status: p.status || 'open' });
    }
    const groups = [];
    for (const g of Array.isArray(state.activeGroups) ? state.activeGroups : []) {
      const members = [];
      let chair = null;
      for (const m of Array.isArray(g.members) ? g.members : []) {
        const pid = m.self ? 'twin' : String(m.id || m.name || 'm');
        if (!m.self) people[pid] = { id: pid, name: m.name || pid, avatar: VALID_AVATAR.test(m.avatar || '') ? m.avatar : '', openteam: m.openteam === true };
        else people.twin.openteam = false;
        members.push(pid);
        if (m.role === 'chair') chair = pid;
      }
      groups.push({
        id: String(g.id || 'g'), title: g.title || '', status: g.status || 'active',
        members, chair, memberCount: typeof g.memberCount === 'number' ? g.memberCount : members.length,
      });
    }
    const spec = { workers, peers, groups };
    spec.hero = pickHero(state.companionFocus, spec);
    spec.people = people;
    return spec;
  }

  /* ------------------------------ place engine --------------------------- */
  function motifFor(family, base) {
    if (family === 'waiting') return WAITING_MOTIF[base] || 'workers';
    if (family === 'verification' || family === 'owner-needed' || family === 'problem') return null;
    return FAMILY_MOTIF[family] || null;
  }

  function copyMask(x) { return 0.15 + 0.85 * LS.smoothstep(0.3 * S.W, 0.55 * S.W, x); }

  function ensurePlace(target, motif, now) {
    const key = PLACE_KEYS[target] || 'mind';
    if (S.placeCur && S.placeCur.key === key) {
      if (motif) { S.placeCur.inst.setMotif(motif); S.placeCur.motif = motif; }
      S.placeCur.base = target;
      return;
    }
    if (S.placeCur && now - S.placeSince < 1.2) { S.queued = { target, motif }; return; }
    const inst = LS.placeFactories[key](env);
    inst.build();
    if (inst.statics && inst.statics.renderOff) inst.statics.renderOff(S.dpr);
    if (motif) inst.setMotif(motif);
    if (S.placeCur) S.placePrev = { ...S.placeCur, fadeT0: now };
    S.placeCur = { key, base: target, motif, inst, mods: { ...S.mods }, revealT0: reduced() ? now - 2 : now };
    S.placeSince = now;
  }

  function fxFor(entry, now) {
    /* reveal/crossfade durations are scene animations → slowed by 1/0.6 */
    const e = (now - entry.revealT0) * 1000 * LS.SCENE_TIME_SCALE;
    const mods = entry.mods || {};
    const dip = S.tScene < S.dipUntil ? S.dipAmt : 1;
    const aMul = (mods.dim != null ? mods.dim : 1) * dip;
    const revealDone = e > 1400;
    return {
      aMul,
      slate: Boolean(mods.slate) || S.tScene < S.slateUntil,
      freeze: Boolean(mods.freeze) || Boolean(mods.eventsPaused),
      slow: mods.slow || 1,
      revealDone,
      forceElements: !revealDone,
      elA: (x, y, d) => {
        const dist = d != null ? d : Math.hypot(x - S.O.x, y - S.O.y);
        const rv = revealDone ? 1 : LS.clamp((e - dist / 1.2) / 300, 0, 1);
        return aMul * copyMask(x) * rv;
      },
      /* Mask-free alpha for the particle field: place fade/reveal only. The
         original field was never dimmed by the copy column or the vignette,
         so far-left particles drift over the text at their normal alpha. */
      elAFree: (x, y, d) => {
        const dist = d != null ? d : Math.hypot(x - S.O.x, y - S.O.y);
        const rv = revealDone ? 1 : LS.clamp((e - dist / 1.2) / 300, 0, 1);
        return aMul * rv;
      },
    };
  }

  /* The particle field and original worker curves run at original speed;
     every other place clock is slowed by SCENE_TIME_SCALE. */
  const placeDt = (entry, dt) => (entry.key === 'particles' ? dt : dt * LS.SCENE_TIME_SCALE);
  function drawPlaces(g, dt, now) {
    if (S.placePrev) {
      const fe = (now - S.placePrev.fadeT0) * 1000 * LS.SCENE_TIME_SCALE;
      if (fe > 900) S.placePrev = null;
      else {
        const fx = fxFor(S.placePrev, now);
        fx.aMul *= 1 - fe / 900;
        S.placePrev.inst.draw(g, placeDt(S.placePrev, dt), now, fx);
      }
    }
    if (S.placeCur) S.placeCur.inst.draw(g, placeDt(S.placeCur, dt), now, fxFor(S.placeCur, now));
    /* The particle field keeps the original un-vignetted look; the edge
       vignette only shades the web/chain places. */
    if (S.placeCur && S.placeCur.key !== 'particles') {
      const grad = g.createRadialGradient(S.O.x, S.O.y, LS.R * 0.8, S.O.x, S.O.y, S.W * 0.62);
      grad.addColorStop(0, 'rgba(7,12,24,0)');
      grad.addColorStop(1, 'rgba(7,12,24,.28)');
      g.fillStyle = grad;
      g.fillRect(0, 0, S.W, S.H);
    }
  }

  /* ------------------------------ transients ----------------------------- */
  function trigger(transient) {
    const now = S.tScene;
    S.transFx.active = { kind: transient.kind, t0: now };
    const chip = S.els.chip;
    if (chip) {
      chip.hidden = false;
      chip.textContent = transient.label || transient.kind || '';
      chip.style.left = `${S.O.x - LS.R}px`;
      chip.style.top = `${S.O.y + LS.R + 28}px`;
      chip.classList.remove('is-out');
      requestAnimationFrame(() => chip.classList.add('is-in'));
    }
    if (transient.kind === 'retry') { S.dipUntil = now + 0.6; S.dipAmt = 0.6; }
    if (transient.kind === 'tool-error') S.slateUntil = now + 0.4;
    if (transient.kind === 'model-switch') S.modEvents.shimmerT = now;
    if (transient.kind === 'steer') env.emit('inhale');
  }

  function drawTransients(g, ts) {
    const a = S.transFx.active;
    if (!a) return;
    const e = (ts - a.t0) * 1000;
    const ms = TRANSIENT_MS[a.kind] || 2000;
    if (e > ms) {
      S.transFx.active = null;
      const chip = S.els.chip;
      if (chip) {
        chip.classList.add('is-out');
        setTimeout(() => { if (!S.transFx.active) chip.hidden = true; }, 240);
      }
      return;
    }
    const R = LS.R, O = S.O;
    const gold = '255,220,81', hi = '190,250,255';
    if (a.kind === 'steer') {
      const from = { x: 0.3 * S.W, y: O.y };
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
    } else if (a.kind === 'retry') {
      const p = LS.clamp(e / 1200, 0, 1);
      g.save();
      g.translate(O.x, O.y);
      g.rotate(p * Math.PI * 2);
      g.setLineDash([6, 8]);
      g.strokeStyle = LS.rgba(gold, 0.35 * (1 - p * 0.6));
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(0, 0, R * 1.18, 0, Math.PI * 2); g.stroke();
      g.restore();
    } else if (a.kind === 'chain-confirmed') {
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
    // model-switch / tool-error / retry dip ride the fx + modulation channels
  }

  /* ------------------------- verification overlay ------------------------ */
  function drawVerification(g, ts) {
    if (!S.state || S.state.family !== 'verification' || S.verifyT0 < 0) return;
    const e = ts - S.verifyT0;
    const gold = '255,220,81';
    const rr = 1.22 * LS.R;
    const O = S.O;
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

  /* ------------------------------- frame --------------------------------- */
  function drawFrame(now, dt) {
    S.frames += 1;
    S.tScene += dt * LS.SCENE_TIME_SCALE;
    tickO(now);
    syncOrb();
    if (S.opts && S.opts.onFrame) S.opts.onFrame(performance.now());
    const W = S.W, H = S.H;
    S.ctxs.place.clearRect(0, 0, W, H);
    S.ctxs.back.clearRect(0, 0, W, H);
    S.ctxs.front.clearRect(0, 0, W, H);
    drawPlaces(S.ctxs.place, dt, now);
    if (S.oAnim || LS.companions.needsLayout()) LS.companions.layoutMembers();
    /* Scenic modifiers (dim/freeze/slate from family) stay on web/chain —
       the particle place behaves exactly like the original renderer. */
    const scenic = S.placeCur && (S.placeCur.base === 'web' || S.placeCur.base === 'chain');
    const slate = (Boolean(S.mods.slate) && scenic) || S.tScene < S.slateUntil;
    LS.companions.draw(S.ctxs.back, S.ctxs.front, dt, now, S.tScene, { aMul: 1, slate });
    drawVerification(S.ctxs.front, S.tScene);
    drawTransients(S.ctxs.front, S.tScene);
  }

  function loop(ts) {
    S.raf = 0;
    const now = ts / 1000;
    const dt = Math.min(0.08, S.lastT ? now - S.lastT : 0.016);
    S.lastT = now;
    drawFrame(now, dt);
    if (!document.hidden && !reduced()) S.raf = requestAnimationFrame(loop);
  }
  function ensureLoop() {
    if (S.disposed) return;
    if (reduced() || document.hidden) {
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
      drawFrame(perfNow(), 0);
      return;
    }
    if (!S.raf) S.raf = requestAnimationFrame(loop);
  }

  /* ------------------------------- update -------------------------------- */
  function update(state) {
    if (!S.inited || !state) return;
    const now = perfNow();
    S.state = state;
    S.mods = resolveSceneModifiers(state.family);
    LS.companions.setLanguage(state.language === 'zh' ? 'zh' : 'en');
    const spec = buildSpec(state);
    LS.catalog = { people: spec.people };
    const key = JSON.stringify([
      spec.workers.map((w) => [w.who, w.status]),
      spec.peers.map((p) => [p.who, p.status]),
      spec.groups.map((g) => [g.id, g.status, g.memberCount]),
      spec.hero,
    ]);
    if (key !== S.specKey) {
      S.specKey = key;
      LS.companions.apply({ workers: spec.workers, peers: spec.peers, groups: spec.groups, hero: spec.hero });
    }
    setHero(Boolean(spec.hero), now);
    if (S.heroOn) {
      const tx = resolveHeroLayout();
      if (tx != null && Math.abs(tx - S.O.x) > 0.5) {
        S.oAnim = { from: { ...S.O }, to: { x: tx, y: 0.45 * S.H }, t0: now };
        if (S.els.entity) S.els.entity.style.left = `${tx}px`;
      }
    }
    const target = state.place && PLACE_KEYS[state.place] ? state.place : 'mind';
    ensurePlace(target, motifFor(state.family, target), now);
    if (S.placeCur) {
      const scenic = S.placeCur.base === 'web' || S.placeCur.base === 'chain';
      S.placeCur.mods = scenic ? { ...S.mods } : {};
    }
    if (state.family === 'verification' && S.lastFamily !== 'verification') S.verifyT0 = S.tScene;
    if (shouldPlayTransient(S.transSeen, state.transient, Date.now())) trigger(state.transient);
    const glowBase = S.placeCur ? S.placeCur.base : target;
    const glow = state.family === 'owner-needed' ? '#FFD27A'
      : state.family === 'problem' ? '#FF8A7A'
        : placeGlow(glowBase);
    if (S.opts && S.opts.orbTint) S.opts.orbTint(glow);
    const parts = S.els.participants;
    if (parts) parts.hidden = spec.workers.length + spec.peers.length + spec.groups.length > 0;
    S.lastFamily = state.family;
    ensureLoop();
  }

  /* -------------------------------- init --------------------------------- */
  function init(opts) {
    S.opts = opts || {};
    S.els.stage = document.querySelector('.live-stage');
    S.els.place = document.querySelector('.core-canvas');
    S.els.back = document.querySelector('[data-companion-back]');
    S.els.front = document.querySelector('[data-companion-front]');
    S.els.entity = document.querySelector('.core-entity');
    S.els.membrane = document.querySelector('.membrane');
    S.els.chip = document.querySelector('[data-transient-chip]');
    S.els.participants = document.querySelector('[data-core-participants]');
    S.els.rail = document.querySelector('[data-companion-rail]');
    S.els.copy = document.querySelector('.core-copy');
    for (const [k, el] of [['place', S.els.place], ['back', S.els.back], ['front', S.els.front]]) {
      S.ctxs[k] = el.getContext('2d');
    }
    measure();
    LS.companions.init(env);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { S.lastT = 0; ensureLoop(); }
    });
    S.inited = true;
    ensureLoop();
  }

  window.IDBotsLiveStageScenes = {
    init,
    update,
    relayout() { measure(); if (reduced()) drawFrame(perfNow(), 0); },
    dispose() { S.disposed = true; cancelAnimationFrame(S.raf); S.raf = 0; },
    /* Extra orb-modulation deltas from transient envelopes (inhale /
       compress / shimmer), merged by stage.js into its text modulation. */
    modulationDelta(nowMs) {
      const now = S.tScene;
      const d = { radius: 0, edgeGlow: 0, exposure: 0 };
      const ei = (now - S.modEvents.inhaleT) * 1000;
      if (ei >= 0 && ei < 400) d.radius += 0.012 * (1 - ei / 400);
      const ec = (now - S.modEvents.compressT) * 1000;
      if (ec >= 0 && ec < 480) {
        if (ec < 180) d.radius -= 0.03 * (ec / 180);
        else d.radius -= 0.03 * (1 - (ec - 180) / 300);
      }
      const es = (now - S.modEvents.shimmerT) * 1000;
      if (es >= 0 && es < 900) {
        const p = es / 900;
        d.exposure += p < 0.5 ? LS.lerp(-0.18, 0.12, p * 2) : LS.lerp(0.12, 0, (p - 0.5) * 2);
        d.edgeGlow += 0.08 * Math.sin(Math.PI * p);
      }
      return d;
    },
    debug() {
      return {
        place: S.placeCur ? S.placeCur.base : null,
        motif: S.placeCur ? S.placeCur.motif || null : null,
        hero: LS.companions.hero(),
        dim: S.mods.dim != null ? S.mods.dim : 1,
        memberLayouts: LS.companions._layoutCount(),
        particle: S.placeCur && S.placeCur.inst.__sim
          ? { activity: S.placeCur.inst.__sim.clock.activity, phase: S.placeCur.inst.__sim.particles[0].phase }
          : null,
        railDensity: S.density,
        raf: Boolean(S.raf),
        frames: S.frames,
      };
    },
    __test: {
      chainSlotLayout, chainFrontSlots, resolveSceneModifiers, pickHero,
      railOrder, shouldPlayTransient, placeGlow, orbRadiusFromRect,
      placeFactories: () => LS.placeFactories,
      makePlace: (key, envOverride) => LS.placeFactories[key](envOverride || env),
      placeKeys: () => ({ ...PLACE_KEYS }),
      timeScale: () => LS.SCENE_TIME_SCALE,
      sceneTime: () => S.tScene,
    },
  };
})();
