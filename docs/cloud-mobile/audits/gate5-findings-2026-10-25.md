# gate5 一手发现汇总（2026-10-25，Twin 验收实测）

来源：IDBots 移动端硬门一验收第 2 夜（证据目录 `/Users/tusm/idbots/project/bots/1/2026-10-25/gate5/`，README 有逐条脚本与截图索引）+ 第 3 回合增补（10-25 上午，同目录 `g5-5e/g5-6a..g5-6g`）。按优先级排列，供外部 Agent 工单合入。

## F-1（P1·控制面运维路径）租户 status=failed 是无自动恢复的终态

- 现象：对租户容器执行外部 `docker restart`，控制面探针恰在容器退出窗口探测，得到 `container exited (code 0)`，租户被置 `failed`（控制面 DB `tenants.last_error`，时间戳 2026-10-25 06:43:59+08）。此后一切 WS/HTTP 代理升级报 4013 "tenant is failed"。
- 根因链（cloud/control-plane 源码）：`statusMachine.nextStatus()` 对 `failed` 直接 stay（L97）；`reconcile.ts` 对 failed 跳过（L59）；`poller` 扫描列表不含 failed（L107）；`cli tenant.upgrade --all` 显式排除 failed。即**没有任何自动或批量路径能把 failed 翻回来**。
- 影响：任何运维级的容器重启（宿主机维护、OOM、docker daemon 重启）都可能把租户永久打停；真实用户表现为「永远连不上」。
- 建议修复：为 failed 增加恢复路径（poller 对 failed 也做健康探测，连续 N 次通过则翻回 booting；或提供 `tenant.recover` 命令），并把「外部 docker 操作」纳入告警。
- 现行受认可恢复操作（修复前）：容器内 CLI `node /app/dist/cli.js tenant start <tenantId> --as <operator>`（注意：容器内 dist 版 CLI 用空格分隔 `tenant start`，点号形式 `tenant.start` 会报 unknown command）。

## F-2（P2·移动端 UX）会话标题自动生成器提示词泄漏

- 现象：PWA 会话列表大量会话标题变成「We need answer only title. Need name chat session.」「We need answer only title, max 50 chars,」等——是标题生成器的系统提示词被当作标题原文写入库（租户 DB `cowork_sessions.title` 一手证据），用户自定义的会话首句反而看不到。
- 影响：多设备场景下用户无法靠标题辨认会话（本次验收 A-02 排查即被它误导）；观感差。
- 建议修复：标题生成的解析层加护栏（取生成结果的首行短语、剔除与提示词匹配的输出、失败时回退用户首句截断）。

## F-3（P2·移动端可靠性）静默断网下客户端连接僵尸化（范围修正：仅静默丢包路径）

- 现象：真机断网若不带 OS 事件（wifi 漂移、NAT 超时、运营商静默丢包），手机侧 WS 既收不到 close 也不会触发 online 事件。实测（宿主机 iptables 对客户端 IP 悄默丢包 31s，`gate5/g5-5b`）：客户端 35s 内不自愈。
- 根因：`gatewayClient.startKeepalive()` 只按周期发 `{type:'ping'}`，从不校验 pong 是否超时（`src/mobile/bridge/gatewayClient.ts` L882-892）；重连只依赖 ws onclose / window online / visibilitychange 三个事件。
- 影响：弱网用户表现为「发消息没反应」直到重新打开应用或分钟级 TCP 超时。
- 建议修复：keepalive 增加 pong 死线（如 2 个周期无 pong 即判定离线并立即重连），与服务端 25s ping/60s 死线对齐。
- **范围修正（10-25 上午 A-08 v4 实测）**：socket 报错路径（等价飞行模式：RST/close 事件可达）客户端表现良好——退避重试 0/2/4/8/15s 不放弃，网络恢复后 26.3s 内重连成功（≤30s 达标）。僵尸化仅在静默丢包（无任何 socket 事件）路径成立。修复优先级可据此让位于 F-4/F-5。
- **方法更正**：Playwright `context.setOffline()` 不切断已建立的 WebSocket（v3 实测：无第二次 welcome、"离线"发送直达、回复照常流式完成）——重连类验收不得再用 setOffline，必须真断 socket（v4 用本地 CONNECT 代理承载并杀隧道，脚本 `g5-5e-a08-v4.mjs` 可复用）。

