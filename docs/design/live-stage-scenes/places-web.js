/* Live Stage prototype — Web place renderers.
   Variant A: irregular hyperlink mesh with hub "sites".
   Variant B: wire globe. Shared "page read" mechanics (scan band → dots home). */
(() => {
  const LS = window.LS;
  const { W, H, R } = LS;
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
      statics.draw(g, fx);
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
        g.fillStyle = LS.rgba(fxNode(), a * m);
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
          g.strokeStyle = LS.rgba(fxHit(), 0.12 * fade * m);
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
              g.strokeStyle = LS.rgba(fxHit(), 0.7 * fadeG * gm);
              g.lineWidth = 1;
              g.stroke();
              g.strokeStyle = LS.rgba(fxHit(), 0.5 * fadeG * gm);
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
                  grad.addColorStop(1, LS.rgba(fxHit(), 0.6 * gm));
                  g.strokeStyle = grad;
                  g.lineWidth = 2;
                  g.beginPath(); g.moveTo(tail.x, tail.y); g.lineTo(head.x, head.y); g.stroke();
                  g.shadowColor = LS.rgba(fxHit(), 0.8 * gm);
                  g.shadowBlur = 6;
                  g.fillStyle = LS.rgba(fxHit(), 0.7 * gm);
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
          const a = 0.3 * (1 - e / 500) * fx.aMul;
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
        reader.draw(g, fx, t, fxHit());
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

  /* ============================ Web B — wire globe ============================ */
  LS.placeFactories['web-b'] = (env) => {
    const statics = LS.makeStatics(env);
    let motif = 'search';
    let t = 0, rot = 0;
    const TILT = (18 * Math.PI) / 180;
    let C = { x: O.x + 0.16 * W, y: O.y + 0.2 * H };
    const Rg = 0.5 * H;
    let sites = [], arcs = [], arcNext = 0;
    const reader = makePageReader(env);
    let readStarted = false;

    function project(lat, lon, out) {
      const cl = Math.cos(lat), sl = Math.sin(lat);
      const x = Rg * cl * Math.cos(lon + rot);
      const y = Rg * sl;
      const z = Rg * cl * Math.sin(lon + rot);
      // tilt about z (screen) axis
      const xt = x * Math.cos(TILT) - y * Math.sin(TILT);
      const yt = x * Math.sin(TILT) + y * Math.cos(TILT);
      out.x = C.x + xt;
      out.y = C.y - yt;
      out.z = z;
      return out;
    }

    function build() {
      const rng = LS.mulberry32(404);
      sites = [];
      for (let i = 0; i < 24; i += 1) {
        sites.push({ lat: -1.2 + rng() * 2.4, lon: rng() * Math.PI * 2 });
      }
    }

    let fxHue = () => line;
    let fxHit = () => hit;

    function drawLines(g, fx) {
      const h = fxHue();
      const p = { x: 0, y: 0, z: 0 };
      const SEG = 64;
      // latitude rings
      for (let li = 0; li < 10; li += 1) {
        const lat = (-72 + li * 16) * (Math.PI / 180);
        let prev = null;
        for (let i = 0; i <= SEG; i += 1) {
          const th = (i / SEG) * Math.PI * 2;
          project(lat, th, p);
          if (prev) {
            const front = p.z > -10 && prev.z > -10;
            const m = fx.elA((p.x + prev.x) / 2, (p.y + prev.y) / 2, 0);
            if (m > 0.002) {
              g.strokeStyle = LS.rgba(h, (front ? 0.07 : 0.07 * 0.35) * m);
              g.lineWidth = 0.8;
              g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(p.x, p.y); g.stroke();
            }
          }
          prev = { x: p.x, y: p.y, z: p.z };
        }
      }
      // meridians
      for (let mi = 0; mi < 14; mi += 1) {
        const lon = (mi / 14) * Math.PI * 2;
        let prev = null;
        for (let i = 0; i <= SEG; i += 1) {
          const th = (i / SEG) * Math.PI * 2;
          project(th - Math.PI / 2, lon, p);
          if (prev) {
            const front = p.z > -10 && prev.z > -10;
            const m = fx.elA((p.x + prev.x) / 2, (p.y + prev.y) / 2, 0);
            if (m > 0.002) {
              g.strokeStyle = LS.rgba(h, (front ? 0.07 : 0.07 * 0.35) * m);
              g.lineWidth = 0.8;
              g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(p.x, p.y); g.stroke();
            }
          }
          prev = { x: p.x, y: p.y, z: p.z };
        }
      }
    }

    function frontSites() {
      const p = { x: 0, y: 0, z: 0 };
      const out = [];
      for (const s of sites) {
        project(s.lat, s.lon, p);
        if (p.z > 20) out.push({ x: p.x, y: p.y, site: s });
      }
      return out;
    }

    function draw(g, dt, tNow, fx) {
      fxHue = () => (fx.slate ? '148,163,184' : line);
      fxHit = () => (fx.slate ? '148,163,184' : hit);
      const sdt = fx.freeze ? 0 : dt * (fx.slow || 1);
      t += sdt;
      rot += sdt * ((4 * Math.PI) / 180);
      C = { x: env.O.x + 0.16 * W, y: env.O.y + 0.2 * H };
      drawLines(g, fx);
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      g.save();
      g.translate(dx, dy);
      // sites
      const front = frontSites();
      for (const s of front) {
        const m = fx.elA(s.x, s.y, 0);
        if (m <= 0.002) continue;
        g.fillStyle = LS.rgba(fxHit(), 0.25 * m);
        g.beginPath(); g.arc(s.x, s.y, 1.4, 0, Math.PI * 2); g.fill();
      }

      if (motif === 'search') {
        if (t >= arcNext && sdt > 0 && front.length >= 2) {
          arcNext = t + 1.4;
          const picks = [...front].sort(() => env.rand() - 0.5).slice(0, 2);
          for (const s of picks) {
            const d = Math.hypot(s.x - O.x, s.y - O.y) || 1;
            const from = { x: O.x + ((s.x - O.x) / d) * R, y: O.y + ((s.y - O.y) / d) * R };
            // control point pushed away from the globe centre → curved arc
            const mx = (from.x + s.x) / 2, my = (from.y + s.y) / 2;
            const cd = Math.hypot(mx - C.x, my - C.y) || 1;
            const lift = Math.min(120, d * 0.35);
            const mid = { x: mx + ((mx - C.x) / cd) * lift, y: my + ((my - C.y) / cd) * lift };
            arcs.push({ from, mid, to: { x: s.x, y: s.y }, t0: t });
          }
        }
        arcs = arcs.filter((a) => t - a.t0 < 2.4);
        for (const a of arcs) {
          const e = (t - a.t0) * 1000;
          const m = fx.elA(a.to.x, a.to.y, 0);
          const q = (u) => LS.quad(a.from, a.mid, a.to, u);
          if (e < 900) {
            const p = LS.easeOutCubic(e / 900);
            const lo = Math.max(0, p - 0.3);
            g.strokeStyle = LS.rgba(fxHit(), 0.5 * m);
            g.lineWidth = 1;
            g.beginPath();
            for (let i = 0; i <= 16; i += 1) {
              const u = lo + ((p - lo) * i) / 16;
              const pt = q(u);
              if (i === 0) g.moveTo(pt.x, pt.y); else g.lineTo(pt.x, pt.y);
            }
            g.stroke();
          } else if (e < 1400) {
            const pe = (e - 900) / 400;
            g.strokeStyle = LS.rgba(fxHit(), 0.5 * (1 - pe) * m);
            g.lineWidth = 1;
            g.beginPath(); g.arc(a.to.x, a.to.y, 2 + 8 * pe, 0, Math.PI * 2); g.stroke();
          } else if (e < 2100) {
            const p = 1 - LS.easeInOutCubic((e - 1400) / 700);
            const pt = q(LS.clamp(p, 0, 1));
            const ptTail = q(LS.clamp(p + 0.06, 0, 1));
            g.save();
            g.globalCompositeOperation = 'lighter';
            const grad = g.createLinearGradient(ptTail.x, ptTail.y, pt.x, pt.y);
            grad.addColorStop(0, LS.rgba(fxHit(), 0));
            grad.addColorStop(1, LS.rgba(fxHit(), 0.6 * m));
            g.strokeStyle = grad; g.lineWidth = 2;
            g.beginPath(); g.moveTo(ptTail.x, ptTail.y); g.lineTo(pt.x, pt.y); g.stroke();
            g.restore();
          } else if (!a.done) {
            a.done = true;
            env.emit('inhale');
          }
        }
      }

      if (motif === 'read') {
        if (!readStarted) {
          readStarted = true;
          const s = front[0] || { x: C.x, y: C.y };
          reader.start(s.x + 20, s.y - 40, t);
        }
        reader.draw(g, fx, t, fxHit());
      }
      g.restore();
    }

    return {
      id: 'web', variant: 'B',
      build,
      setMotif(m) {
        motif = m;
        if (m === 'read') readStarted = false;
        arcs = []; arcNext = t + 0.4;
      },
      draw,
      statics,
    };
  };
})();
