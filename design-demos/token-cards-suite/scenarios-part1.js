window.TOKEN_SUITE_PART1 = [
  {
    id: 'listing',
    kicker: '场景 1 · 重构替代你截图中的 ft-order-card（最高优）',
    title: '上架 / 挂牌席位卡（Listing Seat）',
    desc: '彻底解决截图中的「长小数左右撞字出框」「未标出 MVC MetaContract / BTC MRC-20 链格式」「生硬英文 ME Instant Escrow」及「黄底白字按钮看不清」四大问题。支持上方一键切换 3 种挂牌渠道预览。',
    hasUglyToggle: true,
    modeLabel: '预览挂牌渠道',
    modes: [
      { key: 'me', label: 'ME 积分交易（复现截图长小数）' },
      { key: 'btc', label: 'BTC · metaid.market (PSBT)' },
      { key: 'mvc', label: 'MVC · 链上合约挂单' }
    ],
    variants: [
      {
        code: 'L1',
        name: '方案 L1：单价大字 + 双格 Bento 版（对标 D1）',
        summary: '顶部大字突出挂牌单价与预计总收入，分包颗粒度与交割值守独立成格上下排布，8 位长小数也绝不碰撞。',
        userMsg: '把这 1.04842259 枚 $METAID 按总价 10 ME 挂上去卖',
        botLead: '已为你挂好席位并开启后台自动发币值守：',
        render: (mode) => {
          const cfg = {
            me: {
              grad: 'mvc-grad', pip: 'mvc', pipTxt: 'MVC',
              chainBadge: '<span class="bdg bdg-mvc">MVC · MetaContract</span>',
              idBadge: '<span class="bdg bdg-warn mono" title="mvc-ft:c9cc...:28a481...f417">ID c9cc…f417</span>',
              venueBadge: '<span class="bdg bdg-me">✦ ME 积分交易</span>',
              unitPrice: '9.538139', unitSuffix: 'ME / 枚',
              estTotal: '预计总收 ≈ 10.00 ME',
              lotVal: '1.04842259 枚', lotSub: '共 1 包 · 整包 10.00 ME',
              guardVal: '⚡ 24h 自动发币', guardSub: '买家付积分后即刻链上转币',
              progLeft: '成交进度 · 0 / 1 包', progRight: '0 矿工费秒撤单'
            },
            btc: {
              grad: 'btc-grad', pip: 'btc', pipTxt: '₿',
              chainBadge: '<span class="bdg bdg-btc">BTC · ID-Coin (MRC-20)</span>',
              idBadge: '<span class="bdg bdg-up">✓ 官方认证</span>',
              venueBadge: '<span class="bdg bdg-btc">metaid.market · PSBT</span>',
              unitPrice: '1,580', unitSuffix: 'sat / 枚',
              estTotal: '总挂牌 0.0158 BTC (≈$1,532)',
              lotVal: '1,000 METAID', lotSub: '拆为 5 包 · 每包 200 枚',
              guardVal: '🔒 PSBT 原子签名', guardSub: '链上整包买断 · 无需在线值守',
              progLeft: '成交进度 · 2 / 5 包已售', progRight: '已回笼 0.00632 BTC',
              pct: 40
            },
            mvc: {
              grad: 'mvc-grad', pip: 'mvc', pipTxt: 'MVC',
              chainBadge: '<span class="bdg bdg-mvc">MVC · MetaContract</span>',
              idBadge: '<span class="bdg bdg-up">✓ 官方认证</span>',
              venueBadge: '<span class="bdg bdg-mvc">MVC · 链上合约挂单</span>',
              unitPrice: '6.08', unitSuffix: 'SPACE / 枚',
              estTotal: '总挂牌 3,040 SPACE',
              lotVal: '500 METAID', lotSub: '拆为 5 包 · 每包 100 枚',
              guardVal: '📜 TokenSell 合约', guardSub: '合约锁定筹码 · 自动原子交割',
              progLeft: '成交进度 · 1 / 5 包已售', progRight: '已收 608 SPACE',
              pct: 20
            }
          }[mode || 'me'];
          const pct = cfg.pct || 0;
          return `
            <div class="tk-card">
              <div class="tk-top">
                <div class="tk-ident">
                  <div class="tk-avatar ${cfg.grad}">M<span class="chain-pip ${cfg.pip}">${cfg.pipTxt}</span></div>
                  <div class="tk-title-col">
                    <div class="tk-title-line">
                      <span class="tk-symbol">$METAID</span>
                      ${cfg.idBadge}
                    </div>
                    <div class="tk-subline">${cfg.chainBadge}</div>
                  </div>
                </div>
                ${cfg.venueBadge}
              </div>

              <div class="tk-hero">
                <div>
                  <span class="tk-hero-main num">${cfg.unitPrice}</span>
                  <span class="tk-hero-unit">${cfg.unitSuffix}</span>
                </div>
                <span class="tk-hero-sub num">${cfg.estTotal}</span>
              </div>

              <div class="bento-2">
                <div class="bento-cell">
                  <div class="bento-label">挂牌数量与分包</div>
                  <div class="bento-val num" title="${cfg.lotVal}">${cfg.lotVal}</div>
                  <div class="bento-sub num">${cfg.lotSub}</div>
                </div>
                <div class="bento-cell">
                  <div class="bento-label">结算与交割方式</div>
                  <div class="bento-val">${cfg.guardVal}</div>
                  <div class="bento-sub">${cfg.guardSub}</div>
                </div>
              </div>

              <div class="prog-strip">
                <div class="prog-top num">
                  <span style="font-weight:600;">${cfg.progLeft}</span>
                  <span style="color:var(--text-2);">${cfg.progRight}</span>
                </div>
                <div class="prog-track"><div class="prog-fill" style="width:${pct}%"></div></div>
              </div>

              <div class="btn-row">
                <button class="btn-secondary">撤回挂单</button>
                <button class="btn-primary">生成推销海报</button>
              </div>
            </div>
          `;
        }
      },
      {
        code: 'L2',
        name: '方案 L2：紧凑票据 · 纵向账本版（对标 S1）',
        summary: '采用单列左右对齐账本行，每项指标独占一行，视觉高度更紧凑，适合高频连续挂单与超长数字展示。',
        userMsg: '把这 1.04842259 枚 $METAID 按总价 10 ME 挂上去卖',
        botLead: '挂牌席位已生效，详情如下：',
        render: (mode) => {
          const cfg = {
            me: {
              grad: 'mvc-grad', pip: 'mvc', pipTxt: 'MVC',
              chainTxt: 'MVC · MetaContract · <span style="white-space:nowrap;">ID c9cc…f417</span>',
              statusBadge: '<span class="bdg bdg-up">● 挂牌值守中 0/1</span>',
              venueVal: '<span class="bdg bdg-me">✦ ME 积分交易 · AI 自动发币</span>',
              priceVal: '9.538139 ME / 枚',
              lotVal: '1.04842259 METAID × 1 包',
              totalVal: '10.00 ME',
              pct: 0
            },
            btc: {
              grad: 'btc-grad', pip: 'btc', pipTxt: '₿',
              chainTxt: 'BTC · ID-Coin (MRC-20) · ✓ 已认证',
              statusBadge: '<span class="bdg bdg-brand">● 已售 2/5 包</span>',
              venueVal: '<span class="bdg bdg-btc">metaid.market · PSBT 原子单</span>',
              priceVal: '1,580 sat / 枚',
              lotVal: '200 METAID × 5 包 (共 1,000)',
              totalVal: '0.0158 BTC (每包 316,000 sat)',
              pct: 40
            },
            mvc: {
              grad: 'mvc-grad', pip: 'mvc', pipTxt: 'MVC',
              chainTxt: 'MVC · MetaContract · ✓ 已认证',
              statusBadge: '<span class="bdg bdg-brand">● 已售 1/5 包</span>',
              venueVal: '<span class="bdg bdg-mvc">MVC · TokenSell 合约单</span>',
              priceVal: '6.08 SPACE / 枚',
              lotVal: '100 METAID × 5 包 (共 500)',
              totalVal: '3,040 SPACE (每包 608 SPACE)',
              pct: 20
            }
          }[mode || 'me'];
          return `
            <div class="tk-card compact">
              <div class="tk-top">
                <div class="tk-ident">
                  <div class="tk-avatar sm ${cfg.grad}">M<span class="chain-pip ${cfg.pip}">${cfg.pipTxt}</span></div>
                  <div class="tk-title-col">
                    <div class="tk-title-line">
                      <span class="tk-symbol">$METAID 挂牌单</span>
                    </div>
                    <div class="tk-subline mono">${cfg.chainTxt}</div>
                  </div>
                </div>
                ${cfg.statusBadge}
              </div>

              <div class="ledger-box num">
                <div class="ledger-row">
                  <span class="ledger-k">交易方式</span>
                  <span class="ledger-v">${cfg.venueVal}</span>
                </div>
                <div class="ledger-divider"></div>
                <div class="ledger-row">
                  <span class="ledger-k">挂牌单价</span>
                  <span class="ledger-v">${cfg.priceVal}</span>
                </div>
                <div class="ledger-row">
                  <span class="ledger-k">分包规格</span>
                  <span class="ledger-v" title="${cfg.lotVal}">${cfg.lotVal}</span>
                </div>
                <div class="ledger-row">
                  <span class="ledger-k">挂牌总额</span>
                  <span class="ledger-v" style="color:var(--brand-text);">${cfg.totalVal}</span>
                </div>
              </div>

              <div class="prog-track"><div class="prog-fill" style="width:${cfg.pct}%"></div></div>

              <div class="btn-row">
                <button class="btn-secondary" style="flex:1;">撤回挂单</button>
                <button class="btn-primary" style="flex:1.25;">生成推销海报</button>
              </div>
            </div>
          `;
        }
      }
    ]
  },

  {
    id: 'quote',
    kicker: '场景 2 · 重构升级 ft-quote-card + 承接「挂单列表 / 哪里买划算」',
    title: '买入比价与盘口挂单卡（Buy Quote & Orderbook）',
    desc: '同一个 Token 横跨 BTC (MRC-20)、MVC (MetaContract)、ME 积分交易及即将回归的 MVCSwap 合约池。两套方案分别侧重「全渠道横向比价」与「具体整包挂单挑选」。',
    variants: [
      {
        code: 'Q1',
        name: '方案 Q1：四轨渠道横向比价版（突出哪边买最划算）',
        summary: '将 ME 积分交易、BTC metaid.market (PSBT)、MVC 链上合约及 MVCSwap（标注即将开放）同框对比，清晰标出各渠道底层链与最优单价。',
        userMsg: '我想买大概 100 美元的 $METAID，现在去哪买比较划算？',
        botLead: '为你汇总了 $METAID 当前全渠道实时报价：',
        render: () => `
          <div class="tk-card">
            <div class="tk-top">
              <div class="tk-ident">
                <div class="tk-avatar dual-grad">M</div>
                <div class="tk-title-col">
                  <div class="tk-title-line">
                    <span class="tk-symbol">$METAID 全网比价</span>
                    <span class="bdg bdg-up">✓ 认证</span>
                  </div>
                  <div class="tk-subline">支持双链互通 (BTC MRC-20 ⇄ MVC 合约)</div>
                </div>
              </div>
              <span class="bdg bdg-neutral num">预算 ≈ $100</span>
            </div>

            <div class="row-list num">
              <div class="row-item rec">
                <div class="row-left">
                  <div class="row-title">
                    <span class="bdg bdg-me">✦ ME 积分交易</span>
                    <span class="bdg bdg-brand">★ 最优推荐</span>
                  </div>
                  <div class="row-meta">发 MVC · MetaContract · 免 Gas 秒到 · 深度 4,200 枚</div>
                </div>
                <div class="row-right">
                  <div class="row-price-col">
                    <div class="row-price">9.42 ME</div>
                    <div class="row-price-sub">≈ $0.094 / 枚</div>
                  </div>
                  <button class="btn-mini gold">选用</button>
                </div>
              </div>

              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span class="bdg bdg-btc">BTC · metaid.market</span>
                    <span style="font-size:10.5px;color:var(--text-3);">PSBT 整包</span>
                  </div>
                  <div class="row-meta">得 BTC · ID-Coin · 深度 12,400 枚 (最小包 200 枚)</div>
                </div>
                <div class="row-right">
                  <div class="row-price-col">
                    <div class="row-price">97 sat</div>
                    <div class="row-price-sub">≈ $0.095 / 枚</div>
                  </div>
                  <button class="btn-mini">选用</button>
                </div>
              </div>

              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span class="bdg bdg-mvc">MVC · 链上合约挂单</span>
                  </div>
                  <div class="row-meta">得 MVC · MetaContract · TokenSell 深度 3,500 枚</div>
                </div>
                <div class="row-right">
                  <div class="row-price-col">
                    <div class="row-price">0.98 SPACE</div>
                    <div class="row-price-sub">≈ $0.098 / 枚</div>
                  </div>
                  <button class="btn-mini">选用</button>
                </div>
              </div>

              <div class="row-item muted">
                <div class="row-left">
                  <div class="row-title">
                    <span class="bdg bdg-neutral">MVC · MVCSwap 闪兑</span>
                    <span class="bdg bdg-warn">即将开放</span>
                  </div>
                  <div class="row-meta">MetaContract AMM 流动性池 · 支持任意零碎数量兑换</div>
                </div>
                <div class="row-right">
                  <span style="font-size:10.5px;color:var(--text-3);">合约升级中</span>
                </div>
              </div>
            </div>

            <div class="ledger-box num" style="padding:7px 10px;">
              <div class="ledger-row">
                <span class="ledger-k">AI 凑单试算</span>
                <span class="ledger-v">用 942 ME 连扫 2 包 → 可得 <strong>1,000 METAID</strong></span>
              </div>
            </div>

            <button class="btn-primary">按推荐方案买入 1,000 METAID</button>
          </div>
        `
      },
      {
        code: 'Q2',
        name: '方案 Q2：实盘整包挂单簿版（突出挑包与切换渠道 Tab）',
        summary: '承接 D1 卡片上的「挂单列表」按钮：顶部提供渠道小标签切换，直观列出前 4 包低价实盘单的单包数量、单价、总价与一键买单。',
        userMsg: '看看现在 $METAID 最低的几笔挂单列表',
        botLead: '当前按单价从低到高排列的实盘在售挂单：',
        render: () => `
          <div class="tk-card">
            <div class="tk-top">
              <div class="tk-ident">
                <div class="tk-avatar btc-grad">M<span class="chain-pip btc">₿</span></div>
                <div class="tk-title-col">
                  <div class="tk-title-line">
                    <span class="tk-symbol">$METAID 挂单盘口</span>
                    <span class="bdg bdg-up">地板 9.42 ME</span>
                  </div>
                  <div class="tk-subline">整包买断机制 · 每包标注所属链与结算方式</div>
                </div>
              </div>
            </div>

            <div class="mini-tabs">
              <button class="mini-tab active">全部最优 (18)</button>
              <button class="mini-tab">✦ ME 积分 (6)</button>
              <button class="mini-tab">₿ BTC PSBT (9)</button>
              <button class="mini-tab">◈ MVC 合约 (3)</button>
              <button class="mini-tab" style="opacity:0.55;">MVCSwap (即将开放)</button>
            </div>

            <div class="row-list num">
              <div class="row-item rec">
                <div class="row-left">
                  <div class="row-title">
                    <span>500 METAID</span>
                    <span class="bdg bdg-mvc">MVC·合约</span>
                    <span class="bdg bdg-me">ME 积分</span>
                  </div>
                  <div class="row-meta">单价 9.42 ME/枚 · 卖家 AI_Luna (⚡在线秒发)</div>
                </div>
                <div class="row-right">
                  <div class="row-price-col">
                    <div class="row-price">4,710 ME</div>
                    <div class="row-price-sub">整包总价</div>
                  </div>
                  <button class="btn-mini gold">买这包</button>
                </div>
              </div>

              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span>200 METAID</span>
                    <span class="bdg bdg-btc">BTC·ID-Coin</span>
                    <span class="bdg bdg-btc">PSBT</span>
                  </div>
                  <div class="row-meta">单价 97 sat/枚 · metaid.market 链上原子单</div>
                </div>
                <div class="row-right">
                  <div class="row-price-col">
                    <div class="row-price">19,400 sat</div>
                    <div class="row-price-sub">≈ $18.82</div>
                  </div>
                  <button class="btn-mini">买这包</button>
                </div>
              </div>

              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span>300 METAID</span>
                    <span class="bdg bdg-mvc">MVC·合约</span>
                  </div>
                  <div class="row-meta">单价 0.98 SPACE/枚 · TokenSell 合约托管</div>
                </div>
                <div class="row-right">
                  <div class="row-price-col">
                    <div class="row-price">294 SPACE</div>
                    <div class="row-price-sub">≈ $29.40</div>
                  </div>
                  <button class="btn-mini">买这包</button>
                </div>
              </div>
            </div>

            <div class="btn-row">
              <button class="btn-secondary">按预算自动凑单</button>
              <button class="btn-primary">刷新盘口</button>
            </div>
          </div>
        `
      }
    ]
  },

  {
    id: 'fill',
    kicker: '场景 3 · 重构升级 ft-fill-card（覆盖主动买卖 + 挂单被吃入账喜报）',
    title: '买入 / 卖出成交回执卡（Trade Fill Receipt）',
    desc: '涵盖用户主动扫货买入、卖出闪兑，以及后台挂单被买家吃掉后的自动到账通知。支持上方切换「买入成交」与「卖出/挂单被吃入账」两种状态。',
    modeLabel: '预览买卖方向',
    modes: [
      { key: 'buy', label: '买入扫货成交 (+Token)' },
      { key: 'sell', label: '挂单售出到账 (+ME / +BTC)' }
    ],
    variants: [
      {
        code: 'F1',
        name: '方案 F1：收支对账大字 + 2×2 Bento 版（对标 D1）',
        summary: '第一眼用大号数字确认最终到手资产，下方四宫格规整呈现成交均价、付出/收入总额、包数与链上 TxID 凭证。',
        userMsg: '确认按推荐方案扫货买入 1,000 枚 $METAID',
        botLead: '交割已完成，资产已入账你的钱包：',
        render: (mode) => {
          const isBuy = (mode || 'buy') === 'buy';
          if (isBuy) {
            return `
              <div class="tk-card">
                <div class="tk-top">
                  <div class="tk-ident">
                    <div class="tk-avatar btc-grad">M<span class="chain-pip btc">₿</span></div>
                    <div class="tk-title-col">
                      <div class="tk-title-line">
                        <span class="tk-symbol">买入 $METAID 成交</span>
                        <span class="bdg bdg-up">✓ 已入账</span>
                      </div>
                      <div class="tk-subline">
                        <span class="bdg bdg-btc">BTC · ID-Coin (MRC-20)</span>
                      </div>
                    </div>
                  </div>
                  <span class="bdg bdg-btc">metaid.market · PSBT</span>
                </div>

                <div class="tk-hero">
                  <div>
                    <span class="tk-hero-main num" style="color:var(--up);">+1,000</span>
                    <span class="tk-hero-unit">METAID</span>
                  </div>
                  <span class="tk-hero-sub num">连扫 3 包 · 100% 成交</span>
                </div>

                <div class="bento-2 num">
                  <div class="bento-cell">
                    <div class="bento-label">合计支出 (含矿工费)</div>
                    <div class="bento-val">97,420 sat</div>
                    <div class="bento-sub">≈ $94.50</div>
                  </div>
                  <div class="bento-cell">
                    <div class="bento-label">成交均价</div>
                    <div class="bento-val">97.4 sat / 枚</div>
                    <div class="bento-sub">比挂单均价省 2.1%</div>
                  </div>
                  <div class="bento-cell">
                    <div class="bento-label">最新该链持仓</div>
                    <div class="bento-val">2,250 METAID</div>
                    <div class="bento-sub">BTC 链可用余额</div>
                  </div>
                  <div class="bento-cell">
                    <div class="bento-label">链上交割哈希 (3笔)</div>
                    <div class="bento-val mono">9f3a…81c2 ↗</div>
                    <div class="bento-sub">点击展开全部 TxID</div>
                  </div>
                </div>

                <div class="chip-row">
                  <button class="chip-btn">查看 $METAID 详情</button>
                  <button class="chip-btn">用 $METAID 买好物</button>
                  <button class="chip-btn">反手挂单止盈</button>
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
                      <span class="tk-symbol">挂单售出到账</span>
                      <span class="bdg bdg-brand">⚡ 自动发币完成</span>
                    </div>
                    <div class="tk-subline">
                      <span class="bdg bdg-mvc">MVC · MetaContract</span>
                    </div>
                  </div>
                </div>
                <span class="bdg bdg-me">✦ ME 积分交易</span>
              </div>

              <div class="tk-hero">
                <div>
                  <span class="tk-hero-main num" style="color:var(--up);">+10.00</span>
                  <span class="tk-hero-unit">ME 积分</span>
                </div>
                <span class="tk-hero-sub num">已售 1 / 1 包 · 订单完结</span>
              </div>

              <div class="bento-2 num">
                <div class="bento-cell">
                  <div class="bento-label">发出代币数量</div>
                  <div class="bento-val">-1.04842259</div>
                  <div class="bento-sub">METAID (MVC 合约)</div>
                </div>
                <div class="bento-cell">
                  <div class="bento-label">折算成交单价</div>
                  <div class="bento-val">9.538139 ME</div>
                  <div class="bento-sub">每枚结算价</div>
                </div>
                <div class="bento-cell">
                  <div class="bento-label">对手方买家</div>
                  <div class="bento-val">AI_Kevin</div>
                  <div class="bento-sub">积分验资通过</div>
                </div>
                <div class="bento-cell">
                  <div class="bento-label">发币链上 TxID</div>
                  <div class="bento-val mono">7d1e…49a0 ↗</div>
                  <div class="bento-sub">MVC 区块已广播</div>
                </div>
              </div>

              <div class="chip-row">
                <button class="chip-btn">继续挂牌上架</button>
                <button class="chip-btn">查看我的挂单</button>
              </div>
            </div>
          `;
        }
      },
      {
        code: 'F2',
        name: '方案 F2：左右资产流向对照版（一眼看清拿什么换了什么）',
        summary: '用「左出 ──▶ 右入」双盒直观呈现兑出与收到资产及各自链格式，适合买卖扫货、积分交割及未来 MVCSwap 闪兑通用。',
        userMsg: '确认按推荐方案扫货买入 1,000 枚 $METAID',
        botLead: '已完成链上交割：',
        render: (mode) => {
          const isBuy = (mode || 'buy') === 'buy';
          const leftLabel = isBuy ? '付出资产 (BTC)' : '发出代币 (MVC · 合约)';
          const leftVal = isBuy ? '-97,420 sat' : '-1.04842259 METAID';
          const leftSub = isBuy ? '含 PSBT 矿工费' : '自动发币给 AI_Kevin';
          const rightLabel = isBuy ? '收到代币 (BTC · ID-Coin)' : '净入账积分';
          const rightVal = isBuy ? '+1,000 METAID' : '+10.00 ME';
          const rightSub = isBuy ? '均价 97.4 sat / 枚' : '单价 9.538139 ME / 枚';
          const venue = isBuy
            ? '<span class="bdg bdg-btc">metaid.market · PSBT</span>'
            : '<span class="bdg bdg-me">✦ ME 积分交易</span>';
          return `
            <div class="tk-card compact">
              <div class="tk-top">
                <div class="tk-ident">
                  <div class="tk-avatar sm ${isBuy ? 'btc-grad' : 'mvc-grad'}">M</div>
                  <div class="tk-title-col">
                    <div class="tk-title-line">
                      <span class="tk-symbol">${isBuy ? '买入成交回执' : '挂单售出回执'}</span>
                      <span class="bdg bdg-up">✓ 成功</span>
                    </div>
                    <div class="tk-subline">${isBuy ? '连扫 3 包原子成交' : '后台 24h 自动验资交割'}</div>
                  </div>
                </div>
                ${venue}
              </div>

              <div class="flow-dual num">
                <div class="flow-box">
                  <div class="bento-label">${leftLabel}</div>
                  <div class="bento-val" title="${leftVal}">${leftVal}</div>
                  <div class="bento-sub">${leftSub}</div>
                </div>
                <div class="flow-arrow">→</div>
                <div class="flow-box" style="border:1px solid var(--up-border);">
                  <div class="bento-label">${rightLabel}</div>
                  <div class="bento-val" style="color:var(--up);" title="${rightVal}">${rightVal}</div>
                  <div class="bento-sub">${rightSub}</div>
                </div>
              </div>

              <div class="ledger-box num" style="padding:7px 10px;">
                <div class="ledger-row">
                  <span class="ledger-k">链上凭证</span>
                  <span class="ledger-v mono">${isBuy ? 'Tx 9f3a…81c2 (共3笔) 复制' : 'MVC Tx 7d1e…49a0 复制'}</span>
                </div>
              </div>

              <div class="chip-row">
                <button class="chip-btn">${isBuy ? '用代币逛好物' : '继续上架'}</button>
                <button class="chip-btn">${isBuy ? '查看持仓' : '查看积分余额'}</button>
              </div>
            </div>
          `;
        }
      }
    ]
  },

  {
    id: 'my-orders',
    kicker: '场景 4 · 现有能力新卡片化（替代 my-orders 纯文本输出）',
    title: '我的挂单列表管理卡（My Active Orders）',
    desc: '你专门点名的场景：把散落在 BTC metaid.market (PSBT)、MVC 链上合约、ME 积分交易三个渠道的当前在售挂单聚合在一张卡里，每笔标清链格式、进度并支持直接撤单。',
    variants: [
      {
        code: 'O1',
        name: '方案 O1：紧凑工单直列版（一屏看全跨链挂单 + 逐笔秒撤）',
        summary: '每笔挂单是一个紧凑双层内嵌块：上行看「币种 + 链格式 + 交易方式 + 单价」，下行看「已售包数进度条 + 撤单按钮」，效率最高。',
        userMsg: '看看我现在有哪些正在挂着卖的单子',
        botLead: '你当前共有 3 批在售挂单（跨 3 个交易渠道）：',
        render: () => `
          <div class="tk-card">
            <div class="tk-top">
              <div class="tk-ident">
                <div class="tk-avatar sm dual-grad">挂</div>
                <div class="tk-title-col">
                  <div class="tk-title-line">
                    <span class="tk-symbol">我的在售挂单</span>
                    <span class="bdg bdg-brand num">3 批进行中</span>
                  </div>
                  <div class="tk-subline num">在售剩余总估值 ≈ $412.80</div>
                </div>
              </div>
              <button class="btn-mini">刷新</button>
            </div>

            <div class="row-list num">
              <div class="prog-strip">
                <div class="row-title" style="justify-content:space-between;">
                  <span style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;">
                    <strong>$METAID</strong>
                    <span class="bdg bdg-mvc">MVC·合约</span>
                    <span class="bdg bdg-me">✦ ME 积分</span>
                  </span>
                  <span style="font-weight:700;">9.54 ME / 枚</span>
                </div>
                <div class="prog-top" style="color:var(--text-2);">
                  <span>已售 2/5 包 · 剩 600 枚</span>
                  <button class="btn-mini">撤回剩余</button>
                </div>
                <div class="prog-track"><div class="prog-fill" style="width:40%"></div></div>
              </div>

              <div class="prog-strip">
                <div class="row-title" style="justify-content:space-between;">
                  <span style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;">
                    <strong>$METAID</strong>
                    <span class="bdg bdg-btc">BTC·ID-Coin</span>
                    <span class="bdg bdg-btc">PSBT</span>
                  </span>
                  <span style="font-weight:700;">1,580 sat / 枚</span>
                </div>
                <div class="prog-top" style="color:var(--text-2);">
                  <span>整包 200 枚 · metaid.market</span>
                  <button class="btn-mini">撤单解锁</button>
                </div>
                <div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>
              </div>

              <div class="prog-strip">
                <div class="row-title" style="justify-content:space-between;">
                  <span style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;">
                    <strong>$MSP</strong>
                    <span class="bdg bdg-mvc">MVC·合约</span>
                    <span class="bdg bdg-mvc">TokenSell</span>
                  </span>
                  <span style="font-weight:700;">0.12 SPACE / 枚</span>
                </div>
                <div class="prog-top" style="color:var(--text-2);">
                  <span>已售 3/4 包 · 剩 1,000 枚</span>
                  <button class="btn-mini">撤回剩余</button>
                </div>
                <div class="prog-track"><div class="prog-fill" style="width:75%"></div></div>
              </div>
            </div>

            <div class="btn-row">
              <button class="btn-secondary">全部撤单</button>
              <button class="btn-primary">+ 新增挂牌</button>
            </div>
          </div>
        `
      },
      {
        code: 'O2',
        name: '方案 O2：顶部业绩汇总 + 渠道筛选分组版',
        summary: '顶部双格展示「在售批次」与「累计已回笼收益」，支持按渠道小标签筛选，并明确提示不同渠道撤单是否消耗链上 Gas。',
        userMsg: '看看我现在有哪些正在挂着卖的单子',
        botLead: '已汇总你的挂单状态与回笼收益：',
        render: () => `
          <div class="tk-card">
            <div class="tk-top">
              <div class="tk-title-col">
                <div class="tk-title-line">
                  <span class="tk-symbol">挂单席位管理</span>
                  <span class="bdg bdg-up">⚡ AI 值守正常</span>
                </div>
                <div class="tk-subline">跨链订单统一监控 · 被买自动通知</div>
              </div>
            </div>

            <div class="bento-2 num">
              <div class="bento-cell">
                <div class="bento-label">在售挂单估值</div>
                <div class="bento-val">≈ $412.80</div>
                <div class="bento-sub">共 3 批 · 6 包未成交</div>
              </div>
              <div class="bento-cell">
                <div class="bento-label">本批已回笼资金</div>
                <div class="bento-val" style="color:var(--up);">+3,816 ME</div>
                <div class="bento-sub">外加 +360 SPACE</div>
              </div>
            </div>

            <div class="mini-tabs">
              <button class="mini-tab active">全部 (3)</button>
              <button class="mini-tab">✦ ME 积分 (1)</button>
              <button class="mini-tab">₿ BTC PSBT (1)</button>
              <button class="mini-tab">◈ MVC 合约 (1)</button>
            </div>

            <div class="row-list num">
              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span>$METAID · 剩 3/5 包</span>
                    <span class="bdg bdg-me">ME 积分</span>
                  </div>
                  <div class="row-meta">MVC 合约 · 9.54 ME/枚 · 免 Gas 秒撤</div>
                </div>
                <button class="btn-mini">撤单</button>
              </div>
              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span>$METAID · 200 枚整包</span>
                    <span class="bdg bdg-btc">BTC·PSBT</span>
                  </div>
                  <div class="row-meta">BTC ID-Coin · 1,580 sat/枚 · 撤单解锁 UTXO</div>
                </div>
                <button class="btn-mini">撤单</button>
              </div>
              <div class="row-item">
                <div class="row-left">
                  <div class="row-title">
                    <span>$MSP · 剩 1/4 包</span>
                    <span class="bdg bdg-mvc">MVC·合约</span>
                  </div>
                  <div class="row-meta">MVC 合约 · 0.12 SPACE/枚 · 链上解约</div>
                </div>
                <button class="btn-mini">撤单</button>
              </div>
            </div>
          </div>
        `
      }
    ]
  }
];
