# 封面转换管线设计 v1
### MetaContract（旧版 NFT）→ MRC-721 兑换流水线的「图片转换」正式环节

- 版本：v1（2026-11-18）
- 作者：Avatar 兑换站（metabot#37，发行人 `176C9RPWDggnvdVcWG3wrZEJcm1bHTcKM5`）
- 适用：`metabot-avatar` 专辑（totalSupply 9560）；其余专辑按同一套参数化逻辑复用
- 实现：`cli/attach-cover.mjs`（管线环节）+ `cli/lib/cover-core.mjs`（唯一引擎）+ `cli/backfill-covers.mjs`（存量修补面）
- 本文状态：**设计 + dry-run 验证完成；真实批量执行需 owner 逐批批准**（本文不含任何真实上链写图）

---

## 0. 一句话结论

兑换流水线过去缺的不是「补图脚本」，而是**把旧图变成新图的一环**。本设计把这一环拆成三个可独立调度、可断点续跑、可单独计费的阶段（snapshot → preupload → attach），挂接在「金库收币之后、销毁之前」与「铸造完成之后」两个固定位置。缺图从此是**流程缺陷**（管线漏跑），不是可接受的常态。

---

## 1. 为什么必须做成管线环节

| 事实（实测） | 后果 |
|---|---|
| `item_desc` 只写 name/metadata、不写 cover 时，钱包显示无图 | 每枚兑换出来的新 NFT 都会缺图，除非铸造后补写 |
| 索引器有**发行人闸门**：非 collection 发行人签的 `item_desc` 被静默丢弃，只花手续费（AI_Sunny 两枚实证：`583a945b…`、`e8b97640…`） | 图片转换必须由发行人身份在管线内完成，不能外包给任意 bot |
| 旧图 URL 只存在于**金库持仓行**（wallet-api `nft/utxo-list` 的 `imgUrl`） | 旧币销毁后该行消失 → 图**不可再取**（见 §3） |
| 旧图路径是内容哈希（`…/metafile/compress/8bdc14cb….png`），**不能**由 genesis+tokenIndex 推导 | 「按编号猜 URL」这条退路不存在（唯一实测样本已证伪） |

因此，「图片转换」必须发生在**旧币还在金库里的那段窗口**，并写进铸造后的固定动作。逐张事后补，等于把不可逆的时间窗口交给运气。

---

## 2. 管线架构（文本版）

```
                    ┌──────────────────────────── 兑换流水线（swap engine） ────────────────────────────┐
                    │                                                                                    │
 用户转旧币 ──▶ ① vault-poll  ──▶ ② verify-claim ──▶ ③ mint-and-send ──▶ ④ 发货 ──▶ ⑤ burn-batch ──▶ 黑洞
 (MetaContract)   检测入账         三元组验真          铸造 MRC-721         转给用户      销毁旧币
                    │                                   │                                  │
                    │  ★ A. snapshot（本设计）           │  ★ C. attach（本设计）            │  ★ B. 兜底快照
                    ▼                                   ▼                                  ▼
             旧图取数（免费）                     item_desc 写 cover+desc            销毁前再查一次：
             imgUrl → 下载 → PNG 门 → sha256     （发行人身份，1 笔写链）              catalog 已有则跳过
                    │                                   ▲
                    └──── catalog（本地账本） ──────────┘
                              │
                              └──▶ ★ preupload（可选，1 笔写链）：图先上链拿 metafile pin
```

**图片转换环节的挂接位置（三条，按优先级）：**

| 标签 | 时机 | 动作 | 上链 | 费用 |
|---|---|---|---|---|
| **A. snapshot** | ① vault-poll 检测到入账后（**销毁前必须完成**） | 取 `imgUrl` → 下载 → PNG magic/IHDR 校验 → sha256 → 写 catalog | 否 | 0 |
| **B. 兜底快照** | ⑤ burn-batch 执行前，对批次内每个 tokenIndex | 若 catalog 无该枚 → 立刻 snapshot | 否 | 0 |
| **C. attach** | ③ mint-and-send 拿到 item pinId 后（同一事务链尾） | 以发行人身份写 `item_desc{ pinid, cover, desc }` → 轮询双视图确认 | 是 | ≈796 sats |
| （可选）preupload | A 之后任意时刻（可与 C 合并） | 图片上传拿 `metafile://` pin，供 C 直接引用 | 是 | ≈12,906 sats / 12.4 KB |

