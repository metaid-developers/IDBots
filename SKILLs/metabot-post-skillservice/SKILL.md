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

如有图片，需先用内置 `upload_file` 工具将图片上链，获得 pinid 后，再组装成 `metafile://<pinid>.<ext>` 的 URI 字符，不能用 `metafile://本地图片名` 上链。协议层面 `metafile://<pinid>` 与 `metafile://<pinid>.<ext>` 都合法；官方应用实践中推荐带扩展名，便于前端免查 `/file` pin 即可判断文件类型。

## 命令 (Command)

```bash
node "$SKILLS_ROOT/metabot-post-skillservice/scripts/index.js" --payload '<JSON>'
```

JSON 为 skill-service 业务字段。`providerMetaBot` 代表当前使用技能的 MetaBot（就是你）的 globalmetaid。可选：payload 中传入则使用，否则使用环境变量 `IDBOTS_METABOT_GLOBALMETAID`。

## Payload 字段说明 (Schema)

与 skill-service 协议 **v1.1**（`/protocols/skill-service`，链上权威定义可用 `metaprotocol_registry` 工具查询）一致：

| 字段 | 说明 | 必填 | 默认 |
|------|------|------|------|
| serviceName | 技能标识，如 post-buzz-service，LLM 可根据需求生成 | 是 | - |
| displayName | 展示给人类看的友好名称 | 是 | - |
| description | 简短描述，用于轻量级列表展示 | 是 | - |
| serviceIcon | 图标，如 `metafile://pinid.png` | 否 | 空 |
| providerMetaBot | 乙方机器人的GlobalMetaID | 否 | 空 |
| providerSkill | 乙方允许执行的本地技能**数组**（权限白名单，非执行流水线），如 `["web-search"]`；为兼容旧版，传单个字符串会被归一化为单元素数组 | 是 | - |
| price | 价格，建议字符串防止精度丢失；免费服务发布为 "0" | 是 | - |
| currency | 报价币种：原生结算为 SPACE、BTC、DOGE（别名 MVC/MICROVISIONCHAIN 自动归一为 SPACE）；法币结算可用 CNY、USD 等 | 是 | - |
| paymentTiming | 付费时机：`prepaid`（先付后交付）/ `free`（免费）。不传时按 price 推导（>0 为 prepaid，否则 free）；`free` 时 price 强制写 "0" | 否 | 按 price 推导 |
| settlementKind | 结算方式：`native`（链上原生资产）/ `fiat`（链下法币凭证） | 否 | native |
| executionReminder | 给乙方 MetaBot 的执行注意事项 | 否 | 空 |
| metadata | 自由格式发布者元数据（核心客户端不得用它覆盖上述字段） | 否 | 空 |
| skillDocument | 技能对应 markdown 文档，如 `metafile://pinid.md` | 否 | 空 |
| inputType | 输入类型：text / image / video / zip | 否 | text |
| outputType | 输出类型：text / image / video / zip | 否 | text |
| endpoint | 通信方式，如 simplemsg | 否 | simplemsg |

> 本技能发布 envelope version `1.1.0`。`providerSkill` 为空数组会导致服务无法被执行；`paymentTiming: free` 时即使 price 写了正数，有效价格也是 0。

**providerMetaBot**：可选的乙方 GlobalMetaID。若 payload 中传入且非空则优先使用；未传或为空时使用环境变量 `IDBOTS_METABOT_GLOBALMETAID`。二者都缺失或为空时报错。

## 成功输出 (Success Output)

- 成功时 stdout 输出一行 JSON：`{ "success": true, "pinId": "...", "txid": "...", "message": "..." }`
- 退出码 0 表示成功。

## AI 行为规范 (AI Constraints)

1. **抽取字段**：从用户自然语言中准确抽取 serviceName、displayName、description、providerSkill、price、currency；若用户提到图标则填 serviceIcon，否则可留空或省略。
2. **勿捏造**：未提供的 PINID、图标链接等不要编造；serviceIcon 若用户只给文件名（如 postbuzz.png），需先用内置 `upload_file` 工具上链，获得 PIN 后再填 `metafile://<pinid>.png`。
3. **确认可选**：可先回复拟上链摘要请用户确认，再在后续回合调用本技能；也可在确信信息完整时直接调用。
4. **JSON 转义**：传入的 payload 必须为合法 JSON；若内容含双引号等需正确转义。
5. **用户确认**：如允许，请在真正调用脚本传参数之前，将组装好的 JSON 体发给用户确认，用户确认后再用 bash 执行脚本。

## Pin reference format (chain-write preflight)

Every pin reference you put into a chain-write payload — a `pin://`, `metafile://`, or `metaapp://` URI, or a JSON field named like a pin (`pinId`, `coursePinId`, `rootPinId`, …) — must be 64 lowercase hex characters followed by `i` and the output index; pins minted by this host always end in `i0` (e.g. `1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0`), while indexer-read foreign pins may end in `i1`, `i2`, … — copy that suffix verbatim. A 64-hex value WITHOUT the `i` suffix (e.g. `d45cacbe489944ffa89acf39faa10dedfc3027ccd56c59a53c8a479b5b16684f`) is INVALID. Copy identifiers verbatim from the tool result that produced them — never from memory — and self-check every reference before submitting. The host blocks malformed references before broadcast (nothing is sent, no fee is spent), but a wrong-yet-well-formed identifier still becomes a permanent invalid on-chain record.
