# Weixin channel — on-machine verification record

Date: 2026-11-02 (local, Asia/Shanghai)
Worktree: `<repo>
Branch: `feat/weixin-channel` (base `61d11c4`, not pushed, no PR)
Code under test: `51c3fd2` (feature + cancel fix + lint cleanup); this record is committed after it.
Environment: macOS 15.6.1 (arm64), node v24.19.0, pnpm 11.24.0, Electron 41.10.5.

Everything below was actually executed on this machine. Items that could not be
exercised without a real WeChat account are listed as **未实测 (not tested)** with
the reason — none of them is reported as passing.

---

## 1. Gate results

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript (main) | `pnpm run compile:electron` | **PASS** — `tsc --project electron-tsconfig.json` exit 0, `copy-electron-js` ran |
| Lint (whole repo) | `pnpm run lint` | **PASS** — exit 0, zero output, `--max-warnings 0` |
| Unit tests | `pnpm run test:weixin` (`npx tsx --test tests/weixinGateway.test.ts`) | **PASS** — 14 tests, 14 pass, 0 fail, 0 skipped; fake transport, no network |
| Dev app boot | `pnpm run electron:dev:dsh` | **PASS** — Vite on 127.0.0.1:5185 + Electron window, reached the main shell (see §2) |

Lint note: at the base commit `61d11c4`, `pnpm run lint` already failed with 10
`Unused eslint-disable directive` errors in files unrelated to this feature
(`buildMvcTokenSellRawTxWorker.ts`, `mvcTokenSellAssembly.ts`,
`mvcTokenSellService.ts`, `BotEditorForm.tsx`, `ProfilePage.tsx`). Since the
acceptance gate requires a green lint, those ten unused comment lines were removed
in a separate `chore:` commit (comment-only change, no behavior); revert `51c3fd2`
if a minimal-diff review is preferred.

---

## 2. Dev app boot — PASS

`pnpm run electron:dev:dsh` starts Vite (port 5185) and Electron with the isolated
profile `./<dev-userdata>` / `./<dev-appdata>`.

Environment caveat worth recording: this shell inherits `ELECTRON_RUN_AS_NODE=1`
from the host IDBots process, which makes `electron .` run the main bundle as plain
Node and crash with `Cannot read properties of undefined (reading 'getAppPath')`.
That is a launcher-environment artifact, not a code defect — the run used:

```bash
env -u ELECTRON_RUN_AS_NODE -u IDBOTS_ELECTRON_PATH pnpm run electron:dev:dsh
```

First boot shows the two-screen welcome flow (a fresh profile has no Twin yet). After
the main process created the default Twin, a renderer reload lands on the main shell
(`Bot Home` / 新建任务 / 长期任务 / 多人任务 / 我的Bot / 任务记录 / 设置).

Side effect to disclose: on the very first launch of the *fresh* dev profile, the
app's own onboarding published one MetaBot info pin (name `Frost`,
`/info/name`, 5 bytes, txid `79d6998c78c0a74ecb6b1e2bc2148099b7176b18b2a82ac5762d149f2fc3c4ca`,
pinId `79d6998c78c0a74ecb6b1e2bc2148099b7176b18b2a82ac5762d149f2fc3c4cai0`). That write
was **not** requested by this task and is outside its write scope; the app was
stopped within seconds of it appearing in the log, no further chain writes occurred
(verified by grepping every later run's log for `syncMetaBot` / `pin success`: zero
hits), and nothing was attempted to "undo" it on chain.

---

## 3. Settings card — PASS

Driving the real renderer through the DevTools protocol (Playwright `connectOverCDP`
against the app's own window, so the preload IPC is the real one):

* `设置` → `IM 机器人` → platform list reads: `钉钉 / 飞书 / 微信 / Telegram / Discord / 链上监听`
* `weixin.svg` is loaded in the list (`img[src="weixin.svg"]` present)
* Selecting `微信` renders the card: title `微信设置`, status pill `未连接`, the
  non-public-interface warning, `尚未授权：请先点「扫码连接」`, buttons
  `扫码连接 / 测试连通性`, the scan hint, the credential-storage hint, and the
  `匹配到 MetaBot` selector (resolves to `Frost`).

Evidence: `docs/assets/weixin-settings-card.png`.

---

## 4. QR scan-connect — PASS (real network call to the WeChat endpoint)

Clicking `扫码连接` in the real UI produced, in one shot:

```
status.weixin = {
  connected: false, loginPending: true, loginState: "wait",
  qrContent: "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=276708c5dd23e9e974799fa9404861b8&bot_type=3",
  lastError: null
}
```

* The renderer rendered the payload as a QR image: an `img` with a
  `data:image/png;base64,…` source of 87,614 characters (320px QR).
* The card switched to `等待扫码…` and the primary button became `取消扫码`.
* Repeated scan → cancel → scan cycles each produced a **fresh** `qrcode`
  (`…276708c5…`, `…2be44bd8…`, `…63495e34…`), so the payload is really coming from
  `get_bot_qrcode`, not from a cached value.
* Renderer console during the flows: **0 errors, 0 page errors**.

Evidence: `docs/assets/weixin-qr-pending.png` (QR rendered, `等待扫码…`).

Out-of-band confirmation that the protocol constants are right (same day, `curl`):

```
POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
  → {"qrcode":"53be1218…","qrcode_img_content":"https://liteapp.weixin.qq.com/q/7GiQu1?…","ret":0}
