# MetaApp Publish And Manage

这个文件只描述 IDBots 当前 MetaApp 发布/管理的真实约定。

## 1. 当前能力边界

新技能的脚本会覆盖这些动作：

- prepare publish
- prepare update
- publish prepared payload
- delete / revoke
- share links
- prepare homepage payload
- set homepage to a published MetaApp

当前不把“MetaApp 评论”写成伪能力。当前宿主侧已经成型的是发布、更新、删除、查看、运行、复制分享链接。

## 2. 发布协议真相

链上路径是：

```text
/protocols/metaapp
```

MetaApp wrapper 是一条 JSON pin，重资源先传 `/file`，再把 `metafile://...` 写进 wrapper。

## 3. 字段规则

### 必填

- `appName`
- `content`

建议也显式提供：

- `title`

### 常用默认值

| 字段 | 默认值 |
|---|---|
| `title` | 若为空则回退到 `appName` |
| `prompt` | `""` |
| `introImgs` | `[]` |
| `intro` | `""` |
| `runtime` | `browser` |
| `version` | `v1.0.0` |
| `contentType` | `application/zip` |
| `indexFile` | `index.html` |
| `contentHash` | 本地 ZIP 自动计算；否则留空 |
| `metadata` | `{}` |
| `tags` | `[]` |
| `disabled` | `false` |
| `codeType` | 只有 `code` 存在时才给默认 `application/zip` |

### 重要限制

- `content` 必须最终变成 `metafile://...`
- `code` 可以为空；如果存在，也必须是 `metafile://...`
- `icon` / `coverImg` / `introImgs` 可以是：
  - 本地图片路径（prepare 时先上传）
  - `metafile://...`
  - `https://...`
- `metadata` 必须是对象，不要传随意字符串

## 4. Request JSON 形状

### 创建

```json
{
  "title": "My MetaApp",
  "appName": "my-metaapp",
  "intro": "A browser MetaApp",
  "runtime": "browser",
  "version": "v1.0.0",
  "content": "/absolute/path/to/dist-or-zip",
  "indexFile": "index.html",
  "code": "/absolute/path/to/source.zip",
  "icon": "/absolute/path/to/icon.png",
  "coverImg": "https://example.com/cover.png",
  "introImgs": [],
  "metadata": {},
  "tags": ["tool"]
}
```

### 更新

```json
{
  "targetPinId": "latest-write-pinid",
  "firstPinId": "stable-view-pinid",
  "title": "My MetaApp",
  "appName": "my-metaapp",
  "content": "/absolute/path/to/dist-or-zip",
  "indexFile": "index.html"
}
```

更新时，`firstPinId` 强烈建议带上。它是稳定展示 pin，后续 share-links 应该优先用它，而不是最新 write pin。

## 5. 命令

创建 prepare：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --prepare-request /tmp/metabot-metaapp-request.json \
  --output /tmp/metabot-metaapp-prepared.json
```

更新 prepare：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --prepare-update-request /tmp/metabot-metaapp-update-request.json \
  --output /tmp/metabot-metaapp-update-prepared.json
```

确认后写链：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --publish-prepared /tmp/metabot-metaapp-prepared.json
```

删除：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --delete-pin <pinId> \
  --first-pin-id <firstPinId>
```

分享链接：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --share-links <pinId> \
  --first-pin-id <firstPinId>
```

把已发布 MetaApp 显式设为当前 Bot homepage：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --set-homepage-metaapp <pinId>
```

## 6. Publish Wizard（引导式发布流程）

这是处理“把一个 ZIP / 项目目录 / 静态站点发布成 MetaApp”这类自然语言请求的默认路径。向导的核心是：**先收集字段并预览，prepare 脚本负责上传和打包，把最终 JSON 完整展示给用户确认后，才真正写链**。

### 步骤

1. **分类源工件**
   - ZIP：确认声明的 `indexFile` 确实在包内存在。
   - 项目目录：先用 `bot_browser_preview_local`（见 §9 本地预览）发现可运行的入口目录和默认入口文件。
   - 发布前，检查入口 HTML / CSS / 模板里是否有以 `/` 开头的打包资源引用；如果这些资源应该来自包内，先改成相对路径。

2. **收集必填字段**

   必填非空：`appName`、`content`。强烈建议也显式提供 `title`。

   如果用户没有给默认值：
   - `title` 用目录或 ZIP 的 base name
   - `appName` 用 `title` 的 slug 形式

3. **收集推荐字段**

   主动问用户要不要 `coverImg`、`icon`、`intro`。也问一下是否有 `introImgs`、`tags`、`version`、`runtime`、自定义 `indexFile`，或要作为 `code` 的源码归档。

4. **确认 actor 与写入网络**

   在 prepare 之前，明确说出将要使用的发帖身份（MetaBot）和写入网络。本技能的脚本默认走宿主当前选中的身份和网络。

5. **跑 prepare（脚本负责上传 + 打包）**

   把上面收集到的字段整理成 request JSON（形状见 §4），跑 prepare：

   ```bash
   node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
     --prepare-request /tmp/metabot-metaapp-request.json \
     --output /tmp/metabot-metaapp-prepared.json
   ```

   prepare 会自动完成：
   - `content` / `code` 指向的本地目录或 ZIP → 打包成 ZIP → 上传 → 转成 `metafile://...`
   - `icon` / `coverImg` / `introImgs` 里的本地图片路径 → 按扩展名推断 MIME（仅接受 `image/png`、`image/jpeg`、`image/gif`、`image/svg+xml`、`image/webp`）→ 上传 → 转成 `metafile://...`
   - 已经是 `https://...` 的图片 URL 原样保留
   - 已经是 `metafile://...` 的引用原样保留

   如果本地图片扩展名无法推断出合法 image MIME，prepare 会报错——这时要换成合法图片或 `https://` 图片 URL，不要硬塞。

