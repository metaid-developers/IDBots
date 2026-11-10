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
    sharp: 2.2, shade: .12, sheen: .28, gloss: .3, glassOpacity: .62,
    shellMidAlpha: .22, shellEdgeAlpha: .2, exposure: 1.5, edgeSoftness: .005,
    edgeGlow: .08, colorA: '#FFDC51', colorB: '#FFF3B0', colorC: '#FF9D55',
    colorD: '#22D3EE', highlightColor: '#FFFFFF', shellInner: '#FFFFFF',
    shellMid: '#FFF3B0', shellEdge: '#FFDC51', sheenColor: '#F4F7FA',
    specColor: '#FFFFFF', canvasColor: '#0A1220', glowColor: '#FFDC51'
  };
  const paletteStops = ['#FFFFFF','#FFF9DB','#FFF3B0','#FFDC51','#FFC247','#FF9D55','#82E7F2','#22D3EE','#22D3EE','#22D3EE','#22D3EE','#22D3EE'];
  const statePresets = {
    received: { style: 9, speed: .82, radius: .72, warp: 3.2, contourDeform: .035, glassOpacity: .62, edgeGlow: .08 },
    reasoning: { style: 15, speed: .46, radius: .72, warp: 2.5, contourDeform: .025, glassOpacity: .58, edgeGlow: .065 },
    speaking: { style: 9, speed: 1.05, radius: .72, warp: 3.6, contourDeform: .045, glassOpacity: .64, edgeGlow: .1 },
    'local-recall': { style: 10, speed: .82, radius: .7, warp: 3.4, contourDeform: .045, glassOpacity: .6, edgeGlow: .1 },
    'web2-research': { style: 10, speed: 1.08, radius: .7, warp: 4.1, contourDeform: .055, glassOpacity: .62, edgeGlow: .12 },
    'metaweb-research': { style: 13, speed: .86, radius: .71, warp: 3.8, contourDeform: .045, glassOpacity: .62, edgeGlow: .11 },
    making: { style: 23, speed: .76, radius: .71, warp: 3.4, contourDeform: .03, glassOpacity: .58, edgeGlow: .08 },
    delegation: { style: 24, speed: 1.08, radius: .69, warp: 4.3, contourDeform: .06, glassOpacity: .64, edgeGlow: .12 },
    waiting: { style: 24, speed: .42, radius: .7, warp: 3.2, contourDeform: .025, glassOpacity: .58, edgeGlow: .07 },
    'worker-report': { style: 14, speed: .88, radius: .69, warp: 3.8, contourDeform: .045, glassOpacity: .62, edgeGlow: .13 },
    verification: { style: 12, speed: .48, radius: .7, warp: 2.5, contourDeform: .025, glassOpacity: .68, edgeGlow: .07 },
    'browser-action': { style: 23, speed: .74, radius: .73, warp: 3, contourDeform: .025, glassOpacity: .64, edgeGlow: .1 },
    'owner-needed': { style: 21, speed: .5, radius: .71, warp: 2.7, contourDeform: .025, glassOpacity: .62, edgeGlow: .1 },
    problem: { style: 21, speed: .4, radius: .7, warp: 2.4, contourDeform: .02, glassOpacity: .58, edgeGlow: .07 },
    'report-ready': { style: 9, speed: .24, radius: .7, warp: 2.2, contourDeform: .015, glassOpacity: .66, edgeGlow: .05 },
    complete: { style: 9, speed: .2, radius: .7, warp: 2, contourDeform: .012, glassOpacity: .64, edgeGlow: .04 }
  };
  window.liquidOrbStyleForFamily = (family) => (statePresets[family] || statePresets.received).style;
  const numericKeys = Object.keys(baseParams).filter((key) => typeof baseParams[key] === 'number' && key !== 'style');

  function rgb(hex) {
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
    let current = { ...baseParams, style: statePresets.received.style };
    let target = { ...baseParams, ...statePresets.received };
    const rendered = { ...baseParams };
    let reduced = false, disposed = false, ready = false, raf = 0, lastFrame = null, phase = 0;

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
        const blend = reduced ? 1 : 1 - Math.exp(-dt * 5.5);
        numericKeys.forEach((key) => { current[key] += (target[key] - current[key]) * blend; });
        Object.assign(rendered, current);
        const breath = reduced ? 0 : Math.sin(phase * 1.32);
        rendered.radius = current.radius * (1 + breath * .018);
        rendered.edgeGlow = current.edgeGlow * (1 + breath * .32);
        writeUniforms(values, canvas.width, canvas.height, phase, rendered);
        device.queue.writeBuffer(uniformBuffer, 0, values);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store'
        }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3,1,0,0); pass.end();
        device.queue.submit([encoder.finish()]);
        if (!ready) { ready = true; options.onReady?.(); }
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
      reduced = Boolean(value);
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
