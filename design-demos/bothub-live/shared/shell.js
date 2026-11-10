(() => {
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);

  function reportMarkup(report) {
    const stats = report.stats ? `<div class="report-stats">${report.stats.map((stat) => `
      <div class="report-stat"><strong>${escapeHtml(stat.value)}</strong><span>${escapeHtml(stat.label)}</span></div>`).join('')}</div>` : '';
    return `<article class="report-page">
      <div class="report-kicker">${escapeHtml(report.kicker)}</div>
      <h1 class="report-title">${escapeHtml(report.title)}</h1>
      <p class="report-summary">${escapeHtml(report.summary)}</p>
      ${stats}
      <div class="report-items">${report.items.map((item) => `
        <section class="report-item ${escapeHtml(item.tone)}">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.body)}</p>
          <span class="report-action">${escapeHtml(item.action)}</span>
        </section>`).join('')}</div>
      <p class="report-footer">${escapeHtml(report.footer)}</p>
      <button class="report-back" type="button" data-action="back-to-stage">Back to live trace</button>
    </article>`;
  }

  window.mountBotHubDemo = function mountBotHubDemo(options) {
    const scenarios = window.BotHubScenarios;
    const root = document.getElementById('app');
    const params = new URLSearchParams(window.location.search);
    const initialScenario = scenarios[params.get('scenario')] ? params.get('scenario') : 'decision';
    const reduceInitially = params.get('motion') === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scenarioId = initialScenario;
    let stepIndex = 0;
    let playing = false;
    let timer = null;
    let reportOpen = false;
    let liveEnabled = true;
    let reducedMotion = reduceInitially;

    root.innerHTML = `
      <div class="demo-app ${reducedMotion ? 'reduced-motion' : ''}">
        <header class="app-top">
          <div class="brand-switch">
            <img class="brand-logo" src="assets/logo.png" alt="IDBots" />
            <div class="face-switch"><span class="face active">BotHub</span><span class="face">BotWorks</span></div>
          </div>
          <div class="top-session" data-role="session-title"></div>
          <div class="prototype-tag">${escapeHtml(options.prototypeLabel)}</div>
        </header>
        <div class="workspace">
          <aside class="chat-pane" aria-label="Text conversation">
            <div class="chat-header">
              <img class="chat-avatar" src="assets/twinbot.png" alt="AI_Sunny" />
              <div><div class="chat-name">AI_Sunny</div><div class="chat-sub">Your Twin</div></div>
              <span class="live-indicator">Live</span>
            </div>
            <div class="chat-scroll" data-role="messages" aria-live="polite"></div>
            <div class="composer" aria-label="Composer preview">
              <div class="composer-text">Ask your Twin to move something forward…</div>
              <div class="composer-bottom"><span class="twin-chip">AI_Sunny · Twin</span><button class="send-button" type="button" data-action="restart">Replay</button></div>
            </div>
          </aside>
          <main class="browser-pane">
            <div class="browser-top">
              <button class="browser-back" type="button" data-action="browser-back">Back</button>
              <div class="browser-address" data-role="address"></div>
              <label class="live-switch"><span>Live stage</span><input type="checkbox" checked data-action="live-toggle" /><span class="switch-track"></span></label>
            </div>
            <div class="stage-viewport" data-role="viewport">
              <div class="live-stage ${escapeHtml(options.stageClass)}" data-role="stage">${options.stageHtml}</div>
              <div class="report-view" data-role="report"></div>
              <div class="stage-disabled"><div><strong>Live stage is off</strong>The existing text chat and final projector remain available.</div></div>
            </div>
            <div class="demo-controls">
              <select class="scenario-select" data-action="scenario" aria-label="Demo scenario">
                ${Object.entries(scenarios).map(([id, scenario]) => `<option value="${id}" ${id === scenarioId ? 'selected' : ''}>${escapeHtml(scenario.label)}</option>`).join('')}
              </select>
              <div class="transport">
                <button class="transport-button" type="button" data-action="previous" aria-label="Previous event">Previous</button>
                <button class="transport-button play" type="button" data-action="play">Play</button>
                <button class="transport-button" type="button" data-action="next" aria-label="Next event">Next</button>
                <div class="event-dots" data-role="event-dots"></div>
              </div>
              <button class="motion-button" type="button" data-action="motion">${reducedMotion ? 'Motion: reduced' : 'Motion: full'}</button>
            </div>
          </main>
        </div>
      </div>`;

    const $ = (selector) => root.querySelector(selector);
    const $$ = (selector) => Array.from(root.querySelectorAll(selector));
    const stage = $('[data-role="stage"]');
    const viewport = $('[data-role="viewport"]');
    const scenario = () => scenarios[scenarioId];
    const step = () => scenario().steps[stepIndex];

    function renderMessages() {
      const messages = [{ type: 'user', content: scenario().user }];
      scenario().steps.slice(0, stepIndex + 1).forEach((item) => {
        if (item.message) messages.push({ type: 'assistant', content: item.message });
        if (item.notice) messages.push({ type: 'notice', content: item.notice });
      });
      $('[data-role="messages"]').innerHTML = messages.map((message) => {
        if (message.type === 'notice') return `<div class="message message-notice">${escapeHtml(message.content)}</div>`;
        return `<div class="message message-${message.type}"><span class="message-label">${message.type === 'user' ? 'You' : 'AI_Sunny'}</span><div class="message-bubble">${escapeHtml(message.content)}</div></div>`;
      }).join('') + (!step().reportReady ? `<div class="chat-activity"><span class="activity-ring"></span><span>${escapeHtml(step().verb)} in progress</span></div>` : '');
      const scroll = $('[data-role="messages"]');
      requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }

    function renderDots() {
      $('[data-role="event-dots"]').innerHTML = scenario().steps.map((item, index) => `
        <button type="button" class="event-dot ${index === stepIndex ? 'active' : index < stepIndex ? 'passed' : ''}" data-step="${index}" aria-label="${escapeHtml(item.title)}" title="${escapeHtml(item.title)}"></button>`).join('');
    }

    function render() {
      const current = step();
      stage.dataset.family = current.family;
      stage.dataset.step = current.id;
      stage.dataset.scenario = scenarioId;
      stage.dataset.revision = String(stepIndex);
      stage.dataset.playing = String(playing);
      $('[data-role="session-title"]').textContent = scenario().sessionTitle;
      $('[data-role="address"]').textContent = reportOpen
        ? `bothub://report/${scenarioId}`
        : `bothub://live/${scenarioId}/${current.id}`;
      viewport.classList.toggle('report-open', reportOpen);
      viewport.classList.toggle('live-off', !liveEnabled);
      $('[data-role="report"]').innerHTML = reportMarkup(scenario().report);
      $('[data-action="previous"]').disabled = stepIndex === 0 || reportOpen;
      $('[data-action="next"]').disabled = stepIndex === scenario().steps.length - 1 || reportOpen;
      $('[data-action="play"]').textContent = playing ? 'Pause' : 'Play';
      $('[data-action="play"]').disabled = reportOpen;
      $('[data-action="motion"]').textContent = reducedMotion ? 'Motion: reduced' : 'Motion: full';
      $('.demo-app').classList.toggle('reduced-motion', reducedMotion);
      renderMessages();
      renderDots();
      options.onStep?.(current, {
        scenarioId, stepIndex, playing, reportOpen, liveEnabled, reducedMotion,
        openReport: () => setReportOpen(true)
      });
    }

    function stopTimer() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      playing = false;
    }

    function startTimer() {
      if (reportOpen || !liveEnabled) return;
      if (stepIndex >= scenario().steps.length - 1) stepIndex = 0;
      playing = true;
      render();
      timer = window.setInterval(() => {
        if (stepIndex >= scenario().steps.length - 1) {
          stopTimer();
          render();
          return;
        }
        stepIndex += 1;
        render();
      }, reducedMotion ? 1400 : 3000);
    }

    function setStep(next) {
      stopTimer();
      stepIndex = Math.max(0, Math.min(scenario().steps.length - 1, Number(next) || 0));
      reportOpen = false;
      render();
    }

    function setScenario(next) {
      if (!scenarios[next]) return;
      stopTimer();
      scenarioId = next;
      stepIndex = 0;
      reportOpen = false;
      options.onScenario?.(next);
      render();
    }

    function setReportOpen(next) {
      if (next && !step().reportReady) return;
      stopTimer();
      reportOpen = Boolean(next);
      render();
    }

    function setLiveEnabled(next) {
      liveEnabled = Boolean(next);
      if (!liveEnabled) stopTimer();
      render();
    }

    function setReducedMotion(next) {
      reducedMotion = Boolean(next);
      options.onMotion?.(reducedMotion);
      render();
    }

    root.addEventListener('click', (event) => {
      const stepButton = event.target.closest('button[data-step]');
      if (stepButton) { setStep(Number(stepButton.dataset.step)); return; }
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'play') playing ? (stopTimer(), render()) : startTimer();
      if (action === 'previous') setStep(stepIndex - 1);
      if (action === 'next') setStep(stepIndex + 1);
      if (action === 'restart') setStep(0);
      if (action === 'open-report') setReportOpen(true);
      if (action === 'back-to-stage') setReportOpen(false);
      if (action === 'browser-back') reportOpen ? setReportOpen(false) : setStep(stepIndex - 1);
      if (action === 'motion') setReducedMotion(!reducedMotion);
    });
    root.addEventListener('change', (event) => {
      if (event.target.matches('[data-action="scenario"]')) setScenario(event.target.value);
      if (event.target.matches('[data-action="live-toggle"]')) setLiveEnabled(event.target.checked);
    });

    window.__demo = {
      setStep,
      setScenario,
      openReport: () => setReportOpen(true),
      closeReport: () => setReportOpen(false),
      play: startTimer,
      pause: () => { stopTimer(); render(); },
      setLiveEnabled,
      setReducedMotion,
      getState: () => ({ scenarioId, stepIndex, playing, reportOpen, liveEnabled, reducedMotion, family: step().family })
    };
    window.__seek = setStep;

    const requestedStep = Number(params.get('step'));
    if (Number.isInteger(requestedStep) && params.has('step')) {
      stepIndex = Math.max(0, Math.min(scenario().steps.length - 1, requestedStep));
    }
    render();
    requestAnimationFrame(() => {
      window.__ready = true;
      if (params.get('report') === '1' && step().reportReady) setReportOpen(true);
      if (params.get('play') !== '0') startTimer();
    });
  };
})();
