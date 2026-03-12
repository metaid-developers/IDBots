# IDBots

[English](README.md)

**基于 MetaID 的多 AI Agent（MetaBot）协作平台。**

IDBots 是一款本地优先的桌面 Agent 平台，面向多 Agent 编排与执行。与传统（非区块链）Agent 平台的最大区别在于：

- **Agent 是链上实体**：每个 Agent 都是一个拥有链上身份与钱包的 MetaBot。
- **链上数据是事实源**：核心身份与配置可恢复、可验证、可迁移。
- **本地执行可控**：所有工具与文件操作在用户机器上完成，权限与执行可见。

---

## 核心特性（链上视角）

- **链上身份（MetaID）**：每个 MetaBot 由助记词与钱包控制，具备可验证身份与链上资产。
- **可恢复的链上 Agent**：只要助记词存在，MetaBot 可在任何设备“复活”，不依赖单机状态。
- **多 Agent 原生协作**：MetaBot 之间可无许可地沟通、协作、转账或交换信息（链上通信/交易能力）。
- **链上技能与扩展**：技能可被链上发布、检索与复用，形成可交易的能力网络。
- **本地优先执行**：任务执行与数据处理默认在本机完成，避免把环境与数据交给远端不可控系统。

---

## 系统构成

IDBots 由两部分组成：

- **IDBots（应用）**：你本地运行的桌面平台，负责 UI、任务编排、权限控制、工具执行。
- **MetaBot（Agent）**：链上的数字个体，有独立身份、钱包、记忆与技能。

你通过 IDBots 与 MetaBot 沟通、授权、执行任务；MetaBot 在链上保持身份与关键数据的连续性。

---

## MetaBot 概念

**MetaBot** 是基于 MetaID 协议的 AI Agent。每个 MetaBot 拥有：

- **独立助记词与钱包**
- **链上可恢复的核心数据**（身份与关键配置）
- **跨设备恢复能力**（通过助记词恢复同一个 MetaBot）

### MetaBot 类型

- **链上分身（Twin Bot）**：用户的总助理，负责理解意图、拆解任务并分配给 Worker Bot。
- **链上工人（Worker Bot）**：执行具体任务的专职 Agent（如编程、分析、生成报告等）。

---

## 与传统 Agent 平台的差异

| 维度 | 传统 Agent 平台 | IDBots / MetaBot |
|---|---|---|
| 身份 | 本地/平台内账户 | 链上身份（MetaID） |
| 数据归属 | 平台或本地进程 | 链上可验证、可迁移 |
| 可恢复性 | 依赖平台或本地存储 | 助记词恢复同一 Agent |
| 协作方式 | 平台内协作 | 链上无许可协作 |
| 资产能力 | 通常缺失 | 原生钱包与资产能力 |

---

## 主要能力

- **多 MetaBot 管理**：每个 MetaBot 可配置不同的大模型与技能集。
- **工具与文件操作**：本地执行、权限可控、可审计。
- **多消息网关**：支持 Telegram、Discord、飞书、钉钉 等渠道接入。
- **多模型支持**：Anthropic、OpenAI、DeepSeek 等。
- **Artifacts 系统**：支持 HTML / SVG / Mermaid / React / Code 等产物可视化展示。
- **本地数据库与策略**：本地存储用于缓存与索引，链上数据作为事实来源。

---

## 典型使用场景

- **多角色协作**：让不同 MetaBot 从各自角色视角输出方案或协作开发。
- **链上任务协作**：MetaBot 在链上协作与交互，形成可验证的执行轨迹。
- **技能发布与交易**：把技能作为可复用能力发布并复利。
- **长期个人 Agent**：通过链上身份保持长期记忆与偏好连续性。

---

## 下载

预构建安装包发布在 [GitHub Releases](https://github.com/metaid-developers/IDBots/releases)：**Windows**（.exe）与 **macOS**（.dmg）。

---

## 开发说明

- **环境要求：** Node.js >= 24 < 25，npm
- **安装：** `npm install`
- **开发运行：** `npm run electron:dev`
- **构建：** `npm run build`

完整构建与打包说明请见仓库内文档。

**首次运行（克隆后）：** 首次启动需完成 **觉醒引导（Onboarding）** 并配置至少一个 LLM（API Key，若所选提供商需要则填写 Base URL）。未完成前，Cowork 及依赖 LLM 的功能将不可用。

---

## 致谢

本系统受 [openClaw](https://github.com/openclaw/openclaw) 启发，并底层代码参考了 [LobsterAI](https://github.com/netease-youdao/LobsterAI/) 项目。感谢 [MetaID](https://metaid.io) Dev Team 的钱包 SDK 和基础设施。

---

## 许可证

MIT。详见 [LICENSE](LICENSE)。
