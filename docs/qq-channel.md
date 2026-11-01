# QQ channel (official QQ Open Platform bot)

Status: implemented on `feat/qq-channel`; offline suite green; live QQ verification is
partial — see [qq-channel-verification.md](./qq-channel-verification.md).

This channel is different from the Weixin one on purpose: it speaks to the **official**
QQ Open Platform through Tencent's own SDK. There is no reverse-engineered endpoint in
this folder.

- `@tencent-connect/qqbot-nodejs@1.0.5` (MIT) — REST + WebSocket gateway, message send,
  media upload (chunked above 5 MB), C2C streaming.
- `@tencent-connect/qqbot-connector@1.2.0` — QR bind flow that returns AppID + AppSecret.

Both are ESM-only at the package level (`"type": "module"`). `electron-tsconfig.json`
compiles the main process to CommonJS, so a literal `import()` would be rewritten to
`require()`. `qqGateway.ts` therefore re-imports through
`new Function('specifier', 'return import(specifier)')` — the same escape hatch already
used by `src/main/libs/knowledgeBaseConverters.ts` for pdfjs-dist.

## 1. Architecture

```
renderer (IMSettings.tsx, QQ card)
   │  im:qq:login:start / cancel / credentials:check / credentials:set
   │  im:gateway:start|stop|test (platform = 'qq')
   ▼
IMGatewayManager ── QQGateway (EventEmitter)
   │                   ├─ QQStore            <userData>/qq/accounts/<appId>.json (0600)
   │                   ├─ qqProtocol.ts      pure conversion / mention gate / limits
   │                   ├─ qqMedia.ts         inbound download + path/SSRF/size guards
   │                   └─ QQBot (official SDK, WebSocket transport)
   ▼
IMCoworkHandler (existing, platform-neutral)
```

Files:

| File | Role |
| --- | --- |
| `src/main/im/qqGateway.ts` | lifecycle, QR bind, supervisor/reconnect, inbound dispatch, per-conversation FIFO, outbound text/media, auth probe |
| `src/main/im/qqProtocol.ts` | `IMMessage` conversion, `chatType`, conversation ids, @-mention decision, text chunking, media classification, size constants |
| `src/main/im/qqMedia.ts` | inbound download, filename sanitisation, path containment, SSRF guard, outbound pre-checks |
| `src/main/im/qqStore.ts` | AppID/AppSecret/BotID/owner OpenID persistence (0600), secret-free summaries |
| `src/main/im/types.ts` | `QQConfig`, `QQGatewayStatus`, `IMPlatform = … | 'qq'` |
| `src/main/im/imStore.ts` | config accessors; **strips `appSecret` on every read path** |
| `src/main/im/imGatewayManager.ts` | `MANAGED_IM_PLATFORMS` + qq, login/credential APIs, connectivity probe |
| `src/main/main.ts`, `preload.ts` | IPC handlers / bridge |
| `src/renderer/components/im/IMSettings.tsx` | QQ card: scan, manual credentials, status, test, disconnect |
| `tests/qqGateway.test.ts` | 32 offline tests |

## 2. Credentials

### QR bind

1. Renderer calls `im:qq:login:start` → `QQGateway.beginLogin()`.
2. `startQrConnect` is configured with `displayQrCodeToConsole: false` and
   `source: 'idbots'`; the QR URL arrives via `onQrDisplayed` and is rendered by the
   settings page (never printed to a terminal or a log).
3. On `onSuccess` the credentials are written immediately to
   `<userData>/qq/accounts/<appId>.json` (mode 0600) and mirrored — **AppID only** — into
   the config table.
4. The login window is bounded twice: 60 s for the QR URL to appear, 5 min for the whole
   scan. Cancelling rejects the pending `pollLogin()` and disposes the connector.

### Manual credentials

`im:qq:credentials:set` accepts `{ appId, appSecret, botId?, ownerUserOpenid? }`, writes
through the same 0600 store, then the settings page calls `im:gateway:start('qq')`.

### Secret handling

- `appSecret` is **write-only** over IPC. `imConfig.getConfig()` runs
  `stripQQSecret()`, so no read path returns it.
- Status objects carry `appId` only; `credentialSummary()` has the same rule.
- Logs and error messages pass through `redactQQSecrets()`; the SDK logger discards
  `debug` lines and redacts `info`/`warn` text.
- The appSecret never enters a buzz, a doc, or a PR description. This repository's docs
  and tests use the literal placeholder `test-secret-value` / `qr-secret` only.

## 3. Direct chat and group chat

- `chatType`: `c2c` → `direct`, `group` → `group`.
- Conversation id: `qq:c2c:<user_openid>` / `qq:group:<group_openid>`. The scope prefix
  keeps a private chat and a group apart even if an OpenID collides, so session mappings
  cannot leak across chats.
- **Group messages are answered only when the bot is @-mentioned.** The decision follows
  the SDK's own `mentionGate` priority:
  1. `rawEventType === 'GROUP_AT_MESSAGE_CREATE'` (the platform only delivers this event
     for @-mentions);
  2. `mentions[].is_you === true`;
  3. `<@!appId>` / `<@appId>` inside the content.
  A plain `GROUP_MESSAGE_CREATE` without a mention is dropped before it can create a
  session.
- Mention markers are stripped before the text reaches the model.
- `guild` / `dm` events are ignored: the high-level facade does not derive a
  `replyTarget` for them (SDK `USAGE.md` §5.3), so they are outside this channel's
  contract.

## 4. Concurrency (the Weixin lesson)

Each conversation id owns a promise chain (`enqueueConversation`). Messages from the same
chat run strictly one after another; different chats still run in parallel. When a second
message arrives while the first is still running, the gateway sends at most one
"上一条消息还在处理中，这条已排队" notice per conversation per 30 s and then queues the work.

