# P2P 区块链数据同步功能设计文档

**日期**: 2026-03-20
**项目**: IDBots
**状态**: 待实施

---

## 1. 背景与目标

### 现状

IDBots 当前的数据下行链路依赖中心化架构：

```
区块链 → 索引器服务商（manapi.metaid.io）→ API → 本地客户端 → SQLite → 渲染
```

这带来两个核心问题：
1. **中心化依赖**：数据获取依赖团队运营的中心化节点，违背 MetaID 协议去中心化理念
2. **带宽瓶颈**：历史上曾因节点带宽不足导致服务中断，无法支撑大规模用户

### 目标

将数据下行链路改造为 P2P 架构：

```
区块链 → P2P 网络（用户节点互相同步）→ 本地索引器 → 本地 PebbleDB → 渲染
```

- 每个 IDBots 实例既是数据消费者，也是数据提供者
- 中心化 API 仅作冷启动兜底，长期可完全去除
- 支持灵活配置同步范围，满足不同用户需求

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    IDBots (Electron)                     │
│                                                          │
│  Renderer (React)          Main Process (Node.js)        │
│  ┌──────────────┐          ┌──────────────────────────┐  │
│  │ P2P 状态面板 │◄──IPC───►│ p2pIndexerService.ts     │  │
│  │ 同步进度     │          │ (子进程生命周期管理)      │  │
│  │ 节点数量     │          └──────────┬───────────────┘  │
│  └──────────────┘                     │ HTTP localhost    │
└──────────────────────────────────────┼──────────────────┘
                                        │
                    ┌───────────────────▼──────────────────┐
                    │        man-p2p (Go 子进程)            │
                    │                                       │
                    │  ┌──────────┐  ┌──────────────────┐  │
                    │  │ HTTP API │  │   P2P Layer       │  │
                    │  │ :7281    │  │  (libp2p)         │  │
                    │  └────┬─────┘  │  DHT + GossipSub  │  │
                    │       │        │  + Content Pull   │  │
                    │  ┌────▼─────┐  └────────┬─────────┘  │
                    │  │PebbleDB  │◄───────────┘            │
                    │  │(本地 PIN │                         │
                    │  │ 缓存)    │                         │
                    │  └──────────┘                         │
                    │                                       │
                    │  数据源优先级：                        │
                    │  1. P2P 网络（主）                    │
                    │  2. 本地 PebbleDB 缓存                │
                    │  3. 区块链 RPC 节点（补全）           │
                    │  4. 中心化 API（冷启动兜底）          │
                    └───────────────────────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────┐
                    │           P2P 网络                    │
                    │  Bootstrap/Relay 节点（团队运营）     │
                    │  ┌──────┐  ┌──────┐  ┌──────┐        │
                    │  │Node A│  │Node B│  │Node C│  ...   │
                    │  └──────┘  └──────┘  └──────┘        │
                    └───────────────────────────────────────┘
```

**核心原则**：IDBots 不感知数据来源，所有 PIN 查询统一走本地 `localhost:7281`，数据来源透明化由 man-p2p 内部处理。

---

## 3. man-p2p：Go 索引器内核

### 3.1 融合策略

新建 `man-p2p` 项目，以 MAN 为基础，融合 meta-file-system 的补充能力，再加 libp2p P2P 层：

```
MAN（基础）
├── PIN 完整索引（含 MRC20 代币协议）
├── PebbleDB 16 分片存储
├── 多链支持（BTC/MVC/DOGE）
├── ZMQ mempool 实时追踪
├── 跨链 teleport 验证
└── 现有 HTTP API

+ 从 meta-file-system 移植
├── 用户信息索引（avatar/name/chatpubkey，Redis 缓存替换为纯 PebbleDB）
└── 文件内容检索（按 PIN ID 返回原始内容）

