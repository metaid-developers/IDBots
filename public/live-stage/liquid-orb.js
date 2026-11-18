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
  const statePresets = {
    received: { style: 9, speed: 1.05, radius: .72, warp: 3.6, contourDeform: .55, glassOpacity: .64, edgeGlow: .08 },
    reasoning: { style: 9, speed: 1.05, radius: .72, warp: 4, contourDeform: .95, glassOpacity: .64, edgeGlow: .08 },
    speaking: { style: 9, speed: .82, radius: .72, warp: 3.2, contourDeform: .045, glassOpacity: .64, edgeGlow: .08 },
    'local-recall': { style: 9, speed: .85, radius: .72, warp: 3.5, contourDeform: .55, glassOpacity: .64, edgeGlow: .08 },
    'local-run': { style: 9, speed: .85, radius: .72, warp: 3.5, contourDeform: .55, glassOpacity: .64, edgeGlow: .08 },
    'local-read': { style: 9, speed: .85, radius: .72, warp: 3.5, contourDeform: .55, glassOpacity: .64, edgeGlow: .08 },
    'desktop-control': { style: 9, speed: .92, radius: .72, warp: 3.6, contourDeform: .48, glassOpacity: .64, edgeGlow: .08 },
    projecting: { style: 9, speed: .92, radius: .72, warp: 3.6, contourDeform: .48, glassOpacity: .64, edgeGlow: .08 },
    'web-read': { style: 9, speed: .85, radius: .72, warp: 3.4, contourDeform: .4, glassOpacity: .64, edgeGlow: .08 },
    'chain-write': { style: 9, speed: .8, radius: .72, warp: 3.4, contourDeform: .3, glassOpacity: .64, edgeGlow: .1 },
    'chain-transfer': { style: 9, speed: .72, radius: .72, warp: 3.2, contourDeform: .22, glassOpacity: .64, edgeGlow: .1 },
    'private-chat': { style: 9, speed: .75, radius: .72, warp: 3.3, contourDeform: .35, glassOpacity: .64, edgeGlow: .09 },
    'group-task': { style: 9, speed: .8, radius: .72, warp: 3.4, contourDeform: .42, glassOpacity: .64, edgeGlow: .09 },
    'web2-research': { style: 9, speed: 1, radius: .72, warp: 3.8, contourDeform: .65, glassOpacity: .64, edgeGlow: .08 },
    'metaweb-research': { style: 9, speed: .95, radius: .72, warp: 3.7, contourDeform: .6, glassOpacity: .64, edgeGlow: .08 },
    making: { style: 9, speed: .9, radius: .72, warp: 3.8, contourDeform: .7, glassOpacity: .64, edgeGlow: .08 },
    delegation: { style: 9, speed: 1, radius: .72, warp: 3.8, contourDeform: .65, glassOpacity: .64, edgeGlow: .08 },
    waiting: { style: 9, speed: .46, radius: .72, warp: 2.95, contourDeform: .18, glassOpacity: .64, edgeGlow: .08 },
    'worker-report': { style: 9, speed: .9, radius: .72, warp: 3.6, contourDeform: .5, glassOpacity: .64, edgeGlow: .08 },
    verification: { style: 9, speed: .72, radius: .72, warp: 3.4, contourDeform: .38, glassOpacity: .64, edgeGlow: .08 },
    'browser-action': { style: 9, speed: .92, radius: .72, warp: 3.6, contourDeform: .48, glassOpacity: .64, edgeGlow: .08 },
    'owner-needed': { style: 9, speed: .45, radius: .71, warp: 2.8, contourDeform: .06, glassOpacity: .62, edgeGlow: .1 },
    problem: { style: 9, speed: .38, radius: .7, warp: 2.4, contourDeform: .04, glassOpacity: .58, edgeGlow: .07 },
    'report-ready': { style: 9, speed: .28, radius: .7, warp: 2.2, contourDeform: .015, glassOpacity: .66, edgeGlow: .05 },
    complete: { style: 9, speed: .22, radius: .7, warp: 2, contourDeform: .01, glassOpacity: .64, edgeGlow: .04 },
    // The unclaimed entry page: a calm breathing round orb, never "working".
    idle: { style: 9, speed: .3, radius: .72, warp: 2.4, contourDeform: .03, glassOpacity: .64, edgeGlow: .06 }
  };
  window.liquidOrbStyleForFamily = (family) => (statePresets[family] || statePresets.received).style;
  window.liquidOrbParamsForFamily = (family) => ({ ...baseParams, ...(statePresets[family] || statePresets.received) });
  window.liquidOrbActivityForFamily = (family) => {
    if (family === 'reasoning') return 'thinking';
    if (family === 'speaking') return 'speaking';
    if (family === 'waiting') return 'waiting';
    if (family === 'idle' || family === 'owner-needed' || family === 'problem' || family === 'report-ready' || family === 'complete') return 'resting';
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

  const PRESET_FLUID_BY_STYLE = {
    9: 'glsSiriFluid',
    10: 'glsAuroraFluid',
    11: 'glsPlasmaFluid',
    12: 'glsChromeFluid',
    13: 'glsOpalFluid',
    14: 'glsSpectrumFluid',
    15: 'glsFrostFluid',
    19: 'glsVoiceWaveFluid',
    20: 'glsBlueDropFluid',
    21: 'glsVioletEmberFluid',
    22: 'glsChromaticMetalFluid',
    23: 'glsRefractiveBlobFluid',
    24: 'glsParticleRibbonFluid',
  };

  function stripUnreachableWgslFunctions(code, rootNames) {
    const fnRe = /^fn\s+([A-Za-z0-9_]+)\s*\(/gm;
    const spans = [];
    let match;
    while ((match = fnRe.exec(code)) !== null) {
      const start = match.index;
      const name = match[1];
      let depth = 0, index = start, started = false;
      for (; index < code.length; index += 1) {
        if (code[index] === '{') { depth += 1; started = true; }
        else if (code[index] === '}') {
          depth -= 1;
          if (started && depth === 0) { index += 1; break; }
        }
      }
      spans.push({ name, start, end: index, body: code.slice(start, index) });
    }
    const byName = new Map(spans.map((span) => [span.name, span]));
    const keep = new Set(rootNames);
    const queue = [...rootNames];
    while (queue.length > 0) {
      const current = byName.get(queue.pop());
      if (!current) continue;
      for (const call of current.body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        const callee = call[1];
        if (byName.has(callee) && !keep.has(callee)) {
          keep.add(callee);
          queue.push(callee);
        }
      }
    }
    let out = '';
    let cursor = 0;
    for (const span of spans) {
      out += code.slice(cursor, span.start);
      if (keep.has(span.name)) out += span.body;
      cursor = span.end;
    }
    out += code.slice(cursor);
    return out;
  }

  function specializeOrbEffectSource(baseEffectSource, fixedStyle) {
    let source = String(baseEffectSource || '').replace(/\r\n/g, '\n');
    if (Number.isInteger(fixedStyle) && PRESET_FLUID_BY_STYLE[fixedStyle]) {
      const fnName = PRESET_FLUID_BY_STYLE[fixedStyle];
      const strength = fixedStyle >= 18.5 ? '0.11' : (fixedStyle >= 15.5 ? '0.16' : '0.09');
      source = source
        .replace(
          /fn glsPresetFluid\(p: vec2<f32>, style: i32, t: f32\) -> vec3<f32> \{[\s\S]*?\n\}/,
          `fn glsPresetFluid(p: vec2<f32>, style: i32, t: f32) -> vec3<f32> {\n  return ${fnName}(p, t);\n}`,
        )
        .replace(
          /fn glsContourStrength\(\) -> f32 \{[\s\S]*?\n\}/,
          `fn glsContourStrength() -> f32 {\n  return ${strength};\n}`,
        )
        .replace(/let style = i32\(u\.style \+ 0\.5\);/g, `let style = ${fixedStyle};`)
        .replace(/let s = i32\(u\.style \+ 0\.5\);/g, `let s = ${fixedStyle};`)
        .replace(/else \{ fcol = glsFluid\(fu, md, t\); \}/g, 'else { fcol = vec3<f32>(0.0); }');
      if (fixedStyle !== 23) {
        source = source.replace(
          /fn glsRefractionNormal\(base: vec2<f32>, p: vec2<f32>, t: f32,\s*style: i32\) -> vec2<f32> \{[\s\S]*?\n\}/,
          'fn glsRefractionNormal(base: vec2<f32>, p: vec2<f32>, t: f32, style: i32) -> vec2<f32> {\n  return base;\n}',
        );
      }
    }
    return source;
  }

  // Specialize and dead-code strip the monolithic WGSL effect when a stage uses
  // one style (e.g. Live Stage style 9). Without stripping, Dawn/Tint + Windows
  // DXC/FXC parse and lower all 51 procedural functions (~59 KB WGSL).
  function buildOrbShaderSource(baseEffectSource, fixedStyle) {
    const specialized = specializeOrbEffectSource(baseEffectSource, fixedStyle);
    const combined = `${specialized}\n${entryPoints}`;
    if (Number.isInteger(fixedStyle) && PRESET_FLUID_BY_STYLE[fixedStyle]) {
      return stripUnreachableWgslFunctions(combined, ['vs_main', 'fs_main']);
    }
    return combined;
  }

  // Deterministic WGSL -> GLSL ES 3.00 transpiler for the arithmetic-only orb
  // effect, keeping a single source of truth while letting ANGLE/D3D11 WebGL2
  // render the exact same refractive liquid-glass orb when Windows WebGPU is
  // blocklisted, WARP-only, or slow on older drivers.
  function buildOrbGlslSource(baseEffectSource, fixedStyle) {
    let code = specializeOrbEffectSource(baseEffectSource, fixedStyle);
    if (Number.isInteger(fixedStyle) && PRESET_FLUID_BY_STYLE[fixedStyle]) {
      code = stripUnreachableWgslFunctions(code, ['orbGlassLiquidAnim', 'glsContourScale']);
    }
    code = code.replace(/\/\/[^\n]*/g, '');

    const mapType = (raw) => {
      const t = raw.trim();
      if (t === 'f32') return 'float';
      if (t === 'i32') return 'int';
      if (t === 'u32') return 'uint';
      if (t === 'bool') return 'bool';
      const vf = t.match(/^vec([234])<f32>$/);
      if (vf) return `vec${vf[1]}`;
      const vi = t.match(/^vec([234])<i32>$/);
      if (vi) return `ivec${vi[1]}`;
      return t;
    };

    const structFields = {};
    code = code.replace(/struct\s+(\w+)\s*\{([\s\S]*?)\};?/g, (_m, name, body) => {
      const fields = {};
      const lines = [];
      for (const part of body.split(',')) {
        const fm = part.trim().match(/^(\w+)\s*:\s*([A-Za-z0-9_<>]+)$/);
        if (!fm) continue;
        const glType = mapType(fm[2]);
        fields[fm[1]] = glType;
        lines.push(`  ${glType} ${fm[1]};`);
      }
      structFields[name] = fields;
      if (name === 'Uniforms') return `layout(std140) uniform Uniforms {\n${lines.join('\n')}\n} u;`;
      return `struct ${name} {\n${lines.join('\n')}\n};`;
    });
    code = code.replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var<uniform>\s+u\s*:\s*Uniforms\s*;/g, '');

    const fnReturn = {
      vec2: 'vec2', vec3: 'vec3', vec4: 'vec4', ivec2: 'ivec2', ivec3: 'ivec3', ivec4: 'ivec4',
      float: 'float', int: 'int', uint: 'uint', bool: 'bool', MfRamp: 'MfRamp',
      length: 'float', dot: 'float', atan: 'float', atan2: 'float', f32: 'float', i32: 'int', u32: 'uint',
    };
    for (const m of code.matchAll(/fn\s+(\w+)\s*\(([\s\S]*?)\)\s*->\s*([A-Za-z0-9_<>]+)/g)) {
      fnReturn[m[1]] = mapType(m[3]);
    }

    const convertExpr = (expr) => expr
      .replace(/,\s*\)/g, ')')
      .replace(/\bvec([234])<f32>/g, 'vec$1')
      .replace(/\bvec([234])<i32>/g, 'ivec$1')
      .replace(/\bf32\s*\(/g, 'float(')
      .replace(/\bi32\s*\(/g, 'int(')
      .replace(/\bu32\s*\(/g, 'uint(')
      .replace(/\batan2\s*\(/g, 'atan(')
      .replace(/\bselect\s*\(/g, '_wgsl_select(');

    const globalVars = {};
    code = code.replace(/\bconst\s+(\w+)\s*:\s*([A-Za-z0-9_<>]+)\s*=\s*([^;]+);/g, (_m, name, t, rhs) => {
      const glType = mapType(t);
      globalVars[name] = glType;
      return `const ${glType} ${name} = ${convertExpr(rhs)};`;
    });

    const matchParen = (s, idx) => {
      let depth = 0;
      for (let i = idx; i < s.length; i += 1) {
        if (s[i] === '(') depth += 1;
        else if (s[i] === ')') { depth -= 1; if (depth === 0) return i; }
      }
      return s.length - 1;
    };
    const stripParens = (s) => {
      let out = '', depth = 0;
      for (let i = 0; i < s.length; i += 1) {
        if (s[i] === '(') depth += 1;
        else if (s[i] === ')') depth -= 1;
        else if (depth === 0) out += s[i];
      }
      return out;
    };
    const splitTopArgs = (s) => {
      const args = [];
      let depth = 0, start = 0;
      for (let i = 0; i < s.length; i += 1) {
        if (s[i] === '(') depth += 1;
        else if (s[i] === ')') depth -= 1;
        else if (s[i] === ',' && depth === 0) { args.push(s.slice(start, i).trim()); start = i + 1; }
      }
      if (s.slice(start).trim()) args.push(s.slice(start).trim());
      return args;
    };
    const splitTopMath = (s) => {
      const parts = [];
      let depth = 0, start = 0;
      for (let i = 0; i < s.length; i += 1) {
        if (s[i] === '(') depth += 1;
        else if (s[i] === ')') depth -= 1;
        else if (depth === 0 && '+-*/'.includes(s[i])) {
          const prev = s.slice(0, i).trimEnd();
          if (!prev || '(+-*/,='.includes(prev[prev.length - 1])) continue;
          parts.push(s.slice(start, i));
          start = i + 1;
        }
      }
      parts.push(s.slice(start));
      return parts;
    };
    const swizzleType = (sw) => (sw.length >= 2 && sw.length <= 4 ? `vec${sw.length}` : 'float');

    const inferType = (expr, scope) => {
      const e = expr.trim();
      if (/^(true|false)\b/.test(e) || /&&|\|\||==|!=|<=|>=|<|>/.test(stripParens(e))) return 'bool';
      if (e.startsWith('(') && matchParen(e, 0) === e.length - 1) return inferType(e.slice(1, -1), scope);
      const parts = splitTopMath(e);
      if (parts.length > 1) {
        const types = parts.map((p) => inferType(p, scope));
        for (const rank of ['vec4', 'vec3', 'vec2', 'ivec4', 'ivec3', 'ivec2', 'int', 'float']) {
          if (types.includes(rank)) return rank;
        }
        return types[0];
      }
      if (e.startsWith('-') || e.startsWith('+')) return inferType(e.slice(1), scope);
      if (e.startsWith('!')) return 'bool';
      const callMatch = e.match(/^([A-Za-z_]\w*)\s*\(/);
      if (callMatch) {
        const openIdx = e.indexOf('(');
        const end = matchParen(e, openIdx);
        const rest = e.slice(end + 1).trim();
        let baseType = fnReturn[callMatch[1]];
        if (!baseType) {
          const args = splitTopArgs(e.slice(openIdx + 1, end));
          if (callMatch[1] === '_wgsl_select' || callMatch[1] === 'select') baseType = inferType(args[0], scope);
          else if (callMatch[1] === 'smoothstep' || callMatch[1] === 'step') baseType = inferType(args[args.length - 1], scope);
          else baseType = inferType(args[0], scope);
        }
        return rest.startsWith('.') ? swizzleType(rest.slice(1)) : (baseType || 'float');
      }
      if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(e)) {
        const segs = e.split('.');
        let cur = scope[segs[0]] || globalVars[segs[0]] || (segs[0] === 'u' ? 'Uniforms' : 'float');
        for (let i = 1; i < segs.length; i += 1) {
          cur = (structFields[cur] && structFields[cur][segs[i]]) || swizzleType(segs[i]);
        }
        return cur;
      }
      if (/^[A-Za-z_]\w*$/.test(e)) return scope[e] || globalVars[e] || 'float';
      if (/^\d+$/.test(e)) return 'int';
      return 'float';
    };

    const fnRe = /fn\s+(\w+)\s*\(([\s\S]*?)\)\s*->\s*([A-Za-z0-9_<>]+)\s*\{/g;
    let result = '';
    let pos = 0, fm;
    while ((fm = fnRe.exec(code)) !== null) {
      result += code.slice(pos, fm.index);
      const fnName = fm[1];
      const rawParams = fm[2];
      const retType = mapType(fm[3]);
      const bodyStart = fm.index + fm[0].length;
      let depth = 1, idx = bodyStart;
      for (; idx < code.length; idx += 1) {
        if (code[idx] === '{') depth += 1;
        else if (code[idx] === '}') { depth -= 1; if (depth === 0) break; }
      }
      const rawBody = code.slice(bodyStart, idx);
      pos = idx + 1;
      fnRe.lastIndex = pos;

      const scope = {};
      const glParams = splitTopArgs(rawParams).map((param) => {
        const pm = param.match(/^(\w+)\s*:\s*([A-Za-z0-9_<>]+)$/);
        const pt = mapType(pm[2]);
        scope[pm[1]] = pt;
        return `${pt} ${pm[1]}`;
      }).join(', ');

      let body = rawBody.replace(/for\s*\(\s*var\s+(\w+)\s*(?::\s*([A-Za-z0-9_<>]+))?\s*=\s*([^;]+);/g, (_m2, v, vt, init) => {
        const gt = vt ? mapType(vt) : inferType(init, scope);
        scope[v] = gt;
        return `for (${gt} ${v} = ${convertExpr(init)};`;
      });
      body = body.replace(/\bvar\s+(\w+)\s*:\s*([A-Za-z0-9_<>]+)\s*;/g, (_m2, v, vt) => {
        const gt = mapType(vt);
        scope[v] = gt;
        return `${gt} ${v};`;
      });
      body = body.replace(/\b(let|var)\s+(\w+)\s*:\s*([A-Za-z0-9_<>]+)\s*=\s*([^;]+);/g, (_m2, _kw, v, vt, rhs) => {
        const gt = mapType(vt);
        scope[v] = gt;
        return `${gt} ${v} = ${convertExpr(rhs)};`;
      });
      body = body.replace(/\b(let|var)\s+(\w+)\s*=\s*([^;]+);/g, (_m2, _kw, v, rhs) => {
        const conv = convertExpr(rhs);
        const gt = inferType(conv, scope);
        scope[v] = gt;
        return `${gt} ${v} = ${conv};`;
      });
      body = convertExpr(body);
      result += `${retType} ${fnName}(${glParams}) {${body}}`;
    }
    result += code.slice(pos);

    return `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 fragColor;
float _wgsl_select(float f, float t, bool c) { return c ? t : f; }
vec2 _wgsl_select(vec2 f, vec2 t, bool c) { return c ? t : f; }
vec3 _wgsl_select(vec3 f, vec3 t, bool c) { return c ? t : f; }
vec4 _wgsl_select(vec4 f, vec4 t, bool c) { return c ? t : f; }
${result}
void main() {
  vec4 c = orbGlassLiquidAnim(v_uv);
  vec2 fc = vec2(v_uv.x, 1.0 - v_uv.y) * u.size;
  vec2 uv = (2.0 * fc - u.size) / max(min(u.size.x, u.size.y), 1.0);
  float rad = max(u.radius, 0.05);
  float t = u.time * u.speed;
  float contourRad = rad * glsContourScale(uv, t, u.contourDeform);
  vec2 q = (2.0 * fc - u.size) / u.size;
  float fitEnd = 1.0;
  float fitFeather = 2.0 / max(min(u.size.x, u.size.y), 1.0);
  float fitStart = min(mix(contourRad, fitEnd, 0.5), fitEnd - fitFeather);
  float fit = 1.0 - smoothstep(fitStart, fitEnd, max(abs(q.x), abs(q.y)));
  fragColor = vec4(c.rgb * fit, c.a * fit);
}`;
  }

  window.buildLiquidOrbShaderSource = buildOrbShaderSource;
  window.buildLiquidOrbGlslSource = buildOrbGlslSource;

  async function acquireHardwareDevice(abortIfSignaled) {
    const candidates = [
      undefined,
      { powerPreference: 'high-performance' },
      { powerPreference: 'low-power' },
      { featureLevel: 'compatibility' },
    ];
    let lastError = null;
    let sawFallback = false;
    for (const opts of candidates) {
      let adapter = null;
      try {
        adapter = opts ? await navigator.gpu.requestAdapter(opts) : await navigator.gpu.requestAdapter();
      } catch (error) {
        lastError = error;
        continue;
      }
      abortIfSignaled();
      if (!adapter) continue;
      if (adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) {
        sawFallback = true;
        continue;
      }
      try {
        const device = await adapter.requestDevice();
        abortIfSignaled();
        return device;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    if (sawFallback) throw new Error('WebGPU adapter is software fallback');
    throw new Error('No WebGPU adapter');
  }

  const WEBGPU_STAGE_BUDGET_MS = 4500;
  const GLSL_VERTEX_SHADER = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  vec2 pos = p[gl_VertexID];
  gl_Position = vec4(pos, 0.0, 1.0);
  vec2 uv01 = (pos + vec2(1.0)) * 0.5;
  v_uv = vec2(uv01.x, 1.0 - uv01.y);
}`;

  function startOrbController(canvas, options, startedAt, gpu) {
    const { backend, device, shader, pipeline, drawFrame, disposeBackend, bindBackendErrors } = gpu;
    canvas.dataset.orbBackend = backend;
    const values = new Float32Array(136);
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

    function failController(error) {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
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
        const breathWeight = Math.max(0, Math.min(1, (.12 - current.contourDeform) / .06));
        const breath = reduced ? 0 : Math.sin(phase * 1.32);
        const drift = reduced ? 0 : Math.sin(phase * .73 + Math.sin(phase * .21));
        rendered.radius = current.radius * (1 + breath * .018 * breathWeight);
        rendered.contourDeform = Math.max(0, current.contourDeform + fluidity * (Math.sin(phase * .91) * .12 + Math.sin(phase * 1.37 + 1.8) * .08));
        rendered.warp = current.warp + drift * fluidity * .28;
        rendered.edgeGlow = current.edgeGlow * (1 + breath * .32 * breathWeight);
        if (!reduced) {
          for (const key in modulation) {
            if (typeof rendered[key] === 'number' && Number.isFinite(modulation[key])) rendered[key] += modulation[key];
          }
        }
        writeUniforms(values, canvas.width, canvas.height, phase, rendered);
        drawFrame(values);
        if (!ready) {
          ready = true;
          canvas.dataset.firstFrameMs = String(Math.round(performance.now() - startedAt));
          options.onReady?.();
        }
        if (!reduced) raf = requestAnimationFrame(frame);
      } catch (error) {
        failController(error);
      }
    }

    bindBackendErrors?.(failController);
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
      backend,
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
        disposeBackend(destroyDevice);
      }
    };
  }

  async function initWebGPUBackend(canvas, options, startedAt) {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable');
    const sharedResources = options.sharedResources;
    const outerSignal = options.signal;
    const budgetAbort = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const budgetTimer = budgetAbort ? setTimeout(() => {
      timedOut = true;
      budgetAbort.abort();
    }, WEBGPU_STAGE_BUDGET_MS) : 0;
    const ownsDevice = !sharedResources?.device;
    let device = sharedResources?.device;
    const abortIfSignaled = () => {
      if (!outerSignal?.aborted && !budgetAbort?.signal.aborted) return;
      if (ownsDevice && device) {
        try { device.destroy(); } catch { /* already lost */ }
      }
      throw new Error(timedOut ? 'WebGPU shader compilation timed out' : 'WebGPU startup aborted');
    };
    try {
      abortIfSignaled();
      if (!device) {
        device = await acquireHardwareDevice(abortIfSignaled);
      }
      const format = navigator.gpu.getPreferredCanvasFormat();
      const reusePipeline = Boolean(
        sharedResources?.shader
        && sharedResources?.pipeline
        && sharedResources.shader.__fixedStyle === options.fixedStyle
      );
      const shader = reusePipeline ? sharedResources.shader : device.createShaderModule({
        code: buildOrbShaderSource(window.LiquidOrbEffectSource, options.fixedStyle),
      });
      if (!reusePipeline) {
        try { Object.defineProperty(shader, '__fixedStyle', { value: options.fixedStyle }); } catch { /* frozen mock */ }
        const compilation = await shader.getCompilationInfo();
        abortIfSignaled();
        const errors = compilation.messages.filter((message) => message.type === 'error');
        if (errors.length) {
          if (ownsDevice) device.destroy();
          throw new Error(errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n'));
        }
      }
      const pipelineDescriptor = {
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
      };
      const pipeline = reusePipeline ? sharedResources.pipeline : (
        typeof device.createRenderPipelineAsync === 'function'
          ? await device.createRenderPipelineAsync(pipelineDescriptor)
          : device.createRenderPipeline(pipelineDescriptor)
      );
      abortIfSignaled();
      // Acquire the canvas context ONLY after device + shader + pipeline succeed,
      // so a WebGPU failure leaves the canvas untouched for WebGL2 fallback.
      const context = canvas.getContext('webgpu');
      if (!context) {
        if (ownsDevice) device.destroy();
        throw new Error('No WebGPU canvas context');
      }
      context.configure({ device, format, alphaMode: 'premultiplied' });
      const uniformBuffer = device.createBuffer({ size: 136 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
      });
      return startOrbController(canvas, options, startedAt, {
        backend: 'webgpu',
        device,
        shader,
        pipeline,
        drawFrame(values) {
          device.queue.writeBuffer(uniformBuffer, 0, values);
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({ colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store'
          }] });
          pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3,1,0,0); pass.end();
          device.queue.submit([encoder.finish()]);
        },
        bindBackendErrors(fail) {
          device.lost.then((info) => {
            fail(new Error(info.message || info.reason || 'WebGPU device lost'));
          });
          device.addEventListener('uncapturederror', (event) => {
            event.preventDefault();
            fail(new Error(event.error.message));
          });
        },
        disposeBackend(destroyDevice) {
          try { uniformBuffer.destroy?.(); } catch { /* already lost */ }
          if (destroyDevice) {
            try { device.destroy(); } catch { /* already lost */ }
          }
        },
      });
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  function acquireWebGL2Context(canvas, allowSoftware) {
    const baseAttrs = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    };
    if (!allowSoftware) {
      const strictGl = canvas.getContext('webgl2', { ...baseAttrs, failIfMajorPerformanceCaveat: true });
      if (strictGl) return strictGl;
    }
    const gl = canvas.getContext('webgl2', baseAttrs);
    if (!gl) return null;
    if (!allowSoftware) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(
        (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') || gl.getParameter(gl.RENDERER) || ''
      );
      if (/SwiftShader|Microsoft Basic Render|llvmpipe|Software Rasterizer/i.test(renderer)) {
        try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
        throw new Error(`WebGL2 renderer is software fallback (${renderer})`);
      }
    }
    return gl;
  }

  function initWebGL2Backend(canvas, options, startedAt, allowSoftware = false) {
    if (options.signal?.aborted) throw new Error('WebGL2 startup aborted');
    const gl = acquireWebGL2Context(canvas, allowSoftware);
    if (!gl) throw new Error('No WebGL2 canvas context');

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) || 'WebGL2 shader compile failed';
        gl.deleteShader(shader);
        throw new Error(log);
      }
      return shader;
    };

    let vs = null, fs = null, program = null, vao = null, ubo = null;
    try {
      vs = compile(gl.VERTEX_SHADER, GLSL_VERTEX_SHADER);
      fs = compile(gl.FRAGMENT_SHADER, buildOrbGlslSource(window.LiquidOrbEffectSource, options.fixedStyle));
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'WebGL2 program link failed');
      }
      const blockIndex = gl.getUniformBlockIndex(program, 'Uniforms');
      if (blockIndex !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(program, blockIndex, 0);
      }
      vao = gl.createVertexArray();
      ubo = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, 136 * 4, gl.DYNAMIC_DRAW);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
    } catch (error) {
      if (ubo) gl.deleteBuffer(ubo);
      if (vao) gl.deleteVertexArray(vao);
      if (program) gl.deleteProgram(program);
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
      throw error;
    }

    let onLost = null;
    return startOrbController(canvas, options, startedAt, {
      backend: 'webgl2',
      device: null,
      shader: null,
      pipeline: null,
      drawFrame(values) {
        if (gl.isContextLost()) throw new Error('WebGL2 context lost');
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, values);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      bindBackendErrors(fail) {
        onLost = (event) => {
          event.preventDefault();
          fail(new Error('WebGL2 context lost'));
        };
        canvas.addEventListener?.('webglcontextlost', onLost);
      },
      disposeBackend() {
        if (onLost) canvas.removeEventListener?.('webglcontextlost', onLost);
        try {
          gl.deleteBuffer(ubo);
          gl.deleteVertexArray(vao);
          gl.deleteProgram(program);
          gl.deleteShader(vs);
          gl.deleteShader(fs);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch { /* already lost */ }
      },
    });
  }

  window.createLiquidOrbRenderer = async function createLiquidOrbRenderer(canvas, options = {}) {
    const orbParam = new URLSearchParams(window.location?.search || '').get('orb');
    if (orbParam === 'canvas') throw new Error('Canvas2D fallback requested');
    const startedAt = performance.now();
    const forceWebGL = orbParam === 'webgl' || orbParam === 'webgl2' || options.preferWebGL === true;
    if (!forceWebGL) {
      try {
        return await initWebGPUBackend(canvas, options, startedAt);
      } catch (webgpuError) {
        if (options.signal?.aborted) throw webgpuError;
        const message = webgpuError instanceof Error ? webgpuError.message : String(webgpuError);
        console.warn('[LiquidOrb] WebGPU unavailable, falling back to WebGL2:', message);
        try {
          return initWebGL2Backend(canvas, options, startedAt, false);
        } catch {
          throw webgpuError;
        }
      }
    }
    return initWebGL2Backend(canvas, options, startedAt, orbParam === 'webgl2' || orbParam === 'webgl');
  };
})();
