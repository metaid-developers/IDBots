# CR-WSA-005 · 移动端 bot 弹页能力（方案 A：网关签名临时托管）

- 状态：实现完成，工作树待审（未 commit）
- 日期：2026-11-20
- 关联：`docs/cloud-mobile/10-ws-a-idsbots-server-mode.md`（REQ-A-5 工具面）、`01-interface-contracts.md` C2（HTTP 路由 / token）

## 1. 目标

服务器模式下，任一会话 bot 能把**一个本地页面**（HTML 文件，或含 `index.html` 的目录）经
网关做**限时、限范围**的托管，并在会话里发一张移动端可点开的卡片；用户在手机上点卡片，
页面在 App 内的 WebView（内置浏览器）里打开。桌面行为零变化。

## 2. 组成

| 层 | 文件 | 职责 |
|---|---|---|
| 工具 | `src/main/libs/mobilePageAgentTools.ts` | `mobile_open_page(path, title, description?, ttlHours?)`；成功时返回回执 + `mobile-page-card` fence |
| 托管核心 | `src/main/gateway/mobilePages.ts` | 路径收敛、扩展名白名单、大小/数量上限、TTL、token 铸造与资产解析 |
| Token | `src/main/gateway/tokens.ts` | `signPageToken` / `verifyPageToken`（HMAC-SHA256，base64url `payload.signature`） |
| 路由 | `src/main/gateway/server.ts` | `GET /gateway/v1/pages/{token}/{asset}` |
| 控制面代理 | `cloud/control-plane/src/services/httpProxy.ts` | `GET /pages/*`（cookie）→ 租户 `/gateway/v1/pages/*` |
| 开发代理 | `vite.mobile.config.ts` | `/pages/` → `/gateway/v1/pages/` |
| 卡面 | `src/renderer/components/chat/mobilePageCardSyntax.ts` + `MobilePageCard.tsx` | fence 解析/校验、卡面渲染、同步点击 |
| 接线 | `coworkRunner.ts` / `main.ts` | **仅 `isServerMode()` 时挂载**；control 读 `getActiveGatewayContext()` |

## 3. 安全边界（全部在铸造 token 之前或每次请求时强制）

1. **HMAC 签名**：payload `{p,i,e,t,s?}` 以网关密钥 HMAC-SHA256，恒定时间比较；错签名/错租户/过期一律 `null`。
2. **过期**：默认 24h，`ttlHours` 上限 168h；ts 在 payload 内，服务端每次请求复验。
3. **路径收敛**：realpath 后必须落在租户 data root 内（与 `gateway:file:sign` 同一套 R-path）；请求侧再按 `path.resolve` + realpath 双重检查，`..`、绝对路径、反斜杠、NUL、符号链接逃逸全部 404。
4. **内容类型白名单**：仅 html + 静态资源（css/js/mjs/json/map/webmanifest/xml/txt/svg/图片/字体/wasm/音视频）；点文件（`.` 开头）永不服务；**单文件托管只服务该文件本身**（`s:1`），不暴露同目录兄弟文件。
5. **大小上限**：单文件 8 MiB、整页 32 MiB、服务文件数 256、目录深度 8。
6. **统一 404**：所有拒绝同一状态码，路由不做存在性预言机；不带网关密钥 401（与 `/files`、`/upload` 一致）。
7. **卡面输入校验**：fence 里的 URL 必须是同源 `/pages/<token>/` 形状，外部 URL / `javascript:` / 穿越写法一律降级为普通代码块。

## 4. 桌面零变化

- 新工具**不在** `SERVER_MODE_DISABLED_AGENT_TOOLS`（那是桌面禁用清单，未改），而是在挂载处 `if (this.mobilePage && isServerMode())` 双重门控。
- 路由在所有模式注册，但 token 只能由服务器模式工具铸造；桌面无 token 可用，行为不变。
- 卡面渲染在 `MarkdownContent` 内以 `isMobileBridgeRuntime()` 门控，桌面命中同一 fence 时仍走原代码块路径。

## 5. 部署注意

- 控制面需同步发布 `proxyRoutes` 的 `/pages/*`（本 CR 已含代码）。
- 网关与 token 都复用 `IDBOTS_GATEWAY_SECRET`，无需新增密钥。
- 反向代理/边缘需允许 `/pages/` 路径与 Range 头（与 `/files/` 相同）。

## 6. 测试

- `tests/mobileOpenPage.test.mjs`：token 正/负例、托管包线、穿越/符号链接/扩展名、真实 HTTP 路由、serverMode 过滤与挂载静态守卫、工具正面/拒绝路径。
- `tests/mobilePageCardMarkdown.test.tsx`：fence 解析/拒绝、`MarkdownContent` 卡面渲染、桌面降级、过期卡、同步点击三态、主/渲染两侧 fence 互认、中英双语文案。
- 回归：`tests/gatewayServer.test.mjs`、`tests/serverMode.test.mjs`、`tests/escrowCardMarkdown.test.tsx`、`tests/nftCardMarkdown.test.tsx`、`tests/paymentCardSyntax.test.ts`、`tests/mobileArtifactPreview.test.ts`、`tests/mobileChatProjection.test.ts`、`tests/localFileUrl.test.ts`、`tests/markdownContent*.test.tsx`。
