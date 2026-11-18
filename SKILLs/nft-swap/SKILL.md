---
name: nft-swap
description: MetaContract NFT → MRC-721 swap pilot for the MetaBot Avatar album. Issuer import gate, identity restore, swap engine CLI (vault-poll / verify-claim / mint-and-send / burn-batch) with cover preservation built in (mint-time auto cover, no-cover-no-mint, burn pre-gate), the image-conversion pipeline stage (cli/attach-cover.mjs — snapshot → preupload → post-mint item_desc cover+desc, dry-run by default), and idempotent cover/desc backfill for already-minted items (cli/backfill-covers.mjs). Only the MetaBot Avatar album is in scope; every fund/token action goes through host confirmation gates per PRD §9.
version: 0.4.0
---

# NFT Swap (MetaContract → MRC-721 pilot, MetaBot Avatar album)

Managed swap service for the legacy (MetaContract) NFT album **MetaBot
Avatar**: users deposit old tokens into the vault address, the engine
verifies on-chain, mints the same-numbered MRC-721 item **as the original
issuer identity** with the legacy artwork as its cover, sends it to the
user, and periodically burns the deposited old tokens one-tx-per-token to
the black hole. Free of charge (owner ruling 2026-11-04).

Governed by `PRD-metacontract-to-mrc721-v1.md` (v1.2) and
`REVIEW-ama-prereview-v1.md`; the 16 review corrections are hard
requirements, none may be weakened.

## Status

- **M0 tooling (this release)**: issuer import gate + identity restore +
  vault configuration. Rehearsed on a scratch store; production run happens
  with the app closed.
- **M1-M3 engine modes**: `vault-poll`, `verify-claim`, `mint-and-send`,
  `burn-batch` — landed in the repo tree (`SKILLs/nft-swap/cli/`), resumable
  pipeline on `cli/lib/swap-ledger.mjs` + `cli/lib/vault-poll-lib.mjs`.
- **Cover preservation (0.4.0)**: the engine itself now produces the cover at
  mint time from the vault row's `imgUrl` (root-cause report §4.2, 2026-11-19):
  no cover ⇒ no mint; a cover-less item can no longer be burned. See
  「兑换内嵌取图（0.4.0 cover-loss 修复）」 below. Dry-run self-test:
  `node cli/cover-gate-selftest.mjs`.
- **Image-conversion stage (0.3.0)**: `cli/attach-cover.mjs` — the pipeline
  stage that turns the legacy artwork into the new item's `cover`+`desc`:
  `--snapshot` (free, pre-burn) → `--preupload` (optional, 1 chain write) →
  `--attach` (1 chain write, post-mint hook). Design: `docs/cover-pipeline-v1.md`.
  Both this and the repair CLI run on ONE engine, `cli/lib/cover-core.mjs`
  (vendored into the repo tree since 0.4.0; sha256-frozen copies).
- **Backfill tooling (0.2.0, now a thin repair surface)**: `cli/backfill-covers.mjs`
  — idempotent cover/desc repair for ALREADY-MINTED items (`--dry-run` is the
  default; `--write` needs explicit owner approval). Also produces the
  cover-missing roster with `--scan`.

## Changelog

- **0.4.0 (2026-11-19)** — cover-loss root-cause fix (report §4.2, four steps):
  ① vault row mapper keeps `name`/`imgUrl`; ② cover kernel vendored from the
  installed tree into the repo (cover-core/attach-cover/backfill-covers/docs);
  ③ `mintAndSend` = 缺图不铸 (`COVER_UNAVAILABLE` rejects the row with the
  owner refund path open; transient failures stay claimed; `display.cover`
  asserted before any mint broadcast is recorded; item_desc resume rebuilds a
  cover-less display instead of rewriting it); ④ `burn-batch` cover pre-gate
  (`COVER_MISSING_BEFORE_BURN` roster refuses the broadcast). New
  `cli/lib/cover-bridge.mjs` (journal/catalog sha256 reuse ladder → PNG gate →
  single upload) and `cli/cover-gate-selftest.mjs` (20 checks, fully injected).
  Also fixed: `recordBurnBroadcast` crash on bare-scalar `fee_sats_json`.