+ 新增 P2P 层
├── p2p/host.go          — libp2p 节点初始化、DHT、持久化身份
├── p2p/gossip.go        — GossipSub 新 PIN 实时广播/接收
├── p2p/sync.go          — 内容寻址历史数据拉取
├── p2p/subscription.go  — 订阅/屏蔽过滤器
└── p2p/relay.go         — NAT 穿透 + relay 节点管理
```

### 3.2 P2P 数据流

**上行（本地新 PIN → 广播）：**
```
用户发布 PIN 上链
  → 本地 RPC/ZMQ 扫描到新 PIN
  → 写入 PebbleDB
  → GossipSub 广播 PIN 元数据
    （PIN ID + 路径 + 发布者地址，不含内容）
  → 订阅了该地址的节点收到通知
  → 节点按需拉取完整 PIN 内容
```

**下行（网络新 PIN → 同步到本地）：**
```
GossipSub 收到广播
  → subscription 过滤器判断：在订阅范围内？未被屏蔽？
  → 是 → 向 DHT 查询持有该 PIN 的节点
       → 拉取完整 PIN 数据
       → 异步验证（txid 链上确认）
       → 验证通过 → 写入本地 PebbleDB
  → 否 → 丢弃（full 模式下全部接收）
```

### 3.3 节点身份

每个 IDBots 实例生成一个持久化 libp2p 私钥，存于本地用户数据目录，与 MetaBot 钱包密钥完全独立。Peer ID 由该私钥派生，全网唯一。

### 3.4 NAT 穿透（三层兜底）

1. **libp2p AutoNAT + hole punching** — 覆盖大多数家用网络
2. **团队运营 relay 节点** — 严格 NAT 场景兜底（relay 节点只中继连接，不存储数据，带宽压力极低）
3. **mDNS 局域网发现** — 同局域网节点直连，无需穿透

---

## 4. 同步范围配置

### 4.1 三种同步模式

| 模式 | 说明 | 存储 | 带宽 | 适用场景 |
|------|------|------|------|---------|
| `self` | 只同步自己 MetaBot 发布的 PIN | 极小 | 极低 | 普通用户 |
| `selective` | 同步指定地址/路径的 PIN | 中等 | 中等 | 关注特定用户/协议 |
| `full` | 全量同步所有 PIN | 大 | 高 | SKILL 服务商、重度节点 |

`full` 模式节点同时承担数据中继角色，帮助网络中其他节点获取数据，形成正向激励。

### 4.2 配置结构

存入 IDBots SQLite `kv` 表，key 为 `p2p_config`：

```json
{
  "p2p_sync_mode": "selective",

  "p2p_selective_addresses": [
    "1A2B3C..."
  ],
  "p2p_selective_paths": [
    "/protocols/simplemsg",
    "/info/*"
  ],

  "p2p_block_addresses": [
    "1SPAM1..."
  ],
  "p2p_block_paths": [
    "/files/*.mp4",
    "/files/*.zip",
    "/files/*.iso"
  ],
  "p2p_block_content_size_kb": 512,

  "p2p_bootstrap_nodes": [
    "/ip4/1.2.3.4/tcp/4001/p2p/QmXxx..."
  ],
  "p2p_enable_relay": true,
  "p2p_storage_limit_gb": 10
}
```

**屏蔽规则优先级高于订阅规则**：即使某地址在 `selective_addresses` 中，只要同时在 `block_addresses` 中，就不同步。`block_content_size_kb` 允许只同步 PIN 元数据，不拉取大文件内容。

---

## 5. Electron 集成

### 5.1 新增服务

**`src/main/services/p2pIndexerService.ts`**：

- 启动/停止 man-p2p Go 子进程
- 健康检查（HTTP `/health` 轮询，30s 间隔）
- 崩溃自动重启（指数退避，最大 5 次）
- 日志转发到 renderer
- 代理所有 PIN 查询请求

### 5.2 现有代码改动

**`src/main/services/metaidCore.ts`** — `getPinData()`：

```
改动前：先查本地 SQLite metaid_pins 表 → 再调 manapi.metaid.io
改动后：先查本地 SQLite metaid_pins 表 → 再调 localhost:7281 → 兜底 manapi.metaid.io
```

**`src/main/services/privateChatDaemon.ts`** 等其他调用 manapi 的地方同理，统一走本地 API。

### 5.3 新增 IPC 接口

```typescript
// renderer → main
'p2p:getStatus'   // 获取节点状态（peer 数、同步进度、数据来源分布）
'p2p:getConfig'   // 获取同步配置
'p2p:setConfig'   // 更新同步配置
'p2p:getPeers'    // 获取已连接节点列表

