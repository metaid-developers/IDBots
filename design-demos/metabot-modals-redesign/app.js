(function () {
  const SURFACES = [
    {
      id: 'wallet',
      navLabel: '① 链上钱包 (原生图标 + 多页签资产)',
      kicker: 'Surface 01 · MetaBotWalletModal (合并原 WalletBalance + WalletAssets + Transfer)',
      title: '链上钱包（三链官方图标 · 页签直看全量 Token · 移除旧藏品升级入口）',
      desc: '彻底取消「查看更多 TOKEN 余额」二次弹窗，以页签直接承载原生链（默认）、MRC-20、MVC Token，并内置三步转账流。',
      codeA: 'W1',
      nameA: '方案 A · Studio Linear 单轴分组列表',
      summaryA: '完全延续 Edit MetaBot 的顶栏下划线页签 + 10px 白底/深蓝分组行；点击「转账」在同一面板内平滑推进三步流程，克制紧凑。',
      codeB: 'W2',
      nameB: '方案 B · Studio Bento 双栏资产主控台',
      summaryB: '顶部三链原生卡片常驻展示余额与快捷复制；下方左侧切换 MRC-20 / MVC FT 页签，右侧常驻实时转账单，零页面跳转。',
    },
    {
      id: 'nft',
      navLabel: '② NFT 钱包 (两级专辑 + 分页 + 设头像)',
      kicker: 'Surface 02 · MetaBotNftWalletModal (新增专辑目录 + 分页栏 + IDBots 专属藏品能力)',
      title: 'NFT 钱包（按专辑两级目录 · 分页控制 · 一键设为 Bot 头像 / 发送对话 / 定向挂单）',
      desc: '默认按专辑封面聚合所持 NFT，点击专辑展开第二级单品网格并带完整分页；结合 IDBots 场景支持一键佩戴头像、发卡片到对话与免信任原子挂单。',
      codeA: 'N1',
      nameA: '方案 A · Studio Linear 层级画廊推进式',
      summaryA: '三宫格拼图专辑封面 → 点击推进专辑单品页（含面包屑、认证筛选、排序与底部分页栏）→ 点击藏品查看双栏详情与 4 大动作。',
      codeB: 'N2',
      nameB: '方案 B · Studio Bento 叠卡专辑架 + 右侧检视抽屉',
      summaryB: '拟物叠卡专辑架；展开后采用「左分页网格 + 右常驻详情检视器」，连续点击对比多件藏品、切换佩戴头像时绝不丢失页码与滚动位置。',
    },
    {
      id: 'avatar',
      navLabel: '③ 设置头像 (三源合一工作台)',
      kicker: 'Surface 03 · AvatarPickerModal (消除两步跳转与弹窗宽度抖动)',
      title: '设置头像（内置形象 / 链上 NFT 藏品按专辑筛选 / 本地上传 三源同层）',
      desc: '告别旧版「列表选择 → 点返回 → 弹窗忽窄忽宽」的割裂体验，固定几何尺寸并支持实时预览标准头像框与 MRC-721 链上认证外框。',
      codeA: 'A1',
      nameA: '方案 A · 顶栏分段切换 + 底部实时预览条',
      summaryA: '标准紧凑单栏弹窗（580px），顶部 Segmented Bar 秒切三种来源，链上 NFT 页内支持按专辑胶囊筛选与翻页。',
      codeB: 'A2',
      nameB: '方案 B · 左侧名片实时预览 + 右侧选片台',
      summaryB: '双栏形象工作台（720px），左侧完整呈现该 Bot 在列表与聊天中的头像外框效果，右侧默认聚焦链上 NFT 藏品选片。',
    },
    {
      id: 'mnemonic',
      navLabel: '④ 备份助记词 (防窥金库)',
      kicker: 'Surface 04 · MetaBotBackupMnemonicModal (新增防窥模糊遮罩 + 派生路径核验 + 一键复制)',
      title: '备份助记词（默认防窥遮罩 · 12 词等宽编号网格 · 派生地址防混淆核对）',
      desc: '防止屏幕共享或旁人窥视导致私钥泄露，明确展示 HD 派生路径与对应钱包地址指纹，确保多 Bot 用户不会抄错助记词。',
      codeA: 'M1',
      nameA: '方案 A · 紧凑防窥助记词面板',
      summaryA: '单轴安全卡片（520px），带琥珀色非托管风险提示、毛玻璃防窥遮罩、一键显隐与复制按钮。',
      codeB: 'M2',
      nameB: '方案 B · 硬件金库级双栏地址指纹核对卡',
      summaryB: '左侧 12 词防窥网格，右侧列出 HD 派生路径及对应 MVC / BTC / DOGE 地址首尾指纹，多 Bot 管理更安心。',
    },
    {
      id: 'lifecycle',
      navLabel: '⑤ 安全删除 / 恢复 / 上链同步',
      kicker: 'Surface 05 · Secondary Lifecycle Modals (消灭剩余旧风格弹窗)',
      title: '关联二级弹窗统一规范（5秒安全删除确认 · 一键粘贴恢复 · 上链同步清单）',
      desc: '将删除确认、助记词导入恢复、创建/编辑上链进度弹窗全部纳入同一套 Studio Linear 视觉规范，彻底告别跳动大号 Emoji 与旧圆角边框。',
      codeA: 'S1',
      nameA: '方案 A · 极简线性确认弹窗组',
      summaryA: '轻量紧凑对话框，保留核心警示、应急展开助记词、5 秒倒计时防误触与清晰上链步骤状态。',
      codeB: 'S2',
      nameB: '方案 B · 结构化数据分组确认卡组',
      summaryB: '显式区分「受保护链上资产」与「本地移除范围」，并在恢复与同步态提供更丰富的分组核验信息。',
    }
  ];

  const state = {
    theme: 'dark',
    layoutMode: 'ab', // 'ab' | 'onlyA' | 'onlyB'
    activeSurface: 'all',
    activeBuiltinCode: 'R01',
    activeNftAvatarKey: 'col-metabot-genesis-pin-107i0',
    picks: {
      wallet: 'W1',
      nft: 'N1',
      avatar: 'A1',
      mnemonic: 'M1',
      lifecycle: 'S1',
    },
    wallet: {
      A: { tab: 'native', showDegraded: false, transferTarget: null, transferStep: 1, feeTier: 1, transferAmount: '' },
      B: { tab: 'mrc20', showDegraded: false, transferTarget: null, transferStep: 1, feeTier: 1, transferAmount: '' },
    },
    nft: {
      A: { protocol: 'mrc721', viewMode: 'albums', selectedAlbumId: '', page: 1, pageSize: 8, sortBy: 'recent', onlyVerified: false, detailKey: '', subModal: '' },
      B: { protocol: 'mrc721', viewMode: 'albums', selectedAlbumId: '', page: 1, pageSize: 6, sortBy: 'recent', onlyVerified: false, detailKey: '', subModal: '' },
    },
    avatar: {
      A: { source: 'nft', albumId: 'all', page: 1 },
      B: { source: 'nft', albumId: 'all', page: 1 },
    },
    mnemonic: {
      A: { revealed: false },
      B: { revealed: true },
    },
    lifecycle: {
      subTab: 'delete',
      A: { showPhrase: false, countdownDone: false, filledPaste: true },
      B: { showPhrase: false, countdownDone: true, filledPaste: true },
    }
  };

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById('demoToast');
    if (!el) return;
    el.textContent = `✦ ${msg}`;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function renderNav() {
    const nav = document.getElementById('wbNav');
    const items = [{ id: 'all', navLabel: '全部 5 大模块总览 (A/B 完整对比)' }, ...SURFACES];
    nav.innerHTML = items.map((it) =>
      `<button class="wb-nav-btn ${state.activeSurface === it.id ? 'active' : ''}" data-surface="${it.id}">${it.navLabel}</button>`
    ).join('');
  }

  function renderVariantBody(surfaceId, v) {
    if (surfaceId === 'wallet') {
      return v === 'A' ? window.renderWalletVariantA(state.wallet.A, state) : window.renderWalletVariantB(state.wallet.B, state);
    }
    if (surfaceId === 'nft') {
      return v === 'A' ? window.renderNftVariantA(state.nft.A, state) : window.renderNftVariantB(state.nft.B, state);
    }
    if (surfaceId === 'avatar') {
      return v === 'A' ? window.renderAvatarVariantA(state.avatar.A, state) : window.renderAvatarVariantB(state.avatar.B, state);
    }
    if (surfaceId === 'mnemonic') {
      return v === 'A' ? window.renderMnemonicVariantA(state.mnemonic.A, state) : window.renderMnemonicVariantB(state.mnemonic.B, state);
    }
    return window.renderLifecycleModal(
      { ...state.lifecycle[v], subTab: state.lifecycle.subTab },
      state,
      v
    );
  }

  function renderMain() {
    const root = document.getElementById('surfacesRoot');
    const visible = state.activeSurface === 'all'
      ? SURFACES
      : SURFACES.filter((s) => s.id === state.activeSurface);

    root.innerHTML = visible.map((sf) => {
      const showA = state.layoutMode !== 'onlyB';
      const showB = state.layoutMode !== 'onlyA';
      const singleClass = state.layoutMode !== 'ab' ? 'focus-single' : '';

      const extraSubControls = sf.id === 'lifecycle' ? `
        <div class="seg-bar">
          <span class="seg-label">切换子弹窗</span>
          <button class="seg-item ${state.lifecycle.subTab === 'delete' ? 'active' : ''}" data-act="life-subtab" data-sub="delete">1. 安全删除确认</button>
          <button class="seg-item ${state.lifecycle.subTab === 'restore' ? 'active' : ''}" data-act="life-subtab" data-sub="restore">2. 助记词恢复</button>
          <button class="seg-item ${state.lifecycle.subTab === 'sync' ? 'active' : ''}" data-act="life-subtab" data-sub="sync">3. 创建与上链同步</button>
        </div>
      ` : sf.id === 'nft' ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn-flat" data-act="nft-demo-drill" data-drill="albums">切回第 1 级：专辑封面目录</button>
          <button class="btn-flat" data-act="nft-demo-drill" data-drill="genesis">直达第 2 级：展开 Genesis 专辑 (15件·可翻页)</button>
        </div>
      ` : '';

      const cardA = showA ? `
        <article class="variant-card ${state.picks[sf.id] === sf.codeA ? 'picked' : ''}">
          <div class="variant-bar">
            <div>
              <span class="variant-tag">${sf.codeA} · 套装 A</span>
              <h3>${sf.nameA}</h3>
              <p>${sf.summaryA}</p>
            </div>
            <button class="pick-btn" data-act="pick-variant" data-sf="${sf.id}" data-code="${sf.codeA}">
              ${state.picks[sf.id] === sf.codeA ? '✓ 已选此方案' : '选这套'}
            </button>
          </div>
          <div class="modal-stage">
            ${renderVariantBody(sf.id, 'A')}
          </div>
        </article>
      ` : '';

      const cardB = showB ? `
        <article class="variant-card ${state.picks[sf.id] === sf.codeB ? 'picked' : ''}">
          <div class="variant-bar">
            <div>
              <span class="variant-tag">${sf.codeB} · 套装 B</span>
              <h3>${sf.nameB}</h3>
              <p>${sf.summaryB}</p>
            </div>
            <button class="pick-btn" data-act="pick-variant" data-sf="${sf.id}" data-code="${sf.codeB}">
              ${state.picks[sf.id] === sf.codeB ? '✓ 已选此方案' : '选这套'}
            </button>
          </div>
          <div class="modal-stage">
            ${renderVariantBody(sf.id, 'B')}
          </div>
        </article>
      ` : '';

      return `
        <section class="surface-section" id="sec-${sf.id}">
          <div class="surface-head">
            <div class="surface-title-box">
              <div class="kicker">${sf.kicker}</div>
              <h2>${sf.title}</h2>
              <p>${sf.desc}</p>
            </div>
            ${extraSubControls}
          </div>
          <div class="variants-grid ${singleClass}">
            ${cardA}
            ${cardB}
          </div>
        </section>
      `;
    }).join('');

    updateSelectionDock();
  }

  function updateSelectionDock() {
    const summaryEl = document.getElementById('selectionPills');
    if (!summaryEl) return;
    summaryEl.innerHTML = SURFACES.map((sf) => {
      const code = state.picks[sf.id];
      return `<span class="bdg bdg-brand" style="font-size:11.5px;padding:3px 8px;">${sf.navLabel.split(' ')[0]} ${code}</span>`;
    }).join('<span style="color:var(--text-3);">+</span>');
  }

  function renderAll() {
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
    document.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === state.theme));
    document.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layoutMode));
    renderNav();
    renderMain();
  }

  // Event Delegation
  document.addEventListener('click', (e) => {
    const toastBtn = e.target.closest('[data-toast]');
    if (toastBtn) {
      showToast(toastBtn.dataset.toast);
      return;
    }

    const themeBtn = e.target.closest('[data-theme]');
    if (themeBtn) {
      state.theme = themeBtn.dataset.theme;
      renderAll();
      return;
    }

    const layoutBtn = e.target.closest('[data-layout]');
    if (layoutBtn) {
      state.layoutMode = layoutBtn.dataset.layout;
      renderAll();
      return;
    }

    const surfBtn = e.target.closest('[data-surface]');
    if (surfBtn) {
      state.activeSurface = surfBtn.dataset.surface;
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;
    const v = actEl.dataset.v || 'A';

    if (act === 'pick-all-set') {
      const setKey = actEl.dataset.set;
      SURFACES.forEach((sf) => {
        state.picks[sf.id] = setKey === 'A' ? sf.codeA : sf.codeB;
      });
      renderMain();
      showToast(`已一键全选套装 ${setKey}`);
      return;
    }

    if (act === 'copy-picks') {
      const str = SURFACES.map((sf) => `${sf.id}:${state.picks[sf.id]}`).join(', ');
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(str).catch(() => {});
      showToast(`已复制当前方案组合: ${str}`);
      return;
    }

    if (act === 'pick-variant') {
      state.picks[actEl.dataset.sf] = actEl.dataset.code;
      renderMain();
      return;
    }

    if (act === 'jump-surface') {
      state.activeSurface = actEl.dataset.target;
      renderAll();
      return;
    }

    // Wallet interactions
    if (act === 'wallet-tab') {
      state.wallet[v].tab = actEl.dataset.tab;
      state.wallet[v].transferTarget = null;
      renderMain();
    } else if (act === 'wallet-toggle-degraded') {
      const next = !state.wallet.A.showDegraded;
      state.wallet.A.showDegraded = next;
      state.wallet.B.showDegraded = next;
      renderMain();
    } else if (act === 'wallet-open-transfer') {
      const chain = actEl.dataset.chain;
      const symbol = actEl.dataset.symbol;
      const isToken = actEl.dataset.token === '1';
      state.wallet[v].transferTarget = {
        chain,
        symbol,
        isToken,
        maxBalance: actEl.dataset.max,
        badgeClass: chain === 'btc' ? 'bdg-btc' : chain === 'doge' ? 'bdg-doge' : 'bdg-mvc',
        networkLabel: isToken ? (chain === 'btc' ? 'BTC · MRC-20' : 'MVC · MCP02') : `${chain.toUpperCase()} 主网`,
        fromAddress: chain === 'btc' ? window.MOCK_BOT.btcAddress : chain === 'doge' ? window.MOCK_BOT.dogeAddress : window.MOCK_BOT.mvcAddress,
      };
      state.wallet[v].transferStep = 1;
      state.wallet[v].transferAmount = '';
      renderMain();
    } else if (act === 'wallet-close-transfer') {
      state.wallet[v].transferTarget = null;
      state.wallet[v].transferStep = 1;
      renderMain();
    } else if (act === 'wallet-fill-max') {
      if (state.wallet[v].transferTarget) {
        state.wallet[v].transferAmount = state.wallet[v].transferTarget.maxBalance;
        renderMain();
      }
    } else if (act === 'wallet-fee') {
      state.wallet[v].feeTier = Number(actEl.dataset.idx);
      renderMain();
    } else if (act === 'wallet-step') {
      state.wallet[v].transferStep = Number(actEl.dataset.step);
      renderMain();
    }

    // NFT interactions
    else if (act === 'nft-protocol') {
      state.nft[v].protocol = actEl.dataset.proto;
      state.nft[v].selectedAlbumId = '';
      state.nft[v].detailKey = '';
      state.nft[v].subModal = '';
      state.nft[v].page = 1;
      renderMain();
    } else if (act === 'nft-viewmode') {
      state.nft[v].viewMode = actEl.dataset.mode;
      state.nft[v].detailKey = '';
      state.nft[v].subModal = '';
      state.nft[v].page = 1;
      renderMain();
    } else if (act === 'nft-open-album') {
      state.nft[v].selectedAlbumId = actEl.dataset.album || '';
      state.nft[v].detailKey = '';
      state.nft[v].page = 1;
      renderMain();
    } else if (act === 'nft-demo-drill') {
      const isGenesis = actEl.dataset.drill === 'genesis';
      ['A', 'B'].forEach((k) => {
        state.nft[k].protocol = 'mrc721';
        state.nft[k].viewMode = 'albums';
        state.nft[k].selectedAlbumId = isGenesis ? 'col-metabot-genesis' : '';
        state.nft[k].detailKey = '';
        state.nft[k].subModal = '';
        state.nft[k].page = 1;
      });
      renderMain();
    } else if (act === 'nft-page') {
      state.nft[v].page = Number(actEl.dataset.page);
      renderMain();
    } else if (act === 'nft-verified') {
      state.nft[v].onlyVerified = !state.nft[v].onlyVerified;
      state.nft[v].page = 1;
      renderMain();
    } else if (act === 'nft-select-item') {
      state.nft[v].detailKey = actEl.dataset.key || '';
      renderMain();
    } else if (act === 'nft-submodal') {
      state.nft[v].subModal = actEl.dataset.sub || '';
      renderMain();
    } else if (act === 'nft-set-avatar') {
      state.activeNftAvatarKey = actEl.dataset.key;
      renderMain();
      showToast('已将该 MRC-721 藏品设为当前 Bot 链上头像（顶栏头像框已实时更新）');
    }

    // Avatar interactions
    else if (act === 'avatar-source') {
      state.avatar[v].source = actEl.dataset.src;
      renderMain();
    } else if (act === 'avatar-pick-builtin') {
      state.activeNftAvatarKey = '';
      state.activeBuiltinCode = actEl.dataset.code;
      renderMain();
      showToast(`已切换为内置机器人形象 ${actEl.dataset.code}`);
    } else if (act === 'avatar-nft-album') {
      state.avatar[v].albumId = actEl.dataset.album;
      state.avatar[v].page = 1;
      renderMain();
    } else if (act === 'avatar-nft-page') {
      state.avatar[v].page = Number(actEl.dataset.page);
      renderMain();
    }

    // Mnemonic & Lifecycle interactions
    else if (act === 'mnemonic-toggle') {
      state.mnemonic[v].revealed = !state.mnemonic[v].revealed;
      renderMain();
    } else if (act === 'life-subtab') {
      state.lifecycle.subTab = actEl.dataset.sub;
      renderMain();
    } else if (act === 'life-toggle-phrase') {
      state.lifecycle[v].showPhrase = !state.lifecycle[v].showPhrase;
      renderMain();
    } else if (act === 'life-sim-countdown') {
      state.lifecycle[v].countdownDone = !state.lifecycle[v].countdownDone;
      renderMain();
    } else if (act === 'life-fill-paste') {
      state.lifecycle[v].filledPaste = !state.lifecycle[v].filledPaste;
      renderMain();
    }
  });

  document.addEventListener('change', (e) => {
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;
    const v = actEl.dataset.v || 'A';
    if (act === 'nft-pagesize') {
      state.nft[v].pageSize = Number(actEl.value);
      state.nft[v].page = 1;
      renderMain();
    } else if (act === 'nft-sort') {
      state.nft[v].sortBy = actEl.value;
      state.nft[v].page = 1;
      renderMain();
    }
  });

  renderAll();
})();