## F-4（P1·A-05 功能缺失）PWA 聊天界面没有任何附件入口

- 现象：聊天作曲区仅 7 个控件（会话抽屉 / 全部 Bot / Bot 选择 / 发送 / 三个底部 tab），全页 `input[type=file]` 数量为 0，无 📎/附件/图片按钮；聚焦输入框后复扫不变（`g5-6b` + 复核脚本，`a05-1-attached.png` 未产出——filechooser 从未出现）。
- 影响：验收场景 A-05（上传照片+PDF 并提问）在当前构建上不可执行；附件是「与 Bot 聊天」核心场景的一部分（手机拍照问 Bot 是 PWA 首发的高频用例）。
- 需求：WS-E 补附件上传 UI 与压缩；上游（WS-A gateway→租户）的文件通道按 01/02 契约对齐；A-05 验收待此落地后补跑。

## F-5（P1·A-01 注册流程缺口）注册表单缺邀请码与显示名字段；新测试号无法注册

- 现象一：staging 登录/注册页为裸「手机号+验证码」表单，无邀请码输入、无显示名输入（`g5-6a` 表单 dump：仅 tel/验证码/2 个同意勾选框）。60-acceptance A-01 规格含 invite code 与 display name 两步。需确认是构建未实现还是 staging 关闭了邀请制，二选一后补齐或改验收口径（改口径须 owner 拍板）。
- 现象二：开发模式固定验证码 246810 仅对种子号 13900000000/0001/0002 生效；13900000003 提交同码返回 400 CODE_INVALID（API 响应一手证据）。A-01 要求 5 次注册取 P95，现有种子号已全部注册过，无法产出 5 个全新用户。
- 需求：服务器侧扩展 SMS 种子号配置（或修 dev provider 对任意号放行固定码）。**当前被 SSH 限流阻塞**（详见 F-7）。

## F-6（P2·A-06 未决）第二台设备看不到工具权限单（证据不足不下结论）

- 已证：触发端（发起 permission 请求的设备）权限单正常弹出（拒绝/允许按钮，`a06-A-sheet.png`）；触发词可靠（消息含 permission 即触发）。
- 未证：第二台设备同账号进入同一会话后 60–90s 内未见权限单（`g5-6e/g5-6f`）；但两轮 UI 判定均被测试工具问题污染（F-2 标题改写干扰会话定位、抽屉遮挡未排除干净），**不作为产品结论**。
- 数据层探针（`g5-6g`，ipc-contract 有 `cowork:permission:listPending` 拉取 + `cowork:stream:permission` 推送两条设计路径）：B 端常开原始 WS 在触发窗内未收到任何 permission 帧；listPending 一次返回 undefined、一次超时（疑似撞网关每设备连接限制）。
- 待办：解除连接池干扰后复测数据层两条路径；若后端可见而前端不渲染，则是 WS-E 渲染缺口。

## F-7（运维）staging 主机 SSH 不可达 —— **已解决，定性更正（12:45）**

- **更正**：不是 fail2ban 限流。根因是安全组 22 端口只放行 `113.73.231.190/32`，而本机公网出口 IP 当日变为 `113.73.230.109`（同 /24 运营商重分配）。owner 侧已用 aliyun CLI 将新 IP 加入 sg-j6c03dhvp13et8ezeuod，SSH 恢复。服务器本身健康（up 2d21h，无重启无迁移）。
- 经验：SSH 突然超时先查「出口 IP 是否变了 + 安全组白名单」，不要先入为主归因限流。

## 附：staging A-11（mock 支付）前置缺失

`bundle.getPlans()` 空、`traffic.getRechargeGateway()`=paypal、`bundle.getMeters()`=relay key invalid or revoked——需要 WS-D bundle 后端配置：套餐种子数据、mock 网关启用、有效 relay key。硬门一时间线内需要排期。
（并行会话补充：计费后端已指向生产 ABS `https://www.metaso.network/assist-open-api`，支付宝 app_id/seller_id 主人已核对一致，非阻塞项；进程环境不要动。）

## F-8（P0·事故）租户 LLM 免费额度耗尽 → 一切 turn 秒死 —— **根因已定位（12:45）**

