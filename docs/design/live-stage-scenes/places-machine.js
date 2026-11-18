/* Live Stage prototype — Machine place renderer (PCB / circuit).
   The orb is the processor: a socket + pin ticks around it, seeded traces,
   substrate dot grid, two memory chips, and motif-specific movers. */
(() => {
  const LS = window.LS;
  const { W, H, R } = LS;
  const O = LS.O_BASE;
  const trace = '214,160,92', pulse = '255,214,128', cell = '255,220,81';

  LS.placeFactories.machine = (env) => {
    const statics = LS.makeStatics(env);
    let motif = 'run';
    let t = 0;
    let traces = [], feedTraces = [], chips = [], placed = [];
    const sideFlash = { R: -9, T: -9, B: -9, L: -9 };
    const viaFlash = new Map();
    let pulses = [], spawnAcc = 0;
    const S = 2 * 1.18 * R;
    const half = S / 2;

    /* ---------------- geometry ---------------- */
    function samplePts(pts, every, out) {
      const at = LS.arcTable(pts);
      for (let s = 0; s < at.L; s += every) out.push(at.pointAt(s));
      out.push(at.pointAt(at.L));
    }

    function clearOf(pts, gap) {
      const samples = [];
      samplePts(pts, 10, samples);
      for (const p of samples) {
        for (const q of placed) {
          if (Math.hypot(p.x - q.x, p.y - q.y) < gap) return false;
        }
      }
      return true;
    }

    function commitTrace(pts, side, end) {
      const at = LS.arcTable(pts);
      const tr = { pts, side, end, at, endPos: pts[pts.length - 1] };
      traces.push(tr);
      samplePts(pts, 10, placed);
      return tr;
    }

    function genTrace(rng, sideWeights, usedTicks) {
      const r = rng();
      let side = 'R';
      let acc = 0;
      for (const [s, w] of sideWeights) { acc += w; if (r <= acc) { side = s; break; } }
      let tick = Math.floor(rng() * 14);
      for (let k = 0; k < 14; k += 1) {
        if (!usedTicks[side].has((tick + k) % 14)) { tick = (tick + k) % 14; break; }
      }
      usedTicks[side].add(tick);
      const off = (tick + 0.5) * (S / 14) - half;
      const nrm = { R: [1, 0], L: [-1, 0], T: [0, -1], B: [0, 1] }[side];
      const lat = { R: [0, 1], L: [0, 1], T: [1, 0], B: [1, 0] }[side];
      const start = {
        x: side === 'R' || side === 'L' ? O.x + nrm[0] * (half + 6) : O.x + off,
        y: side === 'T' || side === 'B' ? O.y + nrm[1] * (half + 6) : O.y + off,
      };
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const pts = [{ ...start }];
        let px = start.x, py = start.y;
        // perpendicular run
        const d1 = 20 + rng() * 40;
        px += nrm[0] * d1; py += nrm[1] * d1;
        pts.push({ x: px, y: py });
        // 45° jog
        const latSign = rng() < 0.5 ? -1 : 1;
        const d2 = 20 + rng() * 30;
        px += (nrm[0] + lat[0] * latSign) * d2 * 0.7071;
        py += (nrm[1] + lat[1] * latSign) * d2 * 0.7071;
        px = Math.round(px / 12) * 12; py = Math.round(py / 12) * 12;
        pts.push({ x: px, y: py });
        // orthogonal runs on a 12px grid
        const runs = 2 + Math.floor(rng() * 3);
        let horizontal = side === 'T' || side === 'B';
        let total = d1 + d2;
        const target = 160 + rng() * 260;
        for (let i = 0; i < runs && total < target; i += 1) {
          const len = (2 + Math.floor(rng() * 8)) * 12;
          if (horizontal) {
            const dir = side === 'L' ? -1 : 1;
            px += dir * len;
          } else {
            const dir = side === 'T' ? -1 : side === 'B' ? 1 : rng() < 0.5 ? -1 : 1;
            py += dir * len;
          }
          total += len;
          pts.push({ x: px, y: py });
          horizontal = !horizontal;
        }
        if (clearOf(pts, 9) || attempt === 5) {
          const end = rng() < 0.7 ? 'via' : 'pad';
          return commitTrace(pts, side, end);
        }
      }
      return null;
    }

    function chipTrace(rng, chipIndex) {
      // dedicated feed from the socket right edge to the chip's left edge
      const chip = chips[chipIndex];
      const y0 = O.y + (chipIndex === 0 ? -60 : 60);
      const pts = [
        { x: O.x + half + 6, y: y0 },
        { x: O.x + half + 36, y: y0 },
      ];
      const midX = Math.round(((O.x + half + 36) + (chip.x - 6)) / 2 / 12) * 12;
      pts.push({ x: midX, y: y0 });
      pts.push({ x: midX, y: chip.y + chip.h / 2 });
      pts.push({ x: chip.x - 6, y: chip.y + chip.h / 2 });
      pts.push({ x: chip.x, y: chip.y + chip.h / 2 });
      return commitTrace(pts, 'R', `chip${chipIndex}`);
    }

    function feedTrace(toX, toY, fromY) {
      // socket right edge → a point on a window frame's edge
      const pts = [
        { x: O.x + half + 6, y: fromY },
        { x: toX - 30, y: fromY },
        { x: toX, y: toY },
      ];
      const tr = { pts, side: 'R', end: 'feed', at: LS.arcTable(pts), endPos: pts[2] };
      feedTraces.push(tr);
      return tr;
    }

    function build() {
      const rng = LS.mulberry32(202);
      statics.els.length = 0;
      traces = []; feedTraces = []; placed = []; pulses = [];
      chips = [
        { x: O.x + 0.24 * W, y: O.y - 0.27 * H, w: 70, h: 26, next: 0, lit: new Array(16).fill(-9) },
        { x: O.x + 0.22 * W, y: O.y + 0.28 * H, w: 70, h: 26, next: 0, lit: new Array(16).fill(-9) },
      ];

      // socket
      statics.add(O.x, O.y, (g, m) => {
        const h = fxHue();
        LS.roundRect(g, O.x - half, O.y - half, S, S, 22);
        g.strokeStyle = LS.rgba(h, 0.065 * m);
        g.lineWidth = 1;
        g.stroke();
        LS.roundRect(g, O.x - half + 8, O.y - half + 8, S - 16, S - 16, 16);
        g.strokeStyle = LS.rgba(h, 0.04 * m);
        g.stroke();
        // pin ticks: 14 per side, 6px outward
        g.strokeStyle = LS.rgba(h, 0.1 * m);
        g.beginPath();
        for (let i = 0; i < 14; i += 1) {
          const off = (i + 0.5) * (S / 14) - half;
          g.moveTo(O.x + half, O.y + off); g.lineTo(O.x + half + 6, O.y + off);
          g.moveTo(O.x - half - 6, O.y + off); g.lineTo(O.x - half, O.y + off);
          g.moveTo(O.x + off, O.y - half - 6); g.lineTo(O.x + off, O.y - half);
          g.moveTo(O.x + off, O.y + half); g.lineTo(O.x + off, O.y + half + 6);
        }
        g.stroke();
      });

      // substrate dot grid
      statics.add(O.x + 0.2 * W, O.y, (g, m) => {
        const h = fxHue();
        for (let x = 0; x <= W; x += 20) {
          for (let y = 0; y <= H; y += 20) {
            const d = Math.hypot(x - O.x, y - O.y);
            const f = LS.clamp(1 - (d - half) / (0.55 * W - half), 0, 1);
            const a = 0.03 * f * m;
            if (a < 0.002) continue;
            g.fillStyle = LS.rgba(h, a);
            g.fillRect(x - 0.3, y - 0.3, 0.6, 0.6);
          }
        }
      });

      // traces
      const usedTicks = { R: new Set(), T: new Set(), B: new Set(), L: new Set() };
      const weights = [['R', 0.35], ['T', 0.25], ['B', 0.25], ['L', 0.15]];
      for (let i = 0; i < 30; i += 1) genTrace(rng, weights, usedTicks);
      chipTrace(rng, 0);
      chipTrace(rng, 1);
      // feed traces for desktop / screen frames (drawn in their motifs)
      feedTrace(O.x + 200, O.y + 230, O.y + 100);   // desktop frame bottom edge
      feedTrace(O.x + 210, O.y - 30, O.y - 60);     // screen frame bottom edge
      feedTrace(O.x + 260, O.y - 30, O.y - 20);     // screen frame bottom edge 2

      statics.add(O.x + W * 0.2, O.y, (g, m) => {
        const h = fxHue();
        g.strokeStyle = LS.rgba(h, 0.08 * m);
        g.lineWidth = 1;
        for (const tr of traces) {
          g.beginPath();
          g.moveTo(tr.pts[0].x, tr.pts[0].y);
          for (let i = 1; i < tr.pts.length; i += 1) g.lineTo(tr.pts[i].x, tr.pts[i].y);
          g.stroke();
        }
      });
      // trace end terminations
      statics.add(O.x + W * 0.2, O.y, (g, m) => {
        const h = fxHue();
        for (const tr of traces) {
          const p = tr.endPos;
          if (tr.end === 'via') {
            g.beginPath();
            g.strokeStyle = LS.rgba(h, 0.16 * m);
            g.lineWidth = 1;
            g.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
            g.stroke();
          } else if (tr.end === 'pad') {
            g.fillStyle = LS.rgba(h, 0.12 * m);
            g.fillRect(p.x - 2, p.y - 2, 4, 4);
          }
        }
      });
      // memory chips
      statics.add(chips[0].x, chips[0].y, (g, m) => {
        const h = fxHue();
        for (const c of chips) {
          LS.roundRect(g, c.x, c.y, c.w, c.h, 4);
          g.strokeStyle = LS.rgba(h, 0.08 * m);
          g.lineWidth = 1;
          g.stroke();
          g.fillStyle = LS.rgba(h, 0.05 * m);
          for (let r = 0; r < 2; r += 1) {
            for (let i = 0; i < 8; i += 1) {
              g.fillRect(c.x + 7 + i * 7, c.y + 5 + r * 10, 6, 6);
            }
          }
        }
      });
    }

    // fxHue is set per draw (slate override)
    let fxHue = () => trace;
    const traceSetFor = () => {
      if (motif === 'desktop') return [...traces, feedTraces[0]];
      if (motif === 'screen' || motif === 'project') return [...traces, feedTraces[1], feedTraces[2]];
      return traces;
    };

    function pulseRate() {
      switch (motif) {
        case 'run': return 4.5;
        case 'read': return 3;
        case 'write': return 3;
        case 'desktop': return 1.2;
        case 'screen': case 'project': return 1.6;
        case 'workers': return 0.8;
        case 'waiting': return 0.6;
        default: return 1.4;
      }
    }

    function spawnPulse() {
      if (pulses.length >= 20) return;
      const set = traceSetFor();
      const tr = set[Math.floor(env.rand() * set.length)];
      let dir = env.rand() < 0.5 ? 1 : -1;
      if (motif === 'read') dir = -1;
      if (motif === 'write') dir = 1;
      if (tr.end === 'feed') dir = 1;
      pulses.push({ tr, s: dir > 0 ? 0 : tr.at.L, dir, spd: 150 + env.rand() * 70 });
    }

    function onPulseArrive(p) {
      if (p.dir < 0) {
        sideFlash[p.tr.side] = t;
      } else if (p.tr.end === 'via') {
        viaFlash.set(p.tr, t);
      } else if (p.tr.end.startsWith('chip')) {
        const c = chips[Number(p.tr.end.slice(4))];
        c.lit[c.next % 16] = t;
        c.next += 1;
      }
    }

    function drawPulses(g, fx, m) {
      const h = fx.slate ? '148,163,184' : pulse;
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const p of pulses) {
        const head = p.tr.at.pointAt(p.s);
        const tail = p.tr.at.pointAt(p.s - p.dir * 22);
        const grad = g.createLinearGradient(tail.x, tail.y, head.x, head.y);
        grad.addColorStop(0, LS.rgba(h, 0));
        grad.addColorStop(1, LS.rgba(h, 0.5 * m));
        g.strokeStyle = grad;
        g.lineWidth = 1.4;
        g.beginPath();
        // short polyline along the trace for a curved streak
        const steps = 5;
        for (let i = 0; i <= steps; i += 1) {
          const q = p.tr.at.pointAt(p.s - p.dir * 22 * (1 - i / steps));
          if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
        }
        g.stroke();
        g.shadowColor = LS.rgba(h, 0.9 * m);
        g.shadowBlur = 8;
        g.beginPath();
        g.fillStyle = LS.rgba(h, 0.85 * m);
        g.arc(head.x, head.y, 1.6, 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;
      }
      g.restore();
    }

    function drawFrameDecor(g, fx, m) {
      const h = fx.slate ? '148,163,184' : trace;
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      g.save();
      g.translate(dx, dy);
      if (motif === 'desktop') {
        const fx0 = O.x + 40, fy0 = O.y + 20, fw = 330, fh = 210;
        LS.roundRect(g, fx0, fy0, fw, fh, 10);
        g.fillStyle = `rgba(8,14,26,${0.86 * m})`;
        g.fill();
        g.strokeStyle = LS.rgba(h, 0.18 * m); g.lineWidth = 1; g.stroke();
        g.beginPath(); g.moveTo(fx0, fy0 + 18); g.lineTo(fx0 + fw, fy0 + 18); g.stroke();
        g.fillStyle = LS.rgba(h, 0.3 * m);
        for (let i = 0; i < 3; i += 1) { g.beginPath(); g.arc(fx0 + 12 + i * 8, fy0 + 9, 1.5, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = LS.rgba(h, 0.06 * m);
        g.fillRect(fx0 + 14, fy0 + 34, fw - 60, 46);
        g.fillRect(fx0 + 14, fy0 + 92, fw - 130, 34);
        g.fillRect(fx0 + 14, fy0 + 138, fw - 90, 50);
      }
      if (motif === 'screen' || motif === 'project') {
        const fx0 = O.x + 30, fy0 = O.y - 250, fw = 360, fh = 220;
        LS.roundRect(g, fx0, fy0, fw, fh, 10);
        g.fillStyle = `rgba(8,14,26,${0.86 * m})`;
        g.fill();
        let border = 0.18;
        if (motif === 'project') border = 0.18 + 0.12 * LS.clamp(1 - (t - projectT0) / 1.1, 0, 1);
        g.strokeStyle = LS.rgba(h, border * m); g.lineWidth = 1; g.stroke();
        // tab pill instead of dots
        LS.roundRect(g, fx0 + 12, fy0 + 6, 58, 11, 5.5);
        g.strokeStyle = LS.rgba(h, 0.16 * m); g.stroke();
        if (motif === 'screen') {
          const scanY = fy0 + ((t % 2.2) / 2.2) * fh;
          g.strokeStyle = LS.rgba(h, 0.25 * m);
          g.beginPath(); g.moveTo(fx0 + 2, scanY); g.lineTo(fx0 + fw - 2, scanY); g.stroke();
        }
        if (motif === 'project') {
          const e = (t - projectT0) % 3;
          const p = LS.easeOutQuint(LS.clamp(e / 1.1, 0, 1));
          const cx = LS.lerp(O.x, fx0 + fw / 2, p), cy = LS.lerp(O.y, fy0 + fh / 2, p);
          const sc = LS.lerp(0.4, 1, p);
          g.save();
          g.translate(cx, cy);
          g.scale(sc, sc);
          LS.roundRect(g, -45, -58, 90, 116, 6);
          g.strokeStyle = LS.rgba(h, 0.3 * p * m);
          g.stroke();
          g.fillStyle = LS.rgba(h, 0.05 * p * m);
          g.fillRect(-45, -58, 90, 116);
          g.fillStyle = LS.rgba(h, 0.16 * p * m);
          for (let i = 0; i < 6; i += 1) g.fillRect(-34, -44 + i * 16, (30 + (i * 37) % 40), 4);
          g.restore();
        }
      }
      g.restore();
    }

    // reticle cursor state (desktop)
    let cur = null, curNext = 0, ripple = null;
    let projectT0 = 0;

    function drawDesktopCursor(g, fx, m) {
      const h = fx.slate ? '148,163,184' : pulse;
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      const fx0 = O.x + 40 + dx, fy0 = O.y + 20 + dy;
      if (!cur) cur = { x: fx0 + 60, y: fy0 + 60, fx: fx0 + 60, fy: fy0 + 60, t0: 0 };
      if (t >= curNext) {
        cur.fx = cur.x; cur.fy = cur.y;
        cur.x = fx0 + 20 + env.rand() * 290;
        cur.y = fy0 + 26 + env.rand() * 170;
        cur.t0 = t;
        curNext = t + 1.6;
        ripple = { x: cur.x, y: cur.y, t0: t + 0.9 };
      }
      const p = LS.easeInOutCubic(LS.clamp((t - cur.t0) / 0.9, 0, 1));
      const cx = LS.lerp(cur.fx, cur.x, p), cy = LS.lerp(cur.fy, cur.y, p);
      // 1px dark outline so the reticle reads over the window fill
      g.strokeStyle = `rgba(8,14,26,${0.9 * m})`;
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(cx - 5, cy); g.lineTo(cx + 5, cy);
      g.moveTo(cx, cy - 5); g.lineTo(cx, cy + 5);
      g.stroke();
      g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = LS.rgba(h, 0.6 * m);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(cx - 5, cy); g.lineTo(cx + 5, cy);
      g.moveTo(cx, cy - 5); g.lineTo(cx, cy + 5);
      g.stroke();
      g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.stroke();
      if (ripple && t > ripple.t0) {
        const e = (t - ripple.t0) / 0.5;
        if (e < 1) {
          g.strokeStyle = LS.rgba(h, 0.5 * (1 - e) * m);
          g.beginPath(); g.arc(ripple.x, ripple.y, 6 + 16 * e, 0, Math.PI * 2); g.stroke();
        }
      }
    }

    function draw(g, dt, tNow, fx) {
      fxHue = () => (fx.slate ? '148,163,184' : trace);
      const sdt = fx.freeze ? 0 : dt * (fx.slow || 1);
      t += sdt;
      const dx = env.O.x - O.x, dy = env.O.y - O.y;
      const motifDim = motif === 'desktop' ? 0.6 : motif === 'workers' ? 0.5 : 1;
      const fx2 = { ...fx, elA: (x, y, d) => fx.elA(x, y, d) * motifDim, forceElements: motifDim !== 1 };
      statics.draw(g, fx2);

      const m = fx.aMul * motifDim;

      // pulses
      if (sdt > 0) {
        spawnAcc += sdt * pulseRate();
        while (spawnAcc >= 1) { spawnAcc -= 1; spawnPulse(); }
        for (const p of pulses) {
          p.s += p.dir * p.spd * sdt;
          if (p.s < 0 || p.s > p.tr.at.L) { p.done = true; onPulseArrive(p); }
        }
        pulses = pulses.filter((p) => !p.done);
      }
      g.save();
      g.translate(dx, dy);
      drawPulses(g, fx, fx2.elA(O.x, O.y, 0));
      g.restore();

      g.save();
      g.translate(dx, dy);
      const h = fx.slate ? '148,163,184' : trace;
      const hp = fx.slate ? '148,163,184' : pulse;
      const hc = fx.slate ? '148,163,184' : cell;

      // socket side flashes (read arrivals)
      for (const side of ['R', 'T', 'B', 'L']) {
        const e = (t - sideFlash[side]) * 1000;
        if (e >= 0 && e < 220) {
          const a = 0.12 * (1 - e / 220) * m;
          g.strokeStyle = LS.rgba(hp, a);
          g.lineWidth = 1.2;
          g.beginPath();
          if (side === 'R') { g.moveTo(O.x + half, O.y - half); g.lineTo(O.x + half, O.y + half); }
          if (side === 'L') { g.moveTo(O.x - half, O.y - half); g.lineTo(O.x - half, O.y + half); }
          if (side === 'T') { g.moveTo(O.x - half, O.y - half); g.lineTo(O.x + half, O.y - half); }
          if (side === 'B') { g.moveTo(O.x - half, O.y + half); g.lineTo(O.x + half, O.y + half); }
          g.stroke();
        }
      }
      // via flashes
      for (const [tr, t0] of viaFlash) {
        const e = (t - t0) * 1000;
        if (e > 400) { viaFlash.delete(tr); continue; }
        g.beginPath();
        g.strokeStyle = LS.rgba(hp, 0.4 * (1 - e / 400) * m);
        g.arc(tr.endPos.x, tr.endPos.y, 2.5 + e / 400 * 3, 0, Math.PI * 2);
        g.stroke();
      }
      // memory cells decay
      for (const c of chips) {
        for (let i = 0; i < 16; i += 1) {
          const e = (t - c.lit[i]) * 1000;
          if (e < 0 || e > 1800) continue;
          const a = (0.55 - (0.55 - 0.05) * (e / 1800)) * m;
          g.fillStyle = LS.rgba(hc, a);
          g.fillRect(c.x + 7 + (i % 8) * 7, c.y + 5 + Math.floor(i / 8) * 10, 6, 6);
        }
      }
      // corner LEDs (run motif): sequence every 180ms + occasional bursts
      if (motif === 'run') {
        const step = Math.floor(t / 0.18);
        const litIdx = step % 4;
        const burst = LS.mulberry32(step * 7919)() < 0.12;
        const corners = [
          [O.x - half - 10, O.y - half - 10], [O.x + half + 10, O.y - half - 10],
          [O.x + half + 10, O.y + half + 10], [O.x - half - 10, O.y + half + 10],
        ];
        for (let i = 0; i < 4; i += 1) {
          const lit = i === litIdx || (burst && i === (litIdx + 2) % 4);
          g.fillStyle = LS.rgba(hc, (lit ? 0.7 : 0.12) * m);
          g.fillRect(corners[i][0] - 1.5, corners[i][1] - 1.5, 3, 3);
        }
      }
      g.restore();

      drawFrameDecor(g, fx, m);
      if (motif === 'desktop') drawDesktopCursor(g, fx, m);
    }

    return {
      id: 'machine',
      build,
      setMotif(m) {
        motif = m;
        if (m === 'project') projectT0 = t;
      },
      draw,
      statics,
    };
  };
})();
