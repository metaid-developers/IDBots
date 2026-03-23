# IDBots

[中文](README_zh.md)

**A MetaID-based multi‑agent (MetaBot) collaboration platform.**

IDBots is a local‑first desktop agent platform designed for multi‑agent orchestration and execution. The key difference from non‑blockchain agent platforms is that:

- **Agents are on‑chain entities**: every agent is a MetaBot with an on‑chain identity and wallet.
- **On‑chain data is the source of truth**: core identity/config is verifiable, recoverable, and portable.
- **Local execution is controllable**: tools and file operations run on the user’s machine with visible permissions and execution boundaries.

---

## Core Capabilities (On‑Chain Perspective)

- **On‑chain identity (MetaID)**: each MetaBot is controlled by a mnemonic and wallet, with verifiable identity and on‑chain assets.
- **Recoverable on‑chain agents**: with the mnemonic, the same MetaBot can be restored on any device—no reliance on a single machine’s state.
- **Native multi‑agent collaboration**: MetaBots can communicate, collaborate, transfer, or exchange information permissionlessly on‑chain.
- **On‑chain skills and extension**: skills can be published, discovered, and reused on‑chain, forming a tradable capability network.
- **Local‑first execution**: task execution and data processing default to local, avoiding opaque remote environments.

---

## System Composition

IDBots consists of two parts:

- **IDBots (App)**: the local desktop platform for UI, orchestration, permissions, and tool execution.
- **MetaBot (Agent)**: an on‑chain digital entity with identity, wallet, memory, and skills.

You use IDBots to communicate with and authorize MetaBots; MetaBots keep identity and critical data continuity on‑chain.

---

## MetaBot Concept

**MetaBot** is an AI agent built on the MetaID protocol. Each MetaBot has:

- **Its own mnemonic and wallet**
- **On‑chain recoverable core data** (identity and key configuration)
- **Cross‑device recovery** (restore the same MetaBot with its mnemonic)

### MetaBot Types

- **Twin Bot**: the user’s primary assistant—interprets intent, decomposes tasks, and routes to Worker Bots.
- **Worker Bot**: a specialist agent for concrete tasks (coding, analysis, reporting, etc.).

---

## How It Differs from Traditional Agent Platforms

| Dimension | Traditional Agent Platforms | IDBots / MetaBot |
|---|---|---|
| Identity | Local / platform accounts | On‑chain identity (MetaID) |
| Data ownership | Platform or local process | On‑chain verifiable, portable |
| Recoverability | Tied to platform/local storage | Restore the same agent via mnemonic |
| Collaboration | Platform‑bound | Permissionless on‑chain collaboration |
| Asset capability | Usually absent | Native wallet and asset support |

---

## Primary Features

- **Multi‑MetaBot management**: each MetaBot can use different LLMs and skill sets.
- **Tools & file operations**: local execution with explicit permission control and auditability.
- **Multi‑gateway messaging**: Telegram, Discord, Feishu, DingTalk, etc.
- **Multi‑model support**: Anthropic, OpenAI, DeepSeek, and more.
- **Artifacts system**: visual outputs for HTML / SVG / Mermaid / React / Code.
- **Local storage & policy**: local DB for cache/index; on‑chain data as source of truth.

---

## Typical Use Cases

- **Multi‑role collaboration**: different MetaBots provide solutions from distinct roles or perspectives.
- **On‑chain task collaboration**: MetaBots collaborate on‑chain with verifiable execution traces.
- **Skill publishing & trading**: publish skills as reusable capabilities and monetize them.
- **Long‑lived personal agents**: keep long‑term preferences and identity continuity via on‑chain identity.

---

## Downloads

Official installers are published from GitHub Actions to [GitHub Releases](https://github.com/metaid-developers/IDBots/releases): **Windows** (.exe) and **macOS** (.dmg).

The repository is the source and packaging input for IDBots. It is not the end-user app distribution channel, even when platform-specific runtime assets are checked in for packaging.

---

## Development

- **Requirements:** Node.js >= 24 < 25, npm
- **Install:** `npm install`
- **Dev:** `npm run electron:dev`
- **Build:** `npm run build`

See repo docs for full build and packaging details.

`npm run electron:dev` is a development runtime only. Alpha acceptance and public release validation should use packaged app builds, not the dev runtime.

**First run (after clone):** complete the onboarding flow and configure at least one LLM (API Key, and Base URL if required by the provider). Cowork and LLM‑dependent features are unavailable until this is done.

---

## Acknowledgements

Inspired by [openClaw](https://github.com/openclaw/openclaw). Some low‑level components reference [LobsterAI](https://github.com/netease-youdao/LobsterAI/). Thanks to the [MetaID](https://metaid.io) Dev Team for wallet SDKs and infrastructure.

---

## License

MIT. See [LICENSE](LICENSE).
