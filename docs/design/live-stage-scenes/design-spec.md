# Live Stage Scene System — Design Draft (v0, for owner review)

Status: **accepted by the owner on 2026-11-18** (decisions in §7). The interactive
preview lives next to this file (`index.html`, served from the repository root,
e.g. `python3 -m http.server` then `/docs/design/live-stage-scenes/index.html`).
The accepted catalog is the implementation spec for `public/live-stage/*` and
`src/main/services/studioLiveStageModel.ts`.

## 1. Why the stage needs a scene system

Today the stage has 17 families, but the owner perceives only ~3 looks
(resting, working, waiting). Root cause, from the code:

- `liquidOrbActivityForFamily` collapses 17 families into 5 activity buckets,
  and 10 of them (`received`, `local-recall`, `web2-research`,
  `metaweb-research`, `making`, `delegation`, `worker-report`, `verification`,
  `browser-action`) share the `working` bucket.
- The background is one particle field (42 dots on ellipses). Families only
  change its radius/speed slightly, so nothing tells *where* the Bot is working.
- Many real tools are not classified at all (`familyForTool` returns null and
  the stage silently stays on the previous family). In the owner's session
  `f589ea9e…` ("无法查看钱包NFT") these went unclassified: `wallet_nft_balance`,
  `check_metafile_route`, `list_latest_questions`, `get_question_answers`,
  `post_simpleanswer`, `like_pin`, `send_private_chat`, `projection_begin`.
  `mrc721_item_info` was mis-filed as `verification`; `bash`/`read_image` were
  filed under `local-recall` while the headline said "正在电脑上处理".
- System beats that the owner saw in that session have no stage expression:
  tool timeout + retry, model fallback ("主模型额度不足，已切换备用模型"),
  a mid-turn owner steer ("为什么要这么久"), chain confirmations.
- Concurrent threads of the same Bot — local Workers, on-chain private chats
  (`a2a` sessions), group tasks (`group_task` sessions, incl. OpenTeam guests) —
  only the local Workers reach the stage (`activeWorkers`).

## 2. The system: three layers, three questions

| Layer | Answers | Rule |
|---|---|---|
| **Place** (background) | *Where* is the Bot working right now? | Exactly one place at a time, chosen by the Twin's foreground action. Low contrast, blended into the navy canvas, detail-rich up close. |
| **Companions** (rail + hero connector) | *With whom?* | Concurrent threads (local Workers, private-chat peers, group tasks) live in a right-side rail. Only the thread the Twin is touching *now* gets the full in-scene connector ("hero"); the rest pulse quietly in the rail. |
| **Orb** (the Bot itself) | *How* is it working (intensity / mood)? | Same identity palette everywhere; per-state speed / warp / contour fluidity / glow, plus event-driven modulation (inhale on a hit, compress on a seal, lean toward a peer). |

Places and their visual grammar (shape and hue both differ, so a glance is enough):

| Place | Meaning | Grammar | Hue (all ≤ .12 alpha at rest) |
|---|---|---|---|
| **Mind 心智** | thinking, recalling, talking to the owner | round dots on curved orbits, soft depth layers | violet `#C5A9FF` + cyan sparks `#9BF4FF` |
| **Machine 本机** | this computer: commands, local files, desktop, big screen, local Workers | orthogonal + 45° PCB traces, pads, vias, a socket around the orb (the Bot is the processor) | copper `#D6A05C`, gold pulses `#FFD680` |
| **Web 互联网** | the Web2 internet | irregular hyperlink mesh, hub "sites", page glyphs | blue `#78A8FF` |
| **Chain AI 互联网** | MetaWeb / blockchain: read, write, value, private chat, group tasks | rigid blocks in sequence linked by hash pointers, a pending head slot | cyan-teal `#60E2EC`, seal gold `#FFDC51` |

Signature: **the Bot's world unfolds from the Bot.** Entering a place reveals
its elements radially from the orb outward (distance-based delay, ~0→700 ms);
leaving fades out in 500 ms; both places draw during the 900 ms crossfade.

## 3. State catalog (26 states + 5 transient events)

Status: `existing` = family exists today and keeps its meaning; `changed` =
exists but moves place/triggers; `new` = proposed family.

### Mind 心智
| id | 名称 | Status | Trigger | Place motif | Orb |
|---|---|---|---|---|---|
| idle | 待命 | existing | opened session, no turn | sparse stars, very slow | round, breathing |
| received | 收到 | existing | owner message starts a turn | one acknowledgement ring expands from the orb; stars it passes brighten | brief pop |
| reasoning | 思考 | existing | thinking blocks, requesting | layered orbits speed up; hairline "synapse" links flicker between near stars | high contour fluidity |
| recall | 回忆 | changed (was `local-recall`) | `memory_*`, `knowledge_*`, `conversation_*`, `idbots_session_read*`, `experience_recall`, `procedure_recall`, `recent_chats` | stars spiral slowly inward; every ~1.6 s 3–4 stars join into a constellation and a glint runs to the orb | medium |
| speaking | 回复 | existing (place changed) | assistant prose streaming | keeps the previous place dimmed to 40%, events paused (Mind: calm stars with a voice shimmer) | voice modulation + equalizer |

