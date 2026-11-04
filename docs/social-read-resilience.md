# 社交读路径：基址清单与回退顺序

2026-11-01 起，原 social 服务层（show.now / man.metaid.io）整体下线（man.metaid.io 全站 502；
show.now 301 → www.show.now 504，两台机器交叉验证）。IDBots 的社交读路径改为
**有序基址列表 + 逐级回退**，修复原则（BOT-009 补充验收 #7）：把「单点依赖 show.now」
修成「单点依赖聚合层」是同一个 bug 换地址，不允许。

## 宿主 omni_read（`src/main/libs/omniReaderAgentTools.ts`）

| action | 级 1（聚合层） | 级 2（链上直读，manapi 控制面） | 级 3（终态） |
| --- | --- | --- | --- |
| `buzz_newest` | `so.metaid.io /api/social/feed`（cursor 分页） | `api/pin/path/list?path=/protocols/simplebuzz`（全量）或 `api/metaid/pin/list/{metaid}`（publisher 流）——原始 pin 行，counts=`"unavailable"` | 显式 isError，**两级失败都点名** |
| `buzz_recommended` | `/api/social/feed?sort=hot`（降级声明 `_degraded`） | 无（个性化/热度排名无法从裸 pin 重建） | 显式 isError |
| `buzz_hot` | `/api/social/feed?sort=hot` | 无（同上） | 显式 isError |
| `buzz_search` | `/api/social/feed?keyword=` | 无（manapi 无内容关键词检索） | 显式 isError |
| `buzz_info` | `/api/social/post/{pinId}`（未覆盖 pin 返回 `code:40400` = 显式未知） | `api/pin/{pinId}` 原始 pin，counts=`"unavailable"` | 显式 isError，两级都点名 |
| `notifications` | `/api/metaweb/interactions`（收件箱降级，`_degraded`） | 无（收件箱是聚合层构造） | 显式 isError |
| `followers` / `following` | `/api/social/globalmetaid/{id}/followers|following` | 无（关注图不在 pin 控制面） | 显式 isError |

- **级 1 基址列表**：环境变量 `IDBOTS_SOCIAL_AGG_BASES`（逗号分隔、按序），
  默认 `https://so.metaid.io`。聚合层将来增设镜像时，改环境变量即可，不改代码。
- **各级失败表现**：级 1 单基地址失败 → 试列表内下一个基地址；级 1 整体失败且存在级 2 →
  级 2 数据带 `_degraded` 说明 + counts=`"unavailable"`（机检未知，见下）；级 2 也失败 →
  `isError` 文本同时点名两级（例：`aggregation layer (https://so.metaid.io) unreachable: …;
  chain fallback manapi pins_by_path also failed: …`）。**任何一级都不制造空列表**——
  「读不到」与「没有数据」是两个事实。

## 内置 buzz-app（`METAAPPs/buzz/`）

| 读取 | 级 1（social_agg） | 级 2（metaid_man 链上直读） | 级 3（终态） |
| --- | --- | --- | --- |
| 最新流 | `/api/social/feed` | `/api/pin/path/list?path=/protocols/simplebuzz` | 抛错 → UI「获取动态失败」错误态 |
| 个人流 | `/api/social/feed?publisher=` | `/api/metaid/pin/list/{metaid}?path=` | 同上 |
| 热门/推荐/关注流 | `/api/social/feed`（推荐=hot+黄条声明） | 无（排名/关注图为聚合层构造） | 同上 |
| 帖子详情/引用/评论 | `/api/social/post/{pinId}[/comments]` | 原始 pin（详情路径既有 manapi 兜底） | 错误态 |
| 关注者/关注中 | `/api/social/globalmetaid/{id}/…` | 无 | 错误态 |

- 链上直读命中时置 `buzz.tabs[tab].chainFallback=true`，页面顶部黄条声明
  （`buzz.list.degradedChain`：「社交聚合层暂不可达，正在展示链上原始动态——互动计数未知（—），非零」）。
- `ServiceLocator`：`social_agg`（聚合层主基址）、`metaid_man`/`man_api`（manapi 控制面）。

## 「未知」的机检口径（BOT-009 #9）

- 数据层未知 = 字符串 `"unavailable"`，**不是 null**（null 会被前端 `|| 0` 静默吞成 0），
  也不是 0。断言写法：`value === 'unavailable'` ⇔ 未知；`null`/`0`/缺字段一律不算未知。
- 聚合层原生响应：覆盖内 pin 的 counts 恒为数值（真实 0 也是 0）；未覆盖 pin 的详情读返回
  `{"code":40400,"message":"social post not found"}`（整个载荷无 counts，是显式未知态）。
- 级 2（链上直读）载荷：counts 字段由宿主显式写为 `"unavailable"`。
- UI 渲染：未知 →「—」；真实 0 →「0」。

## 双机验证方法（BOT-009 承诺的交叉复验）

1. **静态检查——功能性 URL 零残留**（两台机器各自跑，scheme 限定，注释不算）：

   ```bash
   cd /path/to/IDBots
   git switch fix/social-read-single-point   # 或合并后的 main
   grep -rEn "https?://(www\.)?show\.now" src/main/libs/omniReaderAgentTools.ts METAAPPs/buzz/ && echo "FAIL: dead base found" || echo "PASS: no show.now request URL"
   grep -rEn "https?://(www\.)?show\.now|https?://man\.metaid\.io" src/main/libs/omniReaderAgentTools.ts METAAPPs/buzz/ && echo "FAIL" || echo "PASS: neither dead base appears as a request URL"
   ```

2. **运行时检查——实际发出的请求全记录**（用编译产物实弹打一发 buzz_newest，
   打印本次发出的每一个 URL 并断言零触碰死基址）：

   ```bash
   pnpm run compile:electron
   node -e "
   const { buildOmniReaderAgentTools } = require('./dist-electron/main/libs/omniReaderAgentTools.js');
   const calls = [];
   const control = {
     fetchJson: async (u) => { calls.push(u); const r = await fetch(u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
     fetchText: async (u) => { calls.push(u); return (await fetch(u)).text(); },
   };
   const omni = buildOmniReaderAgentTools({ tool: (n, d, s, h) => ({ h }), control })[0].h;
   omni({ action: 'buzz_newest', size: 3 }).then(() => {
     console.log('requested URLs:', calls);
     const bad = calls.filter((u) => /show\\.now|man\\.metaid\\.io/.test(u));
     console.log(bad.length === 0 ? 'PASS: no dead-base request' : 'FAIL: ' + bad.join(', '));
     process.exit(bad.length === 0 ? 0 : 1);
   });
   "
   ```

3. **buzz-app 运行时检查**：应用内打开 DevTools → Network → 过滤 `show.now`（及 `man.metaid.io`）
   → 刷新/切四个 tab → 请求计数应为 0；`so.metaid.io` 请求可见。

## 离线阴性测试（BOT-009 #8，进 CI）

- 宿主：`tests/omniReaderAgentTools.test.mjs`
  ——桩注入逐 URL 失败（等价于把基址指向必失败地址；不触网、不依赖真实故障）：
  a) 回退命中级 2 且返回真数据；b) `_degraded`/counts=`"unavailable"` 可机检；
  c) 两级全挂 → isError 同时点名两级；排名类读取无级 2 → 直接显式错误。
- buzz-app：`tests/buzzAppSocialSources.test.mjs` ——social_agg 桩抛错 → 断言回退到
  metaid_man 链上端点、`chainFallback` 置位、counts=`"unavailable"`；全链挂 → 命令 reject
  （UI 既有 fetchFailed 错误态渲染，不出现空列表冒充「无内容」）。