- **0.3.0** — image-conversion stage (`attach-cover.mjs` + `cover-core.mjs`) and
  this cover-pipeline documentation, authored on the installed tree
  (Avatar 兑换站, metabot#37); code never entered git until 0.4.0 vendored it.
- **0.2.0** — `backfill-covers.mjs` repair surface.
- **0.1.0** — M0 tooling + M1 engine (issuer gate, restore, four CLI modes).

## Fixed configuration (owner-ratified, do not edit)

See `cli/lib/issuer-config.mjs` — genesis/codeHash/sensibleId, issuer
address + 236 BIP44 path, vault = `m/44'/236'/0'/0/1`, collection name
`metabot-avatar` (totalSupply 9560), black hole
`1111111111111111111114oLvT2`, net `livenet`, per-swap fee ceiling
5000 sats.

## Security rules (PRD §9/§9b — violation ends the engagement)

1. The issuer mnemonic only lives inside this package's CLI processes and
   the host signing workers (env-injected). It never appears in chat, logs,
   docs, screenshots, or error output; `import-issuer` runs a word-level
   contamination guard over its own output.
2. The mnemonic is read directly from the owner-managed source file inside
   the CLI process (owner-ratified handoff, 2026-11-05). No copy is kept.
3. The restore hard-fails unless the derived address equals the ratified
   issuer address AND the globalmetaid guard passes (`BOT_IDENTITY_MISMATCH`
   otherwise).
4. collection_desc modifications always require a per-action owner
   confirmation card; burn batches always require owner sign-off.
5. Host safety gates are not to be bypassed or re-implemented in weaker
   form (ownerAddress check, burned-refuse, chain check, collection
   createAddress check).

## CLI reference

All CLIs print public fingerprint evidence only (addresses, globalmetaid,
signatures, word counts — never mnemonic words).

```bash
# 1. Import gate — parse the owner's notes file inside this process, pick the
#    commented "endorse"-led group, derive at the 236 issuer path and gate on
#    the ratified issuer address; verify the same-origin binding signature.
node cli/import-issuer.mjs --file /path/to/metacontract_nft_issuer.md

# 2. Restore — create the swap Bot from the issuer identity in the IDBots
#    store (app must be closed). --dry-run runs read-only pre-flight checks.
node cli/restore-issuer.mjs [--user-data "<IDBots userData dir>"] [--dry-run]

# 3. Image-conversion pipeline stage (plan only by default):
node cli/attach-cover.mjs --snapshot --all             # free: capture legacy artwork
node cli/attach-cover.mjs --preupload --all            # upload plan (prints the cost)
node cli/attach-cover.mjs --attach --token 2671 --dry-run
node cli/attach-cover.mjs --audit                      # coverage report (free)

# 4. Cover backfill for already-minted items (repair surface, plan only by default):
node cli/backfill-covers.mjs --tokens 2671,1310,5366 [--probe-image]
node cli/backfill-covers.mjs --scan            # cover-missing roster
node cli/backfill-covers.mjs --tokens 2671 --write   # owner approval required

# Self-test (public throwaway fixture only):
node cli/selftest.mjs
# Cover-gate dry-run self-test (fully injected, zero chain writes, 20 checks):
node cli/cover-gate-selftest.mjs
```

### Known finding: chat key rotation

The identity's on-chain chatpubkey was registered from a key outside this
mnemonic's standard derivations (measured 2026-11-05: no match at 236/10001
or sibling indexes). M0 therefore re-registers (rotates) the identity chat
key from the 236 issuer key via the host sync flow, one extra pin; senders
then encrypt to the rotated key and the bot can decrypt private chats.

## 兑换内嵌取图（0.4.0 cover-loss 修复 — 根因报告 §4.2 四步）

2026-11-18 根因报告定位：兑换条目无封面不是工具不支持，而是**引擎取值链上
`cover` 没有生产者**——金库行里的 `imgUrl` 被行映射器丢弃、引擎默认 null 且
静默省略、账本持久化让崩溃恢复重放「无图」决定（报告 §3.2）。0.4.0 在引擎
层落地四步修复；`attach-cover`/`backfill-covers` 退位为**存量修补面**。

