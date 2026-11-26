(function () {
  'use strict';

  const { esc, badge, copyChip, feeRowsHtml } = window.AB;

  function header(rt, pill, pillClass) {
    const sc = rt.scenario();
    return `
      <div class="tk-top">
        <div class="tk-ident">
          <div class="tk-avatar dual-grad">⇄</div>
          <div class="tk-title-col">
            <div class="tk-title-line"><span class="tk-symbol">${esc(sc.assetTitle)}</span></div>
            <div class="tk-subline">${esc(sc.sourceBadge)} → ${esc(sc.targetBadge)}</div>
          </div>
        </div>
        <span class="b-status-pill ${pillClass || 'quote'}">${esc(pill)}</span>
      </div>
    `;
  }

  function flowBoxes(rt) {
    const sc = rt.scenario();
    return `
      <div class="flow-dual num">
        <div class="flow-box">
          <div class="bento-label">转出</div>
          <div style="margin:0 0 4px;">${badge(sc.sourceChain, sc.sourceBadge)}</div>
          <div class="bento-val">-${esc(sc.sendAmount)} ${esc(sc.sendUnit)}</div>
          <div class="bento-sub">${esc(sc.sourceBalance)}</div>
        </div>
        <div class="flow-arrow">→</div>
        <div class="flow-box" style="border:1px solid var(--up-border);">
          <div class="bento-label">收到</div>
          <div style="margin:0 0 4px;">${badge(sc.targetChain, sc.targetBadge)}</div>
          <div class="bento-val" style="color:var(--up);">+${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)}</div>
          <div class="bento-sub">${esc(sc.targetBalance)} · 1:1 锚定</div>
        </div>
      </div>
    `;
  }

  function quoteLedger(rt) {
    const sc = rt.scenario();
    return `
      <div class="ledger-box num">
        <div class="ledger-row"><span class="ledger-k">转出</span><span class="ledger-v">-${esc(sc.sendAmount)} ${esc(sc.sendUnit)}</span></div>
        <div class="ledger-row"><span class="ledger-k">预计收到</span><span class="ledger-v" style="color:var(--up);">+${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)}</span></div>
        ${feeRowsHtml(sc, { includeExtra: true })}
        <div class="ledger-row"><span class="ledger-k">预计到账</span><span class="ledger-v">${sc.blocks} 个区块 · 约 ${sc.etaMinutes} 分钟</span></div>
        <div class="ledger-row"><span class="ledger-k">付款钱包</span><span class="ledger-v">${esc(sc.botName)} · ${esc(sc.btcAddress)} / ${esc(sc.mvcAddress)}</span></div>
        <div class="ledger-row"><span class="ledger-k">报价有效期</span><span class="ledger-v quote-count" data-quote-count>${esc(rt.quoteCountdown())}</span></div>
      </div>
    `;
  }

  function insufficientBox(sc) {
    return `
      <div class="warn-box num">
        确认已阻止：赎回需要 BTC 费用约 <strong>${sc.requiredBtcSats.toLocaleString('en-US')} sats</strong>，当前可用只有 <strong>${sc.availableBtcSats.toLocaleString('en-US')} sats</strong>。缺口约 ${(sc.requiredBtcSats - sc.availableBtcSats).toLocaleString('en-US')} sats。
      </div>
    `;
  }

  function quote(rt) {
    const blocked = rt.isInsufficient();
    return `
      ${header(rt, blocked ? '费用不足' : '待确认', blocked ? 'warn' : 'quote')}
      ${flowBoxes(rt)}
      ${quoteLedger(rt)}
      ${blocked ? insufficientBox(rt.scenario()) : ''}
      <div class="btn-row">
        <button type="button" class="btn-secondary" data-action="${blocked ? 'topup' : 'cancel'}">${blocked ? '先补足 BTC / 取消' : '取消'}</button>
        <button type="button" class="btn-primary" data-action="confirm" ${blocked ? 'disabled' : ''}>确认桥接</button>
      </div>
    `;
  }

  function signing(rt) {
    return `
      ${header(rt, '签名广播中', 'quote')}
      <div class="dimmed-during-signing">
        ${flowBoxes(rt)}
        ${quoteLedger(rt)}
      </div>
      <div class="a-signing-veil"><span class="spinner"></span><span>正在签名并广播源链交易…</span></div>
    `;
  }

  function stepper(rt) {
    const p = rt.progress();
    const sc = rt.scenario();
    const phase = p.blocksDone >= sc.blocks ? 3 : 2;
    const steps = [
      [1, '源链广播'],
      [2, `区块确认 ${Math.min(p.blocksDone + 1, sc.blocks)}/${sc.blocks}`],
      [3, '目标链入账']
    ];
    return `
      <div class="b-stepper">
        ${steps.map(([idx, label], i) => `
          ${i ? '<span class="b-step-line"></span>' : ''}
          <div class="b-step ${idx < phase ? 'done' : idx === phase ? 'active' : ''}">
            <span class="b-step-dot">${idx < phase ? '✓' : idx}</span><span class="b-step-label">${esc(label)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function bridging(rt) {
    const sc = rt.scenario();
    const p = rt.progress();
    const pct = Math.floor(p.percent * 100);
    return `
      ${header(rt, rt.state === 'bridging-slow' ? '出块偏慢' : '区块确认中', rt.state === 'bridging-slow' ? 'warn' : 'quote')}
      <div class="ledger-box num">
        <div class="ledger-row"><span class="ledger-k">转出</span><span class="ledger-v">-${esc(sc.sendAmount)} ${esc(sc.sendUnit)} · ${esc(sc.sourceBadge)}</span></div>
        <div class="ledger-row"><span class="ledger-k">预计收到</span><span class="ledger-v" style="color:var(--up);">+${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)} · ${esc(sc.targetBadge)}</span></div>
      </div>
      ${stepper(rt)}
      <div class="prog-strip num">
        <div class="prog-top"><span style="font-weight:650;">${esc(p.stage)}</span><span><strong>${pct}%</strong> · ${esc(p.remaining)}</span></div>
        <div class="prog-track"><div class="prog-fill brand" style="width:${pct}%"></div></div>
      </div>
      ${rt.state === 'bridging-slow' ? `<div class="warn-box">${esc(rt.scenario().blockChain)} 区块当前出块慢于平均值；这是正常现象，桥接路径没有改变。</div>` : ''}
      <div class="muted-line">你可以离开——到账后我会在聊天里告诉你。</div>
      <div class="ledger-box num">
        <div class="ledger-row"><span class="ledger-k">源链交易</span><span class="ledger-v">${copyChip(rt.sourceTxid || sc.sourceTxid, '复制源链交易')}</span></div>
        <div class="ledger-row"><span class="ledger-k">已用时间</span><span class="ledger-v">${esc(p.elapsed)}</span></div>
      </div>
    `;
  }

  function completed(rt) {
    const sc = rt.scenario();
    return `
      ${header(rt, '跨链已到账', 'done')}
      <div class="perf-divider"></div>
      <div class="b-receipt-head">
        <div class="b-receipt-title">跨链凭证</div>
        <div class="b-receipt-sub num">OCTOPUS BRIDGE · ${esc(sc.key)} · ${esc(sc.durationText)}</div>
      </div>
      <div class="success-box num"><strong>+${esc(sc.receiveAmount)} ${esc(sc.receiveUnit)}</strong> 已入账到 ${esc(sc.targetChain)} · ${esc(sc.targetBadge)}</div>
      <div class="ledger-box num">
        <div class="ledger-row"><span class="ledger-k">源链交易</span><span class="ledger-v">${copyChip(rt.sourceTxid || sc.sourceTxid, '复制源链交易')}</span></div>
        <div class="ledger-row"><span class="ledger-k">目标链交易</span><span class="ledger-v">${copyChip(rt.targetTxid || sc.targetTxid, '复制目标链交易')}</span></div>
        <div class="ledger-row"><span class="ledger-k">实际费用</span><span class="ledger-v">${esc(sc.feeSummary)}</span></div>
        <div class="ledger-row"><span class="ledger-k">开始 / 完成</span><span class="ledger-v">14:02 → 14:${sc.key === 'S2' ? '33' : '13'}</span></div>
        <div class="ledger-row"><span class="ledger-k">总耗时</span><span class="ledger-v">${esc(rt.completedDurationMs ? rt.progress().elapsed : sc.durationText)}</span></div>
      </div>
      <div class="chip-row">
        <button type="button" class="chip-btn">查看余额</button>
        <button type="button" class="chip-btn">挂牌出售</button>
        <button type="button" class="chip-btn">再次桥接</button>
      </div>
    `;
  }

  function failed(rt) {
    return `
      ${header(rt, '桥接失败', 'down')}
      ${flowBoxes(rt)}
      <div class="down-box">${esc(rt.failReason || '桥节点在目标链入账前返回了可重试错误。')}</div>
      <div class="ledger-box">
        <div class="ledger-row"><span class="ledger-k">资金状态</span><span class="ledger-v">未丢失 · 不会重复扣款</span></div>
        <div class="ledger-row"><span class="ledger-k">源链交易</span><span class="ledger-v">${copyChip(rt.scenario().sourceTxid, '复制源链交易')}</span></div>
      </div>
      <div class="btn-row"><button type="button" class="btn-secondary" data-action="contact">联系桥支持</button><button type="button" class="btn-primary" data-action="retry">重试</button></div>
    `;
  }

  function expired(rt) {
    return `
      ${header(rt, '报价已过期', 'warn')}
      ${flowBoxes(rt)}
      <div class="warn-box">10 分钟报价有效期已结束。费率可能已变化，确认前需要刷新报价。</div>
      ${quoteLedger(rt)}
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
        if (action === 'confirm') rt.confirm();
        if (action === 'cancel' || action === 'topup') rt.cancel();
        if (action === 'refresh' || action === 'retry') rt.refreshQuote();
      });
    });
  }

  function arrival(sc) {
    return `
      <div class="arrival-card" data-arrival-direction="b">
        <div class="arrival-main">
          <div class="arrival-copy">
            <div class="arrival-title num">桥接到账回执 · ${esc(sc.arrivalAmount)}</div>
            <div class="arrival-meta num">${esc(sc.targetChain)} 入账 · ${esc(sc.durationText)} · 目标交易 ${esc(window.AB.shortHash(sc.targetTxid))}</div>
          </div>
          <a class="arrival-link" href="#card-b">原卡</a>
        </div>
        <div class="arrival-receipt num"><span>Octopus Bridge</span><span>${esc(sc.key)} · 1:1 已入账</span></div>
      </div>
    `;
  }

  window.AssetBridgeDirections.b = { render, bind, arrival };
})();