- **根因更正**：不是 F-1 族容器故障。租户容器日志一手证据：`[Orchestrator] LLM Anthropic error: 429 {"error":{"type":"api_error","message":"free_quota_exhausted: free quota exhausted"}}`——0002 租户的 LLM relay 免费额度用尽，每个 turn 死在第一次 LLM 调用（287ms 秒死即此）。会话标题生成同样 429（部分标题异常的次生来源）。
- 额度模型（ABS 源码）：免费额度按身份发放、**周周期重置**（锚定 max(账号创建, WeeklyQuotaEpoch)），等重置不可行。0002 租户绑定身份 = `14dQcNr5ik7Y2ijegLXsjfzdR9m7RS3xxf`（租户 kv `llmRelay.keyIdentity` 一手读取）。
- 恢复路径：①ABS admin 配额调整接口 `POST /v1/admin/llm/accounts/:identityAddress/quota-adjustments`（REQ-D-17 专为验收设计，正数补量、带台账；需 admin token，在 owner/侧）；②新用户=新身份=新免费额度（本回合已用此路解锁验收，见第 5 回合记录）。
- 产品建议：A-10 的「额度卡」UX 应在此场景触发（现在是无任何提示的静默 error，见 F-9）；F-9 修复时应带上 429 free_quota_exhausted 的识别。

- 事发时间线（存档）：08:52–09:55 第 3 回合真实回复正常 → 11:11:54 `d77900ec`（docx 生成）流式 10s 后死（当时把剩余额度烧在工具探索里）→ 11:15:07 `1cec2200` 11s 死 → 11:15:42 `b6fde304` 287ms 死。控制面 /health 全绿、gateway WS 正常，仅 LLM 调用 429——与上根因吻合。
- 11:12 turn 的容器内轨迹还暴露：docx 技能推荐路径 docx-js 不可解析（"docx not resolvable"）、npm 不可用（"npm is broken"）——但**第 5 回合在新租户（0004）上 docx/pdf/xlsx/pptx 四件全部真实生成成功**（走 pandoc/soffice/python 路径），说明缺依赖只影响 docx-js 推荐路径，技能有可用 fallback；docx-js 路径缺失仍记工单优化项。
- UX 并案（F-9·P2）：turn error 时聊天界面**没有任何用户可见反馈**（无错误气泡、无重试按钮）——真实用户视角等于「发出去石沉大海」。建议：error 时内联错误气泡 + 一键重试，并识别 429 free_quota_exhausted 触发额度卡（A-10 语义）。

## F-10（P2·A-01 UX）provisioning 期间刷新页面 → 退回登录页；就绪后应用不自愈

- 现象（g5-8c/g5-8e 两轮一手实测）：新用户注册后租户 provisioning 期间刷新/重开页面，应用直接显示**登录表单**（会话 cookie 有效、/me 200，但 UI 不识别）；租户 ready 后已打开的页面也不会自行过渡到主界面（90s 观察窗），需手动刷新才进入。
- 影响：真实新用户在「开通云端 Bot」等待期若刷新（很常见），会以为登录失败重新注册；.ready 后的页面卡死感会被当成「开通失败」。
- 建议：/me=200 且租户 provisioning 时显示专用「开通中」视图并轮询；ready 后自动进入主界面；登录表单只在无会话时显示。

## F-11（P1·A-04 交付通道）聊天回复里的文件链接是 file:// 容器内部路径，手机端完全不可用

- 现象（0004 租户四件文档一手实测）：Bot 生成文件后回复中的链接 href 为 `file:///data/workspace/移动端验收测试 A-04.docx`（另有「工作目录」同为 file:// 链接）。PWA/手机浏览器点击无任何反应（无 download、无 popup、无导航，g5-7d 三路捕获全空）；桌面浏览器也不可跨源访问。
- 影响面：A-04 判据「文件在手机上通过链接打开」在当前构建上**不可达成**；任何让 Bot「发文件」的场景（报告、周报、PPT）交付通道断裂。这是 PWA 首发前必须修复的交付缺口。
- 根因方向：租户 Agent 把本地路径当链接输出（模型侧行为），客户端桥未提供文件下载通道（契约里有 `cowork.downloadMetafile`/`gateway.fileSign` 但聊天 UI 未接）。修复应双侧：①租户侧文件交付协议（生成文件→经 gateway 签名 URL 或 metafile 上传→回复带 https 链接）；②WS-E 聊天渲染识别文件卡片并走下载/预览桥。
- 缓解判据：四文件本体生成全部成功且容器内实存（37,975/244,505/5,256/66,301 B，一手 ls 证据），文件生成半边达标；仅「手机打开链接」半边挂 F-11。

