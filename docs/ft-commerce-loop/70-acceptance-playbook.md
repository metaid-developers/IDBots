# 主控中心端到端验收标准与实弹演练手册（70-Acceptance Playbook）

本文件供主控 Session（总指挥中心）在 `WS-1 ~ WS-5` 各子开发分支提交合并请求后执行统一验收使用。严格执行仓库 **Delivery Loop** 铁律：**所有分支必须在合入 `main` 后，于 `main` 工作区跑通无色码编译与测试并留存证据，方可判定交付完成并清理对应 worktree。**

---

## 一、工程与架构基础硬门禁（每个子分支必过）

| 门禁编号 | 检查项 | 适用范围 | 判定标准 |
|---|---|---|---|
| **G-01** | 编译与类型检查零错误 | IDBots / MetaSo / ABS / Skill | IDBots: `tsc --noEmit && pnpm run compile:electron` 退出码 `0`；<br>MetaSo & ABS: `go build ./...` 退出码 `0`；<br>Broker Skill: `esbuild` 单文件打包零外部运行时依赖 |
| **G-02** | 无色码全量回归测试 | 全部仓库 | `NO_COLOR=1 FORCE_COLOR=0` 下新增单测 100% 通过，存量测试零新增红灯 |
| **G-03** | `.gitignore` 白名单完整性 | IDBots | 所有新增 `docs/*`、`tests/*`、`METAAPPs/*` 均已添加显式 `!` 放行条目，`git status --ignored` 无遗漏目标文件 |
| **G-04** | Windows 句柄安全清理与 DB 幂等迁移 | IDBots / ABS | SQLite 测试一律先 `close()` 再容错删除目录；新增表（`ft_active_orders`、`paybuzz_*`、`tb_me_ft_trade_order`）在旧库升级首次启动零报错 |
| **G-05** | 精确大整数金额纪律 | 全部仓库 | 任何代币 base-unit、BTC/SPACE `sats`、`milli-ME` 严禁使用 IEEE-754 浮点数做乘除加减后直接入账签名，必须使用 `BigInt` / `Decimal` / `math/big` |
| **G-06** | 薄宿主与合规文案红线 | IDBots / Skill / 海报 | 客户端无中心化“交易所”导航栏；分享海报与默认话术零出现“会涨/暴涨/翻倍/稳赚/早买早赚”禁用词；开发日志 Buzz 严禁误用官方根身份 `bob` 发送 |

---

## 二、链上资产安全与反欺诈专项门禁（Security Redlines）

合流验收时必须逐项通过以下 6 条对抗性测试：

1. **S-01 防同名假币李鬼攻击（Ticker Spoofing）**：在链上存在同名假 `METAID`（不同 `mrc20Id` 或不同 `genesis`）时，用假币向卖家支付购买数字商品、解锁付费文章或充当 ABS 托管交割 —— **核验器比对完整 `assetKey` 不匹配，必须 100% 拒收拒发**。
2. **S-02 防 MRC-20 失败转账回退欺诈**：构造一笔输入余额不足导致 `man-p2p` 执行 `sendAllAmountToFirstOutput` 退回发送方自己的链上交易 `txId` 提交给 ABS `/v1/me/ft-escrow/orders/:id/deliver` 或 `PayReadFulfillDaemon` —— **因 `man-p2p` 中接收方无有效 `Available / TransferPendingIn` 入账记录，必须 100% 拦截拒付**。
3. **S-03 防 PSBT / TokenSell 偷梁换柱签名**：模拟恶意市场接口返回篡改了卖方收款金额或输入资产 UTXO 的 PSBT，或假报低价的 `TokenSell` 四元组 —— **签名前本地字节级校验必须立即抛错中止，私钥签名次数为 `0`**。
4. **S-04 防单次授权令牌（`mandateToken`）越权超支**：技能拿到批准预算上限 `0.01 BTC` 的 `mandateToken` 后，试图累计签出 `0.0101 BTC` 或换签另一种代币 —— **宿主 `ftMandateGateService` 必须硬拦截拒绝**。
5. **S-05 防积分白嫖与免费池套现**：仅含免费 `grant/bonus` 积分的账户调 `/v1/me/ft-escrow/orders` 必须返回 `INSUFFICIENT_ME (tradePoolOnly: true)`；买方直接调 `/v1/me/release` 必须返回 `403 ESCROW_GOVERNED_BY_SERVER`；`ComputeConservation()` 误差恒为 `0`。
6. **S-06 防同一笔 `paymentTxId` 双重消费**：拿同一笔真实的链上打币 `txId` 同时请求结算两张订单或解锁两篇付费文章 —— **第二笔请求必须被数据库唯一键硬拦截**。

