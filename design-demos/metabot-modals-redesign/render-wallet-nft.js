// ============================================================================
// Part 1: Surface 1 (On-Chain Wallet) & Surface 2 (NFT Wallet) Renderers
// ============================================================================

window.shortAddr = function shortAddr(addr, head = 7, tail = 6) {
  if (!addr || addr.length <= head + tail + 3) return addr || '';
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
};

function botAvatarHtml(state) {
  const activeKey = state.activeNftAvatarKey;
  if (activeKey) {
    const found = window.MOCK_NFTS.mrc721Items.find((it) => it.key === activeKey);
    if (found) {
      return `<div class="sl-bot-avatar nft-framed" title="链上 MRC-721 NFT 头像">${found.svg}</div>`;
    }
  }
  const builtin = window.MOCK_BUILTIN_AVATARS.find((b) => b.code === state.activeBuiltinCode) || window.MOCK_BUILTIN_AVATARS[0];
  return `<div class="sl-bot-avatar">${builtin.svg}</div>`;
}

window.botAvatarHtml = botAvatarHtml;

// ----------------------------------------------------------------------------
// SURFACE 1: ON-CHAIN WALLET (W1 vs W2)
// ----------------------------------------------------------------------------
function renderTransferFormHtml(st, variant) {
  const target = st.transferTarget;
  if (!target) return '';
  const step = st.transferStep || 1;
  const feeIdx = st.feeTier ?? 1;
  const fees = target.chain === 'doge'
    ? [
        { label: '慢速', rate: '0.02 DOGE/kB', est: '0.02 DOGE' },
        { label: '标准', rate: '0.05 DOGE/kB', est: '0.05 DOGE' },
        { label: '极速', rate: '0.10 DOGE/kB', est: '0.10 DOGE' },
      ]
    : target.chain === 'btc'
      ? [
          { label: '经济', rate: '2 sat/vB', est: '0.00000310 BTC' },
          { label: '标准', rate: '4 sat/vB', est: '0.00000620 BTC' },
          { label: '优先', rate: '8 sat/vB', est: '0.00001240 BTC' },
        ]
      : [
          { label: '经济', rate: '1 sat/vB', est: '0.00000220 SPACE' },
          { label: '标准', rate: '1 sat/vB', est: '0.00000220 SPACE' },
          { label: '优先', rate: '2 sat/vB', est: '0.00000440 SPACE' },
        ];
  const curFee = fees[feeIdx] || fees[1];
  const sampleTo = target.chain === 'btc'
    ? 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
    : target.chain === 'doge'
      ? 'D8vK3p9M2x4R7t1W6z8B3n5Q9m2L4k7J1'
      : '1MvcRecv8P4k2W9x7R3s5T1u6V8z2B4n6';
  const amt = st.transferAmount || (target.isToken ? '250.00' : target.chain === 'btc' ? '0.00200000' : '15.00000000');

  return `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:6px;white-space:nowrap;">
          ${variant === 'A' ? `<button class="btn-flat" data-act="wallet-close-transfer" data-v="${variant}">← 返回资产</button>` : ''}
          <span style="font-size:13px;font-weight:700;">发送 ${target.symbol}</span>
          <span class="bdg ${target.badgeClass}">${target.networkLabel}</span>
        </div>
        <div style="display:flex;align-items:center;gap:3px;font-size:10.5px;color:var(--text-2);white-space:nowrap;" class="num">
          <span class="bdg ${step === 1 ? 'bdg-brand' : 'bdg-neutral'}">1 填写</span>
          <span>›</span>
          <span class="bdg ${step === 2 ? 'bdg-brand' : 'bdg-neutral'}">2 确认</span>
          <span>›</span>
          <span class="bdg ${step === 3 ? 'bdg-ok' : 'bdg-neutral'}">3 完成</span>
        </div>
      </div>

      ${step === 1 ? `
        <div class="sl-group-box" style="padding:12px;display:flex;flex-direction:column;gap:10px;">
          <div>
            <div class="sl-group-label-row">
              <span class="sl-group-label">接收方 ${target.chain.toUpperCase()} 地址</span>
              <span class="sl-group-note">主网校验</span>
            </div>
            <input class="sl-input mono" value="${sampleTo}" readonly />
          </div>
          <div>
            <div class="sl-group-label-row">
              <span class="sl-group-label">转账数量</span>
              <button style="font-size:11px;font-weight:700;color:var(--brand-fg);white-space:nowrap;" data-act="wallet-fill-max" data-v="${variant}">
                最大 ${target.maxBalance}
              </button>
            </div>
            <div style="position:relative;">
              <input class="sl-input num" value="${amt}" readonly style="padding-right:64px;font-weight:700;" />
              <span style="position:absolute;right:10px;top:7px;font-size:11.5px;font-weight:700;color:var(--text-2);">${target.symbol}</span>
            </div>
          </div>
          <div>
            <div class="sl-group-label-row">
              <span class="sl-group-label">网络费率档位</span>
              <span class="sl-group-note num">预计矿工费 ${curFee.est}</span>
            </div>
            <div class="fee-pills">
              ${fees.map((f, idx) => `
                <button class="fee-pill ${idx === feeIdx ? 'active' : ''}" data-act="wallet-fee" data-v="${variant}" data-idx="${idx}">
                  <div class="fee-pill-title">${f.label}</div>
                  <div class="fee-pill-rate mono">${f.rate}</div>
                </button>
              `).join('')}
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:4px;">
            ${variant === 'B' ? `<button class="btn-flat" data-act="wallet-close-transfer" data-v="${variant}">重置</button>` : ''}
            <button class="btn-primary" data-act="wallet-step" data-v="${variant}" data-step="2">下一步：预览矿工费 →</button>
          </div>
        </div>
      ` : step === 2 ? `
        <div class="sl-group-box">
          <div class="sl-group-row" style="background:var(--inset-bg);">
            <span style="font-size:12px;color:var(--text-2);">即将广播交易</span>
            <span style="font-size:15px;font-weight:800;" class="num">${amt} ${target.symbol}</span>
          </div>
          <div class="sl-group-row">
            <span style="font-size:12px;color:var(--text-2);">发送方 (${window.MOCK_BOT.name})</span>
            <span class="mono" style="font-size:11.5px;">${window.shortAddr(target.fromAddress, 8, 8)}</span>
          </div>
          <div class="sl-group-row">
            <span style="font-size:12px;color:var(--text-2);">接收方地址</span>
            <span class="mono" style="font-size:11.5px;">${window.shortAddr(sampleTo, 8, 8)}</span>
          </div>
          <div class="sl-group-row">
            <span style="font-size:12px;color:var(--text-2);">预估网络矿工费 (${curFee.rate})</span>
            <span class="mono" style="font-size:11.5px;">${curFee.est}</span>
          </div>
          ${target.isToken && target.chain === 'btc' ? `
            <div class="sl-group-row">
              <span style="font-size:12px;color:var(--text-2);">MRC-20 两阶段提交</span>
              <span class="bdg bdg-btc">Commit + Reveal 自动签名</span>
            </div>
          ` : ''}
          <div class="sl-group-row" style="justify-content:flex-end;gap:8px;">
            <button class="btn-flat" data-act="wallet-step" data-v="${variant}" data-step="1">← 修改参数</button>
            <button class="btn-primary" data-act="wallet-step" data-v="${variant}" data-step="3">确认签名并广播</button>
          </div>
        </div>
      ` : `
        <div class="sl-group-box" style="padding:16px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;">
          <span class="bdg bdg-ok" style="font-size:11.5px;padding:3px 9px;">✓ 链上广播成功</span>
          <div style="font-size:15px;font-weight:800;" class="num">-${amt} ${target.symbol}</div>
          <div style="font-size:11.5px;color:var(--text-2);">TxID 已生成并写入本地记录</div>
          <div style="display:flex;align-items:center;gap:6px;background:var(--inset-bg);padding:6px 10px;border-radius:7px;border:1px solid var(--border-subtle);max-width:100%;">
            <code class="mono" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;">8f4a29c1e7b04d3a92f1c8e5b6d7a091...4c29</code>
            <button class="btn-flat" style="height:24px;font-size:11px;" data-toast="已复制交易 TxID">复制</button>
          </div>
          <div style="padding-top:6px;">
            <button class="btn-primary" data-act="wallet-close-transfer" data-v="${variant}">完成并返回钱包</button>
          </div>
        </div>
      `}
    </div>
  `;
}

