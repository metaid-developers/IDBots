// ============================================================================
// Part 2: Surface 3 (Set Avatar), Surface 4 (Backup Mnemonic), Surface 5 (Lifecycle Modals)
// ============================================================================

// ----------------------------------------------------------------------------
// SURFACE 3: AVATAR PICKER (A1 vs A2 — Direct 3-Source Tabs + Album Filter)
// ----------------------------------------------------------------------------
function renderAvatarSourceBody(st, globalState, variant) {
  const src = st.source || 'builtin';
  if (src === 'builtin') {
    return `
      <div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;">
        ${window.MOCK_BUILTIN_AVATARS.map((av) => {
          const isSel = !globalState.activeNftAvatarKey && globalState.activeBuiltinCode === av.code;
          return `
            <button class="nft-tile ${isSel ? 'selected' : ''}" data-act="avatar-pick-builtin" data-code="${av.code}">
              <div class="nft-art-box">${av.svg}</div>
              <div class="nft-tile-info" style="text-align:center;padding:5px;">
                <div class="nft-tile-name" style="font-size:10.5px;">${av.name}</div>
              </div>
            </button>
          `;
        }).join('')}
      </div>
      <div style="font-size:11px;color:var(--text-2);">内置形象采用链上公共 MetaFile Pin 引用，无需重复消耗大图上链费。</div>
    `;
  }
  if (src === 'nft') {
    const albumFilter = st.albumId || 'all';
    const albums = window.MOCK_NFTS.mrc721Albums;
    const filtered = window.MOCK_NFTS.mrc721Items.filter((it) => albumFilter === 'all' || it.albumId === albumFilter);
    const page = st.page || 1;
    const pageSize = 8;
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="btn-flat ${albumFilter === 'all' ? 'active' : ''}" style="height:26px;font-size:11px;${albumFilter === 'all' ? 'border-color:var(--brand-border);background:var(--brand-soft);' : ''}" data-act="avatar-nft-album" data-v="${variant}" data-album="all">全部专辑 (34)</button>
          ${albums.map((a) => `
            <button class="btn-flat" style="height:26px;font-size:11px;${albumFilter === a.albumId ? 'border-color:var(--brand-border);background:var(--brand-soft);' : ''}" data-act="avatar-nft-album" data-v="${variant}" data-album="${a.albumId}">
              ${a.collectionName.split(' ')[0]} (${a.count})
            </button>
          `).join('')}
        </div>
      </div>
      <div class="nft-grid">
        ${slice.map((it) => {
          const isSel = globalState.activeNftAvatarKey === it.key;
          return `
            <button class="nft-tile ${isSel ? 'selected' : ''}" data-act="nft-set-avatar" data-key="${it.key}">
              <div class="nft-art-box">
                ${it.svg}
                <span class="nft-corner-tag mono">${it.number < 0 ? '待确认' : '#' + it.number}</span>
              </div>
              <div class="nft-tile-info">
                <div class="nft-tile-name">${it.name}</div>
                <div class="nft-tile-sub">${it.collectionName}</div>
              </div>
            </button>
          `;
        }).join('')}
      </div>
      <div class="pagination-bar">
        <span class="num">共 ${filtered.length} 件可用 MRC-721 · 第 ${page}/${totalPages} 页</span>
        <div class="page-btns">
          <button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-act="avatar-nft-page" data-v="${variant}" data-page="${page - 1}">‹</button>
          <button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-act="avatar-nft-page" data-v="${variant}" data-page="${page + 1}">›</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="sl-group-box" style="padding:26px 16px;border-style:dashed;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;">
      <div style="width:42px;height:42px;border-radius:10px;background:var(--inset-bg);display:grid;place-items:center;font-size:18px;">🖼</div>
      <div style="font-size:13px;font-weight:700;">拖拽图片至此处，或点击选择本地图像</div>
      <div style="font-size:11.5px;color:var(--text-2);">支持 PNG / JPG / WEBP / GIF · 文件大小不超过 200 KB（保存资料时写入 /info/avatar）</div>
      <button class="btn-flat" style="margin-top:4px;" data-toast="演示：已唤起系统文件选择器">浏览本地文件…</button>
    </div>
  `;
}

window.renderAvatarVariantA = function renderAvatarVariantA(st, globalState) {
  const src = st.source || 'builtin';
  const isNft = Boolean(globalState.activeNftAvatarKey);
  return `
    <div class="sl-modal" style="max-width:580px;">
      <div class="sl-modal-header">
        <div>
          <h4 style="margin:0;font-size:14px;font-weight:700;">设置头像 · ${window.MOCK_BOT.name}</h4>
          <div class="sl-header-sub">告别旧版两步跳转与宽度抖动，固定尺寸三源直达</div>
        </div>
        <button class="sl-icon-btn">✕</button>
      </div>

      <div class="sl-body">
        <div class="seg-bar" style="align-self:flex-start;">
          <button class="seg-item ${src === 'builtin' ? 'active' : ''}" data-act="avatar-source" data-v="A" data-src="builtin">内置机器人形象 (10)</button>
          <button class="seg-item ${src === 'nft' ? 'active' : ''}" data-act="avatar-source" data-v="A" data-src="nft">链上 NFT 藏品 (34)</button>
          <button class="seg-item ${src === 'local' ? 'active' : ''}" data-act="avatar-source" data-v="A" data-src="local">本地上传</button>
        </div>

        ${renderAvatarSourceBody(st, globalState, 'A')}

        <!-- Bottom Live Preview & Apply Bar -->
        <div class="sl-group-box" style="padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--modal-header);">
          <div style="display:flex;align-items:center;gap:10px;">
            ${botAvatarHtml(globalState)}
            <div>
              <div style="font-size:12.5px;font-weight:700;display:flex;align-items:center;gap:6px;">
                <span>当前预览：${window.MOCK_BOT.name}</span>
                ${isNft ? `<span class="bdg bdg-mvc">MRC-721 链上认证外框</span>` : `<span class="bdg bdg-neutral">标准内置形象</span>`}
              </div>
              <div style="font-size:11px;color:var(--text-2);">点击「保存并同步」后写入链上 MetaID 档案</div>
            </div>
          </div>
          <button class="btn-primary" data-toast="已应用所选头像至编辑表单">确认选用</button>
        </div>
      </div>
    </div>
  `;
};

window.renderAvatarVariantB = function renderAvatarVariantB(st, globalState) {
  const src = st.source || 'nft';
  const isNft = Boolean(globalState.activeNftAvatarKey);
  return `
    <div class="sl-modal" style="max-width:720px;">
      <div class="sl-modal-header">
        <div>
          <h4 style="margin:0;font-size:14px;font-weight:700;">形象工作台 · ${window.MOCK_BOT.name} <span class="bdg bdg-brand">左预览 · 右选片</span></h4>
          <div class="sl-header-sub">实时预览「我的 Bot 列表卡」与「对话气泡头像」佩戴效果</div>
        </div>
        <button class="sl-icon-btn">✕</button>
      </div>

      <div class="sl-body">
        <div class="bento-split" style="grid-template-columns:210px minmax(0,1fr);">
          <!-- Left Real-Time Identity Card Preview -->
          <div class="sl-group-box" style="padding:14px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;">
            <div style="width:76px;height:76px;border-radius:16px;overflow:hidden;border:${isNft ? '2px solid #38bdf8' : '1px solid var(--border-subtle)'};box-shadow:${isNft ? '0 0 0 4px rgba(56,189,248,0.16)' : 'none'};">
              ${isNft ? (window.MOCK_NFTS.mrc721Items.find((x) => x.key === globalState.activeNftAvatarKey)?.svg || '') : (window.MOCK_BUILTIN_AVATARS.find((b) => b.code === globalState.activeBuiltinCode)?.svg || '')}
            </div>
            <div>
              <div style="font-size:14px;font-weight:800;">${window.MOCK_BOT.name}</div>
              <div style="font-size:11px;color:var(--text-2);margin-top:2px;">${window.MOCK_BOT.role}</div>
            </div>
            ${isNft ? `<span class="bdg bdg-mvc">✓ NFT 链上持有者核验</span>` : `<span class="bdg bdg-neutral">MetaFile 轻量图标</span>`}
            <div style="width:100%;padding-top:8px;border-top:1px solid var(--divider);display:flex;flex-direction:column;gap:6px;">
              <button class="btn-primary" style="width:100%;" data-toast="已应用当前预览头像">应用此头像</button>
              <button class="btn-flat" style="width:100%;" data-act="avatar-pick-builtin" data-code="R01">恢复默认</button>
            </div>
          </div>

          <!-- Right Source Tabs & Picker -->
          <div style="display:flex;flex-direction:column;gap:10px;">
            <div class="seg-bar" style="align-self:flex-start;">
              <button class="seg-item ${src === 'nft' ? 'active' : ''}" data-act="avatar-source" data-v="B" data-src="nft">链上 NFT 头像 (34)</button>
              <button class="seg-item ${src === 'builtin' ? 'active' : ''}" data-act="avatar-source" data-v="B" data-src="builtin">内置形象 (10)</button>
              <button class="seg-item ${src === 'local' ? 'active' : ''}" data-act="avatar-source" data-v="B" data-src="local">本地上传</button>
            </div>
            ${renderAvatarSourceBody({ ...st, source: src }, globalState, 'B')}
          </div>
        </div>
      </div>
    </div>
  `;
};

// ----------------------------------------------------------------------------
// SURFACE 4: BACKUP MNEMONIC (M1 vs M2 — Privacy Shield + Copy + Path Verification)
// ----------------------------------------------------------------------------
window.renderMnemonicVariantA = function renderMnemonicVariantA(st, globalState) {
  const revealed = Boolean(st.revealed);
  return `
    <div class="sl-modal" style="max-width:520px;">
      <div class="sl-modal-header">
        <div class="sl-bot-id">
          ${botAvatarHtml(globalState)}
          <div class="sl-header-titles">
            <h4>备份助记词 · ${window.MOCK_BOT.name}</h4>
            <div class="sl-header-sub">助记词是恢复该 Bot 链上身份与三链资产的唯一凭证</div>
          </div>
        </div>
        <button class="sl-icon-btn">✕</button>
      </div>

      <div class="sl-body">
        <div style="padding:9px 12px;border-radius:8px;background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn);font-size:11.5px;line-height:1.45;">
          <strong>安全提醒：</strong>请勿截屏或通过网络发送。任何获得这 12 个助记词的人均可直接转走该 Bot 名下全部 BTC / SPACE / DOGE 与 NFT 资产。
        </div>

        <div class="sl-group-label-row">
          <span class="sl-group-label">12 位主助记词 (BIP-39)</span>
          <span class="mono" style="font-size:11px;color:var(--text-2);">派生路径 ${window.MOCK_BOT.derivationPath}</span>
        </div>

        <div class="mnemonic-vault-wrap">
          <ol class="mnemonic-grid ${revealed ? '' : 'blurred'}">
            ${window.MOCK_BOT.mnemonic.map((w, i) => `
              <li class="mnemonic-cell mono">
                <span class="mnemonic-idx">${String(i + 1).padStart(2, '0')}</span>
                <span style="font-weight:700;">${w}</span>
              </li>
            `).join('')}
          </ol>
          ${!revealed ? `
            <div class="mnemonic-shield">
              <div style="font-size:12.5px;font-weight:700;">默认防窥遮罩已开启</div>
              <div style="font-size:11px;color:var(--text-2);">确认周围无人窥屏或录屏后点击查看</div>
              <button class="btn-primary" data-act="mnemonic-toggle" data-v="A">👁 显示 12 个助记词</button>
            </div>
          ` : ''}
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:2px;">
          <div style="display:flex;gap:6px;">
            <button class="btn-flat" data-act="mnemonic-toggle" data-v="A">${revealed ? '隐藏遮罩' : '显示助记词'}</button>
            <button class="btn-flat" data-toast="已复制 12 位助记词至剪贴板（请注意及时清空剪贴板）">复制完整助记词</button>
          </div>
          <button class="btn-primary" data-toast="已关闭助记词备份窗口">我已离线抄写完成</button>
        </div>
      </div>
    </div>
  `;
};

window.renderMnemonicVariantB = function renderMnemonicVariantB(st, globalState) {
  const revealed = Boolean(st.revealed);
  return `
    <div class="sl-modal" style="max-width:620px;">
      <div class="sl-modal-header">
        <div class="sl-bot-id">
          ${botAvatarHtml(globalState)}
          <div class="sl-header-titles">
            <h4>${window.MOCK_BOT.name} · 密钥金库与派生校验 <span class="bdg bdg-warn">最高权限密钥</span></h4>
            <div class="sl-header-sub">同时展示派生路径与三链首尾指纹，防止多 Bot 备份混淆</div>
          </div>
        </div>
        <button class="sl-icon-btn">✕</button>
      </div>

      <div class="sl-body">
        <div class="bento-split" style="grid-template-columns:minmax(0,1.35fr) minmax(200px,0.9fr);">
          <div style="display:flex;flex-direction:column;gap:8px;">
            <div class="mnemonic-vault-wrap">
              <ol class="mnemonic-grid ${revealed ? '' : 'blurred'}">
                ${window.MOCK_BOT.mnemonic.map((w, i) => `
                  <li class="mnemonic-cell mono">
                    <span class="mnemonic-idx">${String(i + 1).padStart(2, '0')}</span>
                    <span style="font-weight:700;">${w}</span>
                  </li>
                `).join('')}
              </ol>
              ${!revealed ? `
                <div class="mnemonic-shield">
                  <button class="btn-primary" data-act="mnemonic-toggle" data-v="B">点击解锁防窥遮罩</button>
                </div>
              ` : ''}
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn-flat" style="flex:1;" data-act="mnemonic-toggle" data-v="B">${revealed ? '重新遮蔽' : '显示明文'}</button>
              <button class="btn-flat" style="flex:1;" data-toast="已复制全部助记词与派生路径说明">复制短语</button>
            </div>
          </div>

          <!-- Right Column: Derived Address Fingerprint Verification -->
          <div class="sl-group-box">
            <div class="sl-group-row" style="background:var(--inset-bg);padding:8px 11px;">
              <span style="font-size:11.5px;font-weight:700;">对应钱包指纹核对</span>
            </div>
            <div class="sl-group-row" style="padding:8px 11px;font-size:11.5px;">
              <span style="color:var(--text-2);">HD 路径</span>
              <code class="mono">${window.MOCK_BOT.derivationPath}</code>
            </div>
            <div class="sl-group-row" style="padding:8px 11px;font-size:11.5px;">
              <span style="color:var(--text-2);">MVC</span>
              <code class="mono">${window.shortAddr(window.MOCK_BOT.mvcAddress, 6, 5)}</code>
            </div>
            <div class="sl-group-row" style="padding:8px 11px;font-size:11.5px;">
              <span style="color:var(--text-2);">BTC</span>
              <code class="mono">${window.shortAddr(window.MOCK_BOT.btcAddress, 6, 5)}</code>
            </div>
            <div class="sl-group-row" style="padding:8px 11px;font-size:11.5px;">
              <span style="color:var(--text-2);">DOGE</span>
              <code class="mono">${window.shortAddr(window.MOCK_BOT.dogeAddress, 6, 5)}</code>
            </div>
            <div class="sl-group-row" style="padding:9px 11px;">
              <button class="btn-primary" style="width:100%;" data-toast="已完成核验并关闭">确认已妥善保管</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
};

// ----------------------------------------------------------------------------
// SURFACE 5: SECONDARY LIFECYCLE MODALS (Delete / Restore / Create-Sync)
// ----------------------------------------------------------------------------
window.renderLifecycleModal = function renderLifecycleModal(st, globalState, variant) {
  const mode = st.subTab || 'delete';
  const isB = variant === 'B';

  if (mode === 'delete') {
    const unlocked = Boolean(st.countdownDone);
    return `
      <div class="sl-modal" style="max-width:${isB ? '560px' : '480px'};">
        <div class="sl-modal-header">
          <div class="sl-bot-id">
            ${botAvatarHtml(globalState)}
            <div class="sl-header-titles">
              <h4>移除本地 MetaBot · ${window.MOCK_BOT.name}</h4>
              <div class="sl-header-sub">安全删除保护 · 5 秒防误触倒计时</div>
            </div>
          </div>
          <button class="sl-icon-btn">✕</button>
        </div>
        <div class="sl-body">
          <div style="padding:10px 12px;border-radius:8px;background:var(--danger-bg);border:1px solid var(--danger-border);color:var(--danger);font-size:12px;line-height:1.45;">
            此操作将从当前设备列表中移除 <strong>${window.MOCK_BOT.name}</strong>。链上身份与资产不会销毁，但若未备份助记词将无法再次找回控制权。
          </div>

          ${isB ? `
            <div class="sl-group-box">
              <div class="sl-group-row">
                <span style="font-size:12px;color:var(--text-2);">保留的数据</span>
                <span class="bdg bdg-ok">✓ 历史会话与链上资产不受影响</span>
              </div>
              <div class="sl-group-row">
                <span style="font-size:12px;color:var(--text-2);">删除前应急备份</span>
                <button class="btn-flat" style="height:26px;font-size:11px;" data-act="life-toggle-phrase" data-v="${variant}">
                  ${st.showPhrase ? '收起助记词' : '展开查看并复制助记词'}
                </button>
              </div>
            </div>
          ` : `
            <div>
              <button class="btn-flat" data-act="life-toggle-phrase" data-v="${variant}">
                ${st.showPhrase ? '隐藏助记词' : '删除前展开核对助记词'}
              </button>
            </div>
          `}

          ${st.showPhrase ? `
            <div class="sl-group-box" style="padding:10px;background:var(--input-bg);">
              <code class="mono" style="font-size:12px;line-height:1.6;">${window.MOCK_BOT.mnemonic.join('  ')}</code>
            </div>
          ` : ''}

          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px;">
            <button class="btn-flat" style="font-size:11px;" data-act="life-sim-countdown" data-v="${variant}">
              ${unlocked ? '重置为 5s 倒计时态' : '⚡ 点击模拟 5s 倒计时结束'}
            </button>
            <div style="display:flex;gap:8px;">
              <button class="btn-flat">取消</button>
              <button class="btn-danger ${unlocked ? 'solid' : ''}" ${unlocked ? '' : 'disabled'} data-toast="演示：已安全移除本地 Bot 记录">
                ${unlocked ? '已备份，确认移除' : '确认移除 (4s)'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (mode === 'restore') {
    const filled = Boolean(st.filledPaste);
    return `
      <div class="sl-modal" style="max-width:${isB ? '620px' : '540px'};">
        <div class="sl-modal-header">
          <div>
            <h4 style="margin:0;font-size:14px;font-weight:700;">从助记词恢复 MetaBot</h4>
            <div class="sl-header-sub">支持整段粘贴 12 个单词自动分格，自动拉取链上头像与档案</div>
          </div>
          <button class="sl-icon-btn">✕</button>
        </div>
        <div class="sl-body">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="sl-group-label">输入或粘贴 12 位助记词</span>
            <button class="btn-flat" style="height:26px;font-size:11px;" data-act="life-fill-paste" data-v="${variant}">
              ${filled ? '清空填入' : '📋 演示一键粘贴整句分格'}
            </button>
          </div>
          <div class="mnemonic-grid">
            ${window.MOCK_BOT.mnemonic.map((w, i) => `
              <div class="mnemonic-cell mono">
                <span class="mnemonic-idx">${String(i + 1).padStart(2, '0')}</span>
                <span style="color:${filled ? 'var(--text-1)' : 'var(--text-3)'};font-weight:${filled ? '700' : '400'};">${filled ? w : 'word…'}</span>
              </div>
            `).join('')}
          </div>
          <div class="sl-group-box">
            <div class="sl-group-row" style="padding:9px 12px;">
              <span style="font-size:12px;color:var(--text-2);">HD 派生路径 (高级可改)</span>
              <code class="mono" style="font-size:12px;">${window.MOCK_BOT.derivationPath}</code>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button class="btn-flat">取消</button>
            <button class="btn-primary" ${filled ? '' : 'disabled'} data-toast="演示：正在派生三链地址并从链上同步 MetaBot 档案">恢复并同步链上资料</button>
          </div>
        </div>
      </div>
    `;
  }

  // mode === 'sync' (Create Success & On-Chain Sync Modal — replaces giant bouncing emojis)
  const steps = [
    { label: '名称与简介 (/info/name, /info/bio)', state: 'done' },
    { label: '链上 NFT 头像声明 (/info/nftAvatar)', state: 'done' },
    { label: '端到端加密聊天公钥 (/info/chatpubkey)', state: 'syncing' },
    { label: '人设与技能清单 (/info/persona)', state: 'pending' },
  ];
  return `
    <div class="sl-modal" style="max-width:${isB ? '580px' : '490px'};">
      <div class="sl-modal-header">
        <div class="sl-bot-id">
          ${botAvatarHtml(globalState)}
          <div class="sl-header-titles">
            <h4>链上身份同步 · ${window.MOCK_BOT.name} <span class="bdg bdg-ok">Gas 补贴已到账</span></h4>
            <div class="sl-header-sub">告别旧版大号跳动 Emoji，统一为 Studio Linear 进度清单</div>
          </div>
        </div>
        <button class="sl-icon-btn">✕</button>
      </div>
      <div class="sl-body">
        <div class="sl-group-box">
          ${steps.map((s) => `
            <div class="sl-group-row" style="padding:9px 12px;">
              <span style="font-size:12px;font-weight:600;">${s.label}</span>
              ${s.state === 'done'
                ? `<span class="bdg bdg-ok">✓ 已上链</span>`
                : s.state === 'syncing'
                  ? `<span class="bdg bdg-brand">↻ 广播确认中…</span>`
                  : `<span class="bdg bdg-neutral">排队中</span>`}
            </div>
          `).join('')}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button class="btn-flat">后台运行</button>
          <button class="btn-primary" data-toast="演示：全部 Pin 节点已广播完成">查看链上 MetaID</button>
        </div>
      </div>
    </div>
  `;
};
