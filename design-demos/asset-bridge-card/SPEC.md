# Asset Bridge Card — Design Spec (3-direction exploration)

Owner-facing mockup for the IDBots built-in Octopus asset bridge. One chat card that
lives through the whole bridge lifecycle IN PLACE: quote/confirm -> signing ->
bridging (block progress) -> completed / failed / expired. A second, compact
"arrival notice" card is posted by the Twin Bot into whatever conversation the owner
is in when the bridge settles.

## 1. Product context

- Surface: IDBots desktop Studio chat. The card sits inside a bot message bubble.
  Bubble column is 392px wide (Studio), must also hold at 375px and 320px.
  Card max width 364px (same as every existing Token-suite card).
- Who: the owner, chatting with their Twin Bot. Says e.g. "把你钱包里的 BTC 转成 MVC 上的
  WBTC" or "把你 BTC 链上的 $METAID 转去 MVC". The bot quotes, the owner clicks confirm IN
  the card, then the owner usually goes off to do other things for 10-30 minutes.
- Wallet: always the MetaBot's own wallet; source and receive are the same wallet
  (BTC P2PKH and MVC addresses derived from the same key). Show the bot name and both
  short addresses so the owner knows which wallet pays and receives.
- Bridge facts (live production numbers, BTC fee rate 2 sat/vB):
  - Asset is 1:1 pegged. Received amount == sent amount. Fees are paid in native coin
    (BTC sats and/or SPACE), never deducted from the asset.
  - BTC -> WBTC: bridge service fee 1,000 sats; own network miner fee ~320 sats
    (160 vB x 2). Needs 1 BTC block for < 0.001 BTC, 2 blocks otherwise; then the bridge
    mints WBTC on MVC (~1 min).
  - MRC-20 ($METAID) BTC -> MVC: service fee 2,292 sats; own miner fee ~1,146 sats
    (commit+reveal, includes 546 sats inscription postage). Needs 3 BTC blocks (bridge
    indexer verification), then mint on MVC.
  - WBTC -> BTC (redeem): 0.0011 SPACE (service 0.0009 + bridge burn miner 0.0002) AND
    1,620 sats BTC (service 1,280 + payout miner 340), plus own miner fees (~0.00025
    SPACE, ~300 sats BTC). Needs 1 MVC block, then the bridge pays out BTC.
  - The redeem direction REQUIRES some BTC in the wallet for fees. If missing, the quote
    card must block confirmation and say exactly how much BTC is needed vs available.
  - Quotes expire after 10:00 (fee rate drifts). Expired -> "refresh quote" action.
  - MRC-20 BTC -> MVC has a per-transaction cap from the bridge's MVC liquidity pool
    (show as a quiet row; sample value is fine).

## 2. States every direction must render (same data, same order)

1. quote — what leaves, what arrives (chain + standard badges), fee breakdown (bridge
   service fee / network miner fee / bridge payout miner fee when redeem / total),
   ETA in blocks AND minutes, paying wallet, quote validity countdown, Confirm + Cancel.
2. quote-insufficient — redeem scenario only: BTC fee balance too low. Confirm disabled,
   inline reason with needed vs available, secondary "top up / cancel" style action.
3. signing — 1-2 s transient: "signing & broadcasting" with the quote data still visible
   (the card does not jump or change size abruptly).