window.renderWalletVariantA = function renderWalletVariantA(st, globalState) {
  const tab = st.tab || 'native';
  return `
    <div class="sl-modal" style="max-width:590px;">
      <div class="sl-modal-header">
        <div class="sl-bot-id">
          ${botAvatarHtml(globalState)}
          <div class="sl-header-titles">
            <h4>链上钱包 · ${window.MOCK_BOT.name} <span class="bdg bdg-neutral">非托管本地签名</span></h4>
            <div class="sl-header-sub">
              <span>已整合全部链上代币</span>
              <span>·</span>
              <span style="color:var(--ok);font-weight:600;">已移除旧版二级弹窗与老藏品升级入口</span>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="btn-flat" data-act="jump-surface" data-target="nft" title="前往 NFT 钱包">NFT 钱包 (50) →</button>
          <button class="sl-icon-btn" data-toast="已刷新三链余额与代币索引" title="刷新余额">↻</button>
          <button class="sl-icon-btn" title="关闭">✕</button>
        </div>
      </div>

      <div class="sl-tabs-underline">
        <div class="sl-tab-list">
          <button class="sl-tab ${tab === 'native' ? 'active' : ''}" data-act="wallet-tab" data-v="A" data-tab="native">
            原生主链 <span class="sl-tab-count">3</span>
          </button>
          <button class="sl-tab ${tab === 'mrc20' ? 'active' : ''}" data-act="wallet-tab" data-v="A" data-tab="mrc20">
            MRC-20 (BTC) <span class="sl-tab-count">4</span>
          </button>
          <button class="sl-tab ${tab === 'mvcft' ? 'active' : ''}" data-act="wallet-tab" data-v="A" data-tab="mvcft">
            MVC Token <span class="sl-tab-count">3</span>
          </button>
        </div>
        <label style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-2);cursor:pointer;">
          <input type="checkbox" ${st.showDegraded ? 'checked' : ''} data-act="wallet-toggle-degraded" />
          演示 MVC 节点降级提示
        </label>
      </div>

      <div class="sl-body">
        ${st.transferTarget ? renderTransferFormHtml(st, 'A') : tab === 'native' ? `
          <div class="sl-group-label-row">
            <span class="sl-group-label">三链原生资产 (默认页)</span>
            <span class="sl-group-note">官方原生链图标 · 8 位精度对齐</span>
          </div>
          <div class="sl-group-box">
            ${window.MOCK_WALLET.native.map((c) => `
              <div class="sl-group-row" style="flex-direction:column;align-items:stretch;gap:7px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                  <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                    <span class="chain-icon">${window.CHAIN_SVGS[c.chain]}</span>
                    <div style="min-width:0;">
                      <div style="display:flex;align-items:center;gap:6px;">
                        <span style="font-size:13.5px;font-weight:700;">${c.symbol}</span>
                        <span class="bdg ${c.badgeClass}">${c.name}</span>
                      </div>
                      <div style="margin-top:3px;display:flex;align-items:center;gap:6px;">
                        <button class="addr-chip mono" data-toast="已复制 ${c.symbol} 地址: ${c.address}">
                          ${window.shortAddr(c.address, 8, 7)} <span>⧉</span>
                        </button>
                      </div>
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
                    <div style="text-align:right;">
                      <div class="num" style="font-size:13.5px;font-weight:700;">${c.balance} <span style="font-size:11.5px;color:var(--text-2);">${c.symbol}</span></div>
                      <div class="num" style="font-size:11px;color:var(--text-3);">${c.feeHint}</div>
                    </div>
                    <button class="btn-flat" data-act="wallet-open-transfer" data-v="A" data-chain="${c.chain}" data-symbol="${c.symbol}" data-max="${c.balance}" data-token="0">转账</button>
                  </div>
                </div>
                ${c.chain === 'mvc' && st.showDegraded ? `
                  <div style="padding:6px 9px;border-radius:6px;background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn);font-size:11px;display:flex;align-items:center;gap:6px;">
                    <span>⚠ 余额可信层提示：</span><span>${c.degradedNote}</span>
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        ` : tab === 'mrc20' ? `
          <div class="sl-group-label-row">
            <span class="sl-group-label">BTC 链 · MRC-20 同质化代币</span>
            <span class="sl-group-note">自动汇总已确认与待确认余额</span>
          </div>
          <div class="sl-group-box">
            ${window.MOCK_WALLET.mrc20.map((t) => `
              <div class="sl-group-row">
                <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                  <div style="width:32px;height:32px;border-radius:8px;background:${t.color}22;border:1px solid ${t.color}55;color:${t.color};display:grid;place-items:center;font-weight:800;font-size:11.5px;flex-shrink:0;">
                    ${t.symbol.slice(0, 3)}
                  </div>
                  <div style="min-width:0;">
                    <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                      <span style="font-size:13px;font-weight:700;">$${t.symbol}</span>
                      <span class="bdg bdg-btc">BTC · MRC-20</span>
                      ${t.verified ? `<span class="bdg bdg-ok">✓ 官方认证</span>` : `<span class="bdg bdg-neutral mono">ID ${t.mrc20Id.slice(0, 10)}</span>`}
                    </div>
                    <div style="font-size:11px;color:var(--text-2);margin-top:2px;" class="num">
                      已确认 ${t.confirmed}${t.pendingIn !== '0' ? ` · <span style="color:var(--ok);">待入账 ${t.pendingIn}</span>` : ''}${t.pendingOut !== '0' ? ` · <span style="color:var(--warn);">待转出 ${t.pendingOut}</span>` : ''}
                    </div>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
                  <div style="text-align:right;">
                    <div class="num" style="font-size:13.5px;font-weight:700;">${t.display}</div>
                    <div style="font-size:10.5px;color:var(--text-3);">${t.tokenName}</div>
                  </div>
                  <button class="btn-flat" data-act="wallet-open-transfer" data-v="A" data-chain="btc" data-symbol="${t.symbol}" data-max="${t.display.replace(/,/g, '')}" data-token="1">转账</button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="sl-group-label-row">
            <span class="sl-group-label">MVC 链 · MetaContract (MCP02) 合约代币</span>
            <span class="sl-group-note">支持极速低 Gas 转账</span>
          </div>
          <div class="sl-group-box">
            ${window.MOCK_WALLET.mvcFt.map((t) => `
              <div class="sl-group-row">
                <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                  <div style="width:32px;height:32px;border-radius:8px;background:${t.color}22;border:1px solid ${t.color}55;color:${t.color};display:grid;place-items:center;font-weight:800;font-size:11.5px;flex-shrink:0;">
                    ${t.symbol.slice(0, 3)}
                  </div>
                  <div style="min-width:0;">
                    <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                      <span style="font-size:13px;font-weight:700;">${t.symbol}</span>
                      <span class="bdg bdg-mvc">MVC · MCP02</span>
                      ${t.bridged ? `<span class="bdg bdg-neutral">⇄ 1:1 跨链桥</span>` : ''}
                      ${t.verified ? `<span class="bdg bdg-ok">✓ 官方认证</span>` : `<span class="bdg bdg-neutral mono">Genesis ${t.genesis}</span>`}
                    </div>
                    <div style="font-size:11px;color:var(--text-2);margin-top:2px;" class="num">
                      可用 ${t.confirmed}${t.unconfirmed !== '0' ? ` · <span style="color:var(--ok);">未确认 ${t.unconfirmed}</span>` : ''}
                    </div>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
                  <div class="num" style="font-size:13.5px;font-weight:700;">${t.display}</div>
                  <button class="btn-flat" data-act="wallet-open-transfer" data-v="A" data-chain="mvc" data-symbol="${t.symbol}" data-max="${t.display.replace(/,/g, '')}" data-token="1">转账</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>
  `;
};

window.renderWalletVariantB = function renderWalletVariantB(st, globalState) {
  const tab = st.tab || 'native';
  const defaultTarget = st.transferTarget || {
    chain: 'mvc',
    symbol: 'SPACE',
    badgeClass: 'bdg-mvc',
    networkLabel: 'MVC 原生币',
    fromAddress: window.MOCK_BOT.mvcAddress,
    maxBalance: '128.45200000',
    isToken: false,
  };
  const mergedSt = { ...st, transferTarget: defaultTarget };

  return `
    <div class="sl-modal" style="max-width:740px;">
      <div class="sl-modal-header">
        <div class="sl-bot-id">
          ${botAvatarHtml(globalState)}
          <div class="sl-header-titles">
            <h4>${window.MOCK_BOT.name} · 链上资产工作台 <span class="bdg bdg-brand">Bento 双栏</span></h4>
            <div class="sl-header-sub">
              <span>顶栏三链原生卡片常驻 + 左侧多协议 Token 页签 + 右侧即时转账单</span>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="btn-flat" data-act="jump-surface" data-target="nft">NFT 藏品库 (50) →</button>
          <button class="sl-icon-btn" data-toast="已同步最新链上 UTXO">↻</button>
          <button class="sl-icon-btn">✕</button>
        </div>
      </div>

      <div class="sl-body">
        <!-- Always-visible 3 Native Chain Hero Strip -->
        <div class="bento-chains-3">
          ${window.MOCK_WALLET.native.map((c) => {
            const isSel = defaultTarget.symbol === c.symbol;
            return `
              <div class="bento-chain-card ${isSel ? 'active' : ''}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                  <div style="display:flex;align-items:center;gap:7px;">
                    <span class="chain-icon sm">${window.CHAIN_SVGS[c.chain]}</span>
                    <span style="font-size:12.5px;font-weight:700;">${c.symbol}</span>
                  </div>
                  <button class="addr-chip mono" style="font-size:10px;padding:1px 5px;" data-toast="已复制 ${c.symbol} 地址">${window.shortAddr(c.address, 5, 4)} ⧉</button>
                </div>
                <div>
                  <div class="num" style="font-size:14.5px;font-weight:800;letter-spacing:-0.01em;">${c.balance}</div>
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
                    <span style="font-size:10.5px;color:var(--text-3);">${c.name}</span>
                    <button class="btn-flat" style="height:24px;padding:0 8px;font-size:11px;" data-act="wallet-open-transfer" data-v="B" data-chain="${c.chain}" data-symbol="${c.symbol}" data-max="${c.balance}" data-token="0">发送</button>
                  </div>
                </div>
                ${c.chain === 'mvc' && st.showDegraded ? `<div style="font-size:10px;color:var(--warn);">⚠ 备用节点校验中</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>

        <!-- Split Lower Console: Token Tabs Left + Live Transfer Slip Right -->
        <div class="bento-split">
          <div style="display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
              <div class="seg-bar">
                <button class="seg-item ${tab === 'native' ? 'active' : ''}" data-act="wallet-tab" data-v="B" data-tab="native">原生地址 (3)</button>
                <button class="seg-item ${tab === 'mrc20' ? 'active' : ''}" data-act="wallet-tab" data-v="B" data-tab="mrc20">MRC-20 (4)</button>
                <button class="seg-item ${tab === 'mvcft' ? 'active' : ''}" data-act="wallet-tab" data-v="B" data-tab="mvcft">MVC FT (3)</button>
              </div>
            </div>

            <div class="sl-group-box">
              ${tab === 'native' ? window.MOCK_WALLET.native.map((c) => `
                <div class="sl-group-row" style="padding:9px 12px;">
                  <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                    <span class="chain-icon sm">${window.CHAIN_SVGS[c.chain]}</span>
                    <div style="min-width:0;">
                      <div style="font-size:12px;font-weight:700;">${c.name} (${c.symbol})</div>
                      <div class="mono" style="font-size:10.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;">${window.shortAddr(c.address, 10, 8)}</div>
                    </div>
                  </div>
                  <button class="btn-flat" style="height:26px;font-size:11px;" data-toast="已复制完整 ${c.symbol} 收款地址">复制收款码</button>
                </div>
              `).join('') : (tab === 'mrc20' ? window.MOCK_WALLET.mrc20 : window.MOCK_WALLET.mvcFt).map((t) => {
                const chainKey = tab === 'mrc20' ? 'btc' : 'mvc';
                const activeRow = defaultTarget.symbol === t.symbol;
                return `
                  <div class="sl-group-row" style="padding:9px 12px;${activeRow ? 'background:var(--brand-soft);' : ''}">
                    <div style="min-width:0;">
                      <div style="display:flex;align-items:center;gap:5px;">
                        <span style="font-size:12.5px;font-weight:700;">${t.symbol}</span>
                        ${t.verified ? `<span class="bdg bdg-ok">✓ 认证</span>` : `<span class="bdg bdg-neutral">未认证</span>`}
                      </div>
                      <div class="num" style="font-size:11px;color:var(--text-2);margin-top:1px;">余额 ${t.display}</div>
                    </div>
                    <button class="btn-flat" style="height:26px;font-size:11px;" data-act="wallet-open-transfer" data-v="B" data-chain="${chainKey}" data-symbol="${t.symbol}" data-max="${t.display.replace(/,/g, '')}" data-token="1">选入右侧转账 →</button>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Right Column: Inline Transfer Slip (no extra modal popup!) -->
          <div>
            ${renderTransferFormHtml(mergedSt, 'B')}
          </div>
        </div>
      </div>
    </div>
  `;
};

// ----------------------------------------------------------------------------
// SURFACE 2: NFT WALLET (N1 vs N2 — 2-Level Album View + Pagination + Avatar/Trade)
// ----------------------------------------------------------------------------
function filterAndSortNfts(st) {
  const kind = st.protocol || 'mrc721';
  const allAlbums = kind === 'mrc721' ? window.MOCK_NFTS.mrc721Albums : window.MOCK_NFTS.mcAlbums;
  let items = (kind === 'mrc721' ? window.MOCK_NFTS.mrc721Items : window.MOCK_NFTS.mcItems).slice();

  if (st.viewMode === 'albums' && st.selectedAlbumId) {
    items = items.filter((it) => it.albumId === st.selectedAlbumId);
  }
  if (st.onlyVerified) {
    items = items.filter((it) => it.verified);
  }
  const q = (st.search || '').trim().toLowerCase();
  if (q) {
    items = items.filter((it) =>
      it.name.toLowerCase().includes(q) ||
      it.collectionName.toLowerCase().includes(q) ||
      String(it.number).includes(q)
    );
  }
  if (st.sortBy === 'serialAsc') {
    items.sort((a, b) => (a.number < 0 ? 999999 : a.number) - (b.number < 0 ? 999999 : b.number));
  } else if (st.sortBy === 'nameAsc') {
    items.sort((a, b) => a.name.localeCompare(b.name));
  }
  const filteredAlbums = st.onlyVerified ? allAlbums.filter((a) => a.verified) : allAlbums;
  return { allAlbums: filteredAlbums, items };
}

function renderPaginationHtml(total, page, pageSize, variant) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const btns = [];
  for (let p = 1; p <= totalPages; p++) {
    btns.push(`<button class="page-btn num ${p === safePage ? 'active' : ''}" data-act="nft-page" data-v="${variant}" data-page="${p}">${p}</button>`);
  }
  return `
    <div class="pagination-bar">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="num">共 <strong>${total}</strong> 件藏品 · 第 ${safePage}/${totalPages} 页</span>
        <select class="sl-select num" style="height:26px;font-size:11px;" data-act="nft-pagesize" data-v="${variant}">
          ${[6, 8, 12].map((sz) => `<option value="${sz}" ${sz === pageSize ? 'selected' : ''}>${sz} 件 / 页</option>`).join('')}
        </select>
      </div>
      <div class="page-btns">
        <button class="page-btn" ${safePage <= 1 ? 'disabled' : ''} data-act="nft-page" data-v="${variant}" data-page="${safePage - 1}">‹</button>
        ${btns.join('')}
        <button class="page-btn" ${safePage >= totalPages ? 'disabled' : ''} data-act="nft-page" data-v="${variant}" data-page="${safePage + 1}">›</button>
      </div>
    </div>
  `;
}

function renderNftSubModalHtml(st, variant) {
  if (st.subModal === 'buy') {
    return `
      <div class="sl-group-box" style="padding:14px;display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:13.5px;font-weight:700;">粘贴原子挂单 JSON 购买 (MRC-721 信任最小化交割)</span>
          <button class="btn-flat" data-act="nft-submodal" data-v="${variant}" data-sub="">← 返回藏品</button>
        </div>
        <textarea class="sl-input mono" style="height:74px;padding:8px;" readonly>{"version":1,"itemPinId":"1149a8b7...114i0","priceSats":250000,"sellerAddress":"bc1q8c7...k3f7","psbtHex":"70736274ff01..."}</textarea>
        <div style="display:flex;align-items:center;justify-content:space-between;background:var(--inset-bg);padding:9px 12px;border-radius:8px;">
          <div style="font-size:12px;">校验状态：<span class="bdg bdg-ok">✓ 链上 UTXO 未花费 · 签名有效</span></div>
          <button class="btn-primary" data-toast="演示：已构建买家 PSBT 输入并完成原子购买广播">支付 0.0025 BTC 立即成交</button>
        </div>
      </div>
    `;
  }
  if (st.subModal === 'listings') {
    return `
      <div class="sl-group-box">
        <div class="sl-group-row" style="background:var(--inset-bg);">
          <span style="font-size:13px;font-weight:700;">我的本地定向挂单记录 (${window.MOCK_NFTS.myListings.length})</span>
          <button class="btn-flat" data-act="nft-submodal" data-v="${variant}" data-sub="">← 返回藏品</button>
        </div>
        ${window.MOCK_NFTS.myListings.map((ord) => `
          <div class="sl-group-row">
            <div>
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:12.5px;font-weight:700;">${ord.itemName}</span>
                ${ord.status === 'valid' ? `<span class="bdg bdg-ok">✓ 有效挂单</span>` : `<span class="bdg bdg-neutral">已过期</span>`}
              </div>
              <div style="font-size:11px;color:var(--text-2);margin-top:2px;" class="num">
                售价 ${ord.price} · 指定买家 ${ord.buyerShort} · ${ord.expires}
              </div>
            </div>
            <button class="btn-flat" data-toast="已复制挂单 JSON，可发送给买家一键成交">复制挂单 JSON</button>
          </div>
        `).join('')}
      </div>
    `;
  }
  return '';
}

function renderNftDetailCardHtml(item, globalState, variant, compactDrawer = false) {
  if (!item) return '';
  const isCurrentAvatar = globalState.activeNftAvatarKey === item.key;
  return `
    <div class="sl-group-box" style="padding:${compactDrawer ? '11px' : '14px'};display:flex;flex-direction:column;gap:10px;">
      ${!compactDrawer ? `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <button class="btn-flat" data-act="nft-select-item" data-v="${variant}" data-key="">← 返回当前页列表 (保留页码)</button>
          <div style="display:flex;gap:6px;">
            <span class="bdg ${item.kind === 'mrc721' ? 'bdg-mvc' : 'bdg-warn'}">${item.kind === 'mrc721' ? 'MRC-721 Pin NFT' : 'MetaContract NFT'}</span>
            ${item.verified ? `<span class="bdg bdg-ok">✓ 官方认证专辑</span>` : `<span class="bdg bdg-neutral">未认证专辑</span>`}
          </div>
        </div>
      ` : ''}

      <div style="display:grid;grid-template-columns:${compactDrawer ? '1fr' : '200px minmax(0,1fr)'};gap:12px;align-items:start;">
        <div style="border-radius:9px;overflow:hidden;border:1px solid var(--border-subtle);max-width:${compactDrawer ? '156px' : '200px'};margin:0 auto;width:100%;">
          ${item.svg}
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;min-width:0;">
          <div>
            <div style="font-size:14.5px;font-weight:800;">${item.name}</div>
            <div style="font-size:11.5px;color:var(--text-2);margin-top:2px;">所属专辑：<strong>${item.collectionName}</strong> (总发行 ${item.supply})</div>
          </div>

          <div class="sl-group-box" style="background:var(--input-bg);">
            <div class="sl-group-row" style="padding:6px 10px;font-size:11.5px;">
              <span style="color:var(--text-2);">链上标识</span>
              <button class="addr-chip mono" data-toast="已复制藏品链上 ID">${window.shortAddr(item.pinId, 8, 6)} ⧉</button>
            </div>
            <div class="sl-group-row" style="padding:6px 10px;font-size:11.5px;">
              <span style="color:var(--text-2);">序列状态 / 面值</span>
              <span class="num">${item.number < 0 ? '⏳ 待区块确认' : `#${item.number}`} · ${item.satoshi} sats</span>
            </div>
            <div class="sl-group-row" style="padding:6px 10px;font-size:11.5px;">
              <span style="color:var(--text-2);">获取时间</span>
              <span class="num">${item.createTime}</span>
            </div>
          </div>

          <!-- IDBots Project-Specific NFT Actions -->
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding-top:2px;">
            ${item.kind === 'mrc721' ? `
              <button class="${isCurrentAvatar ? 'btn-flat' : 'btn-primary'}" style="height:31px;font-size:11.5px;" data-act="nft-set-avatar" data-key="${item.key}">
                ${isCurrentAvatar ? '✓ 当前正佩戴为头像' : '✦ 设为该 Bot 头像'}
              </button>
            ` : `
              <button class="btn-flat" style="height:31px;font-size:11.5px;" disabled title="当前仅 MRC-721 支持链上头像声明">仅 MRC-721 可设头像</button>
            `}
            <button class="btn-flat" style="height:31px;font-size:11.5px;" data-toast="已将「${item.name}」原生 NFT 卡片插入当前对话输入框">发送到对话气泡</button>
            <button class="btn-flat" style="height:31px;font-size:11.5px;" data-toast="已打开 ${item.name} 链上转赠面板 (支持 sat/vB 费率选择)">链上转赠他人</button>
            ${item.kind === 'mrc721' ? `
              <button class="btn-flat" style="height:31px;font-size:11.5px;" data-toast="已打开定向原子挂单生成器 (生成免信任 PSBT 挂单 JSON)">创建定向挂单</button>
            ` : `
              <button class="btn-flat" style="height:31px;font-size:11.5px;" data-toast="已唤起 Bot 助手在集市上架该藏品">让 Bot 上架集市</button>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
}

window.renderNftVariantA = function renderNftVariantA(st, globalState) {
  const { allAlbums, items } = filterAndSortNfts(st);
  const pageSize = st.pageSize || 8;
  const page = Math.min(st.page || 1, Math.max(1, Math.ceil(items.length / pageSize)));
  const pagedItems = items.slice((page - 1) * pageSize, page * pageSize);
  const curAlbum = allAlbums.find((a) => a.albumId === st.selectedAlbumId);
  const detailItem = st.detailKey ? [...window.MOCK_NFTS.mrc721Items, ...window.MOCK_NFTS.mcItems].find((x) => x.key === st.detailKey) : null;

  return `
    <div class="sl-modal" style="max-width:680px;">
      <div class="sl-modal-header">
        <div class="sl-bot-id">
          ${botAvatarHtml(globalState)}
          <div class="sl-header-titles">
            <h4>NFT 钱包 · ${window.MOCK_BOT.name}</h4>
            <div class="sl-header-sub">
              <span>支持两级专辑目录 · 分页浏览 · 一键设为 Bot 链上头像</span>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          ${(st.protocol || 'mrc721') === 'mrc721' ? `
            <button class="btn-flat" data-act="nft-submodal" data-v="A" data-sub="buy">粘贴挂单购买</button>
            <button class="btn-flat" data-act="nft-submodal" data-v="A" data-sub="listings">我的挂单 (3)</button>
          ` : ''}
          <button class="sl-icon-btn" data-toast="已重新拉取链上 NFT 索引">↻</button>
          <button class="sl-icon-btn">✕</button>
        </div>
      </div>

      <div class="sl-tabs-underline">
        <div class="sl-tab-list">
          <button class="sl-tab ${(st.protocol || 'mrc721') === 'mrc721' ? 'active' : ''}" data-act="nft-protocol" data-v="A" data-proto="mrc721">
            MRC-721 藏品 <span class="sl-tab-count">34</span>
          </button>
          <button class="sl-tab ${st.protocol === 'metacontract' ? 'active' : ''}" data-act="nft-protocol" data-v="A" data-proto="metacontract">
            MetaContract (MVC) <span class="sl-tab-count">16</span>
          </button>
        </div>

        <!-- View Mode Switcher: By Album (2-level) vs Flat All Items -->
        <div class="seg-bar" style="margin:5px 0;">
          <button class="seg-item ${st.viewMode === 'albums' ? 'active' : ''}" data-act="nft-viewmode" data-v="A" data-mode="albums">按专辑查看 (${allAlbums.length})</button>
          <button class="seg-item ${st.viewMode === 'all' ? 'active' : ''}" data-act="nft-viewmode" data-v="A" data-mode="all">全部单品</button>
        </div>
      </div>

      <div class="sl-body">
        ${st.subModal ? renderNftSubModalHtml(st, 'A') : detailItem ? renderNftDetailCardHtml(detailItem, globalState, 'A', false) : `
          <!-- Breadcrumb or Filter Toolbar -->
          <div class="nft-toolbar">
            <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
              ${st.viewMode === 'albums' && curAlbum ? `
                <button class="btn-flat" data-act="nft-open-album" data-v="A" data-album="">← 全部专辑</button>
                <span style="font-size:13px;font-weight:700;">${curAlbum.collectionName}</span>
                ${curAlbum.verified ? `<span class="bdg bdg-ok">✓ 官方认证</span>` : ''}
                <span class="bdg bdg-neutral num">持有 ${curAlbum.count} 件</span>
              ` : st.viewMode === 'albums' ? `
                <span class="sl-group-label">第一级：选择专辑封面展开所持单品</span>
              ` : `
                <span class="sl-group-label">平铺浏览当前协议下全部藏品</span>
              `}
            </div>

            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-2);cursor:pointer;">
                <input type="checkbox" ${st.onlyVerified ? 'checked' : ''} data-act="nft-verified" data-v="A" />
                仅看认证
              </label>
              ${(st.viewMode === 'all' || curAlbum) ? `
                <select class="sl-select" style="height:28px;font-size:11.5px;" data-act="nft-sort" data-v="A">
                  <option value="recent" ${st.sortBy === 'recent' ? 'selected' : ''}>最新获取</option>
                  <option value="serialAsc" ${st.sortBy === 'serialAsc' ? 'selected' : ''}>编号升序 #↑</option>
                  <option value="nameAsc" ${st.sortBy === 'nameAsc' ? 'selected' : ''}>名称 A-Z</option>
                </select>
              ` : ''}
            </div>
          </div>

          ${st.viewMode === 'albums' && !curAlbum ? `
            <!-- LEVEL 1: ALBUM DIRECTORY GRID -->
            <div class="album-grid">
              ${allAlbums.map((alb) => {
                const sample = (st.protocol === 'metacontract' ? window.MOCK_NFTS.mcItems : window.MOCK_NFTS.mrc721Items).filter((x) => x.albumId === alb.albumId);
                return `
                  <button class="album-card-a" data-act="nft-open-album" data-v="A" data-album="${alb.albumId}">
                    <div class="album-cover-mosaic">
                      <div class="album-cover-main">${sample[0]?.svg || ''}</div>
                      <div class="album-cover-side">
                        <div>${sample[1]?.svg || sample[0]?.svg || ''}</div>
                        <div>${sample[2]?.svg || sample[0]?.svg || ''}</div>
                      </div>
                    </div>
                    <div class="album-meta-a">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
                        <span class="album-title">${alb.collectionName}</span>
                      </div>
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
                        ${alb.verified ? `<span class="bdg bdg-ok">✓ 认证</span>` : `<span class="bdg bdg-neutral">未认证</span>`}
                        <span class="bdg bdg-brand num">持有 ${alb.count} 件 ›</span>
                      </div>
                    </div>
                  </button>
                `;
              }).join('')}
            </div>
          ` : `
            <!-- LEVEL 2 (Inside Album) OR FLAT ALL ITEMS + PAGINATION -->
            <div class="nft-grid">
              ${pagedItems.map((it) => {
                const isAv = globalState.activeNftAvatarKey === it.key;
                return `
                  <button class="nft-tile ${isAv ? 'selected' : ''}" data-act="nft-select-item" data-v="A" data-key="${it.key}">
                    <div class="nft-art-box">
                      ${it.svg}
                      <span class="nft-corner-tag mono">${it.number < 0 ? '待确认' : `#${it.number}`}</span>
                      ${isAv ? `<span class="nft-avatar-active-pill">当前 Bot 头像</span>` : ''}
                    </div>
                    <div class="nft-tile-info">
                      <div class="nft-tile-name">${it.name}</div>
                      <div class="nft-tile-sub">${it.collectionName}</div>
                    </div>
                  </button>
                `;
              }).join('')}
            </div>
            ${renderPaginationHtml(items.length, page, pageSize, 'A')}
          `}
        `}
      </div>
    </div>
  `;
};

window.renderNftVariantB = function renderNftVariantB(st, globalState) {
  const { allAlbums, items } = filterAndSortNfts(st);
  const pageSize = st.pageSize || 6;
  const page = Math.min(st.page || 1, Math.max(1, Math.ceil(items.length / pageSize)));
  const pagedItems = items.slice((page - 1) * pageSize, page * pageSize);
  const curAlbum = allAlbums.find((a) => a.albumId === st.selectedAlbumId);
  const activeItem = items.find((x) => x.key === st.detailKey) || pagedItems[0] || items[0];

  return `
    <div class="sl-modal" style="max-width:780px;">
      <div class="sl-modal-header">
        <div class="sl-bot-id">
          ${botAvatarHtml(globalState)}
          <div class="sl-header-titles">
            <h4>${window.MOCK_BOT.name} · NFT 藏品与头像库 <span class="bdg bdg-brand">叠卡专辑架 + 右侧常驻检视器</span></h4>
            <div class="sl-header-sub">
              <span>点击左侧任意单品，右侧即刻检视属性、设为头像或挂单，不丢失当前分页位置</span>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="btn-flat" data-act="nft-submodal" data-v="B" data-sub="buy">粘贴买单</button>
          <button class="btn-flat" data-act="nft-submodal" data-v="B" data-sub="listings">我的挂单 (3)</button>
          <button class="sl-icon-btn">✕</button>
        </div>
      </div>

      <div class="sl-body">
        <div class="nft-toolbar">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <div class="seg-bar">
              <button class="seg-item ${(st.protocol || 'mrc721') === 'mrc721' ? 'active' : ''}" data-act="nft-protocol" data-v="B" data-proto="mrc721">MRC-721 (34)</button>
              <button class="seg-item ${st.protocol === 'metacontract' ? 'active' : ''}" data-act="nft-protocol" data-v="B" data-proto="metacontract">MetaContract (16)</button>
            </div>
            <div class="seg-bar">
              <button class="seg-item ${st.viewMode === 'albums' ? 'active' : ''}" data-act="nft-viewmode" data-v="B" data-mode="albums">专辑架 (${allAlbums.length})</button>
              <button class="seg-item ${st.viewMode === 'all' ? 'active' : ''}" data-act="nft-viewmode" data-v="B" data-mode="all">全部单品</button>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:6px;">
            <select class="sl-select" style="height:29px;font-size:11.5px;" data-act="nft-sort" data-v="B">
              <option value="recent" ${st.sortBy === 'recent' ? 'selected' : ''}>最新获取</option>
              <option value="serialAsc" ${st.sortBy === 'serialAsc' ? 'selected' : ''}>编号 #↑</option>
              <option value="nameAsc" ${st.sortBy === 'nameAsc' ? 'selected' : ''}>名称 A-Z</option>
            </select>
          </div>
        </div>

        ${st.subModal ? renderNftSubModalHtml(st, 'B') : st.viewMode === 'albums' && !curAlbum ? `
          <!-- LEVEL 1 IN SET B: Physical Layered Deck Cards -->
          <div class="album-grid">
            ${allAlbums.map((alb) => {
              const sample = (st.protocol === 'metacontract' ? window.MOCK_NFTS.mcItems : window.MOCK_NFTS.mrc721Items).filter((x) => x.albumId === alb.albumId);
              return `
                <button class="album-card-b" data-act="nft-open-album" data-v="B" data-album="${alb.albumId}">
                  <div class="album-card-b-inner">
                    <div style="aspect-ratio:16/10;position:relative;overflow:hidden;border-bottom:1px solid var(--divider);">
                      ${sample[0]?.svg || ''}
                      <span class="nft-corner-tag num">共发行 ${alb.supply}</span>
                    </div>
                    <div style="padding:9px 11px;display:flex;flex-direction:column;gap:5px;">
                      <div class="album-title">${alb.collectionName}</div>
                      <div style="display:flex;align-items:center;justify-content:space-between;">
                        ${alb.verified ? `<span class="bdg bdg-ok">✓ 官方认证</span>` : `<span class="bdg bdg-neutral">社区</span>`}
                        <span class="bdg bdg-brand num">展开 ${alb.count} 件 ›</span>
                      </div>
                    </div>
                  </div>
                </button>
              `;
            }).join('')}
          </div>
        ` : `
          <!-- LEVEL 2 OR ALL ITEMS IN SET B: Master-Detail Split Grid + Inspector -->
          ${curAlbum ? `
            <div style="display:flex;align-items:center;justify-content:space-between;background:var(--inset-bg);padding:7px 11px;border-radius:8px;border:1px solid var(--border-subtle);">
              <div style="display:flex;align-items:center;gap:8px;">
                <button class="btn-flat" style="height:25px;font-size:11px;" data-act="nft-open-album" data-v="B" data-album="">← 返回专辑架</button>
                <span style="font-size:12.5px;font-weight:700;">${curAlbum.collectionName}</span>
                <span class="bdg bdg-brand num">持有 ${curAlbum.count} 件</span>
              </div>
              <span class="mono" style="font-size:10.5px;color:var(--text-3);">Album ID: ${curAlbum.collectionPinId || curAlbum.genesis}</span>
            </div>
          ` : ''}

          <div class="bento-split">
            <div style="display:flex;flex-direction:column;gap:9px;">
              <div class="nft-grid cols-3">
                ${pagedItems.map((it) => {
                  const isSel = activeItem && activeItem.key === it.key;
                  const isAv = globalState.activeNftAvatarKey === it.key;
                  return `
                    <button class="nft-tile ${isSel ? 'selected' : ''}" data-act="nft-select-item" data-v="B" data-key="${it.key}">
                      <div class="nft-art-box">
                        ${it.svg}
                        <span class="nft-corner-tag mono">${it.number < 0 ? '待确认' : `#${it.number}`}</span>
                        ${isAv ? `<span class="nft-avatar-active-pill">当前头像</span>` : ''}
                      </div>
                      <div class="nft-tile-info">
                        <div class="nft-tile-name">${it.name}</div>
                        <div class="nft-tile-sub">${it.collectionName}</div>
                      </div>
                    </button>
                  `;
                }).join('')}
              </div>
              ${renderPaginationHtml(items.length, page, pageSize, 'B')}
            </div>

            <!-- Right Inspector Drawer -->
            <div>
              ${renderNftDetailCardHtml(activeItem, globalState, 'B', true)}
            </div>
          </div>
        `}
      </div>
    </div>
  `;
};