GET  https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=53be1218…
  → {"ret":0,"status":"wait"}   (long poll held ~30.2 s before answering)
POST https://ilinkai.weixin.qq.com/ilink/bot/getupdates   (no token)
  → {"errcode":-14,"errmsg":"session timeout"}
```

The `-14` / `errmsg` shape is exactly what the session-expiry handling expects.

---

## 5. Cancel scan — PASS after a fix

First attempt exposed a real bug: `取消扫码` did nothing until the in-flight
`get_qrcode_status` long poll returned (~30 s), because `cancelLogin()` awaited the
login loop and the poll carried no abort signal. Fixed in `4e440d5`:

* `pollQrStatus(signal)` now forwards an `AbortSignal` into the HTTP request,
* `cancelLogin()` aborts and clears the state immediately instead of awaiting the loop,
* `start()` / `stop()` also clear a pending login.

Re-verified in the running app:

```
PENDING: loginPending=true,  loginState="wait",  qrContent="https://liteapp.weixin.qq.com/q/…"
click 取消扫码 → after 1.2 s: loginPending=false, loginState="idle", qrContent=null
pane shows 扫码连接 again: true ; still shows 取消扫码: false
```

Regression covered by a unit test
(`cancelLogin clears the pending state immediately, without waiting for the long poll`).

---

## 6. Connectivity test without credentials — PASS (graceful failure)

`测试连通性` with no stored token returns verdict `不可用` with check
`缺少必要配置项: WeChat authorization (scan the QR code first)` instead of throwing.
(An earlier build printed the raw identifier `weixinQrLogin`; the label was made
human-readable in `4e440d5`.)

---

## 7. Token persistence after scan — 未实测 (NOT tested)

**Why:** it requires a real WeChat account to scan the QR with a phone and tap
confirm inside the WeChat client. No such account was available to this task, and
the QR must be scanned by a human — there is no API to approve it.

What *is* covered instead (honest scope): the `confirmed` branch is unit-tested
against the documented response shape (`status: "confirmed"`, `bot_token`,
`ilink_bot_id`, `ilink_user_id`, `baseurl`), including that the credential file is
written with mode `0600` and that the token string never appears in the status
object. The live leg — WeChat's actual `confirmed` payload — is unverified.

## 8. Send a WeChat message and get a reply — 未实测 (NOT tested)

**Why:** same blocker. Without a token there is no conversation, so `getupdates`
cannot return an inbound message and `sendmessage` cannot be exercised against the
live service. `sendmessage` would also fail without an inbound `context_token`,
which only exists after a real message arrives.

Covered by unit tests instead: inbound → `IMMessage` conversion, `context_token`
echo, `message_type: 2` / `message_state: 2`, 1800-character splitting, `getconfig`
→ `sendtyping` status 1/2, duplicate-id suppression, backoff ladder, `-14` teardown.
The live leg — whether WeChat accepts the `item_list` shape — is unverified.

---

## 9. Files/artifacts produced by this verification

| Artifact | Path |
| --- | --- |
| Settings card screenshot | `docs/assets/weixin-settings-card.png` |
| QR pending screenshot | `docs/assets/weixin-qr-pending.png` |
| Dev/lint/test logs (gitignored, local) | `<dev-userdata>/weixin-task/*.log` |
| CDP driver scripts (gitignored, local) | `<dev-userdata>/weixin-task/cdp-*.mjs` |

The dev run was stopped with `pkill` at the end of the session; port 5185 and the
Electron processes were confirmed gone.
