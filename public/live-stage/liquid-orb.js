(() => {
  const entryPoints = `
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var out: VOut;
  out.pos = vec4<f32>(p[i], 0.0, 1.0);
  let uv01 = (p[i] + vec2<f32>(1.0)) * 0.5;
  out.uv = vec2<f32>(uv01.x, 1.0 - uv01.y);
  return out;
}
@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let c = orbGlassLiquidAnim(in.uv);
  let fc = vec2<f32>(in.uv.x, 1.0 - in.uv.y) * u.size;
  let uv = (2.0 * fc - u.size) / max(min(u.size.x, u.size.y), 1.0);
  let rad = max(u.radius, 0.05);
  let t = u.time * u.speed;
  let contourRad = rad * glsContourScale(uv, t, u.contourDeform);
  let q = (2.0 * fc - u.size) / u.size;
  let fitEnd = 1.0;
  let fitFeather = 2.0 / max(min(u.size.x, u.size.y), 1.0);
  let fitStart = min(mix(contourRad, fitEnd, 0.5), fitEnd - fitFeather);
  let fit = 1.0 - smoothstep(fitStart, fitEnd, max(abs(q.x), abs(q.y)));
  return vec4<f32>(c.rgb * fit, c.a * fit);
}`;

  const baseParams = {
    style: 'siri', glassEnabled: true, speed: .82, radius: .72, contourDeform: .035,
    bandDensity: 2, chromaticShift: .32, metalScale: .77, metalStretch: .23,
    metalAngle: 65, metalOffset: 0, metalPhase: 0, metalEvolution: 1,
    metalRoughness: .22, metalDepth: .25, particleDensity: .72, ribbonCount: 5,
    ribbonWidth: .42, ribbonTwist: 1.25, ribbonFold: .55, ribbonBreath: .3,
    particleSize: 1.2, particleBloom: .7, zoom: .36, warp: 3.2, ridgeAmt: .5,
    sharp: 2.2, shade: .12, sheen: .28, gloss: .3, glassOpacity: .44,
    shellMidAlpha: .18, shellEdgeAlpha: .18, exposure: 1.36, edgeSoftness: .005,
    edgeGlow: .08, colorA: '#FFD86B', colorB: '#82F4FF', colorC: '#FF7BD5',
    colorD: '#8E6CFF', highlightColor: '#FFFFFF', shellInner: '#FFFFFF',
    shellMid: '#9BF4FF', shellEdge: '#C5A9FF', sheenColor: '#EAF4FF',
    specColor: '#DCEAFF', canvasColor: '#030409', glowColor: '#956CFF'
  };
  const paletteStops = ['#FFFFFF','#EAF4FF','#9BF4FF','#82F4FF','#C5A9FF','#8E6CFF','#82F4FF','#22D3EE','#22D3EE','#22D3EE','#22D3EE','#22D3EE'];
  const familyPalettes = {
    cool: { colorA: '#9EF1FF', colorB: '#6EA8FF', colorC: '#C5A9FF', colorD: '#5E7CFF', glowColor: '#6C8CFF', shellMid: '#9BF4FF', shellEdge: '#C5A9FF' },
    research: { colorA: '#82F4FF', colorB: '#2FD3C6', colorC: '#9BF4FF', colorD: '#3A8BFF', glowColor: '#43E0FF', shellMid: '#9BF4FF', shellEdge: '#7FD4FF' },
    create: { colorA: '#FF7BD5', colorB: '#FF9DE6', colorC: '#FFD86B', colorD: '#C86BFF', glowColor: '#FF6FCF', shellMid: '#FFC9E8', shellEdge: '#FF9DE6' },
    proof: { colorA: '#F2F5FF', colorB: '#C9D8FF', colorC: '#FFE7A3', colorD: '#8FA3C7', glowColor: '#D8E4FF', shellMid: '#DCE4F7', shellEdge: '#E8CF7A' },
    problem: { colorA: '#FFC37B', colorB: '#FF7BD5', colorC: '#8E6CFF', colorD: '#82F4FF', glowColor: '#C56CFF', shellMid: '#FFC9E8', shellEdge: '#C5A9FF' },
  };
  const statePresets = {
    received: { style: 9, speed: 1.05, radius: .72, warp: 3.8, contourDeform: .55, glassOpacity: .62, edgeGlow: .12 },
    reasoning: { ...familyPalettes.cool, style: 11, speed: 1.18, radius: .7, warp: 4.4, contourDeform: .95, glassOpacity: .54, edgeGlow: .18, exposure: 1.42, zoom: .42 },
    speaking: { style: 9, speed: .82, radius: .72, warp: 3.2, contourDeform: .045, glassOpacity: .64, edgeGlow: .08 },
    'local-recall': { ...familyPalettes.cool, style: 23, speed: .85, radius: .71, warp: 3.8, contourDeform: .55, glassOpacity: .58, edgeGlow: .13 },
    'web2-research': { ...familyPalettes.research, style: 23, speed: 1.05, radius: .71, warp: 4.2, contourDeform: .65, glassOpacity: .6, edgeGlow: .15 },
    'metaweb-research': { ...familyPalettes.research, style: 10, speed: .95, radius: .71, warp: 3.9, contourDeform: .6, glassOpacity: .6, edgeGlow: .15 },
    making: { ...familyPalettes.create, style: 21, speed: .95, radius: .71, warp: 4.1, contourDeform: .7, glassOpacity: .56, edgeGlow: .16, exposure: 1.42 },
    delegation: { ...familyPalettes.research, style: 10, speed: 1.05, radius: .69, warp: 4.1, contourDeform: .65, glassOpacity: .6, edgeGlow: .16 },
    waiting: { ...familyPalettes.cool, style: 23, speed: .5, radius: .7, warp: 3.2, contourDeform: .28, glassOpacity: .6, edgeGlow: .09 },
    'worker-report': { ...familyPalettes.research, style: 10, speed: .95, radius: .69, warp: 3.8, contourDeform: .5, glassOpacity: .62, edgeGlow: .14 },
    verification: { ...familyPalettes.proof, style: 23, speed: .72, radius: .7, warp: 3.4, contourDeform: .38, glassOpacity: .64, edgeGlow: .12, exposure: 1.2 },
    'browser-action': { ...familyPalettes.research, style: 23, speed: .92, radius: .72, warp: 3.7, contourDeform: .48, glassOpacity: .62, edgeGlow: .13 },
    'owner-needed': { style: 9, speed: .45, radius: .71, warp: 2.8, contourDeform: .06, glassOpacity: .62, edgeGlow: .1 },
    problem: { ...familyPalettes.problem, style: 9, speed: .38, radius: .7, warp: 2.4, contourDeform: .04, glassOpacity: .58, edgeGlow: .07 },
    'report-ready': { style: 9, speed: .28, radius: .7, warp: 2.2, contourDeform: .015, glassOpacity: .66, edgeGlow: .05 },
    complete: { style: 9, speed: .22, radius: .7, warp: 2, contourDeform: .01, glassOpacity: .64, edgeGlow: .04 }
  };
  window.liquidOrbStyleForFamily = (family) => (statePresets[family] || statePresets.received).style;
  window.liquidOrbParamsForFamily = (family) => ({ ...baseParams, ...(statePresets[family] || statePresets.received) });
  window.liquidOrbActivityForFamily = (family) => {
    if (family === 'reasoning') return 'thinking';
    if (family === 'speaking') return 'speaking';
    if (family === 'owner-needed' || family === 'problem' || family === 'report-ready' || family === 'complete') return 'resting';
    return 'working';
  };
  window.liquidOrbBaseParams = () => ({ ...baseParams });
  const numericKeys = Object.keys(baseParams).filter((key) => typeof baseParams[key] === 'number' && key !== 'style');
  const colorKeys = Object.keys(baseParams).filter((key) => typeof baseParams[key] === 'string' && key !== 'style');

  // Colors are '#RRGGBB' in params; interpolated colors travel as [r, g, b] in 0..1.
  function rgb(hex) {
    if (Array.isArray(hex)) return [hex[0], hex[1], hex[2], 1];
    const value = hex.slice(1);
    return [0,2,4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255).concat(1);
  }

  function writeUniforms(target, width, height, time, params) {
    target.fill(0);
    target[0] = width; target[1] = height; target[2] = time;
    target.set([
      params.speed, params.radius, params.zoom, params.warp, params.ridgeAmt,
      params.sharp, params.shade, params.sheen, params.gloss, params.shellMidAlpha,
      params.shellEdgeAlpha, params.exposure, params.style, params.edgeSoftness, params.edgeGlow,
      0, params.glassEnabled ? 1 : 0, params.glassOpacity, params.contourDeform,
      params.bandDensity, params.chromaticShift, params.metalScale, params.metalStretch,
      params.metalAngle, params.metalOffset, params.metalPhase, params.metalEvolution,
      params.metalRoughness, params.metalDepth, params.particleDensity, params.ribbonCount,
      params.ribbonWidth, params.ribbonTwist, params.ribbonFold, params.ribbonBreath,
      params.particleSize, params.particleBloom
    ], 3);
    const colors = [params.colorA,params.colorB,params.colorC,params.colorD,params.highlightColor,
      params.shellInner,params.shellMid,params.shellEdge,params.sheenColor,params.specColor,
      params.canvasColor,params.glowColor,...paletteStops];
    colors.forEach((hex,index) => target.set(rgb(hex), 40 + index * 4));
  }

  window.createLiquidOrbRenderer = async function createLiquidOrbRenderer(canvas, options = {}) {
    const forcedCanvas = new URLSearchParams(window.location.search).get('orb') === 'canvas';
    if (forcedCanvas) throw new Error('Canvas2D fallback requested');
    if (!navigator.gpu) throw new Error('WebGPU is unavailable');
    const startedAt = performance.now();
    const sharedResources = options.sharedResources;
    let device = sharedResources?.device;
    if (!device) {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter');
      device = await adapter.requestDevice();
    }
    const context = canvas.getContext('webgpu');
    if (!context) {
      if (!sharedResources?.device) device.destroy();
      throw new Error('No WebGPU canvas context');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });
    const shader = sharedResources?.shader ?? device.createShaderModule({ code: `${window.LiquidOrbEffectSource}\n${entryPoints}` });
    if (!sharedResources?.shader) {
      const compilation = await shader.getCompilationInfo();
      const errors = compilation.messages.filter((message) => message.type === 'error');
      if (errors.length) {
        device.destroy();
        throw new Error(errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n'));
      }
    }
    const pipeline = sharedResources?.pipeline ?? device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: { module: shader, entryPoint: 'fs_main', targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
        }
      }] },
      primitive: { topology: 'triangle-list' }
    });
    const values = new Float32Array(136);
    const uniformBuffer = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
    });
    const initialFamily = typeof options.initialFamily === 'string' && statePresets[options.initialFamily] ? options.initialFamily : 'received';
    let current = window.liquidOrbParamsForFamily(initialFamily);
    let target = window.liquidOrbParamsForFamily(initialFamily);
    const rendered = { ...baseParams };
    const currentColors = Object.fromEntries(colorKeys.map((key) => [key, rgb(current[key]).slice(0, 3)]));
    // Additive per-frame offsets that bypass interpolation (speech pulses, flashes).
    let modulation = {};
    let lerpRate = 5.5;
    let reduced = false, disposed = false, ready = false, raf = 0, lastFrame = null, phase = Number.isFinite(options.startPhase) ? options.startPhase : 0;

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    }

    function frame(now) {
      raf = 0;
      if (disposed) return;
      try {
        resize();
        const dt = lastFrame === null ? 0 : Math.min(.08, Math.max(0, (now - lastFrame) / 1000));
        lastFrame = now;
        if (!reduced) phase += dt;
        const blend = reduced ? 1 : 1 - Math.exp(-dt * lerpRate);
        numericKeys.forEach((key) => { current[key] += (target[key] - current[key]) * blend; });
        colorKeys.forEach((key) => {
          const to = rgb(target[key]);
          const from = currentColors[key];
          for (let channel = 0; channel < 3; channel += 1) from[channel] += (to[channel] - from[channel]) * blend;
        });
        Object.assign(rendered, current);
        colorKeys.forEach((key) => { rendered[key] = currentColors[key]; });
        const fluidity = Math.min(1, current.contourDeform / .6);
        const breath = reduced ? 0 : Math.sin(phase * 1.32);
        const drift = reduced ? 0 : Math.sin(phase * .73 + Math.sin(phase * .21));
        rendered.radius = current.radius * (1 + breath * (.018 + fluidity * .014) + drift * fluidity * .018);
        rendered.contourDeform = Math.max(0, current.contourDeform + fluidity * (Math.sin(phase * .91) * .12 + Math.sin(phase * 1.37 + 1.8) * .08));
        rendered.warp = current.warp + drift * fluidity * .28;
        rendered.edgeGlow = current.edgeGlow * (1 + breath * .32) + fluidity * .018 * (1 + Math.sin(phase * .57));
        if (!reduced) {
          for (const key in modulation) {
            if (typeof rendered[key] === 'number' && Number.isFinite(modulation[key])) rendered[key] += modulation[key];
          }
        }
        writeUniforms(values, canvas.width, canvas.height, phase, rendered);
        device.queue.writeBuffer(uniformBuffer, 0, values);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store'
        }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3,1,0,0); pass.end();
        device.queue.submit([encoder.finish()]);
        if (!ready) {
          ready = true;
          canvas.dataset.firstFrameMs = String(Math.round(performance.now() - startedAt));
          options.onReady?.();
        }
        if (!reduced) raf = requestAnimationFrame(frame);
      } catch (error) {
        disposed = true;
        cancelAnimationFrame(raf);
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }

    device.lost.then((info) => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      options.onError?.(new Error(info.message || info.reason || 'WebGPU device lost'));
    });
    device.addEventListener('uncapturederror', (event) => {
      event.preventDefault();
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      options.onError?.(new Error(event.error.message));
    });
    raf = requestAnimationFrame(frame);

    function setReduced(value) {
      if (disposed) return;
      const next = Boolean(value);
      if (reduced === next && raf) return;
      reduced = next;
      canvas.dataset.motion = reduced ? 'reduced' : 'full';
      cancelAnimationFrame(raf); raf = 0; lastFrame = null;
      if (reduced) current = { ...target };
      raf = requestAnimationFrame(frame);
    }

    return {
      setState(family, reduceMotion) {
        if (disposed) return;
        target = { ...baseParams, ...(statePresets[family] || statePresets.received) };
        current.style = target.style;
        canvas.dataset.orbStyle = String(target.style);
        setReduced(reduceMotion);
      },
      setReduced,
      // Direct parameter control for scripted stages (the Genesis Stage). The
      // Live Stage drives the orb through setState only.
      setParams(partial, options = {}) {
        if (disposed || !partial) return;
        target = { ...target, ...partial };
        if (partial.style !== undefined) {
          current.style = target.style;
          canvas.dataset.orbStyle = String(target.style);
        }
        if (options.immediate) {
          numericKeys.forEach((key) => { current[key] = target[key]; });
          colorKeys.forEach((key) => { currentColors[key] = rgb(target[key]).slice(0, 3); });
        }
        if (reduced && !raf) raf = requestAnimationFrame(frame);
      },
      setModulation(offsets) {
        if (disposed) return;
        modulation = offsets && typeof offsets === 'object' ? offsets : {};
      },
      setLerpRate(rate) {
        if (Number.isFinite(rate) && rate > 0) lerpRate = rate;
      },
      getPhase() { return phase; },
      getStyle() { return target.style; },
      getSharedResources() { return { device, shader, pipeline }; },
      dispose(destroyDevice = true) {
        disposed = true;
        cancelAnimationFrame(raf);
        if (destroyDevice) device.destroy();
      }
    };
  };
})();