**硬规则（写入 SKILL.md）：**
1. **销毁前未 snapshot = 流程缺陷**。burn-batch 必须先跑 B，缺 snapshot 的条目不得进销毁批次。
2. **mint-and-send 返回前必须调用 C**。缺图条目不允许进入「已发货」状态。
3. 缺图（`cover` 为空）不再算可接受状态；出现即按事故复盘，而不是排进补图队列。

---

## 3. 取数时机：为什么必须是「销毁前快照」

### 3.1 事实

- 旧图唯一可用来源：金库地址 `1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET` 的 wallet-api v4 `mvc/address/contract/nft/utxo-list` 行内 `imgUrl`。
- 该行是 **UTXO 视图**：旧币一旦销毁（转黑洞），行即从列表消失。
- 已排查的「销毁后仍可查」路径（本次实测 2026-11-18）：
  - `GET /wallet-api/v4/mvc/contract/nft/info?genesis=&codehash=&tokenIndex=` → **404 page not found**
  - `GET /wallet-api/v4/mvc/contract/nft/genesis/{genesis}/tokenIndex/{n}` → **404 page not found**
  - `GET /wallet-api/v4/mvc/address/contract/nft/summary-list?address=<vault>` → 只有按 series 的计数（`count/totalSupply`），**不含 imgUrl**
- 结论：**没有**持币无关的旧图查询接口。图只能在旧币还在手里时取。

### 3.2 设计

- 主路径 A 在 vault-poll 命中后立刻 snapshot（免费，只读 + 本地落账）。
- 兜底 B 在 burn-batch 前对批次逐枚检查 catalog，缺失则当场 snapshot；**这是最后一道闸门**。
- 若两者都错过（历史遗留），`attach` 返回 `NO_LEGACY_IMAGE` 并拒绝写——**不猜、不构造 URL、不写占位图**。这类条目进人工清单，等外部来源（用户自备原图 / 旧钱包缓存）。

### 3.3 已被证伪的退路

有人会想「URL 里带 tokenIndex 吧？」——不。实测唯一一枚：
`…/metafile/compress/8bdc14cb3f4e0df9b6a0065df28877aa7397db4057a6c14626c47fbd082e41bc.png`
这段是内容哈希（与该图 sha256 `3c7a2b66…` 都不同），与 tokenIndex 2671 无任何算术关系。**不要**把 URL 推导写进代码。

---

## 4. 三阶段与幂等键

### 4.1 catalog（新增的本地账本）

`out/attach-cover/cover-catalog.jsonl`，追加写、按 `tokenIndex` 最后写入胜出（字段级合并，已上传/已写入的字段不会被后续行抹掉）。

每行的关键字段：

```jsonc
{ "tokenIndex": 2671,
  "phase": "snapshot|preupload|attached",
  "legacy": { "name": "...", "imgUrl": "...", "txId": "...", "txIndex": 0, "genesis": "...", "codeHash": "..." },
  "image":  { "bytes": 12437, "sha256": "3c7a…", "width": 128, "height": 128, "sourceUrl": "..." },
  "coverPinId": "…i0", "coverUri": "metafile://…i0",
  "itemPinId": "…i0", "itemDescPinId": "…i0",
  "sats": { "upload": 12906, "itemDesc": 796 },
  "sponsor": { "upload": {...}, "itemDesc": {...} },
  "dedupe": { "sha256": "…", "reusedFromTokenIndex": 1234 } }
```

### 4.2 幂等键（四层，缺一不可）

| 层 | 键 | 作用 |
|---|---|---|
| 业务 | `tokenIndex` | catalog 主键；同一编号永不重复建行 |
| 链 | `itemPinId` | `writes.jsonl` 主键；同一 item 永不重复写 item_desc |
| 内容 | `sha256(image bytes)` | 相同字节只上传一次；重复图直接复用已有 `metafile://` pin（0 费用） |
| 交易 | 本地 `writes.jsonl` | 广播成功但索引器未追平 → `SKIP_JOURNAL_PENDING`，不二次花钱 |

### 4.3 各阶段行为