### 引擎行为（mint-and-send / burn-batch）

1. **行映射器保留 `name`/`imgUrl`**（`vault-poll-lib.mjs`，v4 驼峰与下划线两种
   线形都映射）。`partName` 从此来自真实部件名。
2. **mint 前强制取图**：`mintAndSend` 在铸造前调 `deps.resolveCover`（实现：
   `cli/lib/cover-bridge.mjs`）——无显式 `--cover` 时按
   **journal sha256 复用 → attach-cover catalog sha256 复用 → 金库行 imgUrl
   下载 + PNG 门 → 单次上传（仅 broadcast）** 的阶梯产出封面；
   dry-run 只校验出计划（`plan.coverStatus`），绝不上传。
3. **缺图不铸**：broadcast 且 `COVER_UNAVAILABLE`（imgUrl 空/图源已死，永久性）
   → 记 `rejected`（owner 退款路径开放，旧币留在金库，窗口不关）；
   瞬时故障（下载/上传失败）→ 行保持 `claimed` 待重试；任何 mint 广播落账前
   断言 `display.cover` 非空（堵 §3.2d 续跑复用）；item_desc 续跑路径遇到
   无 cover 的历史 display 会**带图重建**而不是原样重写。
4. **销毁前置闸**：`burn-batch` 逐枚读 `item/info` 的 `cover`（缺
   `deps.fetchItemInfo` 直接 fail closed）；无图条目 `eligible=false`
   （`COVER_MISSING_BEFORE_BURN`），broadcast 时整批拒绝并输出名单——
   先补图（attach-cover/backfill-covers）再销。

### 真实兑换时的验证步骤（一行）

`node cli/mint-and-send.mjs --token-index <n> --broadcast` 完成后
`sqlite3 -readonly <ledger> "select dual_check_json from swap_ledger where token_index=<n>;" | grep cover`
非空、且 item/info 明文视图 `cover` == 该值即为生效；dry-run 先看
`plan.coverStatus`。

## 兑换流水线的图片转换环节（0.3.0 起为正式环节；0.4.0 起引擎内嵌，本节为存量修补面）

设计全文：`docs/cover-pipeline-v1.md`。实现：`cli/attach-cover.mjs`；两个 CLI 共用唯一引擎 `cli/lib/cover-core.mjs`，不存在第二份取图/上传/写链逻辑。

### 管线架构（文本版）与挂接点

```
用户转旧币 → ① vault-poll → ② verify-claim → ③ mint-and-send → ④ 发货 → ⑤ burn-batch → 黑洞
                 │                                │                            │
                 │ ★A snapshot（免费）            │ ★C attach（1 笔写链）      │ ★B 销毁前兜底快照
                 ▼                                ▼                            ▼
           旧图：imgUrl → 下载 → PNG 门 → sha256   item_desc{cover+desc}       catalog 缺则当场补
                 └────────────── catalog（本地账本，断点续跑真值）──────────────┘
                                       │
                                       └──▶ ★preupload（可选，1 笔写链）：图先上链拿 metafile pin
```

**图片转换挂在两个固定位置**：A 在「金库收币之后」、C 在「铸造完成之后」。B 是销毁前的最后闸门。

### 三条硬规则（不得放宽；0.4.0 起全部由引擎代码强制执行）

1. **销毁前未 snapshot = 流程缺陷。** `burn-batch` 必须先对批次逐枚检查 catalog，缺失即当场 snapshot（免费）；缺 snapshot 的条目不得进销毁批次。旧币销毁后 wallet-api 行消失，旧图即不可再取（已实测：无持币无关的旧图接口）。→ **0.4.0：`burn-batch` 逐枚 item/info 查 cover，无图整批拒绝（`COVER_MISSING_BEFORE_BURN` + 名单）。**
2. **`mint-and-send` 返回前必须调用 C。** 条目不得以「无 cover」状态进入已发货。→ **0.4.0：cover 前移到铸造前（引擎内嵌取图），C 仍用于存量修补；mint 广播前断言 `display.cover` 非空。**
3. **缺图（cover 为空）不再算可接受状态。** 出现即按流程事故复盘，不进「待补图队列」。→ **0.4.0：mint 侧 `COVER_UNAVAILABLE` 拒铸并记 rejected；burn 侧 `COVER_MISSING_BEFORE_BURN` 拒销。**

