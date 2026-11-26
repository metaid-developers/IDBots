(function () {
  'use strict';

  const { esc, copyChip } = window.AB;

  function routeStrip(rt) {
    const sc = rt.scenario();
    const sourceColor = sc.sourceChain === 'BTC' ? 'var(--btc-fg)' : 'var(--mvc-fg)';
    const targetColor = sc.targetChain === 'BTC' ? 'var(--btc-fg)' : 'var(--mvc-fg)';
    return `
      <div class="c-route-strip num ${sc.sourceChain === 'MVC' ? 'reverse' : ''}">
        <span style="color:${sourceColor};">${esc(sc.sourceChain)}</span>
        <span class="c-route-line"></span>
        <span style="color:${targetColor};">${esc(sc.targetChain)}</span>
      </div>
    `;
  }

  function blockCells(rt, mode) {
    const sc = rt.scenario();
    const p = rt.progress();
    const n = sc.blocks;
    const cells = [];
    for (let i = 1; i <= n; i += 1) {
      let cls = '';
      let fill = 0;
      let pctText = '';
      if (mode === 'completed' || p.blocksDone >= i) {
        cls = 'done';
        fill = 100;
        pctText = '✓';
      } else if ((mode === 'bridging' || mode === 'quote') && p.blocksDone + 1 === i) {
        cls = mode === 'quote' ? '' : 'current';
        fill = mode === 'quote' ? 0 : Math.round(p.fraction * 100);
        pctText = mode === 'quote' ? '0%' : `${Math.round(p.fraction * 100)}%`;
      }
      cells.push(`
        <div class="block-cell ${cls}" style="--fill:${fill}">
          <span class="fill"></span>
          <span class="block-index">B${i}</span>
          <span class="block-pct num">${pctText || '—'}</span>
          ${cls === 'current' ? '<span class="block-cursor"></span>' : ''}
        </div>
      `);
    }
    const payoutDone = mode === 'completed';
    const payoutActive = mode === 'bridging' && p.blocksDone >= n;
    const payoutFill = payoutDone ? 100 : payoutActive ? Math.round(p.fraction * 100) : 0;
    cells.push(`
      <div class="block-cell payout ${payoutDone ? 'done' : payoutActive ? 'current' : ''}" style="--fill:${payoutFill}">
        <span class="fill"></span>
        <span class="block-kind">PAY</span>
        <span class="block-pct num">${payoutDone ? '✓' : payoutActive ? `${payoutFill}%` : '½'}</span>
        ${payoutActive ? '<span class="block-cursor"></span>' : ''}
      </div>
    `);
    return `<div class="block-strip" style="grid-template-columns:repeat(${n},minmax(0,1fr)) minmax(42px,.72fr);">${cells.join('')}</div>`;
  }

  function feeBento(rt) {
    const sc = rt.scenario();
    let service = sc.feeRows[0][1];
    let miner = sc.feeRows[1][1];
    if (sc.key === 'S1') miner = '≈320 sats BTC';
    if (sc.key === 'S2') miner = '≈1,146 sats BTC';
    if (sc.key === 'S3') miner = '≈0.00045 SPACE + ≈640 sats BTC';
    return `
      <div class="bento-2 num">
        <div class="bento-cell"><div class="bento-label">服务费</div><div class="bento-val">${esc(service)}</div></div>
        <div class="bento-cell"><div class="bento-label">矿工费</div><div class="bento-val">${esc(miner)}</div></div>
        <div class="bento-cell"><div class="bento-label">合计</div><div class="bento-val">${esc(sc.feeSummary)}</div></div>
        <div class="bento-cell"><div class="bento-label">你将收到</div><div class="bento-val" style="color:var(--up);">${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)}</div></div>
      </div>
    `;
  }

  function quote(rt) {
    const sc = rt.scenario();
    const blocked = rt.isInsufficient();
    return `
      <div class="c-panel-label"><span>路径</span><span class="num">${esc(sc.sourceChain)} → ${esc(sc.targetChain)}</span></div>
      ${routeStrip(rt)}
      <div class="c-panel-label"><span>区块时间线</span><span class="num">${sc.blocks} 个区块</span></div>
      ${blockCells(rt, 'quote')}
      <div class="c-block-note num">需等待 ${sc.blocks} 个${sc.blockChain === 'BTC' ? '比特币' : 'MVC'}区块 ≈ ${sc.blocks * 10} 分钟</div>
      ${feeBento(rt)}
      ${sc.extraRows.length ? `<div class="muted-line num">单笔流动性上限：${esc(sc.extraRows[0][1])}</div>` : ''}
      <div class="muted-line num">钱包 ${esc(sc.botName)} · BTC ${esc(sc.btcAddress)} · MVC ${esc(sc.mvcAddress)} · 报价 <span class="quote-count" data-quote-count>${esc(rt.quoteCountdown())}</span> 后失效</div>
      ${blocked ? `
        <div class="warn-box num">BTC 费用不足：需要约 <strong>${sc.requiredBtcSats.toLocaleString('en-US')} sats</strong>，当前可用 <strong>${sc.availableBtcSats.toLocaleString('en-US')} sats</strong>。请先补足费用。</div>` : ''}
      <div class="btn-row">
        <button type="button" class="btn-secondary" data-action="${blocked ? 'topup' : 'cancel'}">${blocked ? '补足 / 取消' : '取消'}</button>
        <button type="button" class="hold-btn" data-hold-confirm ${blocked ? 'disabled' : ''} aria-keyshortcuts="Space Enter" aria-label="按住一秒确认桥接">
          <span class="hold-fill"></span>
          按住 1 秒确认桥接<small>松开即取消 · HOLD TO CONFIRM</small>
        </button>
      </div>
    `;
  }

  function signing(rt) {
    return `
      <div class="dimmed-during-signing">
        ${routeStrip(rt)}
        ${blockCells(rt, 'quote')}
        ${feeBento(rt)}
      </div>
      <div class="a-signing-veil"><span class="spinner"></span><span>正在签名并广播源链交易…</span></div>
    `;
  }

  function bridging(rt) {
    const p = rt.progress();
    return `
      <div class="c-panel-label"><span>区块计</span><span class="num">${Math.floor(p.percent * 100)}%</span></div>
      ${routeStrip(rt)}
      ${blockCells(rt, 'bridging')}
      <div class="c-instrument num">
        <div class="c-clock-row"><span class="c-mission-clock">${esc(p.missionClock)}</span><span class="c-next-block">${esc(p.nextBlock)}</span></div>
        <div class="ledger-row"><span class="ledger-k">${esc(p.stage)}</span><span class="ledger-v">${esc(p.remaining)}</span></div>
      </div>
      ${rt.state === 'bridging-slow' ? `<div class="warn-box">${esc(rt.scenario().blockChain)} 区块当前出块慢于平均值；这是正常现象。当前区块进度已停在 90%，只有在真正出块后才会跳到 100%。</div>` : ''}
      <div class="muted-line">你可以离开——到账后我会在聊天里告诉你。</div>
      <div class="a-card-footer"><span class="bdg bdg-neutral num">源链交易</span>${copyChip(rt.sourceTxid || rt.scenario().sourceTxid, '复制源链交易')}</div>
    `;
  }

  function completed(rt) {
    const sc = rt.scenario();
    return `
      <div class="c-panel-label"><span>入账凭证</span><span class="num">100%</span></div>
      <div class="c-receipt-strip">${blockCells(rt, 'completed')}</div>
      <div class="success-box num"><strong>+${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)}</strong> 已到 ${esc(sc.targetChain)} · 全程 ${esc(rt.completedDurationMs ? rt.progress().elapsed : sc.durationText)}</div>
      <div class="ledger-box num">
        <div class="ledger-row"><span class="ledger-k">源链哈希</span><span class="ledger-v">${copyChip(rt.sourceTxid || sc.sourceTxid, '复制源链交易')}</span></div>
        <div class="ledger-row"><span class="ledger-k">目标哈希</span><span class="ledger-v">${copyChip(rt.targetTxid || sc.targetTxid, '复制目标链交易')}</span></div>
        <div class="ledger-row"><span class="ledger-k">实际费用</span><span class="ledger-v">${esc(sc.feeSummary)}</span></div>
      </div>
      <div class="chip-row"><button type="button" class="chip-btn">查看余额</button><button type="button" class="chip-btn">挂牌出售</button><button type="button" class="chip-btn">再次桥接</button></div>
    `;
  }

  function failed(rt) {
    return `
      ${routeStrip(rt)}
      ${blockCells(rt, 'quote')}
      <div class="failed-title">桥接失败</div>
      <div class="down-box">${esc(rt.failReason || '桥节点返回了可重试错误；资金没有丢失。')}</div>
      <div class="btn-row"><button type="button" class="btn-secondary" data-action="contact">联系桥支持</button><button type="button" class="btn-primary" data-action="retry">重试</button></div>
    `;
  }

  function expired(rt) {
    const sc = rt.scenario();
    return `
      ${routeStrip(rt)}
      ${blockCells(rt, 'quote')}
      <div class="expired-title">报价过期</div>
      <div class="warn-box">10 分钟报价有效期已结束。区块时间线未启动，刷新后会重新锁定费率。</div>
      <button type="button" class="btn-primary" data-action="refresh">刷新报价</button>
    `;
  }

  function render(rt) {
    if (rt.state === 'quote' || rt.state === 'quote-insufficient') return quote(rt);
    if (rt.state === 'signing') return signing(rt);
    if (rt.state === 'bridging' || rt.state === 'bridging-slow') return bridging(rt);
    if (rt.state === 'completed') return completed(rt);
    if (rt.state === 'failed') return failed(rt);
    return expired(rt);
  }

  function bind(rt) {
    rt.root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'cancel' || action === 'topup') rt.cancel();
        if (action === 'refresh' || action === 'retry') rt.refreshQuote();
      });
    });

    const hold = rt.root.querySelector('[data-hold-confirm]');
    if (!hold) return;
    let timer = null;
    let active = false;
    const finish = () => {
      if (!active) return;
      active = false;
      timer = null;
      rt.setUiLock(false);
      rt.confirm();
    };
    const cancel = () => {
      if (!active) return;
      active = false;
      if (timer) window.clearTimeout(timer);
      timer = null;
      rt.setUiLock(false);
    };
    const start = (event) => {
      if (hold.disabled || active) return;
      event.preventDefault();
      active = true;
      rt.setUiLock(true);
      hold.classList.add('holding');
      timer = window.setTimeout(finish, 1000);
    };
    hold.addEventListener('pointerdown', start);
    hold.addEventListener('pointerup', cancel);
    hold.addEventListener('pointercancel', cancel);
    hold.addEventListener('pointerleave', cancel);
    hold.addEventListener('keydown', (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) start(event);
    });
    hold.addEventListener('keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') cancel();
    });
    hold.addEventListener('blur', cancel);
  }

  function arrival(sc) {
    return `
      <div class="arrival-card" data-arrival-direction="c">
        <div class="arrival-main">
          <div class="arrival-blocks" aria-hidden="true" style="grid-template-columns:repeat(${sc.blocks + 1},1fr);">
            ${Array.from({ length: sc.blocks }, (_, i) => `<span class="arrival-block">B${i + 1}</span>`).join('')}<span class="arrival-block payout">✓</span>
          </div>
          <div class="arrival-copy">
            <div class="arrival-title num">到账：${esc(sc.arrivalAmount)} · ${esc(sc.targetChain)}</div>
            <div class="arrival-meta num">${esc(sc.durationText)} · ${esc(window.AB.shortHash(sc.targetTxid))} · <a class="arrival-link" href="#card-c">查看原卡</a></div>
          </div>
        </div>
      </div>
    `;
  }

  window.AssetBridgeDirections.c = { render, bind, arrival };
})();
