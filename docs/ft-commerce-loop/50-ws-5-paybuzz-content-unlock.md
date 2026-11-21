# WS-5 开发任务书（实用标杆 2）：链上加密付费阅读 `/protocols/paybuzz`

- **负责范围**：`IDBots`（加密内容打包/派生密钥管理、作者侧 `PayReadFulfillDaemon` 双轨零算力自动发钥、读者侧解密缓存与右侧 Showcase 阅读器、`paybuzz-card` 组件）+ `metaso-p2p`（`/protocols/paybuzz` 索引与全域搜索）+ 链上技能 `metabot-payread`
- **建议分支与工作树**：`IDBots` 分支 `feat/paybuzz-dual-unlock`，工作树 `.worktrees/paybuzz-dual-unlock`
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C6**

---

## 一、核心商业飞轮：FT 微支付 × NFT 会员卡双轨联动

传统内容平台要么抽成高达 20%~50%，要么无法支持几毛钱的无门槛跨国按篇阅读，更不允许读者把买过的年度专栏会员转手卖掉。在 IDBots 中：
- **单篇尝鲜走 FT（或少量 ME）**：路人读者花 `10 $METAID` 秒付秒开，零注册摩擦、作者 100% 全额秒收；
- **长期铁粉买 MRC-721 会员卡**：买一张作者小店里的「专栏年度权益卡」，全年文章 0 元验资秒开，不想看了还能把权益卡挂回小店转卖回血！

---

## 二、详细需求清单（REQ-5）

### REQ-5-01：确定性密钥派生与 `/protocols/paybuzz` 加密发布原语（契约 C6.1）
- **新增文件**：`src/main/services/paybuzzCryptoService.ts`、`src/main/services/paybuzzService.ts`
- **实现要求**：
  1. **防丢钥确定性派生**：给定文章明文 UTF-8 字节流，先计算 `plainSha256`，再结合当前作者 MetaBot 钱包种子按 `HMAC-SHA256(seed, "idbots-paybuzz-key:v1:" + plainSha256)`（并在计算密文后建立 `cipherSha256 -> contentKeyHex` 的本地 SQLite 索引表 `paybuzz_authored_items`）生成 32 字节对称密钥 `K`。即使作者更换电脑，只要恢复助记词重新同步自己发过的 `/protocols/paybuzz` Pin（或在元数据加密槽备份），即可无缝继续自动发钥！
  2. 使用 `AES-256-GCM` 加密正文上传为链上附件（或内联 base64，大于 16 KB 自动走 `metafile://` 附件上传），广播 `/protocols/paybuzz` Pin（明文 `title` + `preview` + `unlockRules`）。
  3. 在 `metaidRpcServer.ts` 暴露发布与解锁本地 RPC，供链上技能 `metabot-payread` 调用。

### REQ-5-02：`metaso-p2p` 索引 `/protocols/paybuzz` 并接入 `search_metaweb`
- **修改仓库**：`/Users/tusm/Documents/MetaID_Projects/metaso-p2p`（`internal/aggregator/paybuzz/`）
- **实现要求**：
  - 索引 `/protocols/paybuzz` 的明文标题、导读摘要、作者资料、字数与 `unlockRules`；
  - 暴露 `GET /api/paybuzz/info?pinId=...` 与 `GET /api/paybuzz/list?author=...&tokenAssetKey=...&vipCollectionPinId=...`；
  - 接入 `metaweb.DocumentSource`（`protocol = "paybuzz"`），使全网用户的 TwinBot 在 `search_metaweb` 搜索相关主题时能直接发现高质量加密研报/教程。

### REQ-5-03：作者侧双轨自动发钥守护 `PayReadFulfillDaemon`（零大模型消耗，契约 C6.2）
- **新增文件**：`src/main/services/payReadFulfillDaemon.ts`
- **触发机制**：挂接在 `privateChatDaemon` 入站确定性钩子上，毫秒级响应，**绝不唤醒 LLM 对话轮次**：
  1. **收到 `PAYREAD_VIP_REQ_V1`（持 NFT 会员卡免单轨）**：
     - 校验时间戳在 `±300s` 窗口内，验证 ECDSA 签名恢复地址等于 `holderAddress`；
     - 校验该 `collectionPinId` 属于本篇 `paybuzzPinId` 声明的 `vipMrc721Collections`；
     - 调 MetaSo `/api/mrc721/address/item` 实时核验 `holderAddress` 当前持有该专辑下未销毁有效 Item `>= 1`；
     - 验证通过立即通过加密私聊发送 `PAYREAD_KEY_GRANT_V1(contentKeyHex)`！
  2. **收到 `PAYREAD_TOKEN_REQ_V1`（FT 单篇微支付轨）**：
     - 检查本地持久化防重放表 `paybuzz_used_payments(payment_tx_id PRIMARY KEY)`，若已使用过（且非同一 `readerGlobalMetaId + paybuzzPinId` 的网络重发幂等请求）直接拒绝；
     - 调用双链核验器（BTC 调 `man-p2p` / `metalet-service`，MVC 调 `higun`）确认 `paymentTxId` 真实向作者配置的 `receiveAddress` 转入足额有效指定 `assetKey` 代币；
     - 写入消费锁并立即加密回传 `PAYREAD_KEY_GRANT_V1(contentKeyHex)`，同时在作者通知栏静默累计今日稿费战报（避免高频卖文频繁弹窗打扰，可聚合成稿费入账通知）。

### REQ-5-04：读者侧 `PaybuzzCard`、自动选轨解锁与右侧 Showcase 阅读器
- **新增文件**：`src/renderer/components/chat/PaybuzzCard.tsx`、`src/renderer/components/commerce/PaybuzzReaderView.tsx`
- **体验流转**：
  1. 对话流展示精美的付费文章导读卡（标题、作者、字数、导读前 300 字、解锁条件徽章如 `10 $METAID 解锁` / `持【专栏卡】免费看`）；
  2. 点击 **「立即解锁全文」**（或口述指令）：
     - 若本地已购缓存表 `paybuzz_unlocked_cache` 已有密钥，0 秒离线解密并在 Studio 右侧 Showcase（或移动端阅读抽屉）打开沉浸式 Markdown 阅读视图；
     - 若尚未解锁但检测到读者钱包持有匹配的 `vipMrc721Collections` 权益卡，无需花钱弹窗，自动发签名领钥秒开，顶部提示「已凭你的会员权益卡免费解锁」；
     - 若需付费，弹出轻量单步确认卡（并附带「去作者小店买会员卡享全集免单」快捷链接），确认支付后数秒内收钥自动展开全文！

---

## 三、测试与验收要求

1. **加解密与密钥恢复单测**：验证 `AES-256-GCM` 密文篡改 1 比特即验签失败；验证用同一助记词在新空库重建实例仍能派生出完全一致的 `K` 解开旧文章。
2. **双轨权限与防白嫖单测**：
   - 读者把 NFT 会员卡卖给别人后再发 `PAYREAD_VIP_REQ_V1`，断言作者守护进程实时查链发现持仓为 0 立即拒发密钥；
   - 读者花 1 篇文章的钱拿同一个 `paymentTxId` 请求解锁作者的第 2 篇文章，断言防重放表 100% 拦截；
   - 同一读者因断网重发同一篇已付款文章的 `PAYREAD_TOKEN_REQ_V1`，断言命中幂等白名单正常重发密钥（保障买家付完钱断网也不丢权益！）。
