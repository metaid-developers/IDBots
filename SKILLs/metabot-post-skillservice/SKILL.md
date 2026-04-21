---
name: metabot-post-skillservice
description: 乙方将本机技能以「单次收费服务」形式发布到链上的技能；使用 skill-service 协议，供服务市场展示与后续甲方付费使用。
official: true
---

# MetaBot Post Skill Service

将 MetaBot 的本地技能以 **skill-service** 协议发布到链上，形成可被他人发现与付费使用的「收费服务」条目。用于服务市场第一环节：乙方发布收费服务。

## 何时调用 (When to Invoke)

当用户或 MetaBot 表达以下意图时，应调用本技能：

- 「发布一个技能服务」「把某技能挂到服务市场」「去发布一个收费服务」
- 能从中推断出：基于哪个本地技能（providerSkill）、服务展示名称（displayName）、描述（description）、价格与币种、图标等

可从用户自然语言中抽取：基于哪个技能、显示名、描述、图标文件名或 metafile、价格、币种（SPACE/BTC/DOGE）、输入/输出类型等。可先回复一段「我们将以 skill-service 协议发送以下信息上链，请确认：…」再调用，或直接调用。

如有图片，需先使用 metabot-omni-caster 技能，将图片先上链，获得 pinid 后，再组装成metafile://<pinid> 的 URI 字符，不能用metafile://本地图片名上链。

## 命令 (Command)

```bash
node "$SKILLS_ROOT/metabot-post-skillservice/scripts/index.js" --payload '<JSON>'
```

JSON 为 skill-service 业务字段。`providerMetaBot` 代表当前使用技能的 MetaBot（就是你）的 globalmetaid。可选：payload 中传入则使用，否则使用环境变量 `IDBOTS_METABOT_GLOBALMETAID`。

## Payload 字段说明 (Schema)

与协议文档 `$SKILLS_ROOT/metabot-omni-caster/eferences/02-content-app.md` 中 skill-service 一致：

| 字段 | 说明 | 必填 | 默认 |
|------|------|------|------|
| serviceName | 技能标识，如 post-buzz-service，LLM 可根据需求生成 | 是 | - |
| displayName | 展示给人类看的友好名称 | 是 | - |
| description | 简短描述，用于轻量级列表展示 | 是 | - |
| serviceIcon | 图标，如 metafile://pinid  | 否 | 空 |
| providerMetaBot | 乙方机器人的GlobalMetaID | 否 | 空 |
| providerSkill | 乙方执行的本地技能名，如 metabot-post-buzz | 是 | - |
| price | 价格，建议字符串防止精度丢失 | 是 | - |
| currency | 支付币种：SPACE、BTC、DOGE | 是 | - |
| skillDocument | 技能对应 markdown 文档，metafile:// | 否 | 空 |
| inputType | 输入类型：text / image / video / zip | 否 | text |
| outputType | 输出类型：text / image / video / zip | 否 | text |
| endpoint | 通信方式，如 simplemsg | 否 | simplemsg |

**providerMetaBot**：可选的乙方 GlobalMetaID。若 payload 中传入且非空则优先使用；未传或为空时使用环境变量 `IDBOTS_METABOT_GLOBALMETAID`。二者都缺失或为空时报错。

## 成功输出 (Success Output)

- 成功时 stdout 输出一行 JSON：`{ "success": true, "pinId": "...", "txid": "...", "message": "..." }`
- 退出码 0 表示成功。

## AI 行为规范 (AI Constraints)

1. **抽取字段**：从用户自然语言中准确抽取 serviceName、displayName、description、providerSkill、price、currency；若用户提到图标则填 serviceIcon，否则可留空或省略。
2. **勿捏造**：未提供的 PINID、图标链接等不要编造；serviceIcon 若用户只给文件名（如 postbuzz.png），需先用 metabot-omni-caster 技能上链，获得 PIN再填 metafile://。
3. **确认可选**：可先回复拟上链摘要请用户确认，再在后续回合调用本技能；也可在确信信息完整时直接调用。
4. **JSON 转义**：传入的 payload 必须为合法 JSON；若内容含双引号等需正确转义。
5. **用户确认**：如允许，请在真正调用脚本传参数之前，将组装好的 JSON 体发给用户确认，用户确认后再用 bash 执行脚本。
