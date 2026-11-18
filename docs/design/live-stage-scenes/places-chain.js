/* Live Stage prototype — Chain place renderers.
   Variant A: block ribbon (front + back), hash links, pending head slot,
   read scan/pin, write packet→unfold→seal→ripple, transfer diamond.
   Variant B: flat-top hex lattice with BFS read path and write pulse. */
(() => {
  const LS = window.LS;
  const { W, H, R } = LS;
  const O = LS.O_BASE;
  const block = '96,226,236', glint = '190,250,255', seal = '255,220,81';

  /* ========================= Chain A — block ribbon ========================= */
  LS.placeFactories['chain-a'] = (env) => {
    let motif = 'read';
    let t = 0;
    let front = null, back = null;
    let blocks = [], backBlocks = [];
    let scroll = 0, backScroll = 0, shiftAnim = null;
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
      scroll = 0; backScroll = 0; shiftAnim = null; cycle = null;
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

    function drawWriteCycle(g, fx, m) {
      if (!cycle || (cycle.kind !== 'write' && cycle.kind !== 'transfer')) return;
      const isTransfer = cycle.kind === 'transfer';
      const e = (t - cycle.t0) * 1000;
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      const hG = isTransfer ? fxSeal() : fxGlint();
      const hp = front.pointAt(headS);
      const head = { x: hp.x + dx, y: hp.y + dy };
      // packet orb → pending head, 0–900ms
      if (e < 900) {
        const p = LS.easeInOutCubic(e / 900);
        const edge = { x: env.O.x + R * 0.7, y: env.O.y + R * 0.4 };
        const ctrl = { x: (edge.x + head.x) / 2, y: Math.max(edge.y, head.y) + 60 };
        const pt = LS.quad(edge, ctrl, head, p);
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.shadowColor = LS.rgba(hG, 0.8 * m);
        g.shadowBlur = 8;
        g.fillStyle = LS.rgba(hG, 0.8 * m);
        g.translate(pt.x, pt.y);
        if (isTransfer) {
          g.rotate(Math.PI / 4);
          g.fillRect(-5, -5, 10, 10);
        } else {
          LS.roundRect(g, -4.5, -4.5, 9, 9, 2);
          g.fill();
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
      // gold seal 1250–1950ms
      if (e >= 1250 && e < 2200) {
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
        blockDraw(g, front, headS, 30, { stroke: 0.13 * m, edge: 0.07 * m, hash: 0.07 * m }, fxHue(), 0);
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
      // ribbon shifts one slot 2400–3000ms; the unfolded block joins the chain
      if (e >= 2400 && !cycle.shifted) {
        cycle.shifted = true;
        shiftAnim = { t0: t, amt: 46 };
        blocks.unshift({ baseS: headS + scroll, s: headS });
      }
    }

    function drawRibbon(g, fx, m, dimMul) {
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
          stroke: (0.13 + boost * 0.42 + flash) * m * dimMul,
          edge: (0.07 + flash * 0.5) * m * dimMul,
          hash: (0.07 + boost * 0.23 + flash * 0.4) * m * dimMul,
        }, h, lift);
      }
      // pending head slot (dashed, breathing) at x = 0.90W
      const hp = front.pointAt(headS);
      const breathe = 0.7 + 0.3 * Math.sin(t * 2.6);
      g.setLineDash([3, 3]);
      LS.roundRect(g, hp.x - 15, hp.y - 15, 30, 30, 6);
      g.strokeStyle = LS.rgba(h, 0.18 * breathe * m * dimMul);
      g.lineWidth = 1;
      g.stroke();
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
        g.fillStyle = LS.rgba(fxGlint(), 0.25 * m * dimMul);
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
      const m = fx.aMul;
      // scroll
      scroll += sdt * 8;
      backScroll += sdt * 5;
      if (shiftAnim) {
        const p = LS.clamp((t - shiftAnim.t0) / 0.6, 0, 1);
        if (p >= 1) { scroll += shiftAnim.amt; shiftAnim = null; }
      }
      const shiftNow = shiftAnim ? shiftAnim.amt * LS.easeInOutCubic(LS.clamp((t - shiftAnim.t0) / 0.6, 0, 1)) : 0;
      // recycle: blocks that exit the tail re-enter at the head, keeping 46px pitch
      for (const b of blocks) {
        if (b.s < -46) b.baseS += 46 * blocks.length;
        b.s = b.baseS - scroll - shiftNow;
      }
      blocks.sort((a, b) => b.s - a.s);
      for (const b of backBlocks) {
        if (b.s < -30) b.baseS += 30 * backBlocks.length;
        b.s = b.baseS - backScroll;
      }
      drawRibbon(g, fx, m, dimMul);

      if (motif === 'read' || motif === 'write' || motif === 'transfer') {
        if (!cycle && t >= cycleNext && sdt > 0) { cycleNext = t + (motif === 'read' ? 2.4 : 3); newCycle(); }
        drawReadCycle(g, fx, m * dimMul);
        drawWriteCycle(g, fx, m * dimMul);
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

  /* ========================= Chain B — hex lattice ========================= */
  LS.placeFactories['chain-b'] = (env) => {
    const statics = LS.makeStatics(env);
    let motif = 'read';
    let t = 0;
    let cells = [], byKey = new Map(), nearOrb = null;
    let cycle = null, cycleNext = 0;
    let fxHue = () => block, fxGlint = () => glint, fxSeal = () => seal;
    const HEX = 20, SQ3 = Math.sqrt(3);
    const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

    function hexPath(g, x, y, r) {
      g.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const a = (i * 60 * Math.PI) / 180;
        if (i === 0) g.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
        else g.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
      }
      g.closePath();
    }

    function build() {
      const rng = LS.mulberry32(505);
      cells = []; byKey = new Map();
      const qMin = Math.floor((0.3 * W) / (1.5 * HEX));
      const qMax = Math.ceil(W / (1.5 * HEX));
      for (let q = qMin; q <= qMax; q += 1) {
        const x = 1.5 * HEX * q;
        const rMin = Math.floor(-q / 2 - 1);
        const rMax = Math.ceil(H / (SQ3 * HEX) - q / 2 + 1);
        for (let r = rMin; r <= rMax; r += 1) {
          const y = SQ3 * HEX * (r + q / 2);
          if (y < -HEX || y > H + HEX) continue;
          if (Math.hypot(x - O.x, y - O.y) < 1.1 * R) continue;
          const c = { q, r, x, y, filled: rng() < 0.12, lit: -9 };
          cells.push(c);
          byKey.set(`${q},${r}`, c);
        }
      }
      nearOrb = cells.reduce((best, c) => {
        const ref = { x: O.x + 1.1 * R, y: O.y };
        const d = Math.hypot(c.x - ref.x, c.y - ref.y);
        return !best || d < best.d ? { c, d } : best;
      }, null).c;
      env.chainApi = api;
      // one static element per 80px strip so the copy-column mask applies
      const strips = new Map();
      for (const c of cells) {
        const k = Math.floor(c.x / 80);
        if (!strips.has(k)) strips.set(k, []);
        strips.get(k).push(c);
      }
      for (const [k, list] of strips) {
        statics.add(k * 80 + 40, O.y, (g, m) => {
          const h = fxHue();
          g.strokeStyle = LS.rgba(h, 0.035 * m);
          g.lineWidth = 1;
          g.beginPath();
          for (const c of list) hexPath(g, c.x, c.y, HEX);
          g.stroke();
          g.fillStyle = LS.rgba(h, 0.025 * m);
          for (const c of list) { if (c.filled) { hexPath(g, c.x, c.y, HEX); g.fill(); } }
        });
      }
    }

    function neighbors(c) {
      const out = [];
      for (const [dq, dr] of DIRS) {
        const n = byKey.get(`${c.q + dq},${c.r + dr}`);
        if (n) out.push(n);
      }
      return out;
    }

    function bfsPath(from, to) {
      const prev = new Map([[from, null]]);
      const q = [from];
      while (q.length) {
        const c = q.shift();
        if (c === to) break;
        for (const n of neighbors(c)) {
          if (!prev.has(n)) { prev.set(n, c); q.push(n); }
        }
      }
      if (!prev.has(to)) return null;
      const path = [];
      for (let c = to; c; c = prev.get(c)) path.unshift(c);
      return path;
    }

    const api = {
      flashNearest(x, y) {
        const dx = env.O.x - O.x, dy = env.O.y - O.y;
        let best = null, bd = 1e9;
        for (const c of cells) {
          const d = Math.hypot(c.x + dx - x, c.y + dy - y);
          if (d < bd) { bd = d; best = c; }
        }
        if (best) best.lit = t;
        return best ? { x: best.x + dx, y: best.y + dy } : null;
      },
      newestPos() {
        const dx = env.O.x - O.x, dy = env.O.y - O.y;
        return { x: nearOrb.x + dx, y: nearOrb.y + dy };
      },
      pendingPos() { return api.newestPos(); },
    };

    function draw(g, dt, tNow, fx) {
      fxHue = () => (fx.slate ? '148,163,184' : block);
      fxGlint = () => (fx.slate ? '148,163,184' : glint);
      fxSeal = () => (fx.slate ? '148,163,184' : seal);
      const sdt = fx.freeze ? 0 : dt * (fx.slow || 1);
      t += sdt;
      statics.draw(g, fx);
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      const m = fx.aMul;
      g.save();
      g.translate(dx, dy);

      // lit cells decay
      for (const c of cells) {
        if (c.lit < 0) continue;
        const e = (t - c.lit) * 1000;
        if (e > 500) { c.lit = -9; continue; }
        const a = 0.12 * (1 - e / 500) * m;
        g.fillStyle = LS.rgba(fxGlint(), a);
        hexPath(g, c.x, c.y, HEX);
        g.fill();
      }

      if (sdt > 0 && t >= cycleNext) {
        cycleNext = t + 3.2;
        if (motif === 'read') {
          const farCells = cells.filter((c) => c.filled && Math.hypot(c.x - O.x, c.y - O.y) > 450);
          const from = farCells[Math.floor(env.rand() * farCells.length)] || cells[0];
          const path = bfsPath(from, nearOrb);
          if (path) cycle = { kind: 'read', t0: t, path, i: 0, inhaled: false };
        } else if (motif === 'write' || motif === 'transfer') {
          cycle = { kind: motif, t0: t };
          env.emit('compress');
        }
      }

      if (cycle && cycle.kind === 'read') {
        const e = t - cycle.t0;
        const idx = Math.floor(e / 0.06);
        for (let i = 0; i <= Math.min(idx, cycle.path.length - 1); i += 1) {
          const c = cycle.path[i];
          const age = (e - i * 0.06) * 1000;
          if (age > 500) continue;
          g.fillStyle = LS.rgba(fxGlint(), 0.12 * (1 - age / 500) * m);
          hexPath(g, c.x, c.y, HEX);
          g.fill();
        }
        if (idx >= cycle.path.length && !cycle.inhaled) {
          const pe = LS.clamp((e - cycle.path.length * 0.06) / 0.9, 0, 1);
          const last = cycle.path[cycle.path.length - 1];
          const from = { x: last.x, y: last.y };
          const ddx = env.O.x - (last.x + dx), ddy = env.O.y - (last.y + dy);
          const dd = Math.hypot(ddx, ddy) || 1;
          const edge = { x: env.O.x - (ddx / dd) * R, y: env.O.y - (ddy / dd) * R };
          const ctrl = { x: (from.x + dx + edge.x) / 2, y: Math.min(from.y + dy, edge.y) - 80 };
          const pt = LS.quad({ x: from.x + dx, y: from.y + dy }, ctrl, edge, LS.easeInOutCubic(pe));
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.translate(pt.x - dx, pt.y - dy);
          g.rotate(Math.PI / 4);
          g.shadowColor = LS.rgba(fxGlint(), 0.8 * m);
          g.shadowBlur = 8;
          g.strokeStyle = LS.rgba(fxGlint(), 0.8 * m);
          g.lineWidth = 1.4;
          g.strokeRect(-3.5, -3.5, 7, 7);
          g.restore();
          if (pe >= 1) { cycle.inhaled = true; env.emit('inhale'); cycle = null; }
        }
      }

      if (cycle && (cycle.kind === 'write' || cycle.kind === 'transfer')) {
        const e = t - cycle.t0;
        const isTransfer = cycle.kind === 'transfer';
        const c = nearOrb;
        // orb-adjacent cell fills gold; ring-1/2 pulse outward at 120ms/ring
        const gold = isTransfer ? 0.85 : 0.6;
        if (e < 1.6) {
          g.fillStyle = LS.rgba(fxSeal(), gold * Math.max(0.1, 1 - e / 1.6) * m);
          hexPath(g, c.x, c.y, HEX);
          g.fill();
        }
        if (e >= 1.6 && e < 4) {
          g.fillStyle = LS.rgba(fxSeal(), 0.06 * m);
          hexPath(g, c.x, c.y, HEX);
          g.fill();
        }
        const ring1 = neighbors(c);
        const ring2 = new Set();
        for (const n of ring1) for (const nn of neighbors(n)) if (nn !== c && !ring1.includes(nn)) ring2.add(nn);
        for (const n of ring1) {
          const pe = LS.clamp((e - 0.12) / 0.5, 0, 1);
          if (pe > 0) { g.fillStyle = LS.rgba(fxSeal(), 0.18 * (1 - pe) * m); hexPath(g, n.x, n.y, HEX); g.fill(); }
        }
        for (const n of ring2) {
          const pe = LS.clamp((e - 0.24) / 0.5, 0, 1);
          if (pe > 0) { g.fillStyle = LS.rgba(fxSeal(), 0.09 * (1 - pe) * m); hexPath(g, n.x, n.y, HEX); g.fill(); }
        }
        if (isTransfer) {
          g.save();
          g.translate(c.x, c.y);
          g.rotate(Math.PI / 4);
          g.fillStyle = LS.rgba(fxSeal(), 0.7 * LS.clamp(1 - e / 1.4, 0, 1) * m);
          g.fillRect(-5, -5, 10, 10);
          g.restore();
        }
        if (e > 2.2) cycle = null;
      }

      g.restore();
    }

    return {
      id: 'chain', variant: 'B',
      build,
      setMotif(m) { motif = m; cycle = null; cycleNext = t + 0.8; },
      draw,
      statics,
    };
  };
})();