**snapshot**（免费）
- 输入：`--tokens` 或 `--all`（= 全金库）
- 动作：resolve legacy → 下载 → https 强制 + 8 MiB 上限 + PNG magic `89504E47…` + IHDR 尺寸 → sha256
- 落账：`phase=snapshot`
- 失败：`LEGACY_NOT_IN_VAULT` / `IMAGE_FAILED`（保留原因，不写半真数据）

**preupload**（1 笔写链）
- 输入：catalog 里已有 image 但无 `coverPinId` 的行
- 动作：重新下载并要求 sha256 一致（`IMAGE_CHANGED` 则拒写）→ `upload-largefile` → `metafile://<pin>`
- 去重：命中 `sha256` 索引 → 直接复用，0 费用
- 落账：`phase=preupload`

**attach**（1 笔写链，铸造后立即调用）
- 输入：`--token N --item-pin <pinId>`（O(1)，不扫 collection）
- 动作：
  1. 已有非空 `cover` → `SKIP_HAS_COVER_AND_DESC` / `SKIP_HAS_COVER`（幂等）
  2. journal 有 `itemDescPinId` → `SKIP_JOURNAL_PENDING`
  3. cover 来源：catalog `coverPinId` → 否则现下载+上传（同样做 sha 去重）
  4. desc 由旧图名生成：`由 MetaContract「MetaBot Avatar」原系列 #N（Arms 8）1:1 兑换而来，封面即旧版原图。`
  5. 一次 `item_desc` 同时写 cover + desc（**一次到位**，不拆两笔）
  6. 轮询 `item/info` 的**明文视图**与 `confirmedOnly=1` 视图，两者都出现 cover 才算 `WRITTEN_VERIFIED`

---

## 5. 9560 枚批量调度

### 5.1 并发纪律

- **写链串行**：宿主 `create-pin` 在本地选 UTXO，并发写有双花/冲突风险 → 一律单并发。
- **读/下载可预取**：snapshot 阶段可并发（建议 4–8 并发），只读不花钱。
- 建议节奏：snapshot 全量一次跑完（约 9560 次下载，数小时）；preupload / attach 按批窗口串行推进。

### 5.2 批窗口与吞吐（估算）

单枚 attach 实测链路：下载 ~0.3–1 s + 上传 3–10 s + `create-pin` 1–3 s + 确认轮询 0–120 s（可配 `--wait-ms`）。
按 8–15 s/枚（轮询取 0）估算：

| 批次大小 | 预计耗时（串行） | 建议频率 |
|---|---|---|
| 100 枚 | 15–25 分钟 | 每日 |
| 500 枚 | 1.1–2 小时 | 每周 2–3 次 |
| 1000 枚 | 2.2–4 小时 | 夜间窗口 |

9560 枚全量 ≈ **21–40 小时** 纯写链时间，因此**必须分批**，且每批单独批准。

### 5.3 需要 owner 逐批批准的闸门（物理位置）

`attach-cover.mjs` 的真实写链需要**同时**满足三个条件，缺一即拒绝（exit 2，零花费）：

1. `--write`
2. `--max-sats N`（硬预算上限，逐笔累计，超限 `BUDGET_STOP` 并停止整批）
3. `--approval-id <id>`，且该 id 存在于 `out/attach-cover/approvals.json` 的 `approvals[]` 中，且 `--max-sats ≤ 该记录的 maxSats`

批准记录形如：

```json
{ "approvals": [
  { "id": "cover-batch-001", "maxSats": 1400000,
    "approvedAt": "2026-11-19T09:00:00+08:00",
    "note": "owner 批准第 1 批 100 枚 preupload+attach",
    "expiresAt": "2026-11-26T00:00:00+08:00" }
] }
```

**这个文件只能由 owner（或其代笔的 Twin）在明确批准后写入；bot 不会自批。** 缺记录时 CLI 会把该追加的 JSON 原样打印出来，等 owner 决定。

### 5.4 断点续跑

- 真值在 catalog，不在内存：任何中断（进程被杀、网络断、预算打满）后，重跑同一条命令即从断点继续。
- 已 `WRITTEN_VERIFIED` / `SKIP_*` 的行自动跳过；`--no-resume` 才重做（仅在确认 pin 被丢弃时用）。
- `batch-state.json` 记录上次运行的模式、预算消耗、累计计数，供巡检。

