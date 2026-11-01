# WeChat (Weixin) IM channel

Status: **MVP, text-only direct chat.** Added behind the existing IM gateway
framework (`src/main/im/`) as a fifth managed platform next to dingtalk / feishu /
telegram / discord.

What this channel is: after the owner scans a QR code with WeChat, a MetaBot can
receive direct text messages from a WeChat user and answer them in the same chat.

What this channel is **not** (v1 scope, see "Not covered" below): group chats,
images/voice/files/video, tool-confirmation prompts rendered inside WeChat,
scheduled-task notifications, and any form of account/password login.

---

## 1. Architecture

```
renderer (IMSettings.tsx)
   │  im:weixin:login:start        ┌──────────────────────────────────────────┐
   │  im:weixin:login:cancel       │ IMGatewayManager                         │
   │  im:status:get / statusChange │  ├─ WeixinGateway (EventEmitter)         │
   ▼                               │  │    ├─ requestQrCode / pollQrStatus    │
main.ts IPC  ────────────────────► │  │    ├─ getupdates long poll loop       │
                                   │  │    ├─ sendText / sendTyping           │
                                   │  │    └─ events: connected/disconnected/ │
                                   │  │                status/error/message/login │
                                   │  └─ WeixinStore (files, 0600)            │
                                   └──────────────────────────────────────────┘
                                          │
                                          ▼
                                   https://ilinkai.weixin.qq.com/ilink/bot/*
```

| File | Role |
| --- | --- |
| `src/main/im/weixinGateway.ts` | Gateway: QR login orchestration, long-poll loop, message conversion, outbound send, typing, backoff, session-expiry handling |
| `src/main/im/weixinProtocol.ts` | Pure protocol helpers: constants, tolerant response parsers, 1800-character splitter, `IMMessage` conversion |
| `src/main/im/weixinTransport.ts` | `fetch`-based HTTP transport behind a small interface (so tests never touch the network) |
| `src/main/im/weixinStore.ts` | Credential + cursor persistence under `<userData>/weixin/accounts/` |
| `src/main/im/types.ts` | `WeixinConfig`, `WeixinGatewayStatus`, `IMPlatform` + `'weixin'` |
| `src/main/im/imGatewayManager.ts` | Registers weixin in `MANAGED_IM_PLATFORMS`, forwards events, owns the QR-login → enable → start sequence |
| `src/renderer/components/im/IMSettings.tsx` | "WeChat" settings card: scan, status, disconnect, connectivity test, MetaBot routing |
| `tests/weixinGateway.test.ts` | 13 unit tests, fake transport, zero real network |

Message flow uses the shared contract unchanged: the gateway emits
`message(IMMessage { platform: 'weixin', chatType: 'direct', ... })`, the manager
hands it to the same `IMCoworkHandler` used by the other platforms, and the reply
comes back through the `replyFn` the gateway passed in.

---

## 2. Protocol essentials (as implemented)

All requests go to `https://ilinkai.weixin.qq.com` (the login response may return a
different `baseurl`, which is then preferred and persisted).

| Purpose | Call |
| --- | --- |
| Request a login QR | `POST ilink/bot/get_bot_qrcode?bot_type=3`, body `{ local_token_list: [...] }` → `{ qrcode, qrcode_img_content }` |
| Poll login state | `GET ilink/bot/get_qrcode_status?qrcode=<token>` (long poll, client timeout 35 s, header `iLink-App-ClientVersion: 1`) → `wait` / `scaned` / `confirmed` / `expired` |
| Receive messages | `POST ilink/bot/getupdates`, body `{ get_updates_buf, base_info }` → `{ msgs[], get_updates_buf, longpolling_timeout_ms? }` |
| Send text | `POST ilink/bot/sendmessage`, body `{ msg: {...}, base_info }` |
| Typing indicator | `POST ilink/bot/getconfig` → `typing_ticket`, then `POST ilink/bot/sendtyping` with `status: 1` (start) / `2` (stop) |

Business request headers: `Authorization: Bearer <bot_token>`,
`AuthorizationType: ilink_bot_token`, `X-WECHAT-UIN` (base64 of a random uint32,
regenerated per request), `Content-Type: application/json`.

Response convention: HTTP 200 with a business code — `ret` or `errcode`, `0` = OK.
`-14` means the session is gone and requires a fresh QR scan.

Message body: `item_list` of `MessageItem`s; `type: 1` carries
`text_item.text`. `message_type` 1 = user, 2 = bot (bot echoes are dropped).
`create_time_ms` becomes `IMMessage.timestamp`.

**`context_token` is the conversation anchor.** Every inbound message carries one;
every outbound `sendmessage` must echo the most recent token for that peer or the
reply cannot be routed. The gateway caches it per peer and treats a missing token
as a hard send failure rather than guessing.

Outbound text is split at **1800 characters** (the value used by the official
plugin). Splits prefer a paragraph break, then a line break, then a space near the
end of the window; a runaway reply is capped at 20 chunks with an explicit
`…(truncated)` marker instead of silently dropping the tail. Each chunk gets a fresh
`client_id` (`idbots-weixin:<ms>-<hex>`).

---

## 3. Persistence

```
<userData>/weixin/accounts/{accountId}.json       # bot token, baseurl, bot id, user id
<userData>/weixin/accounts/{accountId}.sync.json  # opaque get_updates_buf cursor
```

