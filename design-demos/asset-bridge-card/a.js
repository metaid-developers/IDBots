(function () {
  'use strict';

  const { esc, badge, copyChip, feeRowsHtml } = window.AB;

  function arcPoint(t) {
    const p0 = { x: 45, y: 64 };
    const p1 = { x: 104, y: 4 };
    const p2 = { x: 216, y: 4 };
    const p3 = { x: 275, y: 64 };
    const u = 1 - t;
    return {
      x: (u ** 3 * p0.x) + (3 * u ** 2 * t * p1.x) + (3 * u * t ** 2 * p2.x) + (t ** 3 * p3.x),
      y: (u ** 3 * p0.y) + (3 * u ** 2 * t * p1.y) + (3 * u * t ** 2 * p2.y) + (t ** 3 * p3.y)
    };
  }

  function arcHero(rt, mode) {
    const sc = rt.scenario();
    const progress = rt.progress();
    const pct = mode === 'quote' ? 0 : progress.percent;
    const dot = arcPoint(Math.max(0, Math.min(1, pct)));
    const ticks = [];
    for (let i = 1; i <= sc.blocks; i += 1) {
      const t = i / (sc.blocks + 0.5);
      const p = arcPoint(t);
      const done = mode !== 'quote' && (progress.blocksDone >= i || mode === 'completed');
      ticks.push(`<g><circle class="a-block-tick ${done ? 'done' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.2"></circle><text x="${p.x.toFixed(1)}" y="${(p.y + 2.6).toFixed(1)}" text-anchor="middle" font-size="6.5" font-weight="800" fill="${done ? 'var(--card-bg)' : 'var(--text-3)'}">${i}</text></g>`);
    }
    const complete = mode === 'completed';
    const sourceDisc = sc.sourceChain === 'BTC' ? 'btc' : 'mvc';
    const targetDisc = sc.targetChain === 'BTC' ? 'btc' : 'mvc';
    return `
      <div class="a-hero" aria-hidden="true">
        <svg class="a-arc-svg" viewBox="0 0 320 104" role="img">
          <path class="${mode === 'quote' ? 'a-arc-dash' : 'a-arc-base'}" d="M45 64 C104 4 216 4 275 64"></path>
          ${mode === 'quote' ? '' : `<path class="a-arc-progress" pathLength="1" stroke-dasharray="${Math.max(0.006, pct)} 1" d="M45 64 C104 4 216 4 275 64"></path>`}
          ${ticks.join('')}
          ${mode === 'quote' ? '' : `<circle class="a-moving-dot" cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="8"></circle>`}
        </svg>
        <div class="chain-disc source ${sourceDisc}">${esc(sc.sourceChain === 'BTC' ? 'BTC' : 'MVC')}<small>${esc(sc.sourceChain)}</small></div>
        <div class="chain-disc target ${targetDisc}">${complete ? '<span class="disc-check">✓</span>' : ''}${esc(sc.targetChain === 'BTC' ? 'BTC' : 'MVC')}<small>${esc(sc.targetChain)}</small></div>
      </div>
    `;
  }

  function amountLine(sc) {
    return `<div class="a-amount-line num">${esc(sc.sendAmount)} ${esc(sc.sendUnit)}<span>→</span>${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)}</div>`;
  }

  function summaryRows(rt) {
    const sc = rt.scenario();
    return `
      <div class="ledger-box num">
        <div class="ledger-row"><span class="ledger-k">你将收到</span><span class="ledger-v" style="color:var(--up);">${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)}</span></div>
        <div class="ledger-row"><span class="ledger-k">总费用</span><span class="ledger-v">${esc(sc.feeSummary)}</span></div>
        <div class="ledger-row"><span class="ledger-k">预计到账</span><span class="ledger-v">${sc.blocks} 个区块 · 约 ${sc.etaMinutes} 分钟</span></div>
      </div>
    `;
  }

  function walletLine(sc) {
    return `<div class="muted-line num">付款与接收钱包：${esc(sc.botName)} · BTC ${esc(sc.btcAddress)} · MVC ${esc(sc.mvcAddress)}</div>`;
  }

  function feeDetails(rt) {
    const sc = rt.scenario();
    return `
      <details class="fee-details">
        <summary>费用明细 <span class="num">${esc(sc.feeSummary)}</span></summary>
        <div class="ledger-box num">${feeRowsHtml(sc, { includeExtra: true })}</div>
      </details>
    `;
  }

  function quote(rt, insufficient) {
    const sc = rt.scenario();
    const blocked = insufficient || rt.isInsufficient();
    return `
      ${arcHero(rt, 'quote')}
      ${amountLine(sc)}
      <div class="chip-row" style="justify-content:center;">${badge(sc.sourceChain, sc.sourceBadge)}${badge(sc.targetChain, sc.targetBadge)}</div>
      ${summaryRows(rt)}
      ${feeDetails(rt)}
      ${walletLine(sc)}
      ${blocked ? `
        <div class="warn-box num">
          BTC 费用余额不足：需要约 <strong>${sc.requiredBtcSats.toLocaleString('en-US')} sats</strong>，当前只有 <strong>${sc.availableBtcSats.toLocaleString('en-US')} sats</strong>。请先补足 BTC 费用，再确认赎回。
        </div>` : ''}
      <button type="button" class="btn-primary" data-action="confirm" ${blocked ? 'disabled' : ''}>确认桥接</button>
      <div class="quote-note num">报价 <span class="quote-count" data-quote-count>${esc(rt.quoteCountdown())}</span> 后失效</div>
      ${blocked ? '<button type="button" class="btn-secondary" data-action="topup">先补足 BTC / 取消</button>' : '<button type="button" class="btn-text" data-action="cancel">取消</button>'}
    `;
  }

  function signing(rt) {
    const sc = rt.scenario();
    return `
      <div class="dimmed-during-signing">
        ${arcHero(rt, 'quote')}
        ${amountLine(sc)}
        ${summaryRows(rt)}
      </div>
      <div class="a-signing-veil"><span class="spinner"></span><span>正在签名并广播源链交易，报价内容保持不变…</span></div>
      ${walletLine(sc)}
    `;
  }

  function bridging(rt) {
    const p = rt.progress();
    const slow = rt.state === 'bridging-slow';
    return `
      ${arcHero(rt, 'bridging')}
      <div class="a-progress-hero">
        <div class="a-percent num">${Math.floor(p.percent * 100)}<span style="font-size:18px;">%</span></div>
        <div class="a-remaining num">${esc(p.remaining)}</div>
        <div class="a-stage-label num">${esc(p.stage)} · 已用 ${esc(p.elapsed)}</div>
      </div>
      ${slow ? `<div class="warn-box">${esc(rt.scenario().blockChain)} 区块当前出块慢于平均值；这是正常现象，资金仍在原路径中等待确认。</div>` : ''}
      <div class="muted-line">你可以离开——到账后我会在聊天里告诉你。</div>
      <div class="a-card-footer">
        <span class="bdg bdg-neutral num">已用 ${esc(p.elapsed)}</span>
        ${copyChip(rt.sourceTxid || rt.scenario().sourceTxid, '复制源链交易')}
      </div>
    `;
  }

  function txidRows(rt) {
    return `
      <div class="ledger-box num">
        <div class="ledger-row"><span class="ledger-k">源链交易</span><span class="ledger-v">${copyChip(rt.sourceTxid || rt.scenario().sourceTxid, '复制源链交易')}</span></div>
        <div class="ledger-row"><span class="ledger-k">目标链交易</span><span class="ledger-v">${copyChip(rt.targetTxid || rt.scenario().targetTxid, '复制目标链交易')}</span></div>
        <div class="ledger-row"><span class="ledger-k">实际费用</span><span class="ledger-v">${esc(rt.scenario().feeSummary)}</span></div>
        <div class="ledger-row"><span class="ledger-k">总耗时</span><span class="ledger-v">${esc(rt.completedDurationMs ? rt.progress().elapsed : rt.scenario().durationText)}</span></div>
      </div>
    `;
  }

  function completed(rt) {
    const sc = rt.scenario();
    return `
      ${arcHero(rt, 'completed')}
      <div class="a-progress-hero">
        <div class="a-percent num" style="color:var(--up);font-size:25px;">+${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)}</div>
        <div class="a-remaining">已到账</div>
      </div>
      ${txidRows(rt)}
      <div class="chip-row">
        <button type="button" class="chip-btn">查看余额</button>
        <button type="button" class="chip-btn">挂牌出售</button>
        <button type="button" class="chip-btn">再次桥接</button>
      </div>
    `;
  }

  function failed(rt) {
    return `
      ${arcHero(rt, 'quote')}
      <div class="failed-title">桥接没有完成</div>
      <div class="down-box">${esc(rt.failReason || '桥节点返回了可重试错误；源链交易已确认，但资产没有丢失。')}</div>
      <div class="muted-line">资金状态：源链资产仍由桥接路径托管，重试会继续同一笔桥接，不会重复扣款。</div>
      <div class="btn-row"><button type="button" class="btn-secondary" data-action="contact">联系桥支持</button><button type="button" class="btn-primary" data-action="retry">重试桥接</button></div>
    `;
  }

  function expired(rt) {
    const sc = rt.scenario();
    return `
      ${arcHero(rt, 'quote')}
      <div class="expired-title">报价已过期</div>
      <div class="warn-box">10 分钟报价有效期已结束。费率可能已变化，需要重新获取报价后才能确认。</div>
      ${summaryRows(rt)}
      <button type="button" class="btn-primary" data-action="refresh">刷新报价</button>
    `;
  }

  function render(rt) {
    if (rt.state === 'quote' || rt.state === 'quote-insufficient') return quote(rt, rt.state === 'quote-insufficient');
    if (rt.state === 'signing') return signing(rt);
    if (rt.state === 'bridging' || rt.state === 'bridging-slow') return bridging(rt);
    if (rt.state === 'completed') return completed(rt);
    if (rt.state === 'failed') return failed(rt);
    return expired(rt);
  }

  function bind(rt) {
    const details = rt.root.querySelector('.fee-details');
    if (details) {
      let previousHeight = rt.root.offsetHeight;
      details.addEventListener('beforetoggle', () => {
        previousHeight = rt.root.offsetHeight;
      });
      details.addEventListener('toggle', () => {
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const endHeight = rt.root.scrollHeight;
        if (reduce || Math.abs(endHeight - previousHeight) < 2) {
          previousHeight = endHeight;
          return;
        }
        rt.root.style.height = `${previousHeight}px`;
        rt.root.classList.add('morphing');
        requestAnimationFrame(() => {
          rt.root.style.height = `${endHeight}px`;
          window.setTimeout(() => {
            rt.root.classList.remove('morphing');
            rt.root.style.height = '';
          }, 280);
        });
        previousHeight = endHeight;
      });
    }
    rt.root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'confirm') rt.confirm();
        if (action === 'cancel' || action === 'topup') rt.cancel();
        if (action === 'refresh' || action === 'retry') rt.refreshQuote();
      });
    });
  }

  function arrival(sc) {
    const sourceDisc = sc.sourceChain === 'BTC' ? 'btc' : 'mvc';
    const targetDisc = sc.targetChain === 'BTC' ? 'btc' : 'mvc';
    return `
      <div class="arrival-card" data-arrival-direction="a">
        <div class="arrival-main">
          <div class="arrival-discs"><span class="mini-disc ${sourceDisc}">${esc(sc.sourceChain === 'BTC' ? 'B' : 'M')}</span><span class="mini-disc ${targetDisc}">${esc(sc.targetChain === 'BTC' ? 'B' : 'M')}</span></div>
          <div class="arrival-copy">
            <div class="arrival-title num">桥接到账 ${esc(sc.arrivalAmount)} · ${esc(sc.targetChain)}</div>
            <div class="arrival-meta num">${esc(sc.durationText)} · 目标交易 ${esc(window.AB.shortHash(sc.targetTxid))}</div>
          </div>
          <a class="arrival-link" href="#card-a">查看原卡</a><span class="chev">›</span>
        </div>
      </div>
    `;
  }

  window.AssetBridgeDirections.a = { render, bind, arrival };
})();