6. **展示最终 JSON，等用户确认**

   把 prepare 产出的完整 JSON 展示给用户，告诉对方可以点名修改任意字段。**在用户明确确认这份 JSON 和 actor 之前，不要执行写链。**

7. **写链**

   ```bash
   node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
     --publish-prepared /tmp/metabot-metaapp-prepared.json
   ```

8. **发布后 handoff**

   写链成功后，按下面四件套给用户交付（用用户的语言）：

   - **URI**：`metaapp://<viewPinId>`（`viewPinId` 优先用 `firstPinId`，没有才回退到 `pinId`）
   - **打开**：用 `bot_browser_open_uri` 打开 `metaapp://<viewPinId>`，让用户在内置浏览器里立即看到应用。内置浏览器始终是打开应用的首选方式。
   - **管理**：本地 My Apps 页（用户可在里面管理已发布应用）
   - **分享**：`https://openagentinternet.org/browser/metaapp/<viewPinId>` —— 这条 web2 链接**只用于发给别人**，不要把它当成让本地用户打开应用的方式。

   发布后顺手在当前对话里把分享 URI/URL 整理好；如果用户想发一条公告 buzz，直接调用内置 `post_buzz` 工具（原 metabot-post-buzz 技能已转为内置工具），不要把用户赶到别的技能。

### 关于 `firstPinId`

更新 / 删除 / 分享时，**强烈建议带上 `firstPinId`**（稳定展示 pin）。否则公开分享 pin 会漂到最新 write pin，导致分享链接不稳定。

## 7. 分享语义

IDBots 当前真实可分享的是：

- `metaapp://<pinId>`
- `https://openagentinternet.org/browser/metaapp/<pinId>`

脚本会输出：

- `pinId`：最新写链 pin（modify 时是「变更记录」，不是应用本身）
- `firstPinId`：稳定展示 pin（如果已知）
- `metaappUri`：对 modify 操作已指向根 pin（`metaapp://<firstPinId>`），可直接用于对外展示
- `shareWebUrl`：同上，指向根 pin
- `runPath`

> 修改（update）后对外展示 / 打开 / 分享一律用根 pin（`firstPinId`，回退 `targetPinId`，再回退 `pinId`）。不要用 modify 回执的 `pinId` 拼展示链接。

homepage 选中与普通 publish 分开。推荐顺序是：

1. 先 publish MetaApp
2. 把最终 pinId 展示给用户
3. 用户明确确认后，再执行 `--set-homepage-metaapp`

## 8. 删除语义

删除不是硬删资源，而是对目标 MetaApp pin 写一条 `revoke`。

- 只有用户明确说要删除 / 下架时，才执行 delete
- 用户只是想临时禁用，优先考虑 `disabled: true` 的可逆发布更新

## 9. 本地预览（Local Preview）

发布前必须先预览。IDBots 内置浏览器支持预览**尚未上链**的本地项目，预览直接从磁盘实时读取，用户 reload 就能看到最新改动。

预览不经过任何写链，也没有 `pinId`，不能被分享、`metaapp://` 链接或设为 Bot homepage——直到走完 §6 Publish Wizard 真正发布。

### 预览方式

用 `bot_browser_preview_local` 工具，传一个**绝对路径**（指向含 `index.html` 的目录，或单个 html/pdf/图片/视频/音频/md/代码/CSV 文件）：

```
bot_browser_preview_local(path: "/absolute/path/to/app-dir")
bot_browser_preview_local(path: "/absolute/path/to/app-dir", newTab: true)
```

工具内部按文件类型构造预览 URI，交给内置浏览器打开：

- 目录或 `.html`/`.htm` 文件 → `preview-metaapp://localhost<absolutePath>`（可运行应用 / HTML 页面）
- 其他可预览文件（markdown、text、代码、csv、pdf、图片、视频、音频）→ `preview-file://localhost<absolutePath>`（文档在内置浏览器右侧标签页里渲染，不会变成下载）
- 不可预览的类型（如 docx、xlsx、zip）→ 工具返回错误，需先转成 md/html/pdf

### 预览 URI 规范

- scheme 是 `preview-metaapp://`（应用/HTML）或 `preview-file://`（非应用文件）
- host 永远是字面量 `localhost`
- path 是项目目录或入口文件的绝对路径
- 示例：`preview-metaapp://localhost/Users/name/projects/my-app`、`preview-file://localhost/Users/name/notes/report.md`

### 禁止的做法

- **不要**把 `file:///...` 路径交给用户或塞进浏览器
- **不要**手拼 `http://localhost` URL
- **不要**把 preview 服务器内部返回的 `localPreviewUrl`（`/browser-cache/metaapp-preview/...`）直接交给用户——那是内部资源地址，绕过了内置浏览器的 Agent Internet 链接语义

正确的预览入口只有 `bot_browser_preview_local`（按类型等价于 `preview-metaapp://localhost<absPath>` 或 `preview-file://localhost<absPath>`）。

### 静态项目入口布局

预览会按这个顺序发现入口：项目根的 `index.html`、或 `dist/`、`build/`、`out/`、`public/` 下的 `index.html`。如果找不到入口，问用户该用哪个构建产物目录或默认文件。
