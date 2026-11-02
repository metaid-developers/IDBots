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
- Group answers are layer-1 Q&A only (see §3.1): the bot cannot touch the host machine
  from a group, whatever a group member asks.

## 3.1 Security boundary (three layers, enforced in code)

Why this exists: after the bot was invited to a group, **any group member** could command
it, and each of those turns ran with the host bot's full local surface (files, shell,
wallet, chain writes). Prompt wording cannot fix that, so the decision is made once, at
the message entry point (`src/main/im/qqTrust.ts`), and carried — frozen — through the
whole turn.

| Layer | Who | What they get |
| --- | --- | --- |
| 1. Normal conversation | anyone in an allowlisted group | text Q&A only: **no tools, no memory, no attachments** |
| 2. Owner-only | the bound owner OpenID, direct messages | Q&A + long-term memory read/write |
| 3. Local machine operations | **nobody by default** | files / shell / attachments / wallet / chain writes, only when the switch is on AND the identity is in `localToolsAllowFrom` |

Enforcement points (all code, none prompt-only):

- **One decision per message.** `resolveQQMessageGate()` returns an immutable
  `IMTrustContext`; `toQQIMMessage()` re-freezes it. `IMGatewayManager` drops a QQ message
  with no trust context, and `CoworkRunner` can only *narrow* trust when a session is
  continued — never widen it.
- **Group tool surface is empty.** `buildDshHostTools()` returns `[]` for
  `toolScope !== 'local'` (tools are not registered at all), and the policy hook
  (`evaluateDshToolPolicy`) denies every built-in tool (Read/Write/Bash/WebFetch/…) even
  if the runtime mounts it. The skills catalog, the browser-tab block, the active goal and
  the remote-services directory are suppressed as well.
- **Group content never becomes memory.** Group turns run with
  `disableMemoryUpdates: true`, the skills/KB tools are not mounted, and the nightly
  consolidation query explicitly excludes sessions whose mapping channel is
  `im:%:group`. Group sessions are also `hidden_from_session_list = 1`, which keeps them
  out of the recent-session pulse another (private) chat would otherwise see — no group →
  private context flow.
- **Group workspace is isolated.** A group session's cwd is
  `<userData>/qq-group-workspaces/<group-openid>`, created empty, never the owner's
  working directory. The system prompt for a group is a minimal Q&A prompt with no
  skills catalog, no tool instructions and no owner context.
- **Strangers get silence.** An unknown DM sender receives **no text at all** — not even
  "unauthorized" — and no typing indicator. Only the bound `ownerUserOpenid` can trigger
  a DM turn, and an unbound channel serves nobody (fail-closed).
- **Group allowlist.** `groupPolicy` is `open | allowlist | disabled`; the default is
  `allowlist` with an **empty list**, i.e. no group is answered until the owner allows one.
  An unknown/invalid policy value degrades to `disabled`. Groups are authorized from the
  settings list — the id is captured from the platform, never typed by a human (see
  「Group authorization without the 32-hex group OpenID」).
- **Group attachments are refused.** Images/files/videos in a group are never downloaded
  and never written to disk; the bot replies once with
  `群里不支持看文件，私聊我` and does not run a model turn.
- **Identity is the stable id.** `senderId` (`member_openid` in groups, the user OpenID in
  C2C) is the only identity input. Display names are never consulted, so a forged nickname
  cannot gain anything. `senderIsBot === true` (SDK `author.bot`) is dropped first, which
  also breaks bot-to-bot @ loops.
- **Fail-closed.** Any throw inside the gate, a missing sender id, a missing group id or a
  missing owner binding resolves to a silent drop — never to a permissive fallback.
- **Audit.** Every group trigger appends one JSONL record under `<userData>/qq/audit/`
  with group id, sender id, question summary (≤200 chars), reply summary, outcome and
  reason. The settings card lets the owner edit the policy, allow or remove groups from the
  recorded candidate list, and switch layer 3 with its own allowlist.

### Session classification (local list, group vs direct)

All IM sessions — direct AND group — are created as `session_type = 'standard'`, i.e.
they live in the owner's **local conversation list**. Direct IM chats used to be created as
`'a2a'`, which pushed them into the online-conversations tab; that split is gone.

The row tells the two apart with a display marker, and the marker is derived from the
conversation mapping, not from the session type:

| Row | Title (new sessions) | Badge |
| --- | --- | --- |
| QQ direct | `QQ · 私聊` | 私聊 |
| QQ group | `QQ · 群聊 · <last 4 of group openid>` | 群 |

`listSessions()` exposes `imChannel` (`im:qq:group` / `im:qq:direct`) and
`imConversationId` by reading `cowork_conversation_mappings`. Consequences:

- **No destructive migration.** Sessions created before this change keep
  `session_type = 'a2a'` in SQLite; the sidebar puts them in the LOCAL list at render time
  (`a2a` rows WITH an IM channel are local, and are excluded from the A2A group), the row
  renders the IM badge instead of the A2A peer affordances, the detail view suppresses the
  A2A panels, and a legacy `IM-<platform>-<timestamp>` title is replaced **at render time
  only** (the stored title is untouched). A user-renamed or model-generated title always
  wins.
- Very old rows that only carry the untyped `im:<platform>` channel are classified from
  the stored conversation id (`qq:group:…` / `qq:c2c:…`); if that is missing too, the row
  gets **no badge** rather than a guess.
- **Security is unaffected.** Group/direct restrictions are decided by the entry gate
  (`trust.level`), never by `session_type`; making IM sessions 'standard' does not grant a
  direct chat any group limit or vice versa. The group session keeps its isolated
  workspace, empty tool surface, memory blackout and audit trail.
- **One behaviour is preserved by code, not by the hidden flag:** group sessions stay out
  of the recent-session pulse (`recentSessionPulse` excludes `im:%:group`), so a group
  message can still never be quoted into a private-chat prompt. They are visible in the
  owner's own list, which is intended.
- Archived rows are **not** re-classified: an IM direct session archived before this change
  stays under the A2A archive tab; sessions archived afterwards are standard.

### Group authorization without the 32-hex group OpenID

**The deadlock this replaced.** The allowlist could only be filled with the platform's
group OpenID — 32 hex characters such as
`D5C5A8FEDB9C07ED3962FC31238BE4EE`. That string exists **only** inside an inbound message
payload; it is never shown in the QQ client, and it is not the 8-digit 群号 the owner sees.
So the old flow required the bot to *receive* a message from the group in order to learn the
id, while the gate dropped unauthorized messages **without remembering the id**. The id was
discarded on arrival, the list could never be filled, and the group could never be opened.
Asking the owner to paste the id was asking for a value with no legitimate source.

**Recording, not granting.** When `groupPolicy === 'allowlist'` and a group is not in the
list, the gate returns `silent-drop` plus a `pendingGroupId`. The gateway then writes that
id to `<userData>/qq/group-candidates.json` and returns. Precisely what does and does not
happen on that path:

| Step | Happens? |
| --- | --- |
| Reply text / typing indicator | **no** |
| Model turn (`onMessageCallback`) | **no** |
| Tool call of any kind | **no** |
| Memory / knowledge-base write | **no** |
| Attachment download | **no** |
| Local id written to a state file | yes (id, timestamps, drop counter) |
| Message content / sender stored | **no** — only the group id |

Recording is therefore **not** authorisation. The next message from the same group is
refused again, because the decision still reads `groupAllowlist` and nothing else. An
explicit `disabled` policy records nothing at all — an opt-out is honoured, not harvested.

**The settings card** (`IMSettings.tsx`) shows a 「待授权的群」 list. Each row displays the
group name when the platform supplied one and otherwise 「未命名群」, always followed by the
full group ID with a one-click copy button, plus 允许 / 拒绝 / 查群名. 「允许」appends the id
to `groupAllowlist` (the existing config path — no new write path); 「拒绝」marks it ignored
and removes it from the list; the allowed list below carries 移除. **There is no textarea
and no input box asking for a group id anywhere**: a human never has to produce, type, or
transcribe 32 hex characters, and no screen asks them to.

**Group names: what the platform actually provides (verified, not assumed).**

1. **The inbound group event carries no name.** In
   `@tencent-connect/qqbot-nodejs@1.0.5`, `dist/protocol/types.d.ts → GroupMessageEvent`
   declares exactly `id`, `content`, `timestamp`, `author{member_openid, username?, bot?}`,
   `group_openid`, `attachments?`, `mentions?`, `message_scene?`, `message_type?`,
   `msg_elements?`. A full grep of the SDK's `dist/` tree for `group_name` / `groupName` /
   `chat_name` returns **nothing**, and `dist/protocol/api/routes.js` defines only message,
   file, upload, gateway and interaction paths. The message payload can never show a name.