### Machine 本机
| id | 名称 | Status | Trigger | Place motif | Orb |
|---|---|---|---|---|---|
| local-run | 在电脑上执行 | new | `bash`, `terminal_*`, skill scripts | pulses race both ways on traces; four socket-corner LEDs blink in sequence | tight & quick |
| local-read | 读取本地文件 | new (split from `local-recall`) | `read`, `read_image`, `glob`, `grep`, `media_info`, `grab_video_frame`, `describe_*` | pulses flow **inward** from outer pads; socket edge flashes on arrival | medium |
| making | 编写文件 | changed (place) | `write`, `edit`, `apply_patch`, `str_replace_editor`, `convert_media` | pulses flow **outward**; memory cells at trace ends light and decay | small pulse per write |
| desktop-control | 操作电脑桌面 | new | computer-use tools (`cua_*`), `screenshot` | circuit dims; a hairline window frame with a reticle cursor gliding and click ripples | medium |
| browser-action | 操作大屏 | changed (place) | `bot_browser_act/open_uri/read_page/tabs`, `open_metaapp`, `browser_open` | screen frame (the Bot Browser) with a scan line; traces feed it | medium |
| projecting | 投到大屏 | new (split) | `projection_begin`, `bot_browser_preview_local` with `projection:true` | a page silhouette slides from the orb into the screen frame and settles | calm, focused |

### Web 互联网
| id | 名称 | Status | Trigger | Place motif | Orb |
|---|---|---|---|---|---|
| web-search | 搜索网页 | existing (`web2-research`) | `web_search` | search waves ripple through the mesh; 2–3 hub "hits" show a page glyph and send a glint home **along the mesh links** (shortest path) | inhale per returning hit |
| web-read | 阅读网页 | new (split) | `web_fetch`, `fetch_url` | one hub opens into a page silhouette; a scan line reads it; text bars stream to the orb | settled |

### Chain AI 互联网
| id | 名称 | Status | Trigger | Place motif | Orb |
|---|---|---|---|---|---|
| chain-read | 读取 AI 互联网 | existing (`metaweb-research`), triggers widened | `search_metaweb`, `read_metaweb_pin(s)`, `metaweb_pin_versions`, `omni_read`, `search_qa`, `list_latest_questions`, `get_question_answers`, `search_social_posts`, `social_post_*`, `metaid_profile`, `search_metaids`, `list_online_bots/services`, read-only `mrc721_*`, `wallet_*balance`, `check_metafile_route`, `chain_history_recall`, `metaprotocol_registry`, `metatask_get/list`, `search_metaapps` | a scan light runs back along the chain; the target block lifts and a pin rises to the orb | inhale on arrival |
| chain-write | 写入 AI 互联网 | new | `post_buzz`, `post_simplenote/log/question/answer`, `comment_pin`, `like_pin`, `upload_file`, `post_metaprotocol`, `metatask_publish/submit/claim`, `twin_stamp_publish`, `omni_cast`, `mrc721_mint/collection_create`, `bot_browser_publish_app` | the orb compresses and emits a packet → it unfolds into a new block at the pending head → a gold seal turns once → a confirmation ripple runs back along the chain | compress on seal |
| chain-transfer | 链上转账/交易 | new | `wallet_*transfer`, `wallet_*buy/sell`, `mrc721_buy/sell/transfer/offer`, `escrow_*`, `me_charge`, `wallet_btc_broadcast` | exchange: two packets travel opposite ways between orb and chain head and swap; seal = two interlocking rings (cyan + violet, no money imagery) | slow, deliberate |

### Collaboration 协作 (companions)
| id | 名称 | Status | Trigger | Place | Hero connector |
|---|---|---|---|---|---|
| delegation | 委派本地 Bot | existing | `local_worker_delegate`, `twin_task_reassign` | Machine | PCB traces from the orb socket to each Worker card in the rail; gold dispatch pulse |
| waiting | 等待协作 | existing | `longterm_subtask_wait`, `twin_task_status`, turn finished while threads run | place of the hero thread, dimmed to 55% | slow heartbeat pulses; Worker cards show a rotating progress arc |
| worker-report | 协作交回 | existing | cross-session Worker report | Machine | pulse returns into the orb; card turns amber |
| verification | 核对结果 | existing | `twin_task_accept`, `bot_browser_screenshot`, `bot_browser_read_page` | previous place | a scan arc circles the orb and three ticks check off |
| private-chat | 链上私聊 | new | `send_private_chat`, active `a2a` sessions of this Bot | Chain | dashed arc to the peer's mini orb; an encrypted capsule (lock notch) travels; mid-way it drops a copy into a chain block; "awaiting reply" dots near the peer |
| group-task | 群任务 | new | `group_chat`, active `group_task` sessions (local and OpenTeam look identical; OpenTeam guests get a dashed ring + `OT` badge) | Chain | a council ellipse around the orb with members on it; a post sweeps from the sender both ways and lights every member (one-to-many); a block drops into the chain |