* Files are written atomically (tmp + rename) with mode **0600**.
* The token is deliberately **not** stored in the SQLite `im_config` table, so the
  renderer-visible config payload (`im:config:get`) and support bundles never carry
  a bearer credential. `WeixinConfig.token` exists only so a token can be supplied
  programmatically; the QR flow does not write it there.
* The cursor is an opaque blob: persisted verbatim, never decoded or edited.
* On `-14` both files are cleared and the channel requires a new scan.

---

## 4. Security, compliance and risk

**This is a non-public WeChat interface.** `ilinkai.weixin.qq.com` is not a
documented open platform: field names, headers and status values can change without
notice, the endpoint can be rate-limited or disabled, and there is no support
contract. Treat any failure as possible protocol drift, not as a bug in the app.
This warning is repeated at the top of `weixinProtocol.ts` and on the settings card.

Constraints deliberately enforced in code:

* **QR authorization only.** No account/password login, no cookie replay, no web
  WeChat protocol. The only credential path is `get_bot_qrcode` →
  `get_qrcode_status` → `confirmed`.
* **The token never reaches logs.** No `console.*` call in the channel prints the
  token, the `Authorization` header, or a credential file path with content;
  status objects are asserted token-free by the unit tests.
* **No hidden writes.** Sending only ever answers an existing conversation; there is
  no API here to open a conversation, so the channel cannot DM a stranger.

---

## 5. Configuration / UI

Settings → IM → **WeChat**:

1. Amber notice: non-public interface, direct-chat text only.
2. **Scan to connect** → `im:weixin:login:start` → the main process fetches the QR
   payload and starts polling. The renderer renders `qrcode_img_content` (a URL) as
   a QR image with the `qrcode` package.
3. While pending the card shows "Waiting for scan…" → "Scanned — confirm on your
   phone"; the server-side state machine drives the label.
4. On `confirmed` the token is persisted, `enabled` flips to true, and the gateway
   starts automatically. A terminal `expired`/`error` clears the QR and shows the
   error text.
5. **Disconnect** stops the gateway and marks the channel disabled (the credential
   file is kept so the next start does not need a new scan).
6. The MetaBot selector and the connectivity test work exactly as on the other
   channels; the test performs one short `getupdates` round.

Config shape (`WeixinConfig`): `enabled`, `accountId` (credential slot, default
`default`), `token?`, `baseUrl?`, `metabotId?`, `debug?`.

---

## 6. Tests

`tests/weixinGateway.test.ts` (run: `pnpm run test:weixin`, i.e.
`npx tsx --test tests/weixinGateway.test.ts`) covers, entirely against a fake
transport — **no real network**:

* QR request shape + pending status
* `confirmed` → token persisted (file mode asserted `0600`) and absent from status
* `start()` refuses without a token, starts with one
* inbound → `IMMessage` (text, bot-echo drop, media placeholder)
* typing start/stop + `getconfig` ticket reuse
* `sendmessage` payload (context token echo, `message_type` 2, `message_state` 2)
* 1800-character splitting end to end
* backoff ladder 2 s → 4 s → 10 s on repeated failures, gateway stays connected
* `-14` clears token + cursor and emits `disconnected`
* local long-poll timeout is an empty poll, not a failure
* duplicate `message_id` replay is answered once

---

## 7. Not covered (v1) / open items

| Item | State |
| --- | --- |
| Group chats | Not implemented. `group_id` is parsed but every message is treated as `direct`; group send is not attempted. |
| Images / voice / files / video | Not implemented. Inbound media-only messages become a `[unsupported weixin message: …]` text placeholder so the agent can answer instead of going silent; outbound media is not attempted. |
| Tool-confirmation prompt in WeChat | Not implemented. Tools follow the existing IM policy (auto-allow + log); no WeChat-side approval card. |
| Scheduled-task notifications to WeChat | Not wired: `NotifyPlatform` still lists only the four original platforms. `sendNotification` exists and targets the most recent conversation. |
| Automatic re-login after `-14` | Not automatic by design: the token and cursor are cleared and a human must scan again. |
| Live `sendmessage` / `sendtyping` round trip | **Unverified in this environment** — it needs a real WeChat account to scan the QR. The payload shapes follow the published protocol notes; if WeChat changed a field, expect a `ret != 0` error surfaced in the card, not a silent failure. |
| Rate limits / retry-after policy | Unknown; the gateway only applies a local backoff ladder (2 s / 4 s / 10 s / 30 s cap). |
| QR expiry duration | Not exposed by the server; an `expired` answer prompts a new scan. |

---

## 8. Change map

* `src/main/im/weixin{Protocol,Transport,Store,Gateway}.ts` (new)
* `src/main/im/{types,imStore,imGatewayManager,index}.ts`
* `src/main/{main,preload}.ts` (+ `src/main/gateway/allowlist.ts`,
  `docs/cloud-mobile/02-ipc-allowlist-v1.md`, regenerated
  `src/mobile/generated/ipc-contract.json` for the three new IPC channels)
* `src/renderer/components/im/IMSettings.tsx`, `src/renderer/types/{im,electron}.ts`,
  `src/renderer/store/slices/imSlice.ts`, `src/renderer/services/im.ts`,
  `src/renderer/utils/regionFilter.ts`, `src/renderer/services/i18n.ts`,
  `public/weixin.svg`
* `tests/weixinGateway.test.ts` (new), `package.json` (`test:weixin`)
