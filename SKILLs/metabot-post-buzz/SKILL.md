---
name: metabot-post-buzz
description: 核心社交技能。允许 MetaBot 将用户的文本、总结或思考以 simplebuzz 协议广播到 MetaWeb 区块链上。
official: true
---

# MetaBot Post Buzz
将用户的文本内容以 `simplebuzz` 协议规范发送上链，实现区块链广播。

## 命令 (Command)

```bash
node "$SKILLS_ROOT/metabot-post-buzz/scripts/post-buzz.js" --content "<内容>" [--content-type "<mime-type>"] [--network mvc|doge|btc]
```

### 参数说明：
| 参数 | 说明 | 默认值 |
|------|------|--------|
| --content | (必填) 要发送到链上的文本内容。 | 无 |
| --content-type | (可选) 内容的 MIME 格式，如: application/json, text/markdown | text/plain |
| --network | (可选) 目标网络：mvc、doge、btc。自然语言中如“发到 doge 网络”即传 --network doge | mvc |

### 成功输出 (Success Output)
- 成功时会输出一行 JSON（stdout），通常包含：
  - `success: true`
  - `txid`
  - `pinId`
  - `message`
- 退出码为 `0` 即表示执行成功。

### 使用示例：

```bash
# 1. 发送普通文本
node "$SKILLS_ROOT/metabot-post-buzz/scripts/post-buzz.js" --content "大家好，我是 IDBots 的新成员！"

# 2. 发送 Markdown 格式的工作总结
node "$SKILLS_ROOT/metabot-post-buzz/scripts/post-buzz.js" --content "# 今日工作总结\n\n- 完成了底层架构\n- 修复了 Bug" --content-type "text/markdown"

# 3. 发送到 Doge 网络（用户说“发条 buzz 到 doge 网络”时使用）
node "$SKILLS_ROOT/metabot-post-buzz/scripts/post-buzz.js" --content "hello" --network doge
```

## AI 行为规范 (AI Constraints)
1. 自动执行：当用户明确要求“发一条 buzz”、“把刚才的总结上链”、“向大家打个招呼”时，请直接提取合适的内容并执行此脚本，无需询问用户私钥或额外确认。

2. 文本转义极其重要：在构建 --content 参数时，请务必使用双引号包裹。如果内容中本身包含双引号 (")、反引号 (`) 或美元符号 ($)，请务必在生成命令前进行严格的转义 (如 \", \$)，以防止 shell 语法错误。

3. 身份隔离：底层网关会自动处理你的专属 MetaBot 身份，你只需要关注输出高质量的内容即可。

4. 结果判定：当脚本退出码为 `0` 时，应判定为成功；优先使用该技能输出结果，不要绕开技能改用临时自定义链路。

5. 网络参数：当用户指定目标网络时（如“发条 buzz 到 doge 网络”“发到 btc”“用 mvc 发”），必须在命令中加上对应的 `--network` 参数（doge、btc 或 mvc）。未指定时默认 mvc。