---

## 6. 费用预算表（按实测单价外推，标注上限）

### 6.1 实测单价（两笔真实回执）

| 项 | 实测值 | 来源 |
|---|---|---|
| `item_desc`（cover+desc） | **796 sats** | #2671，pin `737794496f8c4e246b26eabe22ca25450adba6342284f7a7ba31f9bdf86f1db4i0` |
| — sponsor 计费 | **16 me_milli（0.016 ME）**，`billed_by=me` | 同上回执 `SPONSOR paid: … points=0.016 me_milli=16` |
| 图片上传 12,437 B | **≈12,906 sats** | sponsor 实测一笔 12,437 B |
| 单枚合计（上传 + item_desc） | **≈13,702 sats** | 12,906 + 796 |

**ME 换算（单样本推断，服务端口径）**：796 sats → 16 me_milli ⇒ 1 ME ≈ 49,750 sats（≈50,000）。标注为推断，不是承诺价。

### 6.2 9560 枚外推

公式（1 sat/vB）：`总 sats ≈ N × (图片字节 + 469 交易信封 + item_desc 796)`

| 场景 | 单枚 sats | 9560 枚总 sats | ≈ SPACE | ≈ ME（按 50k sats/ME） |
|---|---|---|---|---|
| **A. 仅 item_desc**（图已在链上 / 去重命中） | 796 | 7,609,760 | 0.076 | ≈152 |
| **B. 实测口径**（12.4 KB 图 + item_desc） | 13,702 | **130,991,120** | **1.31** | **≈2,620** |
| **C. 上限假设**（图 50 KB） | 51,265 | 490,093,400 | 4.90 | ≈9,802 |
| **D. 极端假设**（图 100 KB） | 101,265 | 968,093,400 | 9.68 | ≈19,362 |

> 表中 B 为主口径；C/D 是「如果旧图比样本大 4×/8×」的压力测试，**不是预测**。真实分布要等 snapshot 全量跑完（免费）后用 `--audit` 出字节分布再收紧。
> 8 MiB 是单张图的**安全上限**，不是预算依据；任何单张接近该值的条目应单独复核。

### 6.3 sponsor 承受度与回退

| 通道 | 现状（2026-11-18） | 全量 9560 是否够 |
|---|---|---|
| sponsor（ME 积分） | 本 bot **2000 ME**（本周发放 2000，已用 0） | **不够**：B 口径需 ≈2,620 ME，缺口 ≈620 ME |
| 自付（Bot 钱包 MVC） | **83,970,784,423 sats ≈ 839.71 SPACE** | 够：B 口径 1.31 SPACE ≈ 余额的 0.16% |

- sponsor 不足时宿主按现有回退逻辑走自付；回执里会有 `sponsor.mode = sponsor-fallback-self-pay`（脚本原样上报，不吞）。
- **诚实提示**：按周发放 2000 ME 计，即使全部走 sponsor，每周最多覆盖 ≈7,290 枚（B 口径），全量需 2 周以上；若要一次性推进，需 owner 决定「充值 ME」或「接受自付 1.31 SPACE」。

### 6.4 与现有费用上限的冲突（必须 owner 裁定）

PRD 的 `perSwapFeeCeilingSats = 5000` 只覆盖铸造/转账。**图片转换单枚 ≈13,702 sats，是它的 2.74 倍。**
→ 该上限不含图片环节。要么为图片环节单列预算（推荐：按批批准，见 §5.3），要么修订上限。**本设计不擅自改上限。**

---

## 7. 失败重试与断点续跑

### 7.1 重试纪律（钱与只读分开）

| 操作 | 自动重试 | 理由 |
|---|---|---|
| 读 collection / vault / item_info / 下载图片 | 3 次，指数退避（0.8s×n） | 只读幂等，重试零成本 |
| `upload-largefile` | **不自动重试**，一次失败即 `UPLOAD_FAILED` | 可能已计费/已上链；盲重试会重复花钱 |
| `create-pin`（item_desc） | **不自动重试**，失败即 `WRITE_FAILED` 并留 journal | 广播可能已成功；靠 journal + 索引器核对 |
| 确认轮询 | 不重试，按 `--wait-ms` 预算轮询 | 超时是 `WRITTEN_UNVERIFIED`，不是失败重写 |