// main → renderer（事件推送）
'p2p:statusUpdate'   // 节点状态变化
'p2p:syncProgress'   // 同步进度更新
```

### 5.4 Go 二进制分发

随 IDBots 安装包打包，存放于 Electron `extraResources` 目录：

| 平台 | 文件名 |
|------|--------|
| macOS ARM64 | `man-p2p-darwin-arm64` |
| macOS x64 | `man-p2p-darwin-x64` |
| Windows x64 | `man-p2p-win32-x64.exe` |
| Linux x64 | `man-p2p-linux-x64` |

主进程通过 `process.resourcesPath` 定位二进制文件，参考现有 `createPinWorker.js` 的子进程管理模式。

---

## 6. 数据一致性与验证

### 6.1 PIN 验证策略（分级）

```
收到 P2P 广播的 PIN
  │
  ├─ 快速验证（同步，毫秒级）
  │   ├── PIN ID 格式合法（txid:vout）
  │   ├── 发布者地址格式合法
  │   └── 内容大小未超过配置限制
  │
  ├─ 异步验证（后台，秒级）
  │   ├── 向链上 RPC 确认 txid 存在
  │   └── 验证通过 → 写入 PebbleDB，标记 verified=true
  │
  └─ 信任加速（已验证节点）
      └── 来自高信誉 peer 的数据可跳过链上验证
          （信誉基于历史验证通过率，防止滥用）
```

### 6.2 冷启动策略

1. 首次启动，P2P 网络节点数为 0
2. 自动降级到中心化 API（`manapi.metaid.io`）获取数据
3. 后台同时尝试连接 bootstrap 节点
4. 一旦 P2P 连接建立，逐步切换数据源
5. UI 显示当前数据来源状态（P2P / 本地缓存 / 中心化 API）

---

## 7. 实施阶段

### 阶段一：man-p2p 内核开发（Go）

1. 以 MAN 为基础，移植 meta-file-system 的用户信息索引和文件内容检索
2. 集成 go-libp2p：节点身份、DHT、GossipSub、内容拉取
3. 实现订阅/屏蔽过滤器
4. 实现 NAT 穿透（AutoNAT + relay）
5. 实现 PIN 分级验证
6. 多平台交叉编译

### 阶段二：Electron 集成

1. 新增 `p2pIndexerService.ts` 子进程管理
2. 改造 `metaidCore.ts` 等现有 API 调用
3. 新增 IPC 接口
4. 打包配置（extraResources）

### 阶段三：UI 与配置

1. P2P 状态面板（节点数、同步进度、数据来源）
2. 同步范围配置界面（模式选择、订阅/屏蔽列表）
3. 存储用量显示

### 阶段四：网络基础设施

1. 部署 bootstrap 节点（至少 3 个，分布不同地区）
2. 部署 relay 节点（NAT 穿透兜底）
3. 监控 P2P 网络健康状态

---

## 8. 关键风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| NAT 穿透失败率高 | 中 | 中 | relay 节点兜底，确保所有用户可连接 |
| P2P 网络冷启动期体验差 | 高 | 中 | 中心化 API 兜底，UI 透明展示数据来源 |
| 恶意节点传播伪造 PIN | 低 | 高 | 链上 txid 验证，信誉系统 |
| Go 二进制跨平台兼容问题 | 中 | 中 | CI 多平台交叉编译测试 |
| PebbleDB 存储膨胀（full 模式） | 中 | 低 | `p2p_storage_limit_gb` 配置上限 |

---

## 9. 相关项目

- **IDBots**: `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots-indev`
- **MAN（索引器主体）**: `/Users/tusm/Documents/MetaID_Projects/man`
- **meta-file-system（补充参考）**: `/Users/tusm/Documents/MetaID_Projects/meta-file-system`
- **man-p2p（待创建）**: 融合上述两者 + libp2p P2P 层的新项目