2. **The Open Platform does publish a name endpoint.**
   [`GET /v2/groups/{group_openid}/info`](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_info.get.html)
   returns `group_openid`, `group_name`, `group_finger_memo`, `group_class_text`,
   `group_tags`, `group_member_num` at 30 QPM.
3. **That endpoint is whitelist-only.** The same page's error table documents
   **code 11253「应用无接口访问权限 — 该接口仅白名单机器人可用，请联系平台运营申请权限」**.
   A normal bot therefore gets `forbidden` and **no name**.

**Consequence, stated in the UI and enforced in code** (`src/main/im/qqGroupInfo.ts`): the
group ID is the authoritative identifier and is always displayed. A name appears **only**
when a lookup returned `ok`. On `forbidden` the row says, in words, that the platform did
not grant the endpoint (error 11253) and that only the ID is available; on
`unavailable`/`error` it says the name could not be fetched right now. We never derive,
guess, truncate-and-label, or placeholder a name. A name that was known is cleared if a
later re-check fails, so a revoked permission cannot leave a stale label behind
(`QQGroupCandidateStore.setName`).

Storage facts: `<userData>/qq/group-candidates.json`, mode `0600`, atomic write
(tmp + rename), capped at 100 remembered groups (oldest `lastSeenAt` evicted) so an invite
storm cannot grow it without bound, and a torn/unreadable file reads as **empty** — an
empty candidate list can only ever refuse groups.

### Inviter verification: not possible, stated plainly

**无法校验邀请人 (the inviter cannot be verified).** The official SDK exposes only
`ready` / `resumed` / `disconnected` / `error` / `message` / `interaction` events
(`USAGE.md` §8); there is **no** group-join event and no "who invited the bot" field in
`GROUP_AT_MESSAGE_CREATE`. Therefore:

- there is no code path that claims to check the inviter — nothing pretends it works;
- a group is answered **only** if its `group_openid` is in `groupAllowlist`;
- a bot pulled into a stranger's group stays silent until the owner adds that group id.

This is a platform limitation, not a product decision, and the settings card says so in
the UI (`qqGroupInviteWarning`).

> Owner-binding assumption (not live-verified): the QR connector returns `userOpenid`, and
> the SDK maps a C2C message's `senderId` from `ev.author.user_openid`
> (`dist/protocol/gateway/event-dispatcher.js:63`). The gate compares those two values.
> The field names line up, but a real scan + real DM was not available to this session, so
> the end-to-end equality is **not tested** — see the verification record.

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
| `im:qq:groups:candidates:list` | P2 | recorded unauthorized groups: `{ pending, all }` (ids + optional names) |
| `im:qq:groups:candidates:dismiss` | P2 | mark a group ignored (still refused, off the list) |
| `im:qq:groups:candidates:restore` | P2 | undo an ignore |
| `im:qq:groups:candidates:name` | P2 | optional platform name lookup; returns `nameStatus` (`ok` / `forbidden` / `unavailable` / `error`) |
| `im:gateway:start/stop/test` | P2 | existing channels, now accept `'qq'` |

`src/mobile/generated/ipc-contract.json` was regenerated.

## 8. Known limits / not covered

- **No live account was used.** QR scan completion, real messages, and real media could
  not be tested; see the verification doc for the exact "not tested + reason" list.
- Active pushes (no `msgId`) are subject to QQ-side quotas we cannot measure offline.
- **Inviter cannot be verified** (see §3.1): the SDK has no group-join event with an
  inviter field, so group access is allowlist-only by design.
- Layer 3 is OFF by default; an owner who wants local capabilities over QQ must enable
  the switch and add their own OpenID. Until then, owner DMs are also plain chat.
- **Group names are usually unavailable.** The group-info endpoint is whitelist-only
  (error 11253), so most bots will only ever see the 32-hex group ID. That is the honest
  default, not a bug: the UI says so on the row and the ID is always shown with a copy
  button. Nothing in the UI asks a human to type a group id.
- **A group must speak before it can be allowed.** The platform reveals the group OpenID
  only in an inbound message, so the bot must receive at least one (silently recorded)
  message from the group. There is no way to pre-authorize a group that has never
  messaged the bot.
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
