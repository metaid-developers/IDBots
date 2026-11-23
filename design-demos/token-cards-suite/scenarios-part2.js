window.TOKEN_SUITE_PART2 = [
  {
    id: 'portfolio',
    kicker: '场景 5 · 补充推荐新卡（替代 wallet 纯文本余额列表）',
    title: '多链钱包 Token 持仓总览卡（Multi-Chain Portfolio）',
    desc: '因为有资产桥，用户经常在 BTC (MRC-20) 与 MVC (MetaContract) 上同时持有同一个 Token（比如两条链上都有 $METAID）。用持仓总览卡彻底告别混乱的纯文本报账。',
    variants: [
      {
        code: 'P1',
        name: '方案 P1：总估值大字 + 统一资产清单版（按价值排序）',
        summary: '顶部展示总估值与 BTC/SPACE/ME 底仓胶囊，下方按估值列出全部 Token，每行用彩色角标区分「BTC · ID-Coin」与「MVC · 合约」同名资产。',
        userMsg: '看看我现在钱包里都有哪些 Token 和资产',
        botLead: '这是你当前多链钱包的实时持仓总览：',
        render: () => `
          <div class="tk-card">
            <div class="tk-top">
              <div class="tk-ident">
                <div class="tk-avatar sm dual-grad">AI</div>
                <div class="tk-title-col">
                  <div class="tk-title-line">
                    <span class="tk-symbol">AI_Sunny 持仓总览</span>
                  </div>
                  <div class="tk-subline">BTC + MVC 双链资产与积分</div>
                </div>
              </div>
              <span class="bdg bdg-up num">+4.8% 24h</span>
            </div>

            <div class="tk-hero">
              <div>
                <span class="tk-hero-main num">≈ $1,842.60</span>
              </div>
              <span class="tk-hero-sub num">共 3 种代币 · 2 条链</span>
            </div>

            <div class="chip-row num">
              <span class="bdg bdg-btc">₿ 0.0142 BTC</span>
              <span class="bdg bdg-mvc">◈ 428 SPACE</span>
              <span class="bdg bdg-me">✦ 1,280 ME</span>
            </div>

            <div class="row-list num">
              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span>$METAID</span>
                    <span class="bdg bdg-btc">BTC · ID-Coin</span>
                  </div>
                  <div class="row-meta">可用 1,050 · 挂单中 200 枚</div>
                </div>
                <div class="row-price-col">
                  <div class="row-price">1,250</div>
                  <div class="row-price-sub">≈ $118.75</div>
                </div>
              </div>

              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span>$METAID</span>
                    <span class="bdg bdg-mvc">MVC · 合约</span>
                    <span class="bdg bdg-neutral">⇄ 同币跨链</span>
                  </div>
                  <div class="row-meta">可用 200 · ME 挂单锁仓 600 枚</div>
                </div>
                <div class="row-price-col">
                  <div class="row-price">800</div>
                  <div class="row-price-sub">≈ $75.36</div>
                </div>
              </div>

              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span>$MSP</span>
                    <span class="bdg bdg-mvc">MVC · 合约</span>
                  </div>
                  <div class="row-meta">可用 15,800 枚 · ✓ 已认证</div>
                </div>
                <div class="row-price-col">
                  <div class="row-price">15,800</div>
                  <div class="row-price-sub">≈ $189.60</div>
                </div>
              </div>
            </div>

            <div class="chip-row">
              <button class="chip-btn">去挂牌卖出</button>
              <button class="chip-btn">跨链桥转换</button>
              <button class="chip-btn">转账</button>
            </div>
          </div>
        `
      },
      {
        code: 'P2',
        name: '方案 P2：按链分仓 Bento 版（BTC 仓 vs MVC 仓上下分明）',
        summary: '按底层网络将「BTC 链仓位 (MRC-20)」与「MVC 链仓位 (MetaContract)」物理分区展示，一眼看清哪条链上有多少筹码和 Gas。',
        userMsg: '看看我现在钱包里都有哪些 Token 和资产',
        botLead: '按所属公链为你分仓整理如下：',
        render: () => `
          <div class="tk-card">
            <div class="tk-top">
              <div class="tk-title-col">
                <div class="tk-title-line">
                  <span class="tk-symbol">分链资产账本</span>
                  <span class="bdg bdg-me num">✦ 1,280 ME 积分</span>
                </div>
                <div class="tk-subline num">账户总估值 ≈ $1,842.60</div>
              </div>
            </div>

            <div class="ledger-box num">
              <div class="ledger-row">
                <span class="bdg bdg-btc">₿ Bitcoin 链 · MRC-20 / ID-Coin</span>
                <span style="font-size:11px;color:var(--text-2);">Gas: 0.0142 BTC</span>
              </div>
              <div class="ledger-divider"></div>
              <div class="ledger-row">
                <span class="ledger-k">$METAID (含挂单 200)</span>
                <span class="ledger-v">1,250 枚 · $118.75</span>
              </div>
            </div>

            <div class="ledger-box num">
              <div class="ledger-row">
                <span class="bdg bdg-mvc">◈ MVC 链 · MetaContract (MCP02)</span>
                <span style="font-size:11px;color:var(--text-2);">Gas: 428 SPACE</span>
              </div>
              <div class="ledger-divider"></div>
              <div class="ledger-row">
                <span class="ledger-k">$METAID ⇄ (同币跨链)</span>
                <span class="ledger-v">800 枚 · $75.36</span>
              </div>
              <div class="ledger-row">
                <span class="ledger-k">$MSP (MetaSpace)</span>
                <span class="ledger-v">15,800 枚 · $189.60</span>
              </div>
            </div>

            <div class="btn-row">
              <button class="btn-secondary" style="flex:1;">跨链归集</button>
              <button class="btn-primary" style="flex:1.2;">挑币挂牌上架</button>
            </div>
          </div>
        `
      }
    ]
  },

  {
    id: 'bridge',
    kicker: '场景 6 · 跨链规划预留（Octopus 资产桥：BTC MRC-20 ⇄ MVC MetaContract）',
    title: '跨链资产桥转换卡（Cross-Chain Asset Bridge）',
    desc: '对用户来说是同一个 Token，只是在 BTC (MRC-20) 与 MVC (MetaContract) 两种底层格式之间 1:1 桥接搬运。支持上方切换「跨链确认中」与「单向通道维护提示」两种真实状态。',
    modeLabel: '预览桥接状态',
    modes: [
      { key: 'bridging', label: 'MVC → BTC 跨链确认中' },
      { key: 'paused', label: 'BTC → MVC 通道暂未开放提示' }
    ],
    variants: [
      {
        code: 'B1',
        name: '方案 B1：双链流向盒 + 三步区块进度版',
        summary: '左右并列源链与目标链格式，下方可视化三步跨链确认进度与预计到账时间，消除跨链等待焦虑。',
        userMsg: '把我 MVC 上的 1,000 枚 $METAID 跨链转到 BTC 链上去挂单',
        botLead: '已通过官方资产桥发起格式转换，正在等待区块确认：',
        render: (mode) => {
          if (mode === 'paused') {
            return `
              <div class="tk-card">
                <div class="tk-top">
                  <div class="tk-ident">
                    <div class="tk-avatar dual-grad">⇄</div>
                    <div class="tk-title-col">
                      <div class="tk-title-line">
                        <span class="tk-symbol">$METAID 跨链资产桥</span>
                        <span class="bdg bdg-warn">单向维护中</span>
                      </div>
                      <div class="tk-subline">同一资产在 BTC 与 MVC 间的格式转换</div>
                    </div>
                  </div>
                </div>

                <div class="flow-dual num">
                  <div class="flow-box" style="opacity:0.65;">
                    <div class="bento-label">源链格式</div>
                    <div class="bento-val">BTC · MRC-20</div>
                    <div class="bento-sub">持有 1,250 枚</div>
                  </div>
                  <div class="flow-arrow">✕</div>
                  <div class="flow-box" style="opacity:0.65;">
                    <div class="bento-label">目标链格式</div>
                    <div class="bento-val">MVC · 合约</div>
                    <div class="bento-sub">暂未开放转入</div>
                  </div>
                </div>

                <div class="ledger-box" style="border:1px solid var(--warn-border);background:var(--warn-bg);">
                  <div style="font-size:11.5px;line-height:1.45;">
                    <strong>通道提示：</strong>当前资产桥仅开放 <strong>MVC → BTC</strong> 方向；你想卖 BTC 链上的 $METAID，无需跨链，可直接走 <strong>BTC · metaid.market (PSBT)</strong> 或 <strong>ME 积分交易</strong> 挂牌！
                  </div>
                </div>

                <div class="btn-row">
                  <button class="btn-secondary">改走 ME 积分挂牌</button>
                  <button class="btn-primary">直接挂 metaid.market</button>
                </div>
              </div>
            `;
          }
          return `
            <div class="tk-card">
              <div class="tk-top">
                <div class="tk-ident">
                  <div class="tk-avatar dual-grad">⇄</div>
                  <div class="tk-title-col">
                    <div class="tk-title-line">
                      <span class="tk-symbol">$METAID 跨链转换</span>
                      <span class="bdg bdg-brand">区块确认中</span>
                    </div>
                    <div class="tk-subline">同一代币 · Octopus 资产桥 1:1 映射</div>
                  </div>
                </div>
              </div>

              <div class="flow-dual num">
                <div class="flow-box">
                  <div class="bento-label">转出 (MVC · 合约)</div>
                  <div class="bento-val">-1,000 METAID</div>
                  <div class="bento-sub">已锁定销毁</div>
                </div>
                <div class="flow-arrow">⇄</div>
                <div class="flow-box" style="border:1px solid var(--btc-border);">
                  <div class="bento-label">转入 (BTC · MRC-20)</div>
                  <div class="bento-val" style="color:var(--up);">+995 METAID</div>
                  <div class="bento-sub">扣桥接矿工费 5 枚</div>
                </div>
              </div>

              <div class="prog-strip num">
                <div class="prog-top">
                  <span style="font-weight:600;">② 跨链节点确认中 (2 / 3 区块)</span>
                  <span style="color:var(--text-2);">预计 ~12 分钟到账</span>
                </div>
                <div class="prog-track"><div class="prog-fill brand" style="width:66%"></div></div>
              </div>

              <div class="chip-row">
                <button class="chip-btn">刷新桥接进度</button>
                <button class="chip-btn">到账后自动挂牌 PSBT</button>
              </div>
            </div>
          `;
        }
      },
      {
        code: 'B2',
        name: '方案 B2：双链持仓变化预览单据版（强调总量不变、换链可用）',
        summary: '除了展示桥接进度，还直观对比转换前后两条链各自的余额变化，让新手秒懂「还是同一个币，只是搬去了 BTC 链」。',
        userMsg: '把我 MVC 上的 1,000 枚 $METAID 跨链转到 BTC 链上去挂单',
        botLead: '跨链请求已提交，双链余额变动与进度如下：',
        render: (mode) => {
          if (mode === 'paused') {
            return `
              <div class="tk-card compact">
                <div class="tk-top">
                  <div class="tk-title-col">
                    <div class="tk-title-line">
                      <span class="tk-symbol">$METAID 跨链通道状态</span>
                      <span class="bdg bdg-warn">BTC→MVC 维护中</span>
                    </div>
                    <div class="tk-subline">MVC → BTC 正常开放 · BTC → MVC 暂未开启</div>
                  </div>
                </div>
                <div class="ledger-box">
                  <div class="ledger-row">
                    <span class="ledger-k">MVC → BTC 转换</span>
                    <span class="ledger-v"><span class="bdg bdg-up">● 正常可用 (~15m)</span></span>
                  </div>
                  <div class="ledger-row">
                    <span class="ledger-k">BTC → MVC 转换</span>
                    <span class="ledger-v"><span class="bdg bdg-warn">● 升级维护中</span></span>
                  </div>
                </div>
                <button class="btn-primary">免跨链：直接用 BTC PSBT / ME 积分挂牌</button>
              </div>
            `;
          }
          return `
            <div class="tk-card compact">
              <div class="tk-top">
                <div class="tk-ident">
                  <div class="tk-avatar sm dual-grad">M</div>
                  <div class="tk-title-col">
                    <div class="tk-title-line">
                      <span class="tk-symbol">$METAID 格式转换单</span>
                    </div>
                    <div class="tk-subline">MVC MetaContract → BTC MRC-20</div>
                  </div>
                </div>
                <span class="bdg bdg-brand num">2/3 确认中</span>
              </div>

              <div class="ledger-box num">
                <div class="ledger-row">
                  <span class="ledger-k">桥接净到账</span>
                  <span class="ledger-v" style="color:var(--up);">+995 METAID (手续费 5 枚)</span>
                </div>
                <div class="ledger-divider"></div>
                <div class="ledger-row">
                  <span class="ledger-k">MVC 合约余额</span>
                  <span class="ledger-v">1,800 → <strong>800 METAID</strong></span>
                </div>
                <div class="ledger-row">
                  <span class="ledger-k">BTC MRC-20 余额</span>
                  <span class="ledger-v">250 → <strong style="color:var(--up);">1,245 METAID</strong></span>
                </div>
                <div class="ledger-row">
                  <span class="ledger-k">源链锁定哈希</span>
                  <span class="ledger-v mono">a41c…90e2 ↗</span>
                </div>
              </div>

              <div class="prog-track"><div class="prog-fill brand" style="width:66%"></div></div>
            </div>
          `;
        }
      }
    ]
  },

  {
    id: 'mint-transfer',
    kicker: '场景 7 · 补充推荐新卡（覆盖内置发币 issue / 增发 mint / 转账 transfer）',
    title: 'Token 创世发行 / Mint / 转账凭证卡（On-Chain Action Receipt）',
    desc: '补齐最后一块纯文本缺口：刚上线的 MVC MetaContract 一键发币、ID-Coin Mint 铸造以及日常 Token 点对点转账，共享同一套链上凭证视觉。支持上方切换 3 种子动作预览。',
    modeLabel: '预览链上动作',
    modes: [
      { key: 'issue', label: '创世发币 (MVC MetaContract)' },
      { key: 'mint', label: 'Mint 铸造 (BTC ID-Coin)' },
      { key: 'send', label: 'Token 转账 (MRC-20 / MVC)' }
    ],
    variants: [
      {
        code: 'M1',
        name: '方案 M1：合约铭牌证书 + 2×2 Bento 版（仪式感强）',
        summary: '适合发币、铸造及大额转账：突出新币图标、防伪合约 ID、总量权限（如固定上限已锁死）及后续一键上架引导。',
        userMsg: '帮我在 MVC 上发行一个叫 $NOVA 的合约代币，总量 2100 万枚，锁死不增发',
        botLead: '创世合约已在 MVC 链上部署成功，代币已铸入你的钱包：',
        render: (mode) => {
          const m = mode || 'issue';
          if (m === 'issue') {
            return `
              <div class="tk-card">
                <div class="tk-top">
                  <div class="tk-ident">
                    <div class="tk-avatar nova-grad">N<span class="chain-pip mvc">MVC</span></div>
                    <div class="tk-title-col">
                      <div class="tk-title-line">
                        <span class="tk-symbol">$NOVA · NovaClub</span>
                        <span class="bdg bdg-up">✓ 创世成功</span>
                      </div>
                      <div class="tk-subline">
                        <span class="bdg bdg-mvc">MVC · MetaContract (MCP02)</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="tk-hero">
                  <div>
                    <span class="tk-hero-main num">21,000,000</span>
                    <span class="tk-hero-unit">NOVA</span>
                  </div>
                  <span class="bdg bdg-brand">🔒 固定总量 · 已锁死增发</span>
                </div>

                <div class="bento-2 num">
                  <div class="bento-cell">
                    <div class="bento-label">小数精度</div>
                    <div class="bento-val">8 位小数</div>
                    <div class="bento-sub">标准 MCP02 v2</div>
                  </div>
                  <div class="bento-cell">
                    <div class="bento-label">初始持有人</div>
                    <div class="bento-val">AI_Sunny</div>
                    <div class="bento-sub">100% 已入账</div>
                  </div>
                  <div class="bento-cell">
                    <div class="bento-label">合约 Genesis ID</div>
                    <div class="bento-val mono">a91f…8b10 复制</div>
                    <div class="bento-sub">防伪唯一标识</div>
                  </div>
                  <div class="bento-cell">
                    <div class="bento-label">链上创世 TxID</div>
                    <div class="bento-val mono">3e0c…72d4 ↗</div>
                    <div class="bento-sub">耗时 1.2s 广播</div>
                  </div>
                </div>

                <div class="btn-row">
                  <button class="btn-secondary">发 Buzz 官宣</button>
                  <button class="btn-primary">去挂牌上架 $NOVA</button>
                </div>
              </div>
            `;
          }
          if (m === 'mint') {
            return `
              <div class="tk-card">
                <div class="tk-top">
                  <div class="tk-ident">
                    <div class="tk-avatar btc-grad">S<span class="chain-pip btc">₿</span></div>
                    <div class="tk-title-col">
                      <div class="tk-title-line">
                        <span class="tk-symbol">Mint $SUNNY 成功</span>
                        <span class="bdg bdg-up">✓ 已铸造</span>
                      </div>
                      <div class="tk-subline"><span class="bdg bdg-btc">BTC · ID-Coin (MRC-20)</span></div>
                    </div>
                  </div>
                  <span class="bdg bdg-btc">metaid.market</span>
                </div>
                <div class="tk-hero">
                  <div>
                    <span class="tk-hero-main num" style="color:var(--up);">+1,000</span>
                    <span class="tk-hero-unit">SUNNY</span>
                  </div>
                  <span class="tk-hero-sub num">全网铸造进度 84.2%</span>
                </div>
                <div class="bento-2 num">
                  <div class="bento-cell">
                    <div class="bento-label">Commit + Reveal 矿工费</div>
                    <div class="bento-val">2,840 sat</div>
                    <div class="bento-sub">≈ $2.75</div>
                  </div>
                  <div class="bento-cell">
                    <div class="bento-label">折算铸造成本</div>
                    <div class="bento-val">2.84 sat / 枚</div>
                    <div class="bento-sub">地板价 12 sat/枚</div>
                  </div>
                </div>
                <div class="chip-row">
                  <button class="chip-btn">再 Mint 一张</button>
                  <button class="chip-btn">去 metaid.market 挂单</button>
                </div>
              </div>
            `;
          }
          return `
            <div class="tk-card">
              <div class="tk-top">
                <div class="tk-ident">
                  <div class="tk-avatar mvc-grad">M<span class="chain-pip mvc">MVC</span></div>
                  <div class="tk-title-col">
                    <div class="tk-title-line">
                      <span class="tk-symbol">已转出 $METAID</span>
                      <span class="bdg bdg-up">✓ 已广播</span>
                    </div>
                    <div class="tk-subline"><span class="bdg bdg-mvc">MVC · MetaContract</span></div>
                  </div>
                </div>
              </div>
              <div class="tk-hero">
                <div>
                  <span class="tk-hero-main num">-500</span>
                  <span class="tk-hero-unit">METAID</span>
                </div>
                <span class="tk-hero-sub num">剩余可用 300 枚</span>
              </div>
              <div class="bento-2 num">
                <div class="bento-cell">
                  <div class="bento-label">收款方</div>
                  <div class="bento-val">AI_Bob</div>
                  <div class="bento-sub mono">1Bp9…x8Kq</div>
                </div>
                <div class="bento-cell">
                  <div class="bento-label">网络手续费 & TxID</div>
                  <div class="bento-val mono">6c1a…20f9 ↗</div>
                  <div class="bento-sub">矿工费 520 sat (SPACE)</div>
                </div>
              </div>
            </div>
          `;
        }
      },
      {
        code: 'M2',
        name: '方案 M2：轻量链上回执条版（对标 S1 极简账本）',
        summary: '控制纵向高度，用紧凑的三行账本呈现核心要素与 TxID 复制，在连续转账或连续 Mint 对话流里清爽不刷屏。',
        userMsg: '帮我在 MVC 上发行一个叫 $NOVA 的合约代币，总量 2100 万枚，锁死不增发',
        botLead: '$NOVA 已完成链上创世发行：',
        render: (mode) => {
          const m = mode || 'issue';
          const map = {
            issue: {
              av: 'nova-grad', ch: 'N', title: '$NOVA 创世发行回执',
              badge: '<span class="bdg bdg-mvc">MVC · MetaContract</span>',
              r1k: '发行总量', r1v: '21,000,000 NOVA (已锁死上限)',
              r2k: '合约标识', r2v: 'a91f:7c20…8b10 复制',
              r3k: '创世哈希', r3v: 'Tx 3e0c…72d4 ↗',
              cta: '去挂牌上架 $NOVA'
            },
            mint: {
              av: 'btc-grad', ch: 'S', title: '$SUNNY Mint 铸造回执',
              badge: '<span class="bdg bdg-btc">BTC · ID-Coin</span>',
              r1k: '铸造入账', r1v: '+1,000 SUNNY (成本 2.84 sat/枚)',
              r2k: '矿工费用', r2v: '2,840 sat (Commit+Reveal)',
              r3k: 'Reveal Tx', r3v: 'Tx 8b4d…19e0 ↗',
              cta: '继续 Mint 下一张'
            },
            send: {
              av: 'mvc-grad', ch: 'M', title: '$METAID 链上转账回执',
              badge: '<span class="bdg bdg-mvc">MVC · MetaContract</span>',
              r1k: '转出数量', r1v: '-500 METAID → AI_Bob (1Bp9…x8Kq)',
              r2k: '网络矿工费', r2v: '0.0000052 SPACE',
              r3k: '交易哈希', r3v: 'Tx 6c1a…20f9 复制',
              cta: '查看剩余持仓'
            }
          }[m];
          return `
            <div class="tk-card compact">
              <div class="tk-top">
                <div class="tk-ident">
                  <div class="tk-avatar sm ${map.av}">${map.ch}</div>
                  <div class="tk-title-col">
                    <div class="tk-title-line">
                      <span class="tk-symbol">${map.title}</span>
                      <span class="bdg bdg-up">✓ 成功</span>
                    </div>
                  </div>
                </div>
                ${map.badge}
              </div>

              <div class="ledger-box num">
                <div class="ledger-row">
                  <span class="ledger-k">${map.r1k}</span>
                  <span class="ledger-v">${map.r1v}</span>
                </div>
                <div class="ledger-row">
                  <span class="ledger-k">${map.r2k}</span>
                  <span class="ledger-v mono">${map.r2v}</span>
                </div>
                <div class="ledger-row">
                  <span class="ledger-k">${map.r3k}</span>
                  <span class="ledger-v mono">${map.r3v}</span>
                </div>
              </div>

              <button class="btn-secondary" style="width:100%;">${map.cta}</button>
            </div>
          `;
        }
      }
    ]
  }
];
