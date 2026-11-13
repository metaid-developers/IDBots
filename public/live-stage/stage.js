(() => {
  const PROTOCOL = 'idbots.live-stage.v1';
  const initial = window.__INITIAL_LIVE_STAGE__;
  const bootLanguage = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  // The persistent stage entry boots UNCLAIMED: orb breathing, fallback
  // avatar, no text. The first accepted patch claims the page for its
  // session; same-origin iframes share sessionStorage, so nothing is ever
  // restored from it — the host re-patches after every reload.
  const IDLE_STATE = {
    protocol: PROTOCOL,
    sessionId: '',
    turnId: '',
    turnStartedAt: 0,
    revision: 0,
    enabled: true,
    family: 'idle',
    botName: '',
    language: bootLanguage,
    kicker: '',
    headline: '',
    caption: '',
    captionSource: 'default',
    phaseStartedAt: 0,
    composition: 'presence',
    motif: 'idle',
    participants: [],
    topology: { mode: 'presence', nodes: [], edges: [] },
    motion: { preset: 'idle', seed: 1, durationMs: 720, easing: 'emphasized-decelerate', energy: .3, density: .2 },
    metrics: { directorEnabled: false, directorCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rejectedPatches: 0, fallbackCount: 0, directorLatencyMs: 0 },
    handoff: null,
    interaction: null,
    pendingProjectionIds: [],
    eventWindow: [],
  };
  let state = initial && typeof initial === 'object' ? initial : IDLE_STATE;
  // A page rendered with a baked initial state (legacy per-turn files, the
  // offline demo) starts claimed by that state; the persistent entry starts
  // unclaimed and claims on the first accepted patch.
  let claimedSessionId = typeof initial?.sessionId === 'string' && initial.sessionId ? initial.sessionId : null;

  const body = document.body;
  const $ = (selector) => document.querySelector(selector);
  const tr = (zh, en) => (state.language === 'zh' ? zh : en);
  const reportOpen = $('[data-report-open]');
  const reportReadyText = $('[data-report-ready-text]');
  if (reportReadyText) reportReadyText.textContent = tr('汇报就绪', 'Report ready');
  reportOpen.addEventListener('click', () => {
    const uri = typeof state.reportUri === 'string' ? state.reportUri : '';
    if (!uri.startsWith('preview-metaapp://localhost/')) return;
    window.parent.postMessage({
      source: 'idbots-live-stage',
      type: 'open-report',
      uri
    }, '*');
  });
  const canvas = $('.core-canvas');
  const ctx = canvas.getContext('2d');
  const reducedMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  const orbLayers = new Set();
  let orb = null, orbStarting = false, orbFailed = false;
  let handoffKey = '', handoffTimer = 0;
  let interactionKey = '', interactionTimer = 0;
  const interactionQueue = [];
  const interactionSelections = new Map();
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

  const textChannels = [
    { element: $('[data-core-title]'), value: '', chars: [], typed: 0, nextAt: 0, typing: false, renderedTyped: -1, delay: 80, zhRate: 30, enRate: 58, doneAt: 0 },
    { element: $('[data-core-caption]'), value: '', chars: [], typed: 0, nextAt: 0, typing: false, renderedTyped: -1, delay: 220, zhRate: 38, enRate: 72, doneAt: 0 },
  ];
  const textMotion = { energy: 0, voiceUntil: 0, lastFrameAt: 0 };
  const TEXT_PAUSES = { '，': 160, '、': 140, ',': 120, '；': 220, ';': 200, '：': 180, ':': 160, '。': 360, '！': 360, '？': 360, '.': 300, '!': 300, '?': 300, '…': 260, '—': 160 };

  function renderTextChannel(channel) {
    if (channel.renderedTyped === channel.typed) return;
    channel.renderedTyped = channel.typed;
    const freshFrom = channel.typing ? Math.max(0, channel.typed - 2) : channel.typed;
    const nodes = [];
    const settled = channel.chars.slice(0, freshFrom).join('');
    if (settled) nodes.push(document.createTextNode(settled));
    if (freshFrom < channel.typed) {
      const fresh = document.createElement('span');
      fresh.className = 'core-fresh';
      fresh.textContent = channel.chars.slice(freshFrom, channel.typed).join('');
      nodes.push(fresh);
    }
    if (channel.typing) {
      const caret = document.createElement('span');
      caret.className = 'core-caret';
      caret.setAttribute('aria-hidden', 'true');
      nodes.push(caret);
    }
    channel.element.replaceChildren(...nodes);
    channel.element.dataset.typing = String(channel.typing);
  }

  function setTextChannel(channel, value, now) {
    const next = typeof value === 'string' ? value : '';
    if (channel.value === next) return;
    // Streaming growth: when the new value only extends the old one, keep the
    // typing cursor where it is so the text grows smoothly instead of
    // restarting from the first character on every patch.
    const appendOnly = channel.value.length > 0 && next.startsWith(channel.value);
    channel.value = next;
    channel.chars = Array.from(next);
    if (appendOnly) {
      channel.typed = Math.min(channel.typed, channel.chars.length);
      channel.typing = !effectiveReduced() && channel.typed < channel.chars.length;
      channel.doneAt = channel.typing ? channel.doneAt : Date.now();
      channel.renderedTyped = -1;
      renderTextChannel(channel);
      return;
    }
    channel.typing = !effectiveReduced() && channel.chars.length > 0;
    channel.typed = channel.typing ? 0 : channel.chars.length;
    channel.nextAt = now + channel.delay;
    channel.doneAt = channel.typing ? 0 : Date.now();
    channel.renderedTyped = -1;
    renderTextChannel(channel);
  }

  function finishTextChannels() {
    for (const channel of textChannels) {
      channel.typed = channel.chars.length;
      channel.typing = false;
      channel.doneAt = Date.now();
      renderTextChannel(channel);
    }
  }

  function updateTextMotion(now) {
    const dt = textMotion.lastFrameAt === 0 ? 0 : Math.min(.08, Math.max(0, (now - textMotion.lastFrameAt) / 1000));
    textMotion.lastFrameAt = now;
    textMotion.energy *= Math.exp(-dt * 7.5);
    if (effectiveReduced()) {
      finishTextChannels();
      textMotion.energy = 0;
      textMotion.voiceUntil = 0;
    } else {
      for (const channel of textChannels) {
        if (!channel.typing) continue;
        let changed = false;
        while (channel.typing && now >= channel.nextAt) {
          const char = channel.chars[channel.typed];
          channel.typed += 1;
          changed = true;
          if (/[\p{L}\p{N}]/u.test(char)) textMotion.energy = Math.min(1, textMotion.energy + (state.language === 'zh' ? .42 : .24));
          textMotion.voiceUntil = now + 150;
          channel.nextAt += 1000 / (state.language === 'zh' ? channel.zhRate : channel.enRate) + (TEXT_PAUSES[char] || 0);
          if (channel.typed >= channel.chars.length) {
            channel.typing = false;
            channel.doneAt = Date.now();
          }
        }
        if (changed) renderTextChannel(channel);
      }
    }
    body.dataset.voice = !effectiveReduced() && now < textMotion.voiceUntil ? 'on' : 'off';
    const activity = window.liquidOrbActivityForFamily(state.family);
    const quiet = activity === 'speaking' || activity === 'resting';
    const modulation = {
      radius: textMotion.energy * .008,
      contourDeform: textMotion.energy * .025,
      edgeGlow: quiet ? textMotion.energy * .07 : 0,
      exposure: quiet ? textMotion.energy * .08 : 0,
    };
    orbLayers.forEach((layer) => layer.controller?.setModulation(modulation));
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
    const now = time || performance.now();
    updateTextMotion(now);
    ctx.clearRect(0, 0, width, height);
    const reduced = effectiveReduced();
    if (reduced !== (body.dataset.motion === 'reduced')) {
      applyState();
      return;
    }
    const t = reduced ? state.motion.seed * .01 : now / 1000;
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
      const curveFor = (from, to) => ({
        x: (from.x + to.x) / 2,
        y: (from.y + to.y) / 2 - Math.min(64, Math.hypot(to.x - from.x, to.y - from.y) * .18)
      });
      const pointOnCurve = (from, control, to, progress) => {
        const inverse = 1 - progress;
        return {
          x: inverse * inverse * from.x + 2 * inverse * progress * control.x + progress * progress * to.x,
          y: inverse * inverse * from.y + 2 * inverse * progress * control.y + progress * progress * to.y
        };
      };
      state.topology.edges.forEach(([fromId, toId], index) => {
        if (!nodes[fromId] || !nodes[toId]) return;
        const from = points[fromId], to = points[toId];
        if (!from || !to) return;
        const control = curveFor(from, to);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
        ctx.strokeStyle = 'rgba(155,244,255,.26)'; ctx.lineWidth = 1; ctx.stroke();
        const progress = reduced ? .6 : (t * .2 + index * .27) % 1;
        const point = pointOnCurve(from, control, to, progress);
        ctx.beginPath(); ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(197,169,255,.85)'; ctx.fill();
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
      ctx.beginPath(); ctx.fillStyle = index % 7 === 0 ? `rgba(155,244,255,${alpha + .12})` : `rgba(197,169,255,${alpha})`;
      ctx.arc(x, y, particle.size, 0, Math.PI * 2); ctx.fill();
    });
    if (!reduced) raf = requestAnimationFrame(drawParticles);
  }

  function restartParticles() {
    cancelAnimationFrame(raf);
    resizeParticles();
    drawParticles(performance.now());
    if (!$('[data-handoff-flow]').hasAttribute('hidden')) layoutHandoff();
  }

  function updateParticipants() {
    const container = $('[data-core-participants]');
    container.replaceChildren();
    // participants[0] is always the twin itself — the block lists only the
    // collaborators the stage is working with, and hides when there are none.
    const collaborators = state.participants.slice(1);
    container.hidden = collaborators.length === 0;
    collaborators.forEach((participant) => {
      const item = document.createElement('div');
      item.className = 'core-participant';
      const label = document.createElement('small');
      label.textContent = tr('协作', 'With');
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
    const params = window.liquidOrbParamsForFamily(family);
    const style = params.style;
    const layerCanvas = document.createElement('canvas');
    layerCanvas.className = 'liquid-orb-canvas';
    layerCanvas.dataset.orbStyle = String(style);
    layerCanvas.setAttribute('aria-hidden', 'true');
    $('.membrane').append(layerCanvas);
    const layer = { canvas: layerCanvas, controller: null, style, family, speed: params.speed, fadeTimer: 0 };
    orbLayers.add(layer);
    orb = layer;
    orbStarting = true;
    const previousPhase = previous?.controller?.getPhase();
    window.createLiquidOrbRenderer(layerCanvas, {
      initialFamily: family,
      startPhase: Number.isFinite(previousPhase) ? previousPhase * ((previous?.speed || 1) / (params.speed || 1)) : undefined,
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
    orb.family = family;
    orb.speed = window.liquidOrbParamsForFamily(family).speed;
    if (orbStarting) return;
    if (!effectiveReduced() && orb.controller && orb.controller.getStyle() !== window.liquidOrbStyleForFamily(family)) mountOrb(family);
    else orb.controller?.setState(family, effectiveReduced());
  }

  function layoutHandoff() {
    const stage = $('.live-stage').getBoundingClientRect();
    if (stage.width < 1 || stage.height < 1) return;
    const worker = $('.hybrid-worker').getBoundingClientRect();
    const orb = $('.membrane').getBoundingClientRect();
    const from = { x: worker.left + worker.width / 2 - stage.left, y: worker.top + worker.height / 2 - stage.top };
    const to = { x: orb.left + orb.width / 2 - stage.left, y: orb.top + orb.height / 2 - stage.top };
    const control = {
      x: (from.x + to.x) / 2,
      y: Math.max(24, Math.min(from.y, to.y) - Math.min(72, stage.height * .1))
    };
    const path = `M${from.x} ${from.y} Q${control.x} ${control.y} ${to.x} ${to.y}`;
    $('[data-handoff-flow]').setAttribute('viewBox', `0 0 ${stage.width} ${stage.height}`);
    $('[data-handoff-track]').setAttribute('d', path);
    $('[data-handoff-motion]').setAttribute('path', path);
  }

  function stopHandoff() {
    clearTimeout(handoffTimer);
    const motion = $('[data-handoff-motion]');
    try { motion.endElement(); } catch { /* the motion may not have started */ }
    const flow = $('[data-handoff-flow]');
    const label = $('[data-handoff-label]');
    flow.classList.add('is-leaving');
    label.classList.add('is-leaving');
    handoffTimer = setTimeout(() => {
      flow.setAttribute('hidden', '');
      label.hidden = true;
      flow.classList.remove('is-leaving');
      label.classList.remove('is-leaving');
    }, 260);
  }

  function updateWorkerVisual(worker) {
    const image = $('[data-worker-avatar]');
    const fallback = $('[data-worker-fallback]');
    const handoffImage = $('[data-handoff-avatar]');
    const avatar = typeof worker?.avatar === 'string' && /^(?:data:image\/|https?:\/\/|avatars\/)/i.test(worker.avatar) ? worker.avatar : '';
    image.onerror = () => {
      image.hidden = true;
      fallback.hidden = false;
      handoffImage.hidden = true;
    };
    handoffImage.onerror = () => {
      handoffImage.hidden = true;
      image.hidden = true;
      fallback.hidden = false;
    };
    if (avatar) {
      image.src = avatar;
      handoffImage.src = avatar;
      image.hidden = false;
      handoffImage.hidden = false;
      fallback.hidden = true;
    } else {
      image.removeAttribute('src');
      handoffImage.removeAttribute('src');
      image.hidden = true;
      handoffImage.hidden = true;
      fallback.hidden = false;
    }
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
    const flow = $('[data-handoff-flow]');
    const label = $('[data-handoff-label]');
    const motion = $('[data-handoff-motion]');
    const worker = state.topology.nodes.find((node) => node.kind === 'worker')?.label || tr('协作 Bot', 'Worker');
    $('[data-handoff-worker]').textContent = worker;
    $('[data-handoff-copy]').textContent = handoff.direction === 'return'
      ? (state.language === 'zh' ? `正在交回结果 · 等待 ${state.botName} 核验` : `Returning work · ${state.botName} review required`)
      : (state.language === 'zh' ? '正在接收获派任务' : 'Receiving the delegated step');
    motion.setAttribute('keyPoints', handoff.direction === 'return' ? '0;1' : '1;0');
    flow.classList.remove('is-leaving');
    label.classList.remove('is-leaving');
    layoutHandoff();
    flow.removeAttribute('hidden');
    label.hidden = false;
    try {
      motion.beginElement();
      handoffTimer = setTimeout(stopHandoff, 5000);
    } catch {
      stopHandoff();
    }
  }

  // Interaction card: the stage hosts ordinary prompts (asks + plain approvals)
  // as a presentation surface. The host still owns the decision — clicks are
  // queued here and drained over the patch channel; the card never resolves
  // anything by itself. All text goes through textContent (no HTML injection).
  const interactionCopy = (zh, en) => (state.language === 'zh' ? zh : en);

  function stopInteractionCountdown() {
    if (interactionTimer) {
      clearInterval(interactionTimer);
      interactionTimer = 0;
    }
  }

  function interactionOptions(interaction, question, index, block) {
    const selections = interactionSelections.get(index) ?? new Set();
    interactionSelections.set(index, selections);
    const wrap = document.createElement('div');
    wrap.className = 'interaction-options';
    question.options.forEach((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'interaction-option';
      const label = document.createElement('span');
      label.textContent = option.label;
      button.append(label);
      if (option.description) {
        const description = document.createElement('small');
        description.textContent = option.description;
        button.append(description);
      }
      button.addEventListener('click', () => {
        if (question.multiSelect) {
          if (selections.has(option.label)) selections.delete(option.label);
          else selections.add(option.label);
          button.classList.toggle('is-selected', selections.has(option.label));
        } else {
          selections.clear();
          selections.add(option.label);
          wrap.querySelectorAll('.interaction-option').forEach((sibling) => sibling.classList.remove('is-selected'));
          button.classList.add('is-selected');
        }
        syncInteractionValidity(interaction, block.closest('[data-interaction-card]'));
      });
      wrap.append(button);
    });
    return wrap;
  }

  function interactionQuestionBlock(interaction, question, index) {
    const block = document.createElement('div');
    block.className = 'interaction-question';
    block.dataset.interactionQuestion = String(index);
    const label = document.createElement('div');
    label.className = 'interaction-question-label';
    label.textContent = interaction.questions.length > 1 ? `${index + 1}. ${question.question}` : question.question;
    block.append(label);
    if (question.detail) {
      const detail = document.createElement('div');
      detail.className = 'interaction-question-detail';
      detail.textContent = question.detail;
      block.append(detail);
    }
    if (question.options.length > 0) block.append(interactionOptions(interaction, question, index, block));
    const custom = document.createElement('textarea');
    custom.className = 'interaction-custom';
    custom.rows = 2;
    custom.placeholder = question.options.length > 0
      ? interactionCopy('其他想法（可选）', 'Add your own answer (optional)')
      : interactionCopy('请输入你的回答', 'Type your answer');
    custom.addEventListener('input', () => syncInteractionValidity(interaction, custom.closest('[data-interaction-card]')));
    block.append(custom);
    return block;
  }

  function syncInteractionValidity(interaction, card) {
    // The submit starts DISABLED for asks, so the gate must never bail on the
    // disabled state itself — that guard is what kept the 2026-11-12 MetaPo
    // card's submit grey forever (9792a14f fixed the selector but this guard
    // still returned before `submit.disabled = !ready` could ever run). The
    // terminal answered/declined/skipped state is carried by the card-level
    // done flag instead, which completeInteraction sets and a rebuilt card
    // clears.
    if (!card || card.dataset.interactionDone === 'true') return;
    const submit = card.querySelector('[data-interaction-submit]');
    if (!submit) return;
    let ready = true;
    card.querySelectorAll('[data-interaction-question]').forEach((block) => {
      const index = Number(block.dataset.interactionQuestion);
      const question = interaction.questions[index];
      const custom = block.querySelector('.interaction-custom').value.trim();
      const selections = interactionSelections.get(index);
      const answered = (selections && selections.size > 0) || (custom.length > 0 && question.options.length === 0);
      block.classList.toggle('is-invalid', !answered);
      if (!answered) ready = false;
    });
    submit.disabled = !ready;
  }

  function collectInteractionAnswers(interaction, card) {
    const answers = {};
    interaction.questions.forEach((question, index) => {
      const block = card.querySelector(`[data-interaction-question="${index}"]`);
      const segments = [...(interactionSelections.get(index) ?? [])];
      const custom = block ? block.querySelector('.interaction-custom').value.trim() : '';
      if (custom) segments.push(custom);
      answers[question.question] = segments.join('|||');
    });
    return answers;
  }

  // Primary return path: hand the click to the Bot Browser shell bridge the
  // moment it happens (stage → shell → renderer → main). The in-page queue +
  // host poll stays as the fallback; the host dedupes by requestId/token, so
  // a click delivered through both paths resolves exactly once.
  function emitInteraction(entry) {
    interactionQueue.push(entry);
    try {
      window.parent.postMessage({ source: 'idbots-live-stage', type: 'stage-interaction', entry }, '*');
    } catch { /* the poll fallback still carries it */ }
  }

  function completeInteraction(card, message) {
    card.dataset.interactionDone = 'true';
    const done = card.querySelector('[data-interaction-done]');
    if (done) {
      done.textContent = message;
      done.hidden = false;
    }
    card.querySelectorAll('.interaction-button').forEach((button) => { button.disabled = true; });
  }

  function syncInteractionCountdown(interaction, card) {
    const countdown = card.querySelector('[data-interaction-countdown]');
    if (!countdown) return;
    if (typeof interaction.expiresAt !== 'number' || interaction.expiresAt <= 0) {
      countdown.hidden = true;
      return;
    }
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((interaction.expiresAt - Date.now()) / 1000));
      countdown.hidden = false;
      countdown.textContent = seconds > 0
        ? interactionCopy(`约 ${seconds} 秒后自动拒绝`, `auto-denies in ~${seconds}s`)
        : interactionCopy('已超时，等待宿主确认', 'Expired — waiting for the host watchdog');
      if (seconds <= 0) {
        stopInteractionCountdown();
        card.querySelectorAll('.interaction-button').forEach((button) => { button.disabled = true; });
      }
    };
    tick();
    interactionTimer = setInterval(tick, 500);
  }

  function buildInteractionCard(interaction) {
    const isAsk = interaction.kind === 'ask' && interaction.questions.length > 0;
    const card = $('[data-interaction-card]');
    const fragment = document.createDocumentFragment();
    const kicker = document.createElement('div');
    kicker.className = 'interaction-kicker';
    kicker.textContent = isAsk ? interactionCopy('需要你的输入', 'Your input is needed') : interactionCopy('需要你的授权', 'Your approval is needed');
    const title = document.createElement('h2');
    title.className = 'interaction-title';
    title.textContent = interaction.title;
    fragment.append(kicker, title);
    if (interaction.detail && !isAsk) {
      const detail = document.createElement('p');
      detail.className = 'interaction-detail';
      detail.textContent = interaction.detail;
      fragment.append(detail);
    }
    if (isAsk) {
      const questions = document.createElement('div');
      questions.className = 'interaction-questions';
      interaction.questions.forEach((question, index) => questions.append(interactionQuestionBlock(interaction, question, index)));
      fragment.append(questions);
    }
    const actions = document.createElement('div');
    actions.className = 'interaction-actions';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'interaction-button is-danger';
    deny.textContent = interactionCopy('拒绝', 'Deny');
    deny.addEventListener('click', () => {
      emitInteraction({ requestId: interaction.requestId, token: interaction.token, behavior: 'deny' });
      completeInteraction(card, interactionCopy('已拒绝，等待舞台更新…', 'Declined — waiting for the stage…'));
    });
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'interaction-button is-primary';
    // syncInteractionValidity finds the submit through this attribute; without
    // it the ask wizard's submit stays disabled forever (2026-11-12 incident).
    submit.dataset.interactionSubmit = '';
    submit.textContent = isAsk ? interactionCopy('提交', 'Submit') : interactionCopy('允许一次', 'Allow once');
    submit.disabled = isAsk;
    submit.addEventListener('click', () => {
      const entry = { requestId: interaction.requestId, token: interaction.token, behavior: 'allow' };
      if (isAsk) entry.answers = collectInteractionAnswers(interaction, card);
      emitInteraction(entry);
      completeInteraction(card, interactionCopy('已发送，等待舞台更新…', 'Answer sent — waiting for the stage…'));
    });
    let skipButton = null;
    if (isAsk) {
      // Skip ≠ deny: every question is returned as unanswered (empty
      // selection, no fabricated note) so the tool ends skipped instead of
      // vetoed. Always clickable, even with nothing selected.
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'interaction-button';
      skip.style.background = 'transparent';
      skip.style.color = '#aab6c6';
      skip.style.border = '1px solid rgba(148,163,184,.26)';
      skip.textContent = interactionCopy('跳过', 'Skip');
      skip.addEventListener('click', () => {
        emitInteraction({ requestId: interaction.requestId, token: interaction.token, behavior: 'allow', skip: true });
        completeInteraction(card, interactionCopy('已跳过，等待舞台更新…', 'Skipped — waiting for the stage…'));
      });
      skipButton = skip;
    }
    const countdown = document.createElement('span');
    countdown.className = 'interaction-countdown';
    countdown.dataset.interactionCountdown = '';
    countdown.hidden = true;
    const done = document.createElement('div');
    done.className = 'interaction-done';
    done.dataset.interactionDone = '';
    done.hidden = true;
    actions.append(deny);
    if (skipButton) actions.append(skipButton);
    actions.append(submit, countdown);
    fragment.append(actions, done);
    return fragment;
  }

  function renderInteraction() {
    const card = $('[data-interaction-card]');
    const interaction = state.interaction;
    stopInteractionCountdown();
    if (!interaction) {
      card.hidden = true;
      if (interactionKey) {
        card.replaceChildren();
        interactionKey = '';
        interactionSelections.clear();
      }
      return;
    }
    const key = `${interaction.requestId}:${interaction.token}`;
    if (key !== interactionKey) {
      interactionKey = key;
      interactionSelections.clear();
      // A fresh prompt reuses the same section element: clear the terminal
      // done flag the previous card may have set, or the validity gate would
      // refuse to run for the new card.
      card.dataset.interactionDone = 'false';
      card.replaceChildren(buildInteractionCard(interaction));
    }
    card.hidden = false;
    syncInteractionCountdown(interaction, card);
    if (interaction.kind === 'ask') syncInteractionValidity(interaction, card);
  }

  // Families whose orb is actively working/thinking/waiting show an elapsed
  // clock after the kicker once the phase is at least 20 s old.
  const ELAPSED_FAMILIES = new Set([
    'reasoning', 'local-recall', 'web2-research', 'metaweb-research', 'making',
    'delegation', 'waiting', 'worker-report', 'verification', 'browser-action',
  ]);
  // Last-resort kicker for states that predate the localized `kicker` field —
  // never fall back to the raw family id.
  const FAMILY_LABELS = {
    received: ['收到', 'Received'],
    reasoning: ['思考中', 'Thinking'],
    'local-recall': ['查阅资料', 'Looking things up'],
    'web2-research': ['上网查找', 'Searching the web'],
    'metaweb-research': ['查 AI 互联网', 'Searching MetaWeb'],
    making: ['动手制作', 'Making'],
    delegation: ['安排协作', 'Delegating'],
    waiting: ['等待协作', 'Waiting on a teammate'],
    'worker-report': ['协作回执', 'Teammate reported'],
    verification: ['核对结果', 'Checking'],
    'browser-action': ['操作大屏', 'On the big screen'],
    'owner-needed': ['需要你决定', 'Needs you'],
    problem: ['出了点问题', 'Problem'],
    'report-ready': ['汇报就绪', 'Report ready'],
    complete: ['已完成', 'Done'],
  };

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return state.language === 'zh'
      ? (minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`)
      : (minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`);
  }

  function updateElapsed() {
    const elapsed = $('[data-core-elapsed]');
    if (!elapsed) return;
    const began = typeof state.phaseStartedAt === 'number' && state.phaseStartedAt > 0 ? state.phaseStartedAt : 0;
    const ms = began ? Date.now() - began : 0;
    if (ms >= 20000 && ELAPSED_FAMILIES.has(state.family)) {
      elapsed.hidden = false;
      elapsed.textContent = ` · ${formatElapsed(ms)}`;
    } else {
      elapsed.hidden = true;
      elapsed.textContent = '';
    }
  }

  function applyState() {
    body.dataset.enabled = String(state.enabled);
    body.dataset.family = state.family;
    body.dataset.activity = window.liquidOrbActivityForFamily(state.family);
    body.dataset.topology = state.topology.mode;
    body.dataset.motion = effectiveReduced() ? 'reduced' : 'full';
    document.documentElement.lang = state.language === 'zh' ? 'zh' : 'en';
    document.title = state.botName ? `${state.botName} · Live Stage` : 'Live Stage';
    // Identity arrives through patches: botAvatar is an https URL or a
    // stage-relative `avatars/<hash>.<ext>` path; absent → the baked fallback.
    const avatarSrc = typeof state.botAvatar === 'string' && state.botAvatar ? state.botAvatar : window.__FALLBACK_AVATAR__;
    document.querySelectorAll('[data-avatar]').forEach((image) => {
      if (image.dataset.avatarSrc !== avatarSrc) {
        image.dataset.avatarSrc = avatarSrc;
        image.src = avatarSrc;
      }
    });
    // The report button follows state.reportUri: enabled only while a
    // projected report URI is present, labelled from the current language.
    const reportUri = typeof state.reportUri === 'string' ? state.reportUri : '';
    const canOpenReport = reportUri.startsWith('preview-metaapp://localhost/');
    reportOpen.disabled = !canOpenReport;
    const reportOpenLabel = $('[data-report-open-label]');
    if (reportOpenLabel) reportOpenLabel.textContent = canOpenReport ? tr('打开汇报', 'Open report') : tr('正在打开最终页面', 'Opening the final page');
    $('[data-bot-name]').textContent = state.botName;
    const kicker = (typeof state.kicker === 'string' && state.kicker)
      || (state.family === 'speaking' ? state.botName : '')
      || (FAMILY_LABELS[state.family] ? tr(...FAMILY_LABELS[state.family]) : state.botName);
    // Top-right stays a family label: while the bot speaks it says so, even
    // though the kicker keeps showing the bot's name.
    $('[data-core-family]').textContent = state.family === 'speaking' ? tr('说话中', 'Speaking') : kicker;
    $('[data-core-verb]').textContent = kicker;
    const offTitle = $('[data-stage-off-title]');
    if (offTitle) offTitle.textContent = tr('现场已关闭', 'Live stage is off');
    const offBody = $('[data-stage-off-body]');
    if (offBody) offBody.textContent = tr('文字对话和最终投影仍然可用。', 'The text conversation and final projector remain available.');
    const now = performance.now();
    setTextChannel(textChannels[0], state.headline, now);
    setTextChannel(textChannels[1], state.caption, now);
    // Headline length tiers keep a long narration readable instead of
    // flooding the stage; the headline stays the most prominent text.
    const headlineLength = Array.from(state.headline || '').length;
    $('[data-core-title]').dataset.length = headlineLength <= 16 ? 'short' : headlineLength <= 40 ? 'medium' : 'long';
    updateElapsed();
    const nodes = Object.fromEntries(state.topology.nodes.map((node) => [node.id, node]));
    // Only satellite nodes that exist in the topology are shown — the model
    // never invents source/evidence nodes for families that have none.
    const nodeSlots = { source: $('.hybrid-source'), worker: $('.hybrid-worker'), evidence: $('.hybrid-evidence') };
    for (const [id, element] of Object.entries(nodeSlots)) {
      if (element) element.hidden = state.topology.mode !== 'structured' || !nodes[id];
    }
    $('[data-node-source]').textContent = nodes.source?.label || tr('来源', 'Source');
    $('[data-node-worker]').textContent = nodes.worker?.label || tr('协作 Bot', 'Worker');
    $('[data-node-evidence]').textContent = nodes.evidence?.label || tr('证据', 'Evidence');
    const tagSource = $('[data-tag-source]');
    if (tagSource) tagSource.textContent = tr('来源', 'source');
    const tagWorker = $('[data-tag-worker]');
    if (tagWorker) tagWorker.textContent = tr('协作', 'worker');
    const tagEvidence = $('[data-tag-evidence]');
    if (tagEvidence) tagEvidence.textContent = tr('证据', 'evidence');
    updateWorkerVisual(nodes.worker);
    // Director metrics stay in state for diagnostics; they are never owner copy.
    const metricsEl = $('[data-director-metrics]');
    if (metricsEl) {
      metricsEl.textContent = '';
      metricsEl.hidden = true;
    }
    updateParticipants();
    syncOrb(state.family);
    syncHandoff();
    renderInteraction();
    restartParticles();
  }

  // While the bot is speaking, working-family updates are held until the
  // words finish typing (+2.5 s dwell, capped 9 s after speech began) so the
  // narration is never cut off mid-line. Terminal/owner scenes always apply
  // immediately, and only the latest held patch is kept.
  const HELD_IMMEDIATE = new Set(['speaking', 'owner-needed', 'problem', 'report-ready', 'complete']);
  let heldPatch = null;
  let heldTimer = 0;

  function speechReleaseAt() {
    const began = typeof state.phaseStartedAt === 'number' && state.phaseStartedAt > 0 ? state.phaseStartedAt : Date.now();
    const cap = began + 9000;
    let lastDone = 0;
    let typing = false;
    for (const channel of textChannels) {
      if (channel.typing) typing = true;
      if (channel.doneAt > lastDone) lastDone = channel.doneAt;
    }
    if (typing) return cap;
    return Math.min(Math.max(lastDone, began) + 2500, cap);
  }

  function stopHeldRelease() {
    if (heldTimer) {
      clearInterval(heldTimer);
      heldTimer = 0;
    }
  }

  function commitStagePatch(patch) {
    state = patch;
    applyState();
  }

  function applyHeldPatch() {
    const patch = heldPatch;
    heldPatch = null;
    stopHeldRelease();
    if (patch) commitStagePatch(patch);
  }

  function heldTick() {
    if (!heldPatch) {
      stopHeldRelease();
      return;
    }
    if (Date.now() >= speechReleaseAt()) applyHeldPatch();
  }

  function armHeldRelease() {
    if (heldTimer) return;
    heldTimer = setInterval(heldTick, 250);
  }

  window.IDBotsLiveStage = {
    applyPatch(patch) {
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'protocol' };
      if (patch.protocol !== PROTOCOL) return { ok: false, reason: 'protocol' };
      if (claimedSessionId == null) {
        // First claim: an unclaimed page adopts the patching session and its
        // state wholesale — the revision baseline starts here.
        if (typeof patch.sessionId !== 'string' || !patch.sessionId) return { ok: false, reason: 'protocol' };
        claimedSessionId = patch.sessionId;
        heldPatch = null;
        stopHeldRelease();
        commitStagePatch(patch);
        return true;
      }
      if (patch.sessionId !== claimedSessionId) return { ok: false, reason: 'session-mismatch' };
      const patchTurnStart = typeof patch.turnStartedAt === 'number' ? patch.turnStartedAt : 0;
      const stateTurnStart = typeof state.turnStartedAt === 'number' ? state.turnStartedAt : 0;
      if (patch.turnId !== state.turnId) {
        // A different turn is accepted only when it is NEWER: a delayed
        // old-turn patch can never overwrite the live turn, and the
        // revision baseline resets with the turn.
        if (!(patchTurnStart > stateTurnStart)) return { ok: false, reason: 'stale-turn' };
        heldPatch = null;
        stopHeldRelease();
        commitStagePatch(patch);
        return true;
      }
      if (typeof patch.revision !== 'number' || patch.revision <= state.revision) return { ok: false, reason: 'stale-revision' };
      if (state.family === 'speaking' && !HELD_IMMEDIATE.has(patch.family)) {
        if (!heldPatch || patch.revision > heldPatch.revision) heldPatch = patch;
        armHeldRelease();
        return true;
      }
      heldPatch = null;
      stopHeldRelease();
      commitStagePatch(patch);
      return true;
    },
    // Host-side pull channel: queued card clicks leave the page exactly once.
    drainInteractions() {
      const items = interactionQueue.splice(0, interactionQueue.length);
      return items;
    },
    getState: () => state
  };
  window.__getLiveStageState = () => state;
  window.__liveStageMotion = () => ({
    activity: body.dataset.activity || '',
    voice: body.dataset.voice || 'off',
    energy: textMotion.energy,
    orbFamily: orb?.family || state.family,
    orbStyle: orb?.style ?? window.liquidOrbStyleForFamily(state.family),
    text: textChannels.map((channel) => ({ value: channel.value, typed: channel.typed, length: channel.chars.length, typing: channel.typing })),
  });
  window.__liveStageBackend = 'loading';
  const elapsedTimer = setInterval(updateElapsed, 1000);
  reducedMedia.addEventListener('change', applyState);
  document.addEventListener('visibilitychange', applyState);
  window.addEventListener('pagehide', () => {
    disposeAllOrbLayers();
    stopHandoff();
    stopInteractionCountdown();
    stopHeldRelease();
    clearInterval(elapsedTimer);
    cancelAnimationFrame(raf);
  });
  new ResizeObserver(restartParticles).observe(canvas);
  applyState();
  window.__ready = true;
})();