### 用法

```bash
# A. 旧图快照（免费；旧币仍在金库时跑）
node cli/attach-cover.mjs --snapshot --all
node cli/attach-cover.mjs --snapshot --tokens 2671 --write   # --write 仅落本地 catalog，零上链

# preupload（默认 dry-run 只打印费用；真实上传需 --write + 批准）
node cli/attach-cover.mjs --preupload --all
node cli/attach-cover.mjs --preupload --all --write --max-sats 1400000 --approval-id cover-batch-001

# C. 铸造后一行接入（O(1)，不扫 collection）
node cli/attach-cover.mjs --attach --token 2671 --item-pin <itemPinId> \
     --write --max-sats 15000 --approval-id cover-batch-001

# 巡检
node cli/attach-cover.mjs --audit          # 覆盖率报告（免费）
```

### 写链三道闸门（真实执行缺一即拒，exit 2，零花费）

1. `--write`；
2. `--max-sats N` 硬预算上限（逐笔累计，超限 `BUDGET_STOP`）；
3. `--approval-id` 必须命中 `out/attach-cover/approvals.json`，且 `--max-sats ≤ 该记录的 maxSats`。**该文件只由 owner（或其代笔的 Twin）在批准后写入，bot 不自批。**

### 幂等（四层）

`tokenIndex`（catalog 主键）· `itemPinId`（写链 journal）· `sha256`（相同图只上传一次，复用 metafile pin）· 本地 `writes.jsonl`（广播成功未追平 → `SKIP_JOURNAL_PENDING`，不二次花钱）。

### 费用口径（实测）

- `item_desc`（cover+desc）**796 sats**（sponsor 记 16 me_milli）；
- 图片上传 12,437 B **≈12,906 sats**；
- 单枚合计 **≈13,702 sats**；9560 枚按此口径 ≈**130,991,120 sats（1.31 SPACE / ≈2,620 ME）**。
- sponsor 余额 2000 ME **不足以覆盖全量**（缺口 ≈620 ME）；可走自付（余额 839.71 SPACE，绰绰有余），回执会明确标 `sponsor-fallback-self-pay`。
- 注意：图片环节单枚成本是 PRD `perSwapFeeCeilingSats=5000` 的 2.74 倍——该上限不含图片，需 owner 另行裁定（推荐按批批准）。

## 存量修补：已铸造条目的封面补写

`cli/backfill-covers.mjs` 是**存量修补面**（不是管线本身），为**已经铸造**的条目补写 `cover`（以及缺失的 `desc`），幂等、可重复跑。它和 `attach-cover.mjs` 共用 `cli/lib/cover-core.mjs` 这一份引擎。

为什么需要：0.3.0 之前铸造的条目没有走封面钩子，只有 name/metadata。这个脚本把「旧版原图」找回来，以发行人身份写 `item_desc`。**0.3.0 起新条目由 `attach-cover` 在铸造后自动带图，本脚本只处理历史存量。**

### 用法

```bash
# 1) 计划（默认就是 dry-run，不上链、不花钱）
node cli/backfill-covers.mjs --tokens 2671,1310,5366

# 2) 连旧图一起取回并校验（对已有封面的条目也做一次只读演练）
node cli/backfill-covers.mjs --tokens 2671 --probe-image

# 3) what-if：条目已有封面，仍按“缺封面”生成完整计划（含图片哈希与费用估算）
node cli/backfill-covers.mjs --tokens 2671 --rehearse-missing

# 4) 待补清单（扫描整个 collection）
node cli/backfill-covers.mjs --scan

# 5) 真正补写（必须先拿到所有者批准）
node cli/backfill-covers.mjs --tokens 2671 --write
```

