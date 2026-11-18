/* Live Stage prototype — shared helpers + Mind place renderer.
   Place factories return { id, build(), setMotif(m), draw(g, dt, t, fx) }.
   fx = { aMul, slate, freeze, reduced, elA(x,y), revealDone }
   All drawing in logical stage coords (1280×760); ctx already has the DPR
   transform. Geometry is defined relative to O_BASE and drawn translated by
   (env.O − O_BASE) so it follows the orb's hero/no-hero position. */
(() => {
  const LS = (window.LS = window.LS || {});
  LS.W = 1280;
  LS.H = 760;
  LS.R = 122;
  LS.O_BASE = { x: LS.W * 0.67, y: LS.H * 0.45 };

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

  /* ============================= MIND — stars ============================= */
  LS.placeFactories.mind = (env) => {
    const { W, H, R } = LS;
    const violet = '197,169,255', cyan = '155,244,255';
    let motif = 'idle';
    let t = 0;
    const statics = LS.makeStatics(env);
    let far = [], mid = [], near = [];
    let ring = null;
    const flash = new Map();
    let synapses = [], synNext = 0;
    let constellation = null, constNext = 0;
    let settle = null; // {from:[{x,y}], t0}
    let drifters = [], driftNext = 0;
    /* settle arc: 220° of the orbit ellipse, concentrated toward the
       report button (lower-left of the orb, ~140°) */
    const ARC_C = (140 * Math.PI) / 180, ARC_SPAN = (220 * Math.PI) / 180;
    const settleAngle = (i, n) => {
      const u = n <= 1 ? 0.5 : i / (n - 1);           // 0..1
      const s = Math.sign(u - 0.5) * Math.pow(Math.abs(u - 0.5) * 2, 1.3) / 2;
      return ARC_C + s * ARC_SPAN;
    };
    let mul = 0.3, mulTarget = 0.3;

    function midPos(s, time) {
      const a = s.ang;
      const rad = motif === 'speaking'
        ? s.rad * (1 + 0.025 * env.voice() * Math.sin(3 * a + 4 * time))
        : s.rad;
      return {
        x: env.O.x + Math.cos(a) * rad * 1.1,
        y: env.O.y + Math.sin(a) * rad * 0.62,
      };
    }

    function activityMul() {
      const a = env.activity();
      return a === 'working' ? 1 : a === 'thinking' ? 1.15 : a === 'speaking' ? 0.6 : a === 'waiting' ? 0.5 : 0.45;
    }

    function build() {
      const rng = LS.mulberry32(101);
      far = []; mid = []; near = [];
      for (let i = 0; i < 140; i += 1) {
        far.push({ x: 0.25 * W + rng() * 0.8 * W, y: rng() * H, r: 0.4 + rng() * 0.5, a: 0.04 + rng() * 0.12, tw: rng() * 6.28, tws: 0.6 + rng() * 1.2 });
      }
      for (let i = 0; i < 46; i += 1) {
        mid.push({ ang: rng() * Math.PI * 2, rad: (1.05 + rng() * 2.15) * R, sp: 0.12 + rng() * 0.35, sz: 0.7 + rng() * 1.6, cyan: i % 7 === 0, born: -9 });
      }
      for (let i = 0; i < 7; i += 1) {
        near.push({ x: 0.3 * W + rng() * 0.72 * W, y: rng() * H, r: 3 + rng() * 3, a: 0.035 + rng() * 0.025, ph: rng() * 6.28 });
      }
    }

    function setMotif(m) {
      if (m === 'received' && motif !== 'received') ring = { t0: t };
      if (m === 'received') ring = { t0: t };
      motif = m;
      if (m === 'settle') {
        settle = { t0: t, from: mid.map((s) => midPos(s, t)) };
        drifters = [];
        driftNext = t + 1.4;
      } else {
        settle = null;
      }
      constellation = null;
      constNext = t + 1.6;
      synapses = [];
      synNext = t + 0.35;
      mulTarget = m === 'idle' ? 0.3 : m === 'reasoning' ? 1.75 : m === 'speaking' ? 0.6 : m === 'settle' || m === 'still' ? 0 : 1;
      if (m === 'still' || m === 'settle') mulTarget = 0;
    }

    function drawFar(g, fx, hue1, hue2) {
      const twMul = motif === 'reasoning' ? 1.6 : 1;
      for (let i = 0; i < far.length; i += 1) {
        const s = far[i];
        const dx = env.O.x - LS.O_BASE.x, dy = env.O.y - LS.O_BASE.y;
        const x = s.x + dx, y = s.y + dy;
        let m = fx.elA(x, y, Math.hypot(s.x - LS.O_BASE.x, s.y - LS.O_BASE.y));
        if (m <= 0.002) continue;
        let a = s.a * (1 + 0.4 * twMul * Math.sin(t * 1.3 * s.tws + s.tw));
        const f0 = flash.get(i);
        if (f0 != null) {
          const e = (t - f0) * 1000;
          if (e < 300) a += 0.35 * (1 - e / 300);
        }
        if (motif === 'still' || motif === 'settle') a *= 0.7;
        g.beginPath();
        g.fillStyle = LS.rgba(i % 9 === 0 ? hue2 : hue1, a * m);
        g.arc(x, y, s.r, 0, Math.PI * 2);
        g.fill();
      }
    }

    function draw(g, dt, tNow, fx) {
      const hue1 = fx.slate ? '148,163,184' : violet;
      const hue2 = fx.slate ? '148,163,184' : cyan;
      const sdt = fx.freeze ? 0 : dt * (fx.slow || 1);
      t += sdt;
      mul += (mulTarget - mul) * (1 - Math.exp(-sdt / 0.5));
      const energy = LS.clamp(env.orbSpeed(), 0.3, 1.2);
      const speed = mul * activityMul() * energy;

      // integrate mid orbiters
      if (sdt > 0 && !settle) {
        for (const s of mid) {
          s.ang += sdt * s.sp * speed;
          if (motif === 'recall') {
            s.rad -= 4 * sdt;
            if (s.rad < 1.0 * R) { s.rad = 3.2 * R; s.born = t; }
          }
        }
      }

      // bokeh discs
      for (const b of near) {
        const dx = env.O.x - LS.O_BASE.x, dy = env.O.y - LS.O_BASE.y;
        const x = b.x + dx + Math.sin(t * 0.31 + b.ph) * 20;
        const y = b.y + dy + Math.cos(t * 0.23 + b.ph * 1.7) * 20;
        const m = fx.elA(x, y, 0);
        if (m <= 0.002) continue;
        g.beginPath();
        g.fillStyle = LS.rgba(hue1, b.a * m);
        g.arc(x, y, b.r, 0, Math.PI * 2);
        g.fill();
      }

      drawFar(g, fx, hue1, hue2);

      // mid orbiters (or settled arc)
      for (let i = 0; i < mid.length; i += 1) {
        const s = mid[i];
        let p;
        if (settle) {
          const e = LS.clamp((t - settle.t0) / 0.8, 0, 1);
          const arc = settleAngle(i, mid.length);
          const tx = env.O.x + Math.cos(arc) * 190, ty = env.O.y + Math.sin(arc) * 125;
          p = { x: LS.lerp(settle.from[i].x, tx, LS.easeOutCubic(e)), y: LS.lerp(settle.from[i].y, ty, LS.easeOutCubic(e)) };
        } else {
          p = midPos(s, t);
        }
        let m = fx.elA(p.x, p.y, Math.hypot(p.x - env.O.x, p.y - env.O.y));
        if (m <= 0.002) continue;
        let a = 0.18 + (s.sz - 0.7) * 0.2;
        if (motif === 'idle') a *= 0.6;
        if (motif === 'settle' || motif === 'still') a = motif === 'settle' ? 0.18 : a * 0.7;
        if (t - s.born < 0.4) a *= (t - s.born) / 0.4;
        g.beginPath();
        g.fillStyle = LS.rgba(s.cyan ? hue2 : hue1, a * m);
        g.arc(p.x, p.y, s.sz, 0, Math.PI * 2);
        g.fill();
        s._px = p.x; s._py = p.y;
      }

      // settle drifters: 2–3 stars at a time leave the arc toward the
      // report button and fade, one launch every 2s
      if (motif === 'settle' && settle) {
        if (sdt > 0 && t >= driftNext && drifters.length < 3) {
          driftNext = t + 2;
          const rp = env.reportPos ? env.reportPos() : { x: 0.12 * W, y: 0.86 * H };
          const arcI = Math.floor(mid.length / 2 + (env.rand() - 0.5) * mid.length * 0.6);
          const a = settleAngle(LS.clamp(arcI, 0, mid.length - 1), mid.length);
          drifters.push({
            x0: env.O.x + Math.cos(a) * 190, y0: env.O.y + Math.sin(a) * 125,
            tx: rp.x, ty: rp.y, t0: t,
          });
        }
        for (const d of drifters) {
          const e = (t - d.t0) / 1.8;
          if (e >= 1) continue;
          const p = LS.easeInOutCubic(LS.clamp(e / 0.85, 0, 1));
          const x = LS.lerp(d.x0, d.tx, p * 0.9), y = LS.lerp(d.y0, d.ty, p * 0.9);
          g.beginPath();
          g.fillStyle = LS.rgba(hue1, 0.32 * (1 - e) * fx.aMul);
          g.arc(x, y, 1.5, 0, Math.PI * 2);
          g.fill();
        }
        drifters = drifters.filter((d) => t - d.t0 < 1.8);
      }

      // reasoning synapses
      if (motif === 'reasoning') {
        if (t >= synNext && synapses.length < 6 && sdt > 0) {
          synNext = t + 0.35;
          const i = Math.floor(env.rand() * mid.length);
          let best = -1, bd = 110;
          for (let j = 0; j < mid.length; j += 1) {
            if (j === i) continue;
            const d = Math.hypot(mid[j]._px - mid[i]._px, mid[j]._py - mid[i]._py);
            if (d < bd) { bd = d; best = j; }
          }
          if (best >= 0) synapses.push({ a: i, b: best, t0: t });
        }
        synapses = synapses.filter((sn) => t - sn.t0 < 1.2);
        for (const sn of synapses) {
          const e = (t - sn.t0) / 1.2;
          const a = 0.22 * Math.sin(Math.PI * e);
          const m = fx.elA(mid[sn.a]._px, mid[sn.a]._py, 0);
          g.beginPath();
          g.moveTo(mid[sn.a]._px, mid[sn.a]._py);
          g.lineTo(mid[sn.b]._px, mid[sn.b]._py);
          g.strokeStyle = LS.rgba(hue2, a * m);
          g.lineWidth = 0.6;
          g.stroke();
        }
      }

      // recall constellation → glint home
      if (motif === 'recall') {
        if (!constellation && t >= constNext && sdt > 0) {
          const seed = env.rand() * Math.PI * 2;
          // compact set: right of the copy column, one 50° sector, radius 1.4r–3r
          const cands = mid
            .filter((s) => {
              if (s._px < env.O.x - 0.6 * R) return false;
              const d = Math.hypot(s._px - env.O.x, s._py - env.O.y);
              if (d < 1.4 * R || d > 3 * R) return false;
              const a = Math.atan2(s._py - env.O.y, s._px - env.O.x);
              let dd = Math.abs(a - seed);
              if (dd > Math.PI) dd = 2 * Math.PI - dd;
              return dd < (50 * Math.PI) / 360;
            })
            .sort((a, b) => Math.atan2(a._py - env.O.y, a._px - env.O.x)
              - Math.atan2(b._py - env.O.y, b._px - env.O.x));
          // longest run of consecutive picks joined by ≤90px segments
          let best = [], run = [];
          for (const s of cands) {
            const prev = run[run.length - 1];
            if (!prev || Math.hypot(s._px - prev._px, s._py - prev._py) <= 90) run.push(s);
            else { if (run.length > best.length) best = run; run = [s]; }
          }
          if (run.length > best.length) best = run;
          const picks = best.slice(0, 4);
          if (picks.length >= 2) {
            constellation = { pts: picks.map((s) => ({ x: s._px, y: s._py })), t0: t };
            constNext = t + 1.6;
          } else constNext = t + 0.4;
        }
        if (constellation) {
          const c = constellation;
          const e = (t - c.t0) * 1000;
          const drawMs = 500, holdMs = 400, glintMs = 700, fadeMs = 600;
          const m = fx.elA(c.pts[0].x, c.pts[0].y, 0);
          if (e < drawMs + holdMs) {
            const p = LS.clamp(e / drawMs, 0, 1);
            const n = c.pts.length;
            const upto = p * (n - 1);
            g.beginPath();
            g.moveTo(c.pts[0].x, c.pts[0].y);
            for (let i = 1; i < n; i += 1) {
              if (i <= upto) g.lineTo(c.pts[i].x, c.pts[i].y);
              else if (i - 1 < upto) {
                const f = upto - (i - 1);
                g.lineTo(LS.lerp(c.pts[i - 1].x, c.pts[i].x, f), LS.lerp(c.pts[i - 1].y, c.pts[i].y, f));
                break;
              }
            }
            g.strokeStyle = LS.rgba(hue2, 0.5 * m);
            g.lineWidth = 0.8;
            g.stroke();
          } else {
            const glintT = e - drawMs - holdMs;
            const last = c.pts[c.pts.length - 1];
            const dxn = env.O.x - last.x, dyn = env.O.y - last.y;
            const dd = Math.hypot(dxn, dyn) || 1;
            const edge = { x: env.O.x - (dxn / dd) * R, y: env.O.y - (dyn / dd) * R };
            if (glintT < glintMs) {
              const p = LS.easeInOutCubic(glintT / glintMs);
              const gx = LS.lerp(last.x, edge.x, p), gy = LS.lerp(last.y, edge.y, p);
              const tx = LS.lerp(last.x, edge.x, Math.max(0, p - 0.25)), ty = LS.lerp(last.y, edge.y, Math.max(0, p - 0.25));
              g.save();
              g.globalCompositeOperation = 'lighter';
              const grad = g.createLinearGradient(tx, ty, gx, gy);
              grad.addColorStop(0, LS.rgba(hue2, 0));
              grad.addColorStop(1, LS.rgba(hue2, 0.6 * m));
              g.strokeStyle = grad;
              g.lineWidth = 2;
              g.beginPath(); g.moveTo(tx, ty); g.lineTo(gx, gy); g.stroke();
              g.restore();
            } else if (!c.inhaled) {
              c.inhaled = true;
              env.emit('inhale');
            }
            const fadeE = glintT / fadeMs;
            if (fadeE < 1) {
              g.beginPath();
              g.moveTo(c.pts[0].x, c.pts[0].y);
              for (let i = 1; i < c.pts.length; i += 1) g.lineTo(c.pts[i].x, c.pts[i].y);
              g.strokeStyle = LS.rgba(hue2, 0.5 * (1 - fadeE) * m);
              g.lineWidth = 0.8;
              g.stroke();
            } else constellation = null;
          }
        }
      }

      // received acknowledgement ring
      if (ring) {
        const e = (t - ring.t0) * 1000;
        if (e < 1100) {
          const p = LS.easeOutCubic(e / 1100);
          const rr = R * (1 + 2.4 * p);
          const m = fx.elA(env.O.x, env.O.y, 0);
          g.beginPath();
          g.strokeStyle = LS.rgba(hue2, 0.28 * (1 - p) * m);
          g.lineWidth = 1;
          g.arc(env.O.x, env.O.y, rr, 0, Math.PI * 2);
          g.stroke();
          for (let i = 0; i < far.length; i += 1) {
            const s = far[i];
            const d = Math.hypot(s.x - LS.O_BASE.x, s.y - LS.O_BASE.y);
            if (Math.abs(d - rr) < 10) flash.set(i, t);
          }
        } else ring = null;
      }
    }

    return {
      id: 'mind',
      build,
      setMotif,
      draw,
      statics,
    };
  };
})();