## F-12（P1·租户镜像）web-search 服务在所有租户启动失败（EACCES），Web2 搜索全灭

- 现象（容器日志一手证据）：`[SkillServices] Failed to start Web Search service: Error: EACCES: permission denied, open '/app/SKILLs/web-search/.server.log'`。0002 租户累计 25 次、新租户 0004 首次启动即失败。`/app/SKILLs/web-search` 属主 root:root，运行时用户 idbots 无写权限。
- 影响面：所有租户的 Web2 联网搜索不可用；A-04 搜索半场降级为链上源引用（Bot 诚实声明「没找到可核验的官方公告」，行为合格但判据字母不满足）。
- 热修不可行：容器内 root chown 报 Operation not permitted（capability 受限），必须**改镜像**。
- 建议修复（工单）：镜像构建期 `chown -R idbots:idbots /app/SKILLs`（或该目录）；或 web-search 日志路径改到 `/data`。修复后 A-04 搜索半场复跑。

## 第 4 回合小结（10-25 10:45–11:20，A-04 攻坚转事故处置）

- A-04 前置完成：租户 25 个技能清单确认 docx/pdf/xlsx/pptx/web-search 全部在装且 enabled（`g5-7a/7a2`）。
- A-04 跑法脚本就绪并已实战校验两轮（`g5-7b`（v1，UI 停止按钮判据对工具链型 agent 过早，作废）、`g5-7d`（v2，会话状态轮询判据，可复用））。
- 诊断链：`g5-7c/7c2`（数据层收割 + 消息页 API 对 error 会话返回 "Session not found"，本身是观察项：错误会话 claudeSessionId=null 导致消息不可读）、`g5-7e`（对照实验：普通聊天同死 → 非 docx 特有）、`g5-7f`（错误字段：session 详情无 lastError 暴露）。
- 结论：触发 F-8 事故定性，A-04 实测顺延至 turn 管道恢复。

## 第 5 回合小结（10-25 11:48–12:45，SSH 恢复后突击：环境修复 + A-01/A-08 收口 + A-04 实测）

- 环境动作：SSH 恢复（F-7）；SMS 种子扩至 0000–0009（/etc/idbots/cp.env，已备份 cp.env.bak-20261025-smsseed）；控制面重建（A-08 阶段 2 顺势实测）；新邀请码 6YEBR7TB（6 次，CLI invite create）；新用户 13900000003（t_yapvabyc，用于诊断）/13900000004（t_xugb5，主力验收租户，Bot 名 Noodle）。
- **A-08 阶段 2 ✓ PASS**：控制面重启→断开到重连 1.1s（≤30s 达标）；三租户容器 StartedAt 逐字节一致、RestartCount=0（零重启）。`g5-8a`。
- **A-01 ✓ PASS（单次实测）**：13900000004 全流程 153s ≤300s，真实回复「开通成功」（Bot Noodle）；邀请码经 API 注入（UI 缺字段=F-5 维持）；INVITE_REQUIRED 403 API 一手证实。`g5-8e`。五连 P95 还差 0005–0007 三次注册。
- **A-04 四文档生成 ✓（半场）**：docx 72s / pdf 58s / xlsx 92s / pptx 271s 全部 completed，文件容器内实存（一手 ls）；「手机端打开链接」半场挂 F-11。`g5-7d` + `a04-*-0004.log`。
- **A-04 搜索（降级完成）**：73s completed、聊天保持打开、引用三条可核验 pin、无 Web2 链接——web-search 服务镜像级损坏（F-12）。`g5-8f`。
- 数据层补充：0003 租户 t_yapvabyc 的 cowork_sessions 为空而 proxy 把 0004 路由到 t_xugb5——注意「登录态→租户」映射以 proxy 日志为准，勿按注册顺序推断。