4. bridging — progress bar (see section 4), current stage label ("waiting for BTC block
   2 of 3"), elapsed time, remaining estimate, source txid (copy chip), and a reassurance
   line: "You can leave — I'll tell you in chat when it lands."
5. bridging-slow — same as bridging but the current block has been pending > 9 min, so
   the segment is pinned at 90%: show a calm note ("BTC blocks are slower than average
   right now; this is normal").
6. completed — received amount, source txid + target txid (both copyable), actual fees
   paid, total time taken, and next actions (view balance / list it for sale / bridge
   again).
7. failed — plain reason, what happened to funds, and a retry/contact action.
8. expired — quote expired before confirm; one "refresh quote" action.

Plus the separate "arrival notice" card (compact, ~1/3 height of the main card) that
the Twin Bot posts into a DIFFERENT conversation: "Your bridge landed: +1,000 METAID on
MVC · 31 min" + "view original card" link + the target txid.

## 3. Scenarios (real content, not lorem)

- S1 "BTC -> WBTC": 0.0005 BTC (50,000 sats) from MetaBot "小橙" (BTC balance
  0.00182 BTC). Receive 0.0005 WBTC on MVC. 1 BTC block. ETA ~11 min.
- S2 "$METAID BTC -> MVC": 1,000 METAID (BTC balance 12,500 METAID MRC-20; BTC gas
  0.00182). Receive 1,000 METAID (MVC MetaContract). 3 BTC blocks. ETA ~31 min.
  Pool cap row: "single-tx cap 50,000 METAID" (sample).
- S3 "WBTC -> BTC": 0.0005 WBTC (MVC) -> 0.0005 BTC. 1 MVC block + payout. ETA ~11 min.
  S3 is the scenario used for quote-insufficient (BTC balance 800 sats, needs ~1,920).
- Sample txids are fine; render them shortened with copy affordance.
- Copy is Simplified Chinese for this review (the shipped card will be bilingual via
  the existing ct(en, zh) helper).

## 4. Progress model (shared, identical for all three directions)

- Segments: N required block confirmations (BTC or MVC), each expected 10 min, plus a
  final "payout / credit on target chain" segment with weight 0.5 block (~1 min).
- Within the current block segment: fraction = min(elapsed_since_last_block / 10 min,
  0.9). It never reaches 100% on time alone; it jumps to 100% only when a block is
  actually found.
- Overall percent = (blocks_done + current_fraction) / (N + 0.5), payout segment fills
  when the bridge broadcasts the target tx; 100% only on completed.
- Remaining estimate = (N - blocks_done - current_fraction) x 10 min + 1 min, floored
  at "about 1 min"; when pinned at 90% show "waiting for the block" instead of a number.
- The mockup must include demo controls: time-lapse x60 (10 s == 10 min), "find a
  block now", "make this block slow" (keeps the 90% pin visible), and a jump-to-state
  switcher. Respect prefers-reduced-motion.

## 5. Design system constraints (must match the shipped S1/D1 Token suite)

Reuse the tokens from design-demos/token-cards-suite/styles.css (copy them; the demo
must be self-contained):
- Card shell: 18px radius, 13px padding, white / #232529, border rgba(15,23,42,.09) /
  rgba(255,255,255,.1), the suite shadows. Inset modules 10-11px radius, #f2f4f7 /
  rgba(255,255,255,.045).
- Primary CTA #ffdc51 with ink #24210c (never white text). Secondary = inset grey.
- Success #0f9d68 / dark #34d399; warn #b45309 / #fbbf24; down #dc3545 / #fb7185.
- Chain accents: BTC #f7931a family (fg #c26200 / dark #fb923c), MVC #0ea5e9 family
  (fg #0369a1 / dark #38bdf8). Chain+standard badges exactly like the suite:
  "BTC · MRC-20", "BTC · 原生", "MVC · MetaContract".
- System font stack (-apple-system, PingFang SC). Tabular numerals on every number.
  Body >= 12px inside the card (labels >= 10.5px only for badges), contrast >= 4.5:1.
- No emoji icons, no purple gradients, no left-border accent cards, no SVG people.
- Dark mode is the default review theme; light must also be correct.

## 6. Visual motif

The thing only this card has: two chains joined by a span that is paced by BLOCKS.
Every direction must make "how many blocks are we waiting for, and which one are we
on" readable at a glance — that is what removes the waiting anxiety.

## 7. The three directions (structurally different skeletons)

A — "Live Activity" (reference: Apple Live Activities / Dynamic Island delivery &
ride-hail trackers). Hero-first, vertical.
- quote: two chain coin discs (BTC orange, MVC blue) joined by a dashed arc; the big
  numeral line "0.0005 BTC -> 0.0005 WBTC" under it. Three summary rows only:
  你将收到 / 总费用 / 预计到账. Fee breakdown hidden behind "费用明细" disclosure.
  Full-width primary "确认桥接", tiny "报价 9:42 后失效" under it, "取消" as text button.
- bridging: the arc becomes the track; a glowing token dot travels along it at the
  overall percent; the block count is printed as small ticks on the arc. Huge percent
  numeral + "约 7 分钟" remaining. One-line stage label. Txid chip at bottom.
- completed: the dot lands in the MVC disc, disc gets a check; headline "+0.0005 WBTC
  已到账"; two txid rows; duration; three chip actions.
- arrival notice: Live-Activity style pill-card (disc pair + one line + chevron).

B — "Ledger Receipt" (by-the-book evolution of the approved B1/B2 bridge cards).
Dense, table-first.
- quote: suite header (⇄ avatar, "$METAID 跨链桥接", status pill "待确认"); the B1
  dual flow boxes (source / target with badges and balances); a ledger table: 转出 /
  预计收到 / 桥服务费 / 网络矿工费 / 合计 / 预计到账 / 付款钱包 / 报价有效期; button row
  [取消] [确认桥接].
- bridging: ledger collapses to a 2-row summary; a 3-step stepper (源链广播 -> 区块确认
  n/N -> 目标链入账) with a progress bar, percent and ETA beneath; txid row.
- completed: the card becomes a receipt — perforated (dashed) divider, "跨链凭证" title,
  rows for both txids, fees actually paid, start/finish time and duration.
- arrival notice: a mini receipt strip.

C — "Block Meter" (reference: Teenage Engineering instrument panels, mempool.space
block strip). Grid/instrument-first.
- quote: route strip "BTC ━━▶ MVC" at top; centerpiece is a row of N block cells plus
  one payout cell — the cells ARE the timeline ("需等待 3 个比特币区块 ≈ 30 分钟");
  fees in a 2x2 bento (服务费 / 矿工费 / 合计 / 你将收到). Confirm is HOLD-TO-CONFIRM
  (press and hold 1 s, yellow fill sweeps the button) because the action is
  irreversible; "取消" secondary.
- bridging: the current cell fills with time (pins at 90%) with a blinking cursor; done
  cells are solid; a monospace mission clock "T+07:12" and "下一块预计 ~3 分"; txid.
- completed: all cells solid green; the cell row turns into the receipt header;
  "+1,000 METAID 已到 MVC"; both hashes.
- arrival notice: a single-row mini block strip with a check.

The three must NOT share a skeleton: A is hero+arc, B is table/receipt, C is a cell
grid with bento and hold-to-confirm.

## 8. Deliverables

- design-demos/asset-bridge-card/index.html — review board: top bar with scenario
  switcher (S1/S2/S3), state switcher (8 states), theme (dark/light), bubble width
  (392/375/320), demo time controls. Three columns A/B/C, each a Studio chat mock: user
  message, bot lead sentence, then the card in the bot bubble. Below the columns, an
  "arrival notice in another conversation" row showing each direction's notice card.
- One self-contained folder (plain HTML/CSS/JS, no build step, no CDN): index.html,
  styles.css, engine.js (scenarios + progress model + state machine), a.js, b.js, c.js.
  Opening index.html via file:// must work.
- Clicking Confirm in any card actually walks signing -> bridging -> completed using the
  engine (with time-lapse), and the card morphs in place (animate height, no jump).