### Owner & wrap-up 你与收尾
| id | 名称 | Status | Place | Motif |
|---|---|---|---|---|
| owner-needed | 需要你决定 | existing | previous place frozen at 35% | amber halo breathing around the orb; interaction card |
| problem | 出了点问题 | existing | previous place desaturated to slate, slowed to 20% | faint coral edge glow; no alarm red |
| report-ready | 汇报就绪 | existing | Mind settle | stars settle into an arc that leans toward the report button |
| complete | 已完成 | existing | Mind still | round, still orb |

### Transient events (≤ 2.4 s overlays, never change the family)
| id | 名称 | Trigger | Motif |
|---|---|---|---|
| steer | 收到补充 | owner message mid-turn | a ripple travels from the copy column to the orb; chip shows the quoted note |
| retry | 重试 | `api_retry`, tool timeout | dashed ring orbits the orb once; place pulses dim briefly |
| model-switch | 切换备用模型 | model fallback system notice | orb shimmer (glow up, exposure dip); chip "已切换到备用模型" |
| chain-confirmed | 已上链 | tool result carrying a txid / pinId | small gold seal stamp near the newest block |
| tool-error | 小挫折 | tool result `isError` mid-turn | place flickers to slate for 400 ms then recovers |

## 4. Concurrency rules (balancing local Workers + private chats + group tasks)

1. **One place.** The place follows the Twin's foreground action in this Studio
   turn only. Background threads never switch the place.
2. **Hysteresis.** A place holds ≥ 2.5 s unless the new action is still running
   after 1 s; rapid alternation (bash → read pin → bash) collapses to the
   dominant place of the last 6 events.
3. **One hero.** Only one companion connector animates at full energy: the
   thread the foreground action touches; otherwise the most recent thread event
   (< 8 s); otherwise none (rail only). Non-hero threads keep a low-frequency
   pulse on their rail item.
4. **Rail order.** Active-now (sending/receiving/dispatching) → working →
   waiting. Max 5 visible items, then a `+N` chip. Groups: 本地协作 / 私聊 / 群任务.
5. **Connector grammar never mixes.** Local Worker = solid PCB trace (local);
   private chat = dashed arc + capsule (remote, encrypted); group task = ring
   (one-to-many). The owner can tell the relationship type without reading.
6. **Turn finished, threads running** (`waiting`): place = hero thread's place
   at 55%; rail persists; copy summarizes ("AI_Pixel 等 3 个协作进行中").
7. Rail sits top-right (14%–60% height) and never overlaps the Task HUD
   (bottom-right).

## 5. Low-key, high-craft budget

- Resting background strokes ≤ .12 alpha, highlights ≤ .6, glow via additive
  blending only on moving highlights.
- Left copy column is protected: background alpha ramps from 15% at x ≤ 30% to
  100% at x ≥ 55%, plus a soft radial vignette centred on the orb.
- Static geometry (traces, mesh, blocks) renders to an offscreen layer on
  resize; per-frame work is limited to moving highlights.
- `prefers-reduced-motion` → each place shows a composed static frame.

## 6. Orb tint (optional, a tweak in the preview)

Only `glowColor` follows the place (Mind `#956CFF`, Machine `#D9A25F`, Web
`#6FA0FF`, Chain `#46D6E6`), at the existing low `edgeGlow`. The orb's
identity palette never changes.

## 7. Owner decisions (2026-11-18)

1. **Web2 place: variant A (hyperlink mesh). Chain place: variant A (block
   ribbon).** Variant B renderers stay in the prototype only. Production note
   from the owner: the chain-write animation must never show blocks that look
   overlapped or doubled — block positions are slot-quantized (no free scroll
   while a write shifts the ribbon), the unfolding block owns the pending slot,
   and the ribbon shifts by exactly one pitch.
2. **`chain-transfer` is its own state, with no money or coin imagery** (no
   gold diamond, no value glyphs). It expresses an *exchange*: two packets
   travel in opposite directions between the orb and the chain head and swap,
   and the seal is two interlocking rings; cyan + violet, never gold.
3. **`speaking` keeps the previous place, dimmed** (it does not return to Mind).
   Periodic place events pause while the Bot speaks; geometry stays.
4. **Group ring stays as drafted** (chair = small gold dot on the orb's top edge).

All transient events are accepted as drafted.