This is what prevents two handlers from writing the same cowork session at once (the
Weixin channel hit `session already owned by an active write handle` this way).

## 5. Media

### Inbound

`readQQMediaRefs()` accepts only `https:` URLs; voice prefers `voice_wav_url` (the
platform's WAV conversion) and keeps `asr_refer_text` as a fallback body. Downloads go
through `defaultQQMediaNetwork.fetchBytes`, which:

- refuses non-HTTPS, userinfo-bearing, localhost, private/link-local literal hosts;
- refuses a declared `content-length` above the cap and re-checks the real body size;
- writes into `<mediaRoot>/<conversation>/` with a **locally generated** name, mode 0600.

The remote filename is sanitised (`sanitizeQQFileName`: strips `/` and `\` paths, control
chars, leading dots, over-long names) and is only kept as display metadata. Every local
write goes through `resolveInsideQQMediaDir`, which rejects anything resolving outside the
conversation directory.

Inbound caps (client-side guards, not platform contracts):

| Guard | Value | Source |
| --- | --- | --- |
| per attachment | 100 MB | the largest documented **outbound** ceiling (video/file, SDK `MEDIA_FILE_TYPE_INFO`); the inbound push payload declares no limit, so we refuse rather than write an unbounded body |
| attachments per message | 5 | our own guard |
| unusable/oversized items | counted as failed and surfaced as `[N attachment(s) failed to download]` in the message body | `toQQIMMessage` |

### Outbound

`sendMedia()` classifies by extension and dispatches to `sendImage` / `sendVideo` /
`sendFile` (voice → `sendVoice`). Sizes are checked **before** any upload starts.

| Kind | SDK constant | Value | Source |
| --- | --- | --- | --- |
| image | `MediaFileType.IMAGE` | 30 MB | SDK `MEDIA_FILE_TYPE_INFO`; also `USAGE.md` §10.3 |
| video | `MediaFileType.VIDEO` | 100 MB | same |
| voice | `MediaFileType.VOICE` | 20 MB | same |
| file | `MediaFileType.FILE` | 100 MB | same |

`tests/qqGateway.test.ts` imports the installed SDK and asserts `getMaxUploadSize()` for
all four kinds equals `QQ_MEDIA_LIMITS_BYTES`, so the constants cannot drift silently.

Files above 5 MB (`LARGE_FILE_THRESHOLD`) are automatically uploaded through the SDK's
chunked path (`upload_prepare → PUT → upload_part_finish → complete_upload`), up to
`CHUNKED_UPLOAD_MAX_SIZE` = 100 MB (`USAGE.md` §10.2).

### Text

No text-length limit is documented in the SDK or its `USAGE.md`. `QQ_TEXT_CHUNK_LIMIT =
1800` is therefore labelled a **client-side compatibility choice** (same value as the
Weixin channel), not a platform limit, and the last chunk is marked `…(truncated)` when
the 20-chunk cap is hit.

### Reply target lifetime

An inbound `msgId` is kept for 5 minutes and used for passive replies. After that the
gateway degrades to an active push (no `msgId`), which is quota-limited by QQ. The 5-minute
number comes from `USAGE.md` §11.2 (a streaming reply must be based on an inbound message
no older than 5 minutes); QQ's passive-reply rules share that window.

### Typing indicator

`sendTyping(target, 30)` is called for C2C only (`USAGE.md` §9.3). Group chats get none.

## 6. Reconnect

Two layers:

1. The SDK's own WebSocket reconnect state machine
   (`RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]`, bounded to 8 attempts in
   `QQBotFactory`).
2. `QQGateway.runSupervisor`: when `bot.start()` rejects or resolves unexpectedly, the
   gateway recreates the bot with its own exponential backoff
   (`[1000, 2000, 5000, 10000, 30000, 60000]`), records `lastError`, and keeps retrying
   until `stop()`. A failure never crashes the process.

## 7. IPC surface

| Channel | Tier | Purpose |
| --- | --- | --- |
| `im:qq:login:start` | P2 | start a QR bind, returns the QR URL |
| `im:qq:login:cancel` | P2 | abort the pending QR bind |
| `im:qq:credentials:check` | P2 | `{ hasCredentials, appId, source }` — no secret |
| `im:qq:credentials:set` | P2 | write-only AppID/AppSecret into the 0600 store |
| `im:gateway:start/stop/test` | P2 | existing channels, now accept `'qq'` |

`src/mobile/generated/ipc-contract.json` was regenerated.

## 8. Known limits / not covered

- **No live account was used.** QR scan completion, real messages, and real media could
  not be tested; see the verification doc for the exact "not tested + reason" list.
- Active pushes (no `msgId`) are subject to QQ-side quotas we cannot measure offline.
- Streaming (`openStream`) and Markdown (`sendMarkdown`, needs markdown permission) are
  not wired: the framework has no streaming surface and `markdownSupport` would have to
  become a per-bot setting.
- Guild / channel / DM scopes are ignored by design.
- The QQ attachment CDN host set is undocumented, so the SSRF guard is property-based
  (HTTPS + no private literal host) rather than an allowlist. DNS rebinding is out of
  scope and is documented here rather than silently assumed away.
- `@tencent-connect/qqbot-connector@1.2.0` declares `"license": "UNLICENSED"` in its
  package.json. It is published under Tencent's official `@tencent-connect` scope, but the
  license field should be reviewed before shipping a distributed build.
- The ESM dynamic import works under Node 24 and was verified directly
  (`node -e "import('@tencent-connect/qqbot-nodejs')…"`). Inside an ASAR-packaged build it
  still relies on the runtime `import()` escape hatch; this was not smoke-tested in a
  packaged artifact.