---

## 三、五大端到端实弹验收剧本（M1 & M2 里程碑）

### 剧本 E2E-1：老用户一句话智能拆包挂单 + 社群裂变海报 + 成交手机通知
1. 老用户 TwinBot 安装链上技能 `metabot-token-broker`，钱包持有单颗大额 `$METAID`（或测试 FT）。
2. 用户输入：“把我钱包里的 `$METAID` 拿出 1000 个卖掉，按容易成交的小包挂出去，支持收积分自动发货（或挂 `metaid.market` / MVC 链上单）”。
3. **验证点**：TwinBot 给出合理的拆包建议并弹出 **1 张** `FtMandateConfirmModal`；用户点 1 次确认后自动完成拆包与挂牌，对话流渲染出带进度条的 `ft-order-card`，点击「生成社群推销海报」成功导出合规归因分享卡。

### 剧本 E2E-2：买方预算约束背包凑单扫货（Smart Sweep）与差额直充买币
1. 市场上存在多笔不同面额挂单（含一笔超预算大单）。
2. 买家输入：“总预算 0.01 BTC（或 100 ME），帮我把市面上划算的 `$METAID` 都收了”。
3. **验证点**：TwinBot 展示 `ft-quote-card` 三端比价，自动跳过超预算整包大单、精准组合吃下多笔小单（若选 ME 且积分不足，原地扫码充值自动续跑），总花费含矿工费严格不超预算；卖家零人工点击自动发币，且卖家手机收到 FCM Push 成交通知！

### 剧本 E2E-3（实用标杆 1）：持币老用户用 `$METAID` 直接秒买数字商品权益卡
1. 店主将一件「AI 实战专栏权益卡」挂牌支持 `200 $METAID` 购买。
2. 买家输入：“用我的 `$METAID` 买一张他的专栏权益卡”。
3. **验证点**：单次确认后数秒内完成链上代币支付与 MRC-721 权益卡自动过户（MVC 同链走单笔原子互换，BTC MRC-20 走 5 分钟排他锁 + `man-p2p` 验链秒发），买家立即收到数字商品。

### 剧本 E2E-4（实用标杆 2A）：持刚买的专栏权益卡 0 元秒开加密长文
1. 承接 E2E-3，已持有该专栏权益卡的买家打开作者发布的 `/protocols/paybuzz` 加密文章卡，点击「解锁阅读全文」。
2. **验证点**：无需花一分钱或唤醒作者大模型，作者 `PayReadFulfillDaemon` 毫秒级验真持卡身份并自动通过加密私聊下发密钥，买家右侧 Showcase 瞬间展开 6,000 字完整排版长文。

### 剧本 E2E-5（实用标杆 2B）：无卡路人花 `10 $METAID` 微支付秒开加密长文
1. 未持卡的另一位用户点击同一篇加密文章，选择「支付 10 $METAID 单篇解锁」。
2. **验证点**：链上转出 `10 $METAID` 后作者守护进程经 `man-p2p` / `higun` 核验无误，自动下发密钥秒开全文；刷新或断网重开直接命中本地已购缓存秒开。
