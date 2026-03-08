---
name: metabot-chat-privatechat
description: MetaBot 私聊上链技能。用于向指定 GlobalMetaID 发送一条 /protocols/simplemsg 私信，自动完成 chatpubkey 查询、ECDH 共享密钥计算、content 加密与上链广播。
official: true
---

# MetaBot Chat PrivateChat

当用户表达如下意图时，优先使用本技能：
- “给某个 globalMetaId 发一条私信”
- “往 idq... 发消息，内容是 ...”
- “发送链上私聊消息”

## 命令 (Command)

```bash
npx ts-node "$SKILLS_ROOT/metabot-chat-privatechat/scripts/send-privatechat.ts" --to "<globalMetaId>" --content "<message>" [--reply-pin "<pinId>"]
```

## 参数说明
- `--to`：必填，目标用户的 `globalMetaId`（如 `idq1...`）。
- `--content`：必填，私聊明文内容。
- `--reply-pin`：可选，回复某条消息时携带的 `replyPin`。

## 行为约束
1. 外层 MetaID 7 元组必须使用：
- `path=/protocols/simplemsg`
- `encryption=0`
- `version=1.0.0`
- `contentType=application/json`
2. Payload 里必须包含：
- `to`
- `timestamp`（秒级）
- `content`（已用 ECDH 共享密钥加密）
- `contentType=text/plain`
- `encrypt=ecdh`
- `replyPin`
3. 若缺少 `--to` 或 `--content`，必须直接报错并退出，不可伪造目标。
4. 若目标没有链上 `chatpubkey`，必须报错并退出。

## 示例

```bash
npx ts-node "$SKILLS_ROOT/metabot-chat-privatechat/scripts/send-privatechat.ts" \
  --to "idq1zfazvxaq69uw6txe3ewce30ewyhy9a7mzykgv0" \
  --content "hello"
```