产物默认写到 `out/backfill-covers/`：每次运行的 `backfill-<mode>-<stamp>.json`、`pending-covers.json` / `pending-covers.md`（清单），以及写链账本 `writes.jsonl`。

### 幂等与费用

- 已有非空 `cover` → `SKIP_HAS_COVER`，不下载、不上传、不写链。
- `cover` 与 `desc` 都齐 → `SKIP_HAS_COVER_AND_DESC`。
- 本地写账本 `writes.jsonl` 记录每一次上传与 item_desc。若上次上传成功但写链失败，重跑会**复用**已上传的 metafile pin，不重复付上传费；若 item_desc 已广播（索引器尚未追平），重跑为 `SKIP_JOURNAL_PENDING`，不重复花钱。`--ignore-journal` 仅用于确认 pin 被丢弃后的恢复。
- 费用（实测）：封面+描述一枚约 **796 sats**；仅封面约 650 sats。脚本用 `--fee-rate`（默认 1 sat/vB）做上界估算——仅封面 178 B payload ≈ 649 sats，与真实回执相差约 4%。默认走宿主 `create-pin` 的 traffic/积分代付模式（回执带 `feeAssist`）；若回执没有 `feeAssist`，这笔由 Bot 自己的钱包支付——脚本会原样报告 `totalCost`。

### 发行人闸门（硬限制）

索引器只收录 **collection 发行人**签发的 item_desc。非发行人写的 item_desc 会被静默丢弃，只花手续费。脚本每次运行都做两道前置检查，任一不符即停：

1. RPC 身份 `metabot_id` 的 `mvc_address` == 发行人固定地址 `176C9RPWDggnvdVcWG3wrZEJcm1bHTcKM5`；
2. `collection/info` 的 `createAddress` == 同一地址。

### 旧图解析

优先读本地 catalog（`out/attach-cover/cover-catalog.jsonl`，即 snapshot 阶段的产物）；没有才回退到金库地址 `1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET` 的 NFT 持仓（wallet-api v4 `nft/utxo-list`，flag 游标翻页、按 outpoint 去重）取 `imgUrl`。下载后校验 PNG magic（`89504E470D0A1A0A`）与 IHDR 尺寸，并对**将要上传的字节**算 sha256；写链前会重新下载并要求 sha256 一致（否则 `IMAGE_CHANGED`，拒绝写入）。不硬编码任何单张图。

**关键约束**：旧币销毁后，wallet-api 的持仓行消失，旧图不可再取（已实测无持币无关接口）。因此 snapshot 必须发生在销毁之前；`burn-batch` 前必须补跑兜底快照。

### 校验口径

写入后轮询 `item/info`：

- 明文视图 `cover` == 计划值；
- `confirmedOnly=1`（只读确认库、跳过 overlay）视图 `cover` 也 == 计划值。

两者同时命中才算 `WRITTEN_VERIFIED`。不要等 `descConfirmed` 变成 true —— 该字段在 metaso 的语义里恒为 false（只在 overlay 填充时出现），确认库反而会省略它。

### 边界

- 只处理 `metabot-avatar` 这一个 collection；collectionid 与金库地址是固定常量，确需变更用 `--collection-id` / `--vault-address` 并先拿到所有者裁定。
- item_desc 是**按字段 first-write-wins**：已写过的 cover 不会被本脚本覆盖；`--rehearse-missing` 只是预览，不会真的改写已有封面。
- 金库里已经没有旧图（例如旧币已销毁）且条目又缺封面 → `NO_LEGACY_IMAGE`，脚本拒绝写，不做猜测。
- `--scan` 的清单只列 `burned=false` 且仍有 `ownerAddress` 的条目；没有 tokenIndex 映射的条目单独列出，便于人工核对。
- 本脚本不碰助记词；签名全部发生在宿主进程内。

## Vault

The vault is the fixed subaddress `m/44'/236'/0'/0/1` of the issuer
account, written into the bot config at M0
(`cowork_config` key `nft_swap_pilot_config`). Polling filters the
wallet-api `utxo-list` to THIS address only, with flag-cursor full-page
pagination and local genesis/codeHash/tokenIndex filtering (PRD §3).
