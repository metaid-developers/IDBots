---
name: metabot-omni-reader
description: MetaBot 的链上数据读取能力（Omni-Reader）。当用户需要查询 MetaID/MetaWeb 链上信息（用户信息、Buzz/社交、PIN 列表、文件索引、通知等）时，通过查阅 references 下的接口文档并用 curl 请求对应 API 获取 JSON，再根据返回字段向用户作答。
official: true
---
# MetaBot Omni-Reader（链上数据读取）

本技能是 MetaBot 的「链上数据之眼」：通过查阅预置的接口文档，用 **curl** 调用 manapi.metaid.io、file.metaid.io/metafile-indexer、Show.Now、MAN 等服务的 HTTP API，获取实时 JSON 数据，再根据返回字段含义用自然语言回答用户。**不依赖专用脚本**，接口定义与扩展均以 `references/` 下的 Markdown 文档为准。

## 执行逻辑 (Agent Workflow)

当用户询问链上信息（某人的名字/地址、最新 Buzz、某条帖子详情、通知、文件列表、搜索用户等）时，**必须严格按以下步骤**：

1. **确定查询类型**：根据用户意图，选择对应的参考文档：
   - **用户信息**（昵称、头像、地址、chatpubkey、按关键词搜用户）→ 阅读 `references/00-user.md`
   - **社交与互动**（最新/推荐/热门 Buzz、评论点赞、通知、关注列表等）→ 阅读 `references/01-social.md`
   - **PIN 与链数据**（PIN 详情、按 path/metaiD/地址列 PIN、区块/内存池、通知列表、原始内容等）→ 阅读 `references/02-PIN.md`
   - **文件类**（文件元数据、按创作者/metaiD/扩展名列文件、最新版本等）→ 阅读 `references/03-file.md`
   - 若后续新增能力（如 04-xxx.md），同样先读对应文档再选接口。
2. **查阅文档**：打开上述文档，找到与用户问题匹配的接口（base_url + 路径、必填/可选参数）。
3. **构造 URL**：按文档中的 Inputs 将 path/query 参数拼成完整 URL（注意保留文档中的拼写，如 `notifcation`）。
4. **用 curl 请求**：在终端执行 `curl -s "<完整URL>"`（或 `curl -sL` 如需跟随重定向），获取 JSON 响应。
5. **解读并作答**：根据文档说明与实际返回的 JSON 字段名理解含义，用自然语言总结回答；勿直接粘贴大段原始 JSON，除非用户明确要求。

## 命令方式 (How to Call APIs)

**统一用 curl（Windows / macOS 均可用）：**

```bash
curl -s "https://<base>/<path>?<query>"
```

- 将文档中的 base_url 与路径、参数拼成完整 URL。
- `-s` 静默模式，不输出进度；需要时可用 `-sL` 跟随重定向。
- 返回体一般为 JSON；字段含义以各 reference 文档说明及实际键名为准，不在此一一约定。

**示例（仅作格式参考，具体以 references 为准）：**

- 按 metaId 查用户：`curl -s "https://manapi.metaid.io/api/info/metaid/0d16...i0"`
- 最新 10 条 Buzz（Show.Now）：见 `01-social.md` 中的示例 URL。

## 参考文档索引 (Reference Index)

| 文档 | 适用场景 |
|------|----------|
| `references/00-user.md` | 用户信息：按 metaId/地址/globalMetaID 查用户、按关键词搜索用户、用户列表 |
| `references/01-social.md` | 社交互动：最新/推荐/热门 Buzz、搜索 Buzz、Buzz 详情与评论点赞、通知、关注者/正在关注 |
| `references/02-PIN.md` | 通用 PIN：PIN 详情与版本、按 path/metaiD/地址列 PIN、全局/区块/内存池、通知、原始内容、indexer 状态与统计 |
| `references/03-file.md` | 文件：按 PinId/firstPinId 查文件、按创作者/metaiD/扩展名列文件、最新版本 |
| （后续可增）`references/04-xxx.md` | 按实际新增文档的说明使用 |

**扩展方式**：新增能力时，在 `references/` 下增加新的 `NN-xxx.md`，在本表与上文的「确定查询类型」中补充说明即可，无需改脚本或配置。

## 平台说明 (Windows / macOS)

- **curl**：Windows 10+ 与 macOS 均自带或可用 `curl`，本技能不区分平台，统一使用 `curl -s "<URL>"` 即可。
- 若环境无 curl，可改用等价 HTTP 工具（如 PowerShell `Invoke-RestMethod`），只要能得到接口返回的 JSON 即可。

## AI 行为规则 (Strict Constraints)

1. **先读文档再请求**：未确定用哪个接口时，必须先读对应的 reference 文档，再构造 URL 并 curl，禁止猜测路径或参数。
2. **路径与拼写**：URL 路径、参数名以文档为准（例如通知接口为 `notifcation` 时不要改成 `notification`）。
3. **参数必填**：文档标明必填的 path/query 必须带上，否则会 404 或空结果。
4. **理解返回**：各接口返回的 JSON 结构可能不同（有的在 `data` 下，有的为数组），根据文档说明与实际字段名理解含义后作答，勿机械转储 JSON。
5. **总结作答**：用自然语言回答用户；仅在用户明确要求时才提供原始 JSON。
