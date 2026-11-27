(function () {
  'use strict';

  const BLOCK_MS = 10 * 60 * 1000;
  const PAYOUT_MS = 60 * 1000;
  const QUOTE_MS = 10 * 60 * 1000;
  const SIGNING_MS = 1500;

  const TX = {
    s1Source: '7d9d2ad3f9a24ab947f07f4a1c7e80f1ef4a7f4d6a28c5d6b19a2186f7c0a501',
    s1Target: '4d0c7ee1d33a0d75cf2b35de21d7b31c17f4378c77315b45c25c9ef28eb9d612',
    s2Source: 'a41c90e2f84be22e6b7792aa441d8543a16f0e72c3f72154bbfe2c57a3de88f2',
    s2Target: 'c29a54e334fed79e9d014f511f83cf492eeacb034b1e882f2af0a6ff32cc93a1',
    s3Source: 'e81f0a35b9d3b24c1f927561d0b64134c20d4c8338f8fd6de52d8bb3b8d07f44',
    s3Target: '19c88dd47fc2a1339d4d9fd8b804611e21b98e78e6dbb342e08cd22fd09aa762'
  };

  const scenarios = {
    S1: {
      key: 'S1',
      navLabel: 'S1 BTC → WBTC',
      title: 'BTC → WBTC 跨链桥',
      assetTitle: 'WBTC 跨链桥接',
      userMsg: '把你钱包里的 0.0005 BTC 转成 MVC 上的 WBTC',
      botLead: '已按当前 2 sat/vB 费率报好价：资产 1:1 到账，费用用 BTC 支付（桥服务费 + 网络矿工费），不从代币里扣。',
      sendAmount: '0.0005',
      sendUnit: 'BTC',
      receiveAmount: '0.0005',
      receiveUnit: 'WBTC',
      arrivalAmount: '+0.0005 WBTC',
      sourceBadge: 'BTC · 原生',
      targetBadge: 'MVC · MetaContract',
      sourceChain: 'BTC',
      targetChain: 'MVC',
      blockChain: 'BTC',
      blocks: 1,
      etaMinutes: 11,
      botName: '小橙',
      btcAddress: '1NxaBc74…7Qp2',
      mvcAddress: 'mvc1q8s2…k9xe',
      sourceBalance: 'BTC 余额 0.00182',
      targetBalance: 'WBTC 余额 0.00000',
      feeSummary: '1,320 sats BTC',
      feeRows: [
        ['桥服务费', '1,000 sats BTC'],
        ['网络矿工费', '≈320 sats BTC'],
        ['桥支付矿工费', '—'],
        ['合计', '≈1,320 sats BTC']
      ],
      extraRows: [],
      requiredBtcSats: 1320,
      availableBtcSats: 182000,
      insufficient: false,
      sourceTxid: TX.s1Source,
      targetTxid: TX.s1Target,
      durationText: '11 分 08 秒'
    },
    S2: {
      key: 'S2',
      navLabel: 'S2 METAID → MVC',
      title: '$METAID BTC → MVC 跨链桥',
      assetTitle: '$METAID 跨链桥接',
      userMsg: '把你 BTC 链上的 1,000 枚 $METAID 转去 MVC',
      botLead: '已按当前 2 sat/vB 费率报好价：资产 1:1 到账，费用用 BTC 支付（桥服务费 + 网络矿工费），不从代币里扣。',
      sendAmount: '1,000',
      sendUnit: 'METAID',
      receiveAmount: '1,000',
      receiveUnit: 'METAID',
      arrivalAmount: '+1,000 METAID',
      sourceBadge: 'BTC · MRC-20',
      targetBadge: 'MVC · MetaContract',
      sourceChain: 'BTC',
      targetChain: 'MVC',
      blockChain: 'BTC',
      blocks: 3,
      etaMinutes: 31,
      botName: '小橙',
      btcAddress: '1NxaBc74…7Qp2',
      mvcAddress: 'mvc1q8s2…k9xe',
      sourceBalance: 'METAID 余额 12,500',
      targetBalance: 'MVC METAID 余额 320',
      feeSummary: '3,438 sats BTC',
      feeRows: [
        ['桥服务费', '2,292 sats BTC'],
        ['网络矿工费', '≈1,146 sats BTC'],
        ['桥支付矿工费', '—'],
        ['合计', '≈3,438 sats BTC']
      ],
      extraRows: [['单笔流动性上限', '50,000 METAID']],
      requiredBtcSats: 3438,
      availableBtcSats: 182000,
      insufficient: false,
      sourceTxid: TX.s2Source,
      targetTxid: TX.s2Target,
      durationText: '31 分 12 秒'
    },
    S3: {
      key: 'S3',
      navLabel: 'S3 WBTC → BTC',
      title: 'WBTC → BTC 赎回桥',
      assetTitle: 'WBTC 赎回桥接',
      userMsg: '把 MVC 上的 0.0005 WBTC 赎回成 BTC',
      botLead: '赎回需要同时预留 BTC 侧费用；我先检查了你的钱包余额。',
      sendAmount: '0.0005',
      sendUnit: 'WBTC',
      receiveAmount: '0.0005',
      receiveUnit: 'BTC',
      arrivalAmount: '+0.0005 BTC',
      sourceBadge: 'MVC · MetaContract',
      targetBadge: 'BTC · 原生',
      sourceChain: 'MVC',
      targetChain: 'BTC',
      blockChain: 'MVC',
      blocks: 1,
      etaMinutes: 11,
      botName: '小橙',
      btcAddress: '1NxaBc74…7Qp2',
      mvcAddress: 'mvc1q8s2…k9xe',
      sourceBalance: 'WBTC 余额 0.00050',
      targetBalance: 'BTC 余额 800 sats',
      feeSummary: '0.00135 SPACE + 1,920 sats BTC',
      feeRows: [
        ['桥服务费', '0.0009 SPACE + 1,280 sats BTC'],
        ['网络矿工费', '≈0.00025 SPACE + ≈300 sats BTC'],
        ['桥支付矿工费', '0.0002 SPACE + 340 sats BTC'],
        ['合计', '≈0.00135 SPACE + ≈1,920 sats BTC']
      ],
      extraRows: [],
      requiredBtcSats: 1920,
      availableBtcSats: 800,
      insufficient: true,
      sourceTxid: TX.s3Source,
      targetTxid: TX.s3Target,
      durationText: '11 分 21 秒'
    }
  };

  const stateNames = {
    quote: '报价待确认',
    'quote-insufficient': '费用余额不足',
    signing: '签名广播中',
    bridging: '区块确认中',
    'bridging-slow': '出块偏慢',
    completed: '已到账',
    failed: '桥接失败',
    expired: '报价已过期'
  };

  const directions = window.AssetBridgeDirections = window.AssetBridgeDirections || {};
  const runtimes = [];
  const runtimeById = {};
  let activeScenario = 'S2';
  let timeLapse = false;
  let booted = false;
  let lastTick = 0;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function shortHash(value) {
    if (!value) return '—';
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }

  function badge(chain, label) {
    const cls = chain === 'BTC' ? 'bdg-btc' : 'bdg-mvc';
    return `<span class="bdg ${cls}">${esc(label)}</span>`;
  }

  function copyChip(value, label) {
    return `<button type="button" class="copy-chip" data-copy="${esc(value)}" title="${esc(label || '复制')} ${esc(value)}">${esc(shortHash(value))}</button>`;
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `T+${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes <= 0) return `${seconds} 秒`;
    return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
  }

  function feeRowsHtml(sc, opts) {
    const rows = [...sc.feeRows];
    if (opts && opts.includeExtra) rows.push(...sc.extraRows);
    return rows.map(([k, v], idx) => `
      ${idx === rows.length - 1 ? '<div class="ledger-divider"></div>' : ''}
      <div class="ledger-row"><span class="ledger-k">${esc(k)}</span><span class="ledger-v num">${esc(v)}</span></div>
    `).join('');
  }

  function scenario() {
    return scenarios[activeScenario];
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  class CardRuntime {
    constructor(direction, mount) {
      this.id = direction;
      this.mount = mount;
      this.module = directions[direction];
      this.root = document.createElement('section');
      this.root.className = `tk-card direction-${direction}`;
      this.root.dataset.cardDirection = direction;
      this.root.dataset.state = 'quote';
      this.root.setAttribute('aria-live', 'polite');
      mount.innerHTML = '';
      mount.appendChild(this.root);
      this.clock = 0;
      this.uiLock = false;
      this.lastPaint = 0;
      this.lastHtml = '';
      this.resetForScenario();
    }

    scenario() {
      return scenarios[activeScenario];
    }

    resetForScenario() {
      this.clock = 0;
      this.state = 'quote';
      this.quoteExpiresAt = QUOTE_MS;
      this.blocksDone = 0;
      this.blockStartClock = 0;
      this.bridgeStartClock = 0;
      this.payoutStartClock = null;
      this.completedDurationMs = null;
      this.slowActive = false;
      this.sourceTxid = null;
      this.targetTxid = null;
      this.failReason = '';
      clearTimeout(this.signingTimer);
      this.render(false);
      markStateButtons(this.state);
    }

    quoteRemainingMs() {
      return Math.max(0, this.quoteExpiresAt - this.clock);
    }

    quoteCountdown() {
      return formatCountdown(this.quoteRemainingMs());
    }

    isInsufficient() {
      const sc = this.scenario();
      return this.state === 'quote-insufficient' || (sc.insufficient && (this.state === 'quote' || this.state === 'signing'));
    }

    confirm() {
      if (this.state !== 'quote' && this.state !== 'quote-insufficient') return;
      if (this.isInsufficient()) return;
      if (this.quoteRemainingMs() <= 0) {
        this.forceState('expired');
        return;
      }
      this.state = 'signing';
      markStateButtons('signing');
      clearTimeout(this.signingTimer);
      this.signingTimer = setTimeout(() => {
        if (this.state === 'signing') this.beginBridging();
      }, SIGNING_MS);
      this.render(true);
    }

    beginBridging() {
      const startedAt = this.clock;
      this.state = 'bridging';
      this.bridgeStartClock = startedAt;
      this.blockStartClock = startedAt;
      this.blocksDone = 0;
      this.payoutStartClock = null;
      this.completedDurationMs = null;
      this.slowActive = false;
      this.sourceTxid = this.scenario().sourceTxid;
      this.targetTxid = null;
      markStateButtons('bridging');
      this.render(true);
    }

    cancel() {
      if (this.state === 'quote' || this.state === 'quote-insufficient') {
        this.quoteExpiresAt = this.clock + QUOTE_MS;
        this.render(false);
      }
    }

    refreshQuote() {
      this.state = this.scenario().insufficient ? 'quote-insufficient' : 'quote';
      this.quoteExpiresAt = this.clock + QUOTE_MS;
      this.render(true);
    }

    retry() {
      this.refreshQuote();
    }

    forceState(next) {
      clearTimeout(this.signingTimer);
      const sc = this.scenario();
      this.slowActive = false;
      if (next === 'quote' || next === 'quote-insufficient') {
        this.state = next;
        this.quoteExpiresAt = this.clock + QUOTE_MS;
      } else if (next === 'signing') {
        this.state = 'signing';
        this.signingTimer = setTimeout(() => {
          if (this.state === 'signing') this.beginBridging();
        }, SIGNING_MS);
      } else if (next === 'bridging' || next === 'bridging-slow') {
        this.beginBridgingSilently();
        if (next === 'bridging-slow') {
          this.slowActive = true;
          this.state = 'bridging-slow';
          this.blockStartClock = this.clock - BLOCK_MS;
        }
      } else if (next === 'completed') {
        this.state = 'completed';
        this.blocksDone = sc.blocks;
        this.sourceTxid = sc.sourceTxid;
        this.targetTxid = sc.targetTxid;
        this.completedDurationMs = (sc.blocks * BLOCK_MS) + PAYOUT_MS + 12000;
        this.bridgeStartClock = this.clock - this.completedDurationMs;
      } else if (next === 'failed') {
        this.state = 'failed';
        this.sourceTxid = sc.sourceTxid;
        this.failReason = '桥节点在目标链入账前返回了可重试错误；源链交易已确认，但资产没有丢失。';
      } else if (next === 'expired') {
        this.state = 'expired';
        this.quoteExpiresAt = this.clock;
      }
      markStateButtons(next);
      this.render(true);
    }

    beginBridgingSilently() {
      this.state = 'bridging';
      this.bridgeStartClock = this.clock;
      this.blockStartClock = this.clock;
      this.blocksDone = 0;
      this.payoutStartClock = null;
      this.completedDurationMs = null;
      this.sourceTxid = this.scenario().sourceTxid;
      this.targetTxid = null;
    }

    makeSlow() {
      if (this.state !== 'bridging' && this.state !== 'bridging-slow') return;
      const sc = this.scenario();
      if (this.blocksDone >= sc.blocks) return;
      this.slowActive = true;
      this.state = 'bridging-slow';
      const elapsed = this.clock - this.blockStartClock;
      if (elapsed < BLOCK_MS) {
        this.blockStartClock = this.clock - BLOCK_MS;
      }
      markStateButtons('bridging-slow');
      this.render(true);
    }

    findBlock() {
      if (this.state !== 'bridging' && this.state !== 'bridging-slow') return false;
      const sc = this.scenario();
      if (this.blocksDone >= sc.blocks) return false;
      this.blocksDone += 1;
      this.blockStartClock = this.clock;
      this.slowActive = false;
      this.state = 'bridging';
      if (this.blocksDone >= sc.blocks) {
        this.payoutStartClock = this.clock;
      }
      markStateButtons('bridging');
      this.render(false);
      return true;
    }

    complete() {
      if (this.state === 'completed') return;
      this.state = 'completed';
      this.targetTxid = this.scenario().targetTxid;
      this.completedDurationMs = Math.max(1000, this.clock - this.bridgeStartClock);
      markStateButtons('completed');
      this.render(true);
    }

    advance(realDelta, now) {
      const scaled = realDelta * (timeLapse ? 60 : 1);
      this.clock += scaled;

      if ((this.state === 'quote' || this.state === 'quote-insufficient') && this.quoteRemainingMs() <= 0) {
        this.state = 'expired';
        markStateButtons('expired');
        this.render(true);
      }

      if (this.state === 'bridging' || this.state === 'bridging-slow') {
        const sc = this.scenario();
        if (this.blocksDone < sc.blocks) {
          const elapsed = this.clock - this.blockStartClock;
          if (elapsed > 9 * 60 * 1000 && this.state === 'bridging') {
            this.state = 'bridging-slow';
            markStateButtons('bridging-slow');
          }
          if (!this.slowActive && elapsed >= BLOCK_MS) {
            this.findBlock();
          }
        } else if (this.payoutStartClock != null && this.clock - this.payoutStartClock >= PAYOUT_MS) {
          this.complete();
        }
      }

      const interval = (this.state === 'bridging' || this.state === 'bridging-slow') ? 240 : 950;
      if (!this.uiLock && now - this.lastPaint >= interval) {
        if (this.state === 'quote' || this.state === 'quote-insufficient' || this.state === 'signing') {
          const countdown = this.root.querySelector('[data-quote-count]');
          if (countdown) {
            countdown.textContent = this.quoteCountdown();
            this.lastPaint = now;
            return;
          }
        }
        this.render(false);
        this.lastPaint = now;
      }
    }

    progress() {
      const sc = this.scenario();
      const n = sc.blocks;
      if (this.state === 'completed') {
        return {
          percent: 1,
          blocksDone: n,
          currentBlock: n,
          fraction: 1,
          pinned: false,
          stage: '目标链已入账',
          remaining: '已到账',
          elapsed: formatDuration(this.completedDurationMs || 0),
          missionClock: formatClock(this.completedDurationMs || 0),
          nextBlock: '已完成'
        };
      }
      if (this.state !== 'bridging' && this.state !== 'bridging-slow') {
        return {
          percent: 0,
          blocksDone: 0,
          currentBlock: 1,
          fraction: 0,
          pinned: false,
          stage: `等待 ${sc.blockChain} 区块 1 / ${n}`,
          remaining: `约 ${sc.etaMinutes} 分钟`,
          elapsed: '0 秒',
          missionClock: 'T+00:00',
          nextBlock: `约 10 分钟`
        };
      }

      const elapsedTotal = Math.max(0, this.clock - this.bridgeStartClock);
      let percent;
      let fraction;
      let stage;
      let remaining;
      let nextBlock;
      let pinned = false;
      if (this.blocksDone < n) {
        const raw = Math.max(0, this.clock - this.blockStartClock) / BLOCK_MS;
        fraction = Math.min(raw, 0.9);
        pinned = this.state === 'bridging-slow' && fraction >= 0.89;
        percent = (this.blocksDone + fraction) / (n + 0.5);
        stage = `等待 ${sc.blockChain} 区块 ${this.blocksDone + 1} / ${n}`;
        if (pinned) {
          remaining = '等待这个区块';
          nextBlock = '等待这个区块';
        } else {
          const mins = Math.max(1, Math.ceil((n - this.blocksDone - fraction) * 10 + 1));
          remaining = `约 ${mins} 分钟`;
          const next = Math.max(1, Math.ceil((1 - fraction) * 10));
          nextBlock = `下一块预计 ~${next} 分`;
        }
      } else {
        const payoutElapsed = Math.max(0, this.clock - (this.payoutStartClock || this.clock));
        const payoutFraction = Math.min(0.95, payoutElapsed / PAYOUT_MS);
        fraction = payoutFraction;
        percent = (n + payoutFraction * 0.5) / (n + 0.5);
        stage = `${sc.targetChain} 目标链入账中`;
        remaining = '约 1 分钟';
        nextBlock = '目标链入账中';
      }
      return {
        percent: Math.min(0.995, percent),
        blocksDone: this.blocksDone,
        currentBlock: Math.min(n, this.blocksDone + 1),
        fraction,
        pinned,
        stage,
        remaining,
        elapsed: formatDuration(elapsedTotal),
        missionClock: formatClock(elapsedTotal),
        nextBlock
      };
    }

    render(animate) {
      if (!this.module) return;
      if (this.uiLock) return;
      const html = this.module.render(this);
      this.root.dataset.state = this.state;
      this.root.dataset.scenario = activeScenario;
      this.root.classList.toggle('is-slow', this.state === 'bridging-slow');
      if (html === this.lastHtml && this.root.innerHTML) return;

      const reduce = reducedMotion();
      if (!animate || reduce || !this.root.innerHTML) {
        this.root.style.height = '';
        this.root.classList.remove('morphing');
        this.root.innerHTML = html;
        this.lastHtml = html;
        if (this.module.bind) this.module.bind(this);
        return;
      }

      const oldHeight = this.root.offsetHeight;
      this.root.style.height = `${oldHeight}px`;
      this.root.innerHTML = html;
      const newHeight = this.root.scrollHeight;
      this.root.classList.add('morphing');
      requestAnimationFrame(() => {
        this.root.style.height = `${newHeight}px`;
        window.setTimeout(() => {
          this.root.classList.remove('morphing');
          this.root.style.height = '';
        }, 280);
      });
      this.lastHtml = html;
      if (this.module.bind) this.module.bind(this);
    }
  }

  // Small runtime helper installed without relying on accessor syntax in older WebKit.
  CardRuntime.prototype.setUiLock = function lockedSetter(value) {
    this.uiLock = Boolean(value);
    if (!this.uiLock) this.render(false);
  };

  function markStateButtons(state) {
    document.querySelectorAll('#stateGroup .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.state === state);
    });
  }

  function updateChatCopy() {
    const sc = scenario();
    document.querySelectorAll('[data-user-msg]').forEach((el) => { el.textContent = sc.userMsg; });
    document.querySelectorAll('[data-bot-lead]').forEach((el) => { el.textContent = sc.botLead; });
  }

  function renderArrivals() {
    const sc = scenario();
    ['a', 'b', 'c'].forEach((direction) => {
      const mount = document.getElementById(`arrival-${direction}`);
      if (mount && directions[direction]) mount.innerHTML = directions[direction].arrival(sc);
    });
  }

  function setScenario(key) {
    if (!scenarios[key]) return;
    activeScenario = key;
    document.querySelectorAll('#scenarioGroup .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scenario === key);
    });
    updateChatCopy();
    runtimes.forEach((rt) => rt.resetForScenario());
    renderArrivals();
  }

  function setState(next) {
    document.querySelectorAll('#stateGroup .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.state === next);
    });
    runtimes.forEach((rt) => rt.forceState(next));
  }

  function setTimeLapse(enabled) {
    timeLapse = Boolean(enabled);
    const btn = document.getElementById('timeLapseBtn');
    if (btn) btn.setAttribute('aria-pressed', String(timeLapse));
  }

  function bindControls() {
    document.querySelectorAll('#scenarioGroup .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => setScenario(btn.dataset.scenario));
    });
    document.querySelectorAll('#stateGroup .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => setState(btn.dataset.state));
    });
    document.querySelectorAll('#themeGroup .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#themeGroup .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.documentElement.classList.toggle('dark', btn.dataset.theme === 'dark');
      });
    });
    document.querySelectorAll('#widthGroup .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#widthGroup .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.documentElement.style.setProperty('--card-stage-width', `${btn.dataset.width}px`);
      });
    });
    const lapse = document.getElementById('timeLapseBtn');
    if (lapse) lapse.addEventListener('click', () => setTimeLapse(!timeLapse));
    const find = document.getElementById('findBlockBtn');
    if (find) find.addEventListener('click', () => runtimes.forEach((rt) => rt.findBlock()));
    const slow = document.getElementById('slowBlockBtn');
    if (slow) slow.addEventListener('click', () => runtimes.forEach((rt) => rt.makeSlow()));
  }

  function tick(now) {
    if (!lastTick) lastTick = now;
    const delta = Math.min(1000, now - lastTick);
    lastTick = now;
    runtimes.forEach((rt) => rt.advance(delta, now));
  }

  function boot() {
    if (booted) return;
    booted = true;
    updateChatCopy();
    ['a', 'b', 'c'].forEach((direction) => {
      const mount = document.getElementById(`card-${direction}`);
      if (!mount || !directions[direction]) return;
      const rt = new CardRuntime(direction, mount);
      runtimes.push(rt);
      runtimeById[direction] = rt;
    });
    bindControls();
    renderArrivals();
    window.setInterval(() => tick(performance.now()), 100);
  }

  function debugSetProgress(blocksDone, fraction, slow) {
    runtimes.forEach((rt) => {
      const sc = rt.scenario();
      rt.beginBridgingSilently();
      rt.blocksDone = Math.max(0, Math.min(sc.blocks - 1, blocksDone));
      const fractionMs = Math.max(0, Math.min(0.9, fraction)) * BLOCK_MS;
      rt.blockStartClock = rt.clock - fractionMs;
      rt.bridgeStartClock = rt.clock - (rt.blocksDone * BLOCK_MS) - fractionMs;
      rt.slowActive = Boolean(slow);
      rt.state = slow ? 'bridging-slow' : 'bridging';
      markStateButtons(rt.state);
      rt.render(false);
    });
  }

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    const value = btn.getAttribute('data-copy') || '';
    const mark = () => {
      btn.classList.add('copied');
      window.setTimeout(() => btn.classList.remove('copied'), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(mark).catch(mark);
    } else {
      mark();
    }
  });

  window.AB = {
    scenarios,
    stateNames,
    scenario,
    esc,
    shortHash,
    badge,
    copyChip,
    feeRowsHtml,
    formatCountdown,
    formatClock,
    formatDuration,
    BLOCK_MS,
    PAYOUT_MS,
    QUOTE_MS
  };

  window.AssetBridgeDemo = {
    boot,
    runtimeById,
    setScenario,
    setState,
    setTimeLapse,
    findBlock: () => runtimes.forEach((rt) => rt.findBlock()),
    makeSlow: () => runtimes.forEach((rt) => rt.makeSlow()),
    debugSetProgress,
    get scenario() { return activeScenario; },
    get timeLapse() { return timeLapse; }
  };
})();