### 7.2 模糊态处理（最重要的安全设计）

- `WRITTEN_UNVERIFIED`：pin 已广播但双视图未同时出现 → **不重写**，下一次运行靠 journal 命中 `SKIP_JOURNAL_PENDING`。
- 上传成功但 item_desc 失败 → journal 记下 `coverPinId`，重跑**复用**该 pin，不二次上传（省 12,906 sats）。
- `IMAGE_CHANGED`（下载字节与快照 sha256 不一致）→ 拒写并报错，绝不把错的图写进链。

### 7.3 熔断

- `--max-consecutive-failures N`（默认 3）：连续失败达阈值即 `CIRCUIT_OPEN` 停止整批，避免「批量刷错误」。
- `--max-sats`：逐笔累计，下一笔会超限即 `BUDGET_STOP`，不做「差一点点也写完」。

---

## 8. 验收口径（怎么证明一枚真的带图）

一次成功的 attach 必须同时满足：

1. `item_desc` pin 存在且作者 = 发行人地址；
2. `item/info` **明文视图** `cover == metafile://<pin>`；
3. `item/info?confirmedOnly=1`（跳过 overlay，只读确认库）**同样** `cover ==` 该值；
4. `desc` 非空且含旧系列编号。

> 不要等 `descConfirmed` 变 true —— metaso 的该字段只在 overlay 填充时出现且恒为 false，确认库反而省略它。以 `confirmedOnly=1` 的双视图一致为准。

---

## 9. 已知边界与未验证项（诚实清单）

1. **上传与 item_desc 的真实写链路径本轮未执行**（遵守零上链约束）。两笔实测（796 / 12,906 sats）来自此前的单枚作业，不是本 CLI 回执。
2. **旧图字节分布未知**：目前只有 1 个样本（12,437 B / 128×128）。全量费用区间要等 snapshot 跑完才有真实分布。
3. **ME↔sats 换算来自单样本反推**，服务端可能随时调整。
4. **`mint-and-send` 尚未实现**：本设计给出挂接契约（`attachCoverForToken()` 或一行 CLI），M1 落地时接入并做一次真实铸造验证。
5. **销毁后无补救**：这是设计约束，不是待办。历史已销毁且未快照的条目只能走人工。
6. 本设计只覆盖 `metabot-avatar`；其他专辑需换 genesis/collection/vault 三个参数并重新验闸门。

---

## 10. owner 需要批准的事（按顺序）

| # | 事项 | 需要 owner 做什么 |
|---|---|---|
| 1 | 接受本设计为管线正式环节 | 确认 §2 的三条硬规则进 SKILL.md |
| 2 | 图片环节的费用上限 | 裁定：按批批准（推荐）还是修订 `perSwapFeeCeilingSats` |
| 3 | sponsor vs 自付 | 充值 ME，或书面接受自付（B 口径 ≈1.31 SPACE） |
| 4 | 第 1 批真实执行 | 在 `approvals.json` 写入 `cover-batch-001`（建议先 10 枚试跑，再 100 枚） |
| 5 | M1 接入 | `mint-and-send` 实现时把 attach 作为返回前必经步骤 |

---

## 附：命令速查

```bash
# 存量修补（已铸造、缺图）— 只读计划
node cli/backfill-covers.mjs --scan

# 管线阶段（全部默认 dry-run，零上链）
node cli/attach-cover.mjs --snapshot --all                 # 免费：全金库旧图快照
node cli/attach-cover.mjs --preupload --all                # 计划上传（打印费用）
node cli/attach-cover.mjs --attach --token 2671 --dry-run  # 单枚计划 / 幂等跳过
node cli/attach-cover.mjs --audit                          # 覆盖率报告（免费）

# 铸造后一行接入（M1 用）
node cli/attach-cover.mjs --attach --token <N> --item-pin <itemPinId> \
     --write --max-sats 15000 --approval-id cover-batch-00X

# 真实批量（需 approvals.json 中对应记录）
node cli/attach-cover.mjs --preupload --all --write --max-sats 1400000 --approval-id cover-batch-001
node cli/attach-cover.mjs --attach --all --write --max-sats 800000 --approval-id cover-batch-001 --limit 100
```
