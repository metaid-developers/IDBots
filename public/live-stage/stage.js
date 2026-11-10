(() => {
  const initial = window.__INITIAL_LIVE_STAGE__;
  const storageKey = `idbots.live-stage:${initial.sessionId}:${initial.turnId}`;
  let state = initial;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved && saved.protocol === initial.protocol && saved.sessionId === initial.sessionId && saved.turnId === initial.turnId && saved.revision >= initial.revision) state = saved;
  } catch { /* the initial snapshot is sufficient */ }

  const body = document.body;
  const $ = (selector) => document.querySelector(selector);
  const canvas = $('.core-canvas');
  const ctx = canvas.getContext('2d');
  const reducedMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  const orbLayers = new Set();
  let orb = null, orbStarting = false, orbFailed = false;
  let handoffKey = '', handoffTimer = 0;
  let width = 0, height = 0, raf = 0;

  document.querySelectorAll('[data-avatar]').forEach((image) => {
    image.addEventListener('error', () => {
      if (image.src === window.__FALLBACK_AVATAR__) return;
      image.src = window.__FALLBACK_AVATAR__;
    });
  });

  function effectiveReduced() {
    return reducedMedia.matches || !state.enabled || document.hidden;
  }

  function resizeParticles() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth; height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  const particles = Array.from({ length: 42 }, (_, index) => {
    const random = (salt) => {
      const value = Math.sin(index * 91.731 + salt * 17.17) * 43758.5453;
      return value - Math.floor(value);
    };
    return { angle: random(1) * Math.PI * 2, radius: 110 + random(2) * 250, speed: .12 + random(3) * .35, size: .7 + random(4) * 1.8, drift: random(5) };
  });

  function drawParticles(time = 0) {
    if (!state || !width || !height) return;
    ctx.clearRect(0, 0, width, height);
    const reduced = effectiveReduced();
    if (reduced !== (body.dataset.motion === 'reduced')) {
      applyState();
      return;
    }
    const t = reduced ? state.motion.seed * .01 : time / 1000;
    const structured = state.topology.mode === 'structured';
    const cx = width * (structured ? .56 : .67), cy = height * .45;
    if (structured) {
      const nodes = Object.fromEntries(state.topology.nodes.map((node) => [node.id, node]));
      const points = {
        twin: { x: cx, y: cy },
        source: { x: width * .72, y: height * .2 },
        worker: { x: width * .87, y: height * .43 },
        evidence: { x: width * .84, y: height * .7 }
      };
      state.topology.edges.forEach(([fromId, toId], index) => {
        if (!nodes[fromId] || !nodes[toId]) return;
        const from = points[fromId], to = points[toId];
        if (!from || !to) return;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y);
        ctx.strokeStyle = 'rgba(255,220,81,.3)'; ctx.lineWidth = 1.1; ctx.stroke();
        const progress = reduced ? .6 : (t * .2 + index * .27) % 1;
        ctx.beginPath(); ctx.arc(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,220,81,.9)'; ctx.fill();
      });
    }
    particles.forEach((particle, index) => {
      const angle = particle.angle + t * particle.speed * state.motion.energy + state.motion.seed * .0001;
      let x = cx + Math.cos(angle) * particle.radius * 1.1;
      let y = cy + Math.sin(angle) * particle.radius * .62;
      if (state.family === 'local-recall' || state.family === 'web2-research' || state.family === 'metaweb-research') {
        const pull = .68 + Math.sin(t * .8 + particle.drift * 6) * .18;
        x = cx + Math.cos(angle) * particle.radius * pull * 1.2;
        y = cy + Math.sin(angle) * particle.radius * pull * .65;
      } else if (structured) {
        x = cx + Math.cos(angle) * particle.radius * .65;
        y = cy + Math.sin(angle) * particle.radius * .45;
      } else if (state.family === 'report-ready' || state.family === 'complete') {
        const arc = -Math.PI * .85 + (index / particles.length) * Math.PI * 1.7;
        x = cx + Math.cos(arc) * 190; y = cy + Math.sin(arc) * 125;
      }
      const alpha = state.family === 'report-ready' || state.family === 'complete' ? .18 : .18 + particle.drift * .35;
      ctx.beginPath(); ctx.fillStyle = index % 7 === 0 ? `rgba(255,220,81,${alpha + .2})` : `rgba(211,222,234,${alpha})`;
      ctx.arc(x, y, particle.size, 0, Math.PI * 2); ctx.fill();
    });
    if (!reduced) raf = requestAnimationFrame(drawParticles);
  }

  function restartParticles() {
    cancelAnimationFrame(raf);
    resizeParticles();
    drawParticles(performance.now());
  }

  function updateParticipants() {
    const container = $('[data-core-participants]');
    container.replaceChildren();
    state.participants.forEach((participant, index) => {
      const item = document.createElement('div');
      item.className = 'core-participant';
      const label = document.createElement('small');
      label.textContent = index === 0 ? 'In focus' : 'Connected';
      const value = document.createElement('span');
      value.textContent = participant;
      item.append(label, value);
      container.append(item);
    });
  }

  function disposeOrbLayer(layer) {
    if (!layer) return;
    clearTimeout(layer.fadeTimer);
    layer.controller?.dispose(false);
    layer.canvas.remove();
    orbLayers.delete(layer);
  }

  function disposeAllOrbLayers() {
    const devices = new Set([...orbLayers].map((layer) => layer.controller?.getSharedResources().device).filter(Boolean));
    orbLayers.forEach(disposeOrbLayer);
    devices.forEach((device) => device.destroy());
    orb = null;
    orbStarting = false;
  }

  function fallbackOrb(error) {
    orbFailed = true;
    disposeAllOrbLayers();
    body.dataset.orbBackend = 'canvas';
    window.__liveStageBackend = 'canvas';
    window.__liveStageOrbError = error instanceof Error ? error.message : String(error);
  }

  function failOrbLayer(layer, previous, error) {
    if (orb !== layer) {
      disposeOrbLayer(layer);
      return;
    }
    disposeOrbLayer(layer);
    orbStarting = false;
    if (previous && orbLayers.has(previous) && previous.controller) {
      orb = previous;
      previous.canvas.dataset.active = 'true';
      previous.controller.setReduced(effectiveReduced());
      body.dataset.orbBackend = 'webgpu';
      window.__liveStageBackend = 'webgpu';
    } else {
      orb = null;
      fallbackOrb(error);
    }
  }

  function mountOrb(family) {
    if (orbStarting || orbFailed || !state.enabled || document.hidden) return;
    const previous = orb;
    const style = window.liquidOrbStyleForFamily(family);
    const layerCanvas = document.createElement('canvas');
    layerCanvas.className = 'liquid-orb-canvas';
    layerCanvas.dataset.orbStyle = String(style);
    layerCanvas.setAttribute('aria-hidden', 'true');
    $('.membrane').append(layerCanvas);
    const layer = { canvas: layerCanvas, controller: null, style, family, fadeTimer: 0 };
    orbLayers.add(layer);
    orb = layer;
    orbStarting = true;
    window.createLiquidOrbRenderer(layerCanvas, {
      sharedResources: previous?.controller?.getSharedResources(),
      onReady: () => {
        if (orb !== layer) return;
        body.dataset.orbBackend = 'webgpu';
        window.__liveStageBackend = 'webgpu';
        layerCanvas.getBoundingClientRect();
        layerCanvas.dataset.active = 'true';
        if (previous && previous !== layer && orbLayers.has(previous)) {
          previous.canvas.dataset.active = 'false';
          if (effectiveReduced()) disposeOrbLayer(previous);
          else previous.fadeTimer = setTimeout(() => disposeOrbLayer(previous), 950);
        }
      },
      onError: (error) => failOrbLayer(layer, previous, error)
    }).then((controller) => {
      if (orb !== layer) {
        controller.dispose(false);
        return;
      }
      layer.controller = controller;
      orbStarting = false;
      controller.setState(layer.family, effectiveReduced());
      if (window.liquidOrbStyleForFamily(layer.family) !== layer.style) syncOrb(layer.family);
    }).catch((error) => failOrbLayer(layer, previous, error));
  }

  function syncOrb(family) {
    orbLayers.forEach((layer) => layer.controller?.setReduced(effectiveReduced()));
    if (orbFailed) return;
    if (!orb) {
      mountOrb(family);
      return;
    }
    if (effectiveReduced()) return;
    orb.family = family;
    if (orbStarting) return;
    if (orb.controller && orb.controller.getStyle() !== window.liquidOrbStyleForFamily(family)) mountOrb(family);
    else orb.controller?.setState(family, effectiveReduced());
  }

  function stopHandoff() {
    clearTimeout(handoffTimer);
    const motion = $('[data-handoff-motion]');
    try { motion.endElement(); } catch { /* the motion may not have started */ }
    $('[data-handoff-flow]').setAttribute('hidden', '');
    $('[data-handoff-label]').hidden = true;
  }

  function syncHandoff() {
    const handoff = state.handoff;
    body.dataset.handoff = handoff?.direction || 'none';
    if (effectiveReduced()) {
      stopHandoff();
      return;
    }
    const key = handoff ? `${handoff.direction}:${handoff.eventId}` : '';
    if (key === handoffKey) return;
    handoffKey = key;
    if (!handoff) {
      stopHandoff();
      return;
    }
    clearTimeout(handoffTimer);
    const motion = $('[data-handoff-motion]');
    const worker = state.topology.nodes.find((node) => node.kind === 'worker')?.label || 'Worker';
    $('[data-handoff-worker]').textContent = worker;
    $('[data-handoff-copy]').textContent = handoff.direction === 'return'
      ? (state.language === 'zh' ? '正在交回结果 · 等待 Twin 核验' : 'Returning work · Twin review required')
      : (state.language === 'zh' ? '正在接收获派任务' : 'Receiving the delegated step');
    motion.setAttribute('keyPoints', handoff.direction === 'return' ? '0;1' : '1;0');
    $('[data-handoff-flow]').removeAttribute('hidden');
    $('[data-handoff-label]').hidden = false;
    try {
      motion.beginElement();
      handoffTimer = setTimeout(stopHandoff, 2600);
    } catch {
      stopHandoff();
    }
  }

  function applyState() {
    body.dataset.enabled = String(state.enabled);
    body.dataset.family = state.family;
    body.dataset.topology = state.topology.mode;
    body.dataset.motion = effectiveReduced() ? 'reduced' : 'full';
    document.title = `${state.botName} · Live Stage`;
    $('[data-bot-name]').textContent = `${state.botName} · Twin presence`;
    $('[data-core-family]').textContent = state.family;
    $('[data-core-verb]').textContent = state.family;
    $('[data-core-title]').textContent = state.headline;
    $('[data-core-caption]').textContent = state.caption;
    const nodes = Object.fromEntries(state.topology.nodes.map((node) => [node.id, node]));
    $('[data-node-source]').textContent = nodes.source?.label || 'Source';
    $('[data-node-worker]').textContent = nodes.worker?.label || 'Worker';
    $('[data-node-evidence]').textContent = nodes.evidence?.label || 'Evidence';
    const metrics = state.metrics;
    $('[data-director-metrics]').textContent = metrics.directorEnabled
      ? `Director ${metrics.directorCalls} calls · ${metrics.inputTokens + metrics.outputTokens} tokens${metrics.fallbackCount ? ` · ${metrics.fallbackCount} fallback` : ''}`
      : '';
    updateParticipants();
    syncOrb(state.family);
    syncHandoff();
    restartParticles();
  }

  window.IDBotsLiveStage = {
    applyPatch(patch) {
      if (!patch || patch.protocol !== initial.protocol || patch.sessionId !== initial.sessionId || patch.turnId !== initial.turnId) return false;
      if (typeof patch.revision !== 'number' || patch.revision <= state.revision) return false;
      state = patch;
      try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* history still works in memory */ }
      applyState();
      return true;
    },
    getState: () => state
  };
  window.__getLiveStageState = () => state;
  window.__liveStageBackend = 'loading';
  reducedMedia.addEventListener('change', applyState);
  document.addEventListener('visibilitychange', applyState);
  window.addEventListener('pagehide', () => {
    disposeAllOrbLayers();
    stopHandoff();
    cancelAnimationFrame(raf);
  });
  new ResizeObserver(restartParticles).observe(canvas);
  applyState();
  window.__ready = true;
})();
