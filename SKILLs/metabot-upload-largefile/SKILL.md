---
name: metabot-upload-largefile
description: 文件上链技能。用于把本地文件上传到 MetaID 链上并返回 PINID 与预览地址。当用户说“把这个文件上链”“上传附件到链上”“大文件分片上传”“把本地图片/视频/PDF 发到链上”等涉及文件上链的意图时，优先调用此技能。
official: true
---

# MetaBot Upload Large File (统一文件上链)

这个技能统一处理小文件和大文件上链。

- `<= 2 MiB`：直接上链
- `> 2 MiB`：自动走分片上链
- 硬限制：`<= 20 MiB`
- 成功后必须返回 `pinId` 和预览地址

预览地址格式固定为：

```text
https://file.metaid.io/metafile-indexer/api/v1/files/content/<pinId>
```

## 🧠 执行逻辑

当用户要把一个本地文件上传到链上时，按下面流程执行：

1. 确认用户给了真实的本地文件路径。
2. 不要自己读取文件内容，也不要把大文件塞进上下文。
3. 直接调用 `scripts/upload-largefile.js`，把文件路径传给 `--file`。
4. 如果用户指定了 MIME 类型，传 `--content-type`；如果用户指定目标网络，传 `--network`。
5. 读取脚本 stdout 返回的 JSON，把 `pinId` 和 `previewUrl` 明确展示给用户。

## 💻 命令语法

```bash
node "$SKILLS_ROOT/metabot-upload-largefile/scripts/upload-largefile.js" \
  --file <本地文件路径> \
  [--content-type "<mime-type>"] \
  [--network mvc|doge|btc]
```

## 📋 参数说明

| 参数 | 说明 | 必填 | 默认值 |
| --- | --- | --- | --- |
| `--file` | 本地文件路径 | 是 | 无 |
| `--content-type` | 指定 MIME 类型；不传则按扩展名推断 | 否 | 自动推断 |
| `--network` | 目标网络：`mvc`、`doge`、`btc` | 否 | `mvc` |

## ✅ 成功输出

脚本成功时会只向 stdout 输出一行 JSON：

```json
{
  "success": true,
  "pinId": "abc123i0",
  "previewUrl": "https://file.metaid.io/metafile-indexer/api/v1/files/content/abc123i0",
  "fileName": "demo.png",
  "size": 12345,
  "contentType": "image/png;binary",
  "uploadMode": "chunked"
}
```

其中：

- `pinId`：最终文件索引 PINID
- `previewUrl`：可直接预览文件内容的地址
- `uploadMode`：`direct` 或 `chunked`

## ⚠️ 严格约束

1. 不要用 `cat`、Read 工具或其它方式主动读取用户的大文件内容。只传文件路径给脚本。
2. 文件超过 `20 MiB` 必须直接报错，不要尝试上传。
3. 文件大于 `2 MiB` 时必须走分片上传，不能继续走 direct upload。
4. 当前 IDBots 内置实现里，大文件分片上传只支持 `mvc`。如果用户指定 `doge` 或 `btc` 且文件大于 `2 MiB`，要明确报错，不要假装支持。
5. 如果用户没有提供真实文件路径，必须先追问路径，不能捏造。
6. 始终使用 `$SKILLS_ROOT/metabot-upload-largefile/scripts/upload-largefile.js`，不要调用 `.ts`。

## ✅ 示例

**1. 上传一个 PNG：**

```bash
node "$SKILLS_ROOT/metabot-upload-largefile/scripts/upload-largefile.js" \
  --file /path/to/logo.png
```

**2. 上传一个 PDF：**

```bash
node "$SKILLS_ROOT/metabot-upload-largefile/scripts/upload-largefile.js" \
  --file /path/to/report.pdf \
  --content-type application/pdf
```

**3. 上传一个大于 2 MiB 的视频到 MVC：**

```bash
node "$SKILLS_ROOT/metabot-upload-largefile/scripts/upload-largefile.js" \
  --file /path/to/demo.mp4 \
  --network mvc
```
