/*
 * Canvas2D liquid orb for machines without WebGPU. It mirrors the controller
 * surface of window.createLiquidOrbRenderer (setParams / setModulation /
 * setLerpRate / setReduced / dispose) so the Genesis Stage drives either
 * backend the same way. The contour uses the same wave as the WGSL shader.
 */
(() => {
  const DEFAULTS = {
    radius: .62, speed: .9, contourDeform: .3, warp: 3.4, edgeGlow: .12, exposure: 1.2, glassOpacity: .55,
    colorA: '#FFD86B', colorB: '#82F4FF', colorC: '#FF7BD5', colorD: '#8E6CFF',
    shellMid: '#9BF4FF', shellEdge: '#C5A9FF', glowColor: '#956CFF',
  };
  const COLOR_KEYS = ['colorA', 'colorB', 'colorC', 'colorD', 'shellMid', 'shellEdge', 'glowColor'];
  const NUMBER_KEYS = ['radius', 'speed', 'contourDeform', 'warp', 'edgeGlow', 'exposure', 'glassOpacity'];

  const toRgb = (hex) => {
    if (Array.isArray(hex)) return hex.slice(0, 3).map((value) => value * 255);
    const value = String(hex || '#ffffff').slice(1);
    return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) || 0);
  };
  const rgba = (rgb, alpha) => `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${Math.max(0, Math.min(1, alpha))})`;

  function contourWave(angle, t) {
    return Math.sin(angle * 3 + t * .62) * .52 + Math.sin(angle * 5 - t * .41 + 1.7) * .31 + Math.sin(angle * 2 + t * .23 + 3.1) * .17;
  }

  window.createFallbackOrb = function createFallbackOrb(canvas, options = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No Canvas2D context');
    let target = { ...DEFAULTS };
    const current = { ...DEFAULTS };
    const colors = Object.fromEntries(COLOR_KEYS.map((key) => [key, toRgb(DEFAULTS[key])]));
    let modulation = {};
    let lerpRate = 5.5;
    let reduced = false, disposed = false, raf = 0, last = null, phase = 0, readySent = false;

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    }

    function draw(now) {
      raf = 0;
      if (disposed) return;
      resize();
      const dt = last === null ? 0 : Math.min(.08, Math.max(0, (now - last) / 1000));
      last = now;
      const blend = reduced ? 1 : 1 - Math.exp(-dt * lerpRate);
      NUMBER_KEYS.forEach((key) => { current[key] += (target[key] - current[key]) * blend; });
      COLOR_KEYS.forEach((key) => {
        const to = toRgb(target[key]);
        for (let channel = 0; channel < 3; channel += 1) colors[key][channel] += (to[channel] - colors[key][channel]) * blend;
      });
      const mod = reduced ? {} : modulation;
      const speed = Math.max(0, current.speed);
      if (!reduced) phase += dt * speed;
      const t = phase;
      const w = canvas.width, h = canvas.height;
      const cx = w / 2, cy = h / 2;
      const breath = reduced ? 0 : Math.sin(t * 1.32 / Math.max(.2, speed)) * .018;
      const radius = Math.max(.02, current.radius + (mod.radius || 0)) * (1 + breath) * Math.min(w, h) / 2;
      const deform = Math.max(0, current.contourDeform + (mod.contourDeform || 0)) * .11;
      const glow = Math.max(0, current.edgeGlow + (mod.edgeGlow || 0));
      const exposure = Math.max(.2, current.exposure + (mod.exposure || 0));

      ctx.clearRect(0, 0, w, h);
      const steps = 120;
      const path = new Path2D();
      for (let index = 0; index <= steps; index += 1) {
        const angle = (index / steps) * Math.PI * 2;
        const r = radius * (1 + deform * contourWave(angle, t));
        const x = cx + Math.cos(angle) * r, y = cy + Math.sin(angle) * r;
        if (index === 0) path.moveTo(x, y); else path.lineTo(x, y);
      }
      path.closePath();

      ctx.save();
      ctx.shadowColor = rgba(colors.glowColor, Math.min(.8, glow * 2.8));
      ctx.shadowBlur = radius * (.16 + glow * 1.1);
      ctx.fillStyle = '#060a15';
      ctx.fill(path);
      ctx.restore();

      ctx.save();
      ctx.clip(path);
      ctx.globalCompositeOperation = 'lighter';
      const blobs = ['colorA', 'colorB', 'colorC', 'colorD'];
      const swirl = current.warp * .08;
      blobs.forEach((key, index) => {
        const angle = t * (.31 + index * .07) + index * 1.7 + Math.sin(t * .23 + index) * swirl;
        const orbit = radius * (.32 + .14 * Math.sin(t * .4 + index * 2.1));
        const x = cx + Math.cos(angle) * orbit, y = cy + Math.sin(angle * 1.13) * orbit;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * (.95 + .1 * Math.sin(t + index)));
        gradient.addColorStop(0, rgba(colors[key], .3 * exposure));
        gradient.addColorStop(.55, rgba(colors[key], .1 * exposure));
        gradient.addColorStop(1, rgba(colors[key], 0));
        ctx.fillStyle = gradient;
        ctx.fillRect(cx - radius * 2, cy - radius * 2, radius * 4, radius * 4);
      });
      ctx.globalCompositeOperation = 'source-over';
      const depth = ctx.createRadialGradient(cx, cy, radius * .2, cx, cy, radius * 1.08);
      depth.addColorStop(0, 'rgba(4,6,14,0)');
      depth.addColorStop(.72, 'rgba(4,6,14,.12)');
      depth.addColorStop(1, `rgba(4,6,14,${.55 - current.glassOpacity * .3})`);
      ctx.fillStyle = depth;
      ctx.fillRect(cx - radius * 2, cy - radius * 2, radius * 4, radius * 4);
      const spec = ctx.createRadialGradient(cx - radius * .38, cy - radius * .46, 0, cx - radius * .38, cy - radius * .46, radius * .55);
      spec.addColorStop(0, `rgba(255,255,255,${.34 * current.glassOpacity + .08})`);
      spec.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = spec;
      ctx.fillRect(cx - radius * 2, cy - radius * 2, radius * 4, radius * 4);
      ctx.restore();

      const rim = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      rim.addColorStop(0, rgba(colors.shellMid, .85));
      rim.addColorStop(1, rgba(colors.shellEdge, .7));
      ctx.lineWidth = Math.max(1, radius * .012);
      ctx.strokeStyle = rim;
      ctx.stroke(path);

      if (!readySent) {
        readySent = true;
        options.onReady?.();
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);

    function setReduced(value) {
      if (disposed) return;
      reduced = Boolean(value);
      cancelAnimationFrame(raf); raf = 0; last = null;
      raf = requestAnimationFrame(draw);
    }

    return {
      setState() {},
      setReduced,
      setParams(partial, opts = {}) {
        if (disposed || !partial) return;
        target = { ...target, ...partial };
        if (opts.immediate) {
          NUMBER_KEYS.forEach((key) => { current[key] = target[key]; });
          COLOR_KEYS.forEach((key) => { colors[key] = toRgb(target[key]); });
        }
        if (reduced && !raf) raf = requestAnimationFrame(draw);
      },
      setModulation(offsets) { modulation = offsets && typeof offsets === 'object' ? offsets : {}; },
      setLerpRate(rate) { if (Number.isFinite(rate) && rate > 0) lerpRate = rate; },
      getStyle() { return target.style; },
      getSharedResources() { return null; },
      dispose() { disposed = true; cancelAnimationFrame(raf); },
    };
  };
})();
