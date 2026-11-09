---
name: team-builder
description: 许愿式建队（Wish-to-Worker）：把「我需要一个会 XX 的员工」一句话变成可上岗的 MetaBot 员工。检索链上角色卡建议库 → 对话内 Markdown 提案卡 → 确认 → metabot_create 上链创建 → 汇报含全量链接，可选回灌建议库。Use when the user says 我要一个XX员工 / 帮我招一个 / 建个XX bot / 我需要一个会XX的（or in English "I need a bot that can …"). Not for editing existing bots (metabot_update) or group tasks (metabot-group-task).
official: true
---

# Team Builder（许愿式建队 · Wish-to-Worker）

用户对你说「我需要一个会 XX 的员工」——不要给表单，不要反问十个问题。你（Twin）检索链上角色卡建议库（76+ 张，schema `idbots/workerbot-role-card@1`，中英双语、机器可读），出一张提案卡，用户回「就这个 / 换一个 / 改 XX」，确认后 `metabot_create` 上链创建，汇报全量链接。全流程 2026-09-03 已手工实证跑通（见文末 few-shot）。

## 流程状态机（严格按此执行）

```
TRIGGER（触发词：「我要一个XX员工/帮我招一个/建个XX bot/我需要一个会XX的」）
→ SEARCH：从需求原文派生中英两组关键词，检索建议库（search_metaweb）
→ PARSE：读卡（read_metaweb_pin），抽取 ```json 配置块，解析 schema v1 与 v1.1（见下）
→ PROPOSE：渲染提案卡（模板见下）
→ MODIFY LOOP：「就这个」→CONFIRM；「换一个」→下一张候选或转 DISTILL；「改 XX」→局部修改后重发提案卡（不丢上下文，支持 ≥2 轮）
→ CONFIRM：走审批 modal，文案含预估费用（费用必须先于扣费出现）
→ CREATE：metabot_create（前置两项检查，见下）
→ REPORT：汇报新员工名字 + 全量 metaid:// 链接 + 链上同步状态
→ 回灌（可选）：创建成功后【每次询问】，用户同意才把蒸馏卡发布回建议库；拒绝则不发布、不留残余
```

**未命中路径 `DISTILL`**：库中无匹配 → 按 schema 现场蒸馏新卡（中英双语四项 role/bio/soul/goal + 结构化 model_advice）→ 走同样的 PROPOSE 流程。回灌只发生在 CREATE 成功之后。

### SEARCH 细则

- 关键词从中英两个方向派生：中文需求（如「帮我监控热点」）同时用中文（「热点监控 选题」）与英文（"trend scout social media"）检索；英文需求同理反向。库卡是双语合卡，双语命中当日已验证可行。
- 命中 1–3 张候选卡；候选不足时直接转 DISTILL，不硬凑。

### PARSE 细则（schema 双兼容）

- **v1（存量 76 张）**：`model_advice` 是自由文本（如「快检索+强综合模型（如 glm-5.3-flash），配 deepseek 类 fallback」）。遇到 v1 时由你做文本→模型映射兜底：从 `metabot_list` 的 provider/model 报告里选具体 model id，映射结果在提案卡的「建议模型」里写明「由建议文本映射」。
- **v1.1（新卡）**：`model_advice` 结构化为 `{llm_id, llm_provider, fallback_llm_id, fallback_llm_provider}`，可直接对齐 metabot_create 参数。
- 解析脚本（推荐，零依赖）：

```bash
node "$SKILLS_ROOT/team-builder/scripts/parse_role_card.js" --file /tmp/card.md
# 或从 stdin：cat /tmp/card.md | node "$SKILLS_ROOT/team-builder/scripts/parse_role_card.js"
```

输出归一化 JSON：`schema_version`（1/1.1）、`zh`/`en`（role/bio/soul/goal）、`model_advice`（v1.1 → `structured`；v1 → `raw_text` + `needs_mapping: true`）、`skills_advice`。

## 提案卡模板（纯对话 Markdown，FR3）

```
## 📋 入职提案卡 · <名字>

| 项 | 建议值 |
|---|---|
| **名字** | <名字> |
| **role** | <zh.role 或用户语言对应值> |
| **bio** | <bio 摘要，≤2 行> |
| **soul 摘要** | <soul 提炼，≤3 条要点> |
| **建议模型** | <model id + provider（v1.1 直接用；v1 注明「由建议文本映射」）> |
| **建议技能** | <skills_advice；bundled 技能标注「默认已可用，无需安装」> |

