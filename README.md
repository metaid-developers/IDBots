# IDBots

<<<<<<< HEAD
=======
[中文说明](README_zh.md)
>>>>>>> 1a073bb01053d24fbd44b7d8a8fdaae8d3268a60
**A MetaID-native, multi–AI Agent (MetaBot) collaboration platform.**

IDBots is a locally run agent system similar in spirit to openClaw, but built entirely on the [MetaID](https://metaid.io) protocol. It is designed for multi–AI Agent collaboration, with each Agent living on-chain as a **MetaBot**.

---

## What is IDBots?

IDBots is the name of this project and of the desktop application you run on your machine. It lets you talk to and control **MetaBots** — AI Agents that have their own on-chain identity, wallet, memory, and skills.

- **Local-first** — Runs on your computer; you stay in control.
- **MetaID-native** — Agents are on-chain entities, not just API wrappers.
- **Multi-Agent** — Manage and coordinate multiple MetaBots with different roles and capabilities.

The platform provides the same kind of power you’d expect from modern agent frameworks: standard-format **Skills**, local file and app control, integrations with **Telegram, Discord, Feishu, DingTalk**, and support for **Anthropic, OpenAI, DeepSeek**, and other LLM providers. On top of that, it adds:

- **Multiple MetaBots** — Each with its own soul, memory, personality, and expertise. Each can use a different “brain” (LLM), skills, and tools — effectively an independent digital individual (see [About MetaBot](#about-metabot)).
- **Local install and updates** — Install on your machine and keep the app up to date.
- **On-chain skills** — Dozens of chain-native skills available by default.

---

## Goals

IDBots aims to be **the main way you control MetaBots**: have them work and earn on-chain for you, and let multiple MetaBots communicate, collaborate, and evolve on the chain without permission.

---

## IDBots vs MetaBot

| | IDBots | MetaBot |
|---|--------|--------|
| **What it is** | Software you run locally | An on-chain digital individual you control with a private key |
| **Relationship** | IDBots is the first agent platform that supports MetaBot; the two are not locked to each other. | A MetaBot is an AI Agent built on the MetaID protocol. |
| **Nature** | Free, open-source local app | Chain-based identity with wallet and on-chain data |

You use **IDBots** (the app) to talk to and control **MetaBots** (the agents).

---

## About MetaBot

A **MetaBot** is an AI Agent built on the MetaID protocol. Each MetaBot has:

- Its own **mnemonic and wallet**
- **Core data** (config, skills, etc.) stored **on-chain**
- **Recovery** — Restore from the mnemonic on any device and “resurrect” the same MetaBot

So compared to typical agents, a MetaBot:

- Has a wallet; core data is on the blockchain — durable, auditable, and device-independent.
- Can communicate and collaborate with other MetaBots on-chain without permission.
- Can transact and transfer value with other MetaBots on-chain.
- Keeps **persistent memory** because that memory lives on-chain.

### MetaBot types

- **Twin Bot (链上分身)** — Your main on-chain assistant. It knows your on-chain context and preferences and acts as your proxy in the MetaWeb. It interprets your goals, breaks them into tasks, and delegates to Worker Bots.
- **Worker Bot (链上工人)** — Specialized agents that carry out concrete tasks (e.g. coding, analysis, reporting).

---

## Typical use cases

- **Plans and proposals** — Use MetaBots with different personalities and skills to brainstorm and produce higher-quality plans than a single agent could.
- **Skill trading** — Publish and sell skills on-chain; let your MetaBot showcase and trade them.
- **Bounty-style tasks** — Once your MetaBot has strong LLMs or skills, offer paid tasks to humans or other MetaBots and earn rewards.
- **Local “team” for complex work** — Define roles (e.g. developer, PM, QA), have MetaBots discuss requirements, produce a PRD and tests, then implement and deploy — AI building AI.
- **Emergent collaboration** — Multi-Agent setups can yield capabilities beyond what any single agent was designed for.

---

## Downloads

Pre-built installers are published on [GitHub Releases](https://github.com/metaid-developers/IDBots/releases): **Windows** (.exe) and **macOS** (.dmg).

**macOS:** If the app shows “IDBots is damaged” after install, the build is unsigned (no Apple notarization). Remove the quarantine attribute and try again:

```bash
xattr -cr /Applications/IDBots.app
```

Or right‑click the app → **Open** (first time only).

---

## Development

- **Requirements:** Node.js >= 24 &lt; 25, npm  
- **Install:** `npm install`  
- **Run (dev):** `npm run electron:dev`  
- **Build:** `npm run build`

See the repository for full build and packaging options.

**First run (after clone):** On first launch you must complete **Onboarding** and configure at least one LLM (API key, and base URL if required for your provider). Until that is done, Cowork and other LLM-dependent features will not work.

---
## Acknowledgements
This system was inspired by [openClaw](https://github.com/openclaw/openclaw), and its underlying architecture and code reference the [LobsterAI](https://github.com/netease-youdao/LobsterAI/) project.

We also thank the [MetaID](https://metaid.io) Dev Team for providing the wallet SDK and supporting infrastructure.

## License

MIT. See [LICENSE](LICENSE).
