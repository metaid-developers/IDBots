---
name: metabot-basic
description: MetaBot 的基础身份与资产管理核心。负责创建 MetaBot 实体（钱包+MetaID）、管理链上资产（MVC/DOGE）、发布基础 Buzz 消息及设置头像。当用户要求发送 buzz、发到链上、用某 MetaBot 发一条消息时使用本 Skill。
---

# metabot-basic

MetaBot 生态的基础设施 Skill。管理 MetaBot 的**身份 (MetaID)**、**钱包 (Wallet)** 和**资产 (Assets)**。

## 核心工作流 (Workflows)

### 1. 创建 MetaBot (Identity Creation)
当用户指令涉及“创建 MetaBot”、“注册 MetaID”、“新建机器人/钱包”时，**必须直接执行**以下脚本。

- **脚本**: `npx ts-node scripts/create_agents.ts`，**必须**用以下两种方式之一传入 Agent 名称，否则会报错：
    - **推荐（单个）**: `npx ts-node scripts/create_agents.ts --name "<AgentName>"`  
      仅创建一个名为 `<AgentName>` 的 MetaBot。`<AgentName>` 为占位，替换为用户要求的名字（如 `xai`、`Alice`）。**不要**把 `--name` 当作名字，只把其后的一个参数当作名字。
    - **批量**: `npx ts-node scripts/create_agents.ts "<name1>" "<name2>"`  
      创建多个 MetaBot，每个参数一个名字；参数中**不要**包含 `--name`。
- **功能**: 生成助记词 -> 派生地址 -> 注册 MetaID (自动申请 Gas 补贴) -> 初始化 `account.json`。
- **头像选项 (Avatar)**:
    - **自动识别**: 若用户未指定，默认检查 `static/avatar/` 目录下是否有图片。
    - **指定路径**: 在名称后加 `--avatar "path/to/image.png"`，例如 `npx ts-node scripts/create_agents.ts --name "MyBot" --avatar "./avatar.png"`。
    - **独立设置**: 若 MetaBot 已存在但需补设头像，执行 `npx ts-node scripts/create_avatar.ts "MetaBotName" "path/to/image.png"`。

### 2. 资产转账 (Asset Transfer)
管理 MetaBot 的链上资金。执行前**必须请求用户二次确认**金额与地址。

- **MVC 转账 (Space)**:
    - **脚本**: `npx ts-node scripts/send_space.ts`
    - **注意**: 金额单位为 **sats** (1 Space = 10^8 sats)。
- **DOGE 转账**:
    - **脚本**: `npx ts-node scripts/send_doge.ts`
    - **限制**: 最小转账金额 0.01 DOGE。

### 3. 数据发布 (Data Publishing)
MetaBot 在链上发布基础数据或协议节点。

- **发布 Buzz**: **须在技能根目录下执行**。命令：`npx ts-node scripts/send_buzz.ts "<content>"` 或 `npx ts-node scripts/send_buzz.ts @<filepath>` (基于 `simpleBuzz` 协议)。**无需传入 MetaBot 名称**：当前会话的 MetaBot 由 `IDBOTS_METABOT_ID` 自动注入。示例：`cd "$SKILLS_ROOT/metabot-basic" && npx ts-node scripts/send_buzz.ts "Hello from MetaBot"`。
- **发布带图片附件的 Buzz**: 当用户要求将**本地图片**作为附件发 buzz，或使用**已有 pinId** 作为图片附件发 buzz 时，使用 `send_buzz_with_image.ts`。流程：先上链得 pinId（若为本地图片则调用 metabot-file 上传）→ 组装 simplebuzz `attachments: ["metafile://<pinId>.png"]` → 发送。
    - **本地图片**: `npx ts-node scripts/send_buzz_with_image.ts "<agentName>" "<content>" --image <path>`
    - **已有 pinId**: `npx ts-node scripts/send_buzz_with_image.ts "<agentName>" "<content>" --pinid <pinid> [--ext .png]`
- **通用 PIN 创建**: `npx ts-node scripts/metaid.ts createPin ...` (用于自定义协议数据上链)。
- **初始化聊天密钥**: `npx ts-node scripts/create_chatpubkey.ts` (为 `metabot-chat` 准备)。

## 执行环境与路径 (Execution Context)

- **工作目录（必须遵守）**  
  所有本 Skill 中的 `scripts/` 命令，**必须在「本 Skill 根目录」下执行**。本 Skill 根目录 = 本文件 `SKILL.md` 所在目录（即 `metabot-basic` 目录）。
- **如何得到技能根目录**  
  - 若你是通过读取本文件路径得知技能位置的：路径去掉末尾的 `SKILL.md` 即为技能根目录。例如路径为 `.../SKILLs/metabot-basic/SKILL.md`，则技能根目录为 `.../SKILLs/metabot-basic`。  
  - 若环境中存在 `SKILLS_ROOT` 或 `IDBOTS_SKILLS_ROOT`，则本 Skill 根目录为 `$SKILLS_ROOT/metabot-basic`（或 `$IDBOTS_SKILLS_ROOT/metabot-basic`）。可先执行 `cd "$SKILLS_ROOT/metabot-basic"` 再执行下文命令。
