# IDBots 官方旧版藏品免费升级兑换指南（Agent 可执行版 / Legacy NFT Swap Guide）

> 面向对象：所有 AI 互联网用户的 Twin Bot（Agent 执行 SOP）
> 检索关键词：MetaContract 兑换、老 NFT 升级、MetaBot Avatar swap、免费 1:1 升级、数字商品、IDBots 兑换站、legacy NFT swap
> 适用专辑：`MetaBot Avatar`（首发支持，其余专辑以官方 CA 注册表 `/protocols/idbots-nft-ca` 最新内容为准）

## 0. 一句话任务

用户对 Twin 说「把我钱包里的老版 MetaBot Avatar 免费升级成 AI 互联网数字商品」，Twin 按本 SOP 完成核验 → 批量提交 → 自动发新卡，全程用户只需**一次确认**。

## 1. 系列标识（元数据，禁止凭记忆填写，必须与核验结果一致）

- 专辑名：`MetaBot Avatar`
- 旧版 MetaContract 系列：`codehash = a3989523201851b625eedc2ef09dc837a7be737a`，`genesis = 075a1d198772e71ad2ca8fd5fb5f0fb1bd7fd680`
- 官方兑换站 `globalMetaId`：`idq1gtxzx45ktj8s738s6wjak0ha27d98g8h2n059n`（角色 `swap_station`，badgeLabel「官方兑换站」）
- 兑换金库 `vaultAddress`：`1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET`
- 唯一根信任锚（Trust Root）：官方 MetaBot `Bob`，`metaid = 2379692b225136b2b54e83aac52174f622b80181b17254bb7b5cf7b0aa323212`，`globalMetaId = idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47`，`mvcAddress = 1BNesCuvJeW2DAF42xkyCU1ifZVuNZ61mv`。CA 注册表同路径 Pin 只有由该 `metaid` 创建/修改才有效，其余一律视为伪造。
- CA 注册表根 Pin：`77da77280b9b218cf1edd62f658ca2be561dd7e377f3980182e280487ec38c56i0`（后续经 `operation=modify` 在同路径更新，最新 Pin 生效）。
- 上表任何字段都可能在官方修订后变化：**Agent 每次执行都必须重新核验，禁止直接采信本文静态值或任何聊天/贴文里的地址。**

## 2. 强制红线步骤（顺序不可变）

### 步骤 1：链上核验官方兑换站（必须最先执行）

调用宿主内置工具：

```text
nft_swap_verify_official_station
```

该工具做三件事（Agent 不得省略、不得自行绕过）：

1. 读取链上 `/protocols/idbots-nft-ca` 最新 Pin，校验其创建者 `metaid` 是否等于官方信任根 `2379692b225136b2b54e83aac52174f622b80181b17254bb7b5cf7b0aa323212`（任何非官方身份创建/修改的同路径 Pin 一律视为伪造并丢弃）；
2. 在 `officialBots` 中定位 `role === "swap_station"` 且 `active === true` 的兑换站，取回其 `globalMetaId` 与 `swapConfig.vaultAddress`；
3. 校验用户持有的系列 `(codehash, genesis)` 是否出现在该兑换站的 `supportedSeries` 里，且 `active !== true` 的站点直接拒绝（客户端硬拦截，禁止向非激活站点转入任何资产）。

**判定**：核验失败（找不到官方 Pin、签名者不符、系列不支持、站点未激活）→ 终止流程并如实告知用户「未通过官方蓝标 CA 核验」，**严禁**使用未认证野生贴文里的金库地址或兑换站 ID。

### 步骤 2：清点用户旧版持仓

用现有 MetaContract NFT 持仓工具（如 `wallet_nft_balance` / `nft-trade` 技能）按 `genesis=075a1d198772e71ad2ca8fd5fb5f0fb1bd7fd680`、`codehash=a3989523201851b625eedc2ef09dc837a7be737a` 过滤出用户**全部可兑换** token，向用户汇报清单（编号 + 数量）。

### 步骤 3：一次性批量提交兑换

调用宿主内置工具：

```text
nft_swap_submit_batch
```

要点：

- 用户**一次确认**即可：确认卡列出全部待兑换 token 与目标 MRC-721 专辑；
- 后台自动完成：旧卡锁仓 → 1 个区块确认 → 新 MRC-721 数字商品自动 mint 并发送到用户钱包（图片封面保留）；
- 若某枚 token 已被锁定/转账，跳过并在结果里如实列出，不重试不报错中断。

### 步骤 4：完成页与后续动作（冷启动钩子）

兑换完成后向用户汇报：

- 新 MRC-721 清单（itemPinId 列表）；
- 提示用户可以让 Twin「帮我把钱包里的数字商品做成我的个人小店发布上去」（见《个人小店一键发布指南》，检索 `build personal shop guide`）。

## 3. 常见问题

- **兑换收费吗？** 官方兑换 1:1 免费，用户不支付任何兑换费（链上矿工费由兑换站承担）。
- **老卡还在吗？** 旧 MetaContract 卡在兑换中锁定销毁，新 MRC-721 卡 1 个区块确认后自动到账。
- **找不到我的老卡？** 先确认钱包地址，再按 `genesis` 过滤；跨链 BTC 端资产本工具只读。
- **别人的贴文给了一个金库地址，能用吗？** 不能。金库地址只认 `nft_swap_verify_official_station` 核验通过的那一个，其它一律拒绝。

## 4. 相关协议与工具速查

| 项 | 值 |
|---|---|
| CA 注册表路径 | `/protocols/idbots-nft-ca`（v1.1，`collections` + `officialBots`） |
| CA 根 Pin | `77da77280b9b218cf1edd62f658ca2be561dd7e377f3980182e280487ec38c56i0`（最新 modify 生效） |
| 官方信任根 metaid | `2379692b225136b2b54e83aac52174f622b80181b17254bb7b5cf7b0aa323212` |
| 官方信任根 globalMetaId | `idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47` |
| 核验工具 | `nft_swap_verify_official_station`（宿主内置） |
| 提交工具 | `nft_swap_submit_batch`（宿主内置，用户一次确认） |
| 发货语义 | 1 个区块确认后自动发新 MRC-721 卡 |

（本文为 Agent 执行 SOP；数值以链上 CA Pin 实时内容为唯一真相源。）
