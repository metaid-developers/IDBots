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
    const avatar = typeof worker?.avatar === 'string' && /^(?:data:image\/|https?:\/\/)/i.test(worker.avatar) ? worker.avatar : '';
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
    const worker = state.topology.nodes.find((node) => node.kind === 'worker')?.label || 'Worker';
    $('[data-handoff-worker]').textContent = worker;
    $('[data-handoff-copy]').textContent = handoff.direction === 'return'
      ? (state.language === 'zh' ? '正在交回结果 · 等待 Twin 核验' : 'Returning work · Twin review required')
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
    if (!card) return;
    const submit = card.querySelector('[data-interaction-submit]');
    if (!submit || submit.disabled) return;
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

  function completeInteraction(card, message) {
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
      interactionQueue.push({ requestId: interaction.requestId, token: interaction.token, behavior: 'deny' });
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
      interactionQueue.push(entry);
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
        interactionQueue.push({ requestId: interaction.requestId, token: interaction.token, behavior: 'allow', skip: true });
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
      card.replaceChildren(buildInteractionCard(interaction));
    }
    card.hidden = false;
    syncInteractionCountdown(interaction, card);
    if (interaction.kind === 'ask') syncInteractionValidity(interaction, card);
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
    updateWorkerVisual(nodes.worker);
    const metrics = state.metrics;
    $('[data-director-metrics]').textContent = metrics.directorEnabled
      ? `Director ${metrics.directorCalls} calls · ${metrics.inputTokens + metrics.outputTokens} tokens${metrics.fallbackCount ? ` · ${metrics.fallbackCount} fallback` : ''}`
      : '';
    updateParticipants();
    syncOrb(state.family);
    syncHandoff();
    renderInteraction();
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
    // Host-side pull channel: queued card clicks leave the page exactly once.
    drainInteractions() {
      const items = interactionQueue.splice(0, interactionQueue.length);
      return items;
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
    stopInteractionCountdown();
    cancelAnimationFrame(raf);
  });
  new ResizeObserver(restartParticles).observe(canvas);
  applyState();
  window.__ready = true;
})();