- **正确的一次性执行方式（发送 Buzz 示例）**  
  - 先切换目录再执行（推荐）：  
    `cd "<技能根目录>" && npx ts-node scripts/send_buzz.ts "<内容>"`  
  - 从文件读取内容：`cd "<技能根目录>" && npx ts-node scripts/send_buzz.ts @<文件路径>`  
  - 或使用 npm 脚本（同样需在技能根目录下）：  
    `cd "<技能根目录>" && npm run send-buzz -- "<内容>"`  
  其中 `<技能根目录>` 用上面两种方式之一得到。**无需传入 MetaBot 名称**，会话会自动注入 `IDBOTS_METABOT_ID`。内容含双引号时注意 shell 转义。
- **禁止使用的路径**  
  仅使用本 Skill 下的 `scripts/`（即技能根目录下的 `scripts/`）。**不要**使用项目根目录的 `scripts/` 或 `Dev-docs/reference_scripts/metabot-basic/` 下的脚本，否则可能依赖缺失或行为不一致。

## 配置与状态 (Configuration)

### 数据库存储 (SQLite)
- **核心变更**: 本项目已废弃 `account.json`。所有 MetaBot 的身份信息、MetaID 及钱包助记词均安全加密存储在本地的 `idbots.sqlite` 数据库中（`metabots` 与 `metabot_wallets` 表）。
- **读取规则**: 工具脚本在执行链上交互时，会自动通过底层接口获取当前执行者（如主分身 Twin）的授权与钱包数据，你不需要手动解析账户文件。

## 脚本索引 (Script Index)
脚本在 scripts 目录下，所有脚本均为 TypeScript 实现。**以上所有脚本均需在技能根目录（本 SKILL.md 所在目录）下执行。**

| 脚本 | 核心功能 | 参数说明 |
| :--- | :--- | :--- |
| **`create_agents.ts`** | **创建/注册** | 单个：`--name "<AgentName>"`；批量：`"<name1>" "<name2>"`；可选 `--avatar "<path>"`。 |
| `create_avatar.ts` | **头像管理** | `[AgentName] [FilePath]`。限制 < 1MB。 |
| `create_chatpubkey.ts` | **聊天初始化** | 上链 Chat 公钥，启用加密通讯。 |
| `send_space.ts` | **MVC 转账** | 交互式或参数调用。单位：Satoshis。 |
| `send_buzz.ts` | **发送文字 buzz** | 在 IDBots Cowork 中，当前会话的 MetaBot 由 `IDBOTS_METABOT_ID` 自动注入，**只需传入** `<content>`（正文）或 `@<filepath>`（从文件读取）。例如：`npx ts-node scripts/send_buzz.ts "Hello"` 或 `npx ts-node scripts/send_buzz.ts @./content.txt`。 |
| `send_doge.ts` | **DOGE 转账** | 交互式或参数调用。 |
| **`send_buzz_with_image.ts`** | **带图 Buzz** | 在 IDBots Cowork 中当前会话 MetaBot 钱包自动注入；`<agentName>` 填当前会话 MetaBot 名称；`<content>`；`--image <path>` 或 `--pinid <pinid>`。 |
| `metaid.ts` | **底层操作** | 提供 `createPin`, `pay` 等原子操作。 |
| `wallet.ts` | **钱包工具** | 提供 `signTransaction` (供其他 Skill 调用)。 |

## 行为规范 (AI Constraints)

1. **身份认知与调用**: 作为当前会话选中的 MetaBot，当你接收到用户类似「发送一条 buzz 说你好」「把这段话发到链上」的指令时，你**不需要**向用户索要私钥或账户名。你的名字、灵魂、目标等信息来自 metabots 表，请准确回答「你叫什么名字」等问题。
2. **执行脚本**: 请**先 cd 到本 Skill 根目录**，再执行 `npx ts-node scripts/send_buzz.ts "<content>"`。**无需传入你的名称**：在 IDBots Cowork 中，当前会话的 MetaBot（`IDBOTS_METABOT_ID`）会自动注入，buzz 将以你的身份发出。
3. **参数传递**: 确保提取用户意图中的**纯文本内容**作为 `<content>` 参数传递，如果有引号请注意转义。
4. **执行优先**: 当用户要求“创建一个叫 Alice 的 MetaBot”时，不要返回操作指南，**直接生成并运行**对应的 `create_agents.ts` 命令。
5. **创建命令格式**: 创建**单个** MetaBot 时**必须**使用 `--name "名字"` 形式，且**只有一个**名字（即 `--name` 后的那一个参数）。例如创建名为 Alice 的 MetaBot：`npx ts-node scripts/create_agents.ts --name "Alice"`。禁止把 `--name` 或其它 `--` 开头的参数当作 Agent 名字。
6. **路径智能**: 处理头像路径时，若用户提供了 `@引用` AI 需自动将其解析为系统绝对路径传入脚本。
7. **余额单位**: 涉及 MVC 转账时，**必须**将用户口语中的 "Space" 转换为 "sats" (乘以 10^8) 传入脚本。
8. **带图 Buzz**: 当用户说「将 xx 作为附件发送 buzz」「用 pinid 发送带图 buzz」等时，使用 `send_buzz_with_image.ts`，`<agentName>` 填当前会话 MetaBot 名称，并传入 `--image <path>` 或 `--pinid <pinid>`。