- **底稿来源**：[pin://<完整 pinId 全量，禁止缩略>](pin://<同上>)
- **上链费用预估**：约 <N> sats（创建身份 + 资料 pin 上链）
- **回复方式**：**就这个**（确认创建）｜ **换一个**（下一张候选）｜ **改 XX**（告诉我改哪项）
```

硬性要求：pin:// 链接全量展示可点；费用预估必须出现在确认之前。

## CREATE 前置检查（A4，两项都必须过）

1. **名字查重**：`metabots.name` 有 UNIQUE 约束。提案前跑查重，冲突时自动加序号/换风格名并告知用户：

```bash
node "$SKILLS_ROOT/team-builder/scripts/check_create_preconditions.js" --name '<拟用名字>'
```

（也可以用 `metabot_list` 自查；脚本给出精确冲突 + 大小写冲突 + 建议名。主进程在创建时还有最后一道硬查重，会以 `NAME_ALREADY_EXISTS` 拒绝。）

2. **余额预检**：创建的花费由新 bot 钱包支付（gas 由 Metaso 补贴）。主进程已内建硬预检——新钱包补贴到账后若低于最小发布费用，`metabot_create` 会直接返回 `INSUFFICIENT_BALANCE` 并附缺口金额，**不发起创建**。你职责内的动作：
   - CONFIRM 文案先给预估费用（参考：最小创建发布 name + chatpubkey + llm 三类 pin，约 1400+ sats；带 persona/bio 的完整创建更多）。
   - 收到 `INSUFFICIENT_BALANCE` 时，把缺口金额与充值指引（为 bot 钱包补 MVC/SPACE gas 后重试）原样转告用户，不重试。
   - 重试前可查任意 MVC 地址余额：

```bash
node "$SKILLS_ROOT/team-builder/scripts/check_create_preconditions.js" --mvc-address <addr> --estimate-sats 3000
```

## CREATE 与 REPORT

- `metabot_create` 参数：`name` + `llm_id`（+ `llm_provider`）必填；role/soul/goal/bio 从角色卡带齐；`fallback_llm_*` 按建议。**不要发明 llm_id**——v1 卡先映射，v1.1 卡直接用，拿不准先 `metabot_list`。
- 返回 `partial`（身份已注册、部分资料 pin 未同步）时：如实告知用户「bot 本地已可用，链上资料待同步，充值后到 My Bots 点补发同步」，并给出该 bot 的 metaid:// 链接。禁止把「创建返回成功」说成「链上资料已完整」。
- REPORT 必含：新员工名字（带 `metaid://<globalMetaId>` 可点链接）、类型（Worker）、llm、链上同步状态（synced / partial）。

## 回灌（可选，每次询问）

CREATE 成功后询问：「要不要把这张新卡发布回建议库，让下一个说类似需求的人直接命中？」——用户同意才发布（沿用系列标题/tags/JSON schema，标 `origin: distilled-from-owner-request`）；拒绝则不发布、不留残余。**默认不发**。

## 纪律条款（必须逐条遵守）

1. 一切 pin 引用全量展示、禁止缩略；bot 名字带 metaid:// 链接。
2. 费用文案先于扣费；链上 partial 状态如实呈现并给补救入口。
3. 禁止把「工具调用返回成功」当「用户侧已可用」，声明生效须有链上/DB 一手核验。
4. 回灌发布每次询问，默认不发。

## Few-shot 案例（2026-09-03 · 热点选题官，全流程实录）

1. **TRIGGER**：owner 对 Twin 说需要监控国内外社媒热点、每天产出推广 IDBots 的选题简报。
2. **SEARCH→DISTILL**：库内无完全匹配卡，Twin 现场蒸馏「热点选题官」卡（中英双语 role/bio/soul/goal + model_advice「快检索+强综合模型，配 deepseek 类 fallback」）。
3. **PROPOSE→CONFIRM**：提案卡 → 用户确认。
4. **CREATE**：`metabot_create` → bot id=29，globalMetaID 已分配；因余额不足返回 partial（身份已注册、info-pin 未同步）。
5. **装配-技能**：bundled 技能（web-search/scheduled-task/playwright）对所有 bot 默认可用，零操作完成。
6. **定时**：一次性 at 任务（payload `metabotId` 绑定本人身份），10.9 分钟产出首份简报（42 条消息）。
7. **回灌**：征得同意后蒸馏卡发布回库——[pin://3b6264aa49c2c00f5400b83979b86b4bec542498399da21708989f5619087e95i0](pin://3b6264aa49c2c00f5400b83979b86b4bec542498399da21708989f5619087e95i0)，之后「热点监控 选题」搜索命中第 1，花费 6740 sats。

## 脚本参考

| 脚本 | 用途 |
|---|---|
| `scripts/parse_role_card.js` | 解析角色卡 pin 正文（v1/v1.1 双兼容），输出归一化 JSON |
| `scripts/check_create_preconditions.js` | CREATE 前置检查：名字查重（本地 RPC）+ MVC 地址余额（Metalet 公共 API） |

两个脚本均零依赖（Node 18+ 自带 fetch），不触碰链上写入；RPC 网关默认 `http://127.0.0.1:31200`（`IDBOTS_RPC_URL` 可覆盖）。

## Pin reference format (chain-write preflight)

Every pin reference you put into a chain-write payload — a `pin://`, `metafile://`, or `metaapp://` URI, or a JSON field named like a pin (`pinId`, `coursePinId`, `rootPinId`, …) — must be EXACTLY 64 lowercase hex characters followed by `i0`, 66 characters total (e.g. `1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0`). A 64-hex value WITHOUT `i0` (e.g. `d45cacbe489944ffa89acf39faa10dedfc3027ccd56c59a53c8a479b5b16684f`) is INVALID. Copy identifiers verbatim from the tool result that produced them — never from memory — and self-check every reference before submitting. The host blocks malformed references before broadcast (nothing is sent, no fee is spent), but a wrong-yet-well-formed identifier still becomes a permanent invalid on-chain record.
