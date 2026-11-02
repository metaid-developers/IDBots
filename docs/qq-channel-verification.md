# QQ channel verification record

Date: 2026-11-02 (Asia/Shanghai)
Branch: `feat/qq-channel` (worktree `.worktrees/feat-qq-channel`), based on `4e05b1ad`.
Host: macOS, Node v24.19.0, pnpm 11.24.0.
No push, no PR (per task brief).

## 1. Gate results

| Gate | Command | Result |
| --- | --- | --- |
| Electron compile | `pnpm run compile:electron` | **pass** — `tsc --project electron-tsconfig.json` + `copy-electron-js.cjs`, no diagnostics |
| Renderer typecheck | `npx tsc -p tsconfig.json --noEmit` | **pass**, no diagnostics |
| Lint (0 warnings) | `pnpm run lint` | **pass**, exit 0, no output |
| Offline QQ suite | `pnpm run test:qq` | **68/68 pass** (32 gateway + 24 security + 12 classification), 0 fail, no network |
| Security regression suite | `npx tsx --test tests/qqSecurity.test.ts` | **24/24 pass**, 0 fail, no network |
| Session classification suite | `tests/qqSessionClassification.test.ts` | **12/12 pass**, 0 fail, no network |
| Dev launch | `env -u ELECTRON_RUN_AS_NODE -u IDBOTS_ELECTRON_PATH pnpm run electron:dev:dsh` | **pass** — Vite on :5185, Electron window painted, renderer initialisation complete |

Notes:

- `pnpm run lint` on a clean `4e05b1ad` fails with one **pre-existing** error:
  `src/main/libs/mvcTokenSellAssembly.ts:752` carries an
  `eslint-disable-next-line @typescript-eslint/no-var-requires` that the repo config has
  already disabled, so `--report-unused-disable-directives` reports it as unused. The
  branch removes that stale directive (one comment line) and leaves behaviour untouched;
  it is called out in the PR draft as an out-of-scope unblock.
- The suite imports the installed SDK only for the constant-parity assertion; nothing is
  fetched.

## 2. Offline coverage (`tests/qqGateway.test.ts`, 32 tests)

Protocol / conversion

1. conversation ids keep direct and group chats apart
2. `toQQIMMessage` maps c2c and group messages including `chatType`
3. guild/dm map to `null`
4. @-mention gate: event, structured mentions, content fallback, plain group
5. mention markers are stripped
6. `splitQQText` respects the chunk limit and marks truncation
7. inbound/outbound media classification
8. `readQQMediaRefs` prefers `voice_wav_url` and drops non-HTTPS URLs

Safety

9. remote file names cannot traverse directories
10. `resolveInsideQQMediaDir` refuses escapes
11. media URLs must be HTTPS and not target localhost/private literals
12. MIME sniffing + outbound ceiling checks
13. documented upload ceilings match the installed SDK (`getMaxUploadSize` parity)
14. `QQStore` writes 0600 and never returns the secret from a summary

Inbound flow

15. c2c message reaches the callback and a reply carries the passive `msgId` (typing on)
16. group chat answers @-mentions only, isolates conversations, no typing
17. duplicate platform message ids are processed once
18. inbound image downloaded into the media dir with a safe name, 0600, correct bytes
19. oversized and non-HTTPS attachments are reported, not written

Queueing

20. same-conversation messages are serialized; different conversations run in parallel
21. a busy conversation sends one queue notice and rate-limits it

Outbound

22. `sendText` drops an expired passive `msgId` and chunks long answers
23. `sendMedia` picks the right SDK helper and enforces the platform ceiling

Reconnect / status

24. supervisor applies exponential backoff and keeps the gateway alive
25. fatal start failures keep retrying and `ready` restores the connected state
26. `probeAuth` succeeds without echoing the AppSecret
27. `probeAuth` surfaces a credential error without leaking the secret

QR authorization

28. state machine: wait → expired → confirmed; credentials persisted 0600
29. cancel rejects the pending wait and resets status
30. failure surfaces an error state and rejects `pollLogin`
31. `beginLogin` persists the credential and restarts the gateway with it
32. manual credentials are saved under the appId slot and can start the gateway

## 2.1 Security regression coverage (`tests/qqSecurity.test.ts`, 24 tests)

The incident that motivated this work: a bot invited into a group could be commanded by
**any** member, with the host bot's full local surface. The suite pins every red line:

| # | Invariant pinned |
| --- | --- |
| SEC-01 | group turns are layer-1 only: no tools, no memory read/write, no attachments |
| SEC-02 | the default is `allowlist` + empty list ⇒ no group is served at all |
| SEC-03 | owner DM is layer 2: memory on, layer 3 still OFF |
| SEC-04 | layer 3 needs BOTH the switch and its own allowlist (naming the owner) |
| SEC-05 | a stranger DM is a silent drop with no reply text |
| SEC-06 | no owner binding ⇒ every DM is a stranger (fail-closed) |
| SEC-07 | identity is the stable id; a forged display name changes nothing |
| SEC-08 | `senderIsBot` is dropped first (no bot-to-bot loop) |
| SEC-09 | an unknown group policy degrades to `disabled` |
| SEC-10 | the gate never throws: malformed input is a silent drop |
| SEC-11 | inviter fields are never consulted; only the allowlist decides |
| SEC-12 | audit summaries are collapsed and capped at 200 chars |
| SEC-13 | group workspaces are per-group and path-traversal-safe |
| SEC-14 | a non-allowlisted group gets no reply and no callback, but an audit line |
| SEC-15 | a stranger DM produces no reply, no typing, no callback |
| SEC-16 | an allowed group turn carries a frozen no-tool trust context + audit line |
| SEC-17 | group image/file/video: zero downloads, zero disk writes, fixed notice only |
| SEC-18 | owner DM still downloads attachments (layer 2 unchanged) |
| SEC-19 | a bot sender is dropped even in an open group |
| SEC-20 | runner: empty tool surface + deny-all backstop + suppressed skills/browser/goal |
| SEC-21 | group sessions stay out of nightly consolidation and the recent-session pulse |
| SEC-22 | group sessions get an isolated workspace, a minimal prompt, no memory |
| SEC-23 | `DEFAULT_QQ_CONFIG` is the strict one |
| SEC-24 | the docs state the inviter cannot be verified |

Every case runs against fake SDK / fake network surfaces; nothing leaves the process.

### 2.2 Session classification (`tests/qqSessionClassification.test.ts`, 11 tests)

Owner follow-up: direct and group IM chats both belong in the LOCAL list, told apart by a
marker. Pinned by tests:

| # | Invariant pinned |
| --- | --- |
| CLS-01 | a group row is recognised from `im:qq:group` + conversation id (last-4 suffix) |
| CLS-02 | a direct row is recognised and carries no group suffix |
| CLS-03 | non-IM / untyped-and-unknown channels classify as null (no wrong badge) |
| CLS-03b | legacy `im:<platform>` rows recover the kind from `qq:group:` / `qq:c2c:` |
| CLS-04 | old `IM-<platform>-<ts>` titles are detected; user titles are preserved |
| CLS-05 | short/absent ids degrade to an empty suffix |
| CLS-06 | every IM session is created as `standard`; the old direct⇒a2a mapping is gone |
| CLS-07 | group/direct grants do not depend on session type (spoofed type changes nothing) |
| CLS-08 | the frozen trust still rides every turn (group prompt, memory gates) |
| CLS-09 | list rows AND full sessions expose `im_channel` / `im_conversation_id` from the mapping table |
| CLS-09b | a legacy `a2a` IM row is grouped into the LOCAL list at render time (and loses A2A UI) |
| CLS-10 | group conversations stay out of the recent-session pulse |

## 3. Live (real app) checks

### 3.1 Settings card

Launched the dev shell on a fresh profile. Settings → IM 机器人 now lists **QQ** between
WeChat and Telegram, and the QQ card renders:

- status line (`未连接` / credentials state),
- **扫码创建机器人** and **测试连通性** buttons,
- **手动填写凭据** form with AppID + AppSecret inputs and **保存并连接**,
- AppSecret hint (0600, never returned to the UI), group-@ rule hint,
- MetaBot selector.

Screenshot captured at runtime:
`.dev-userdata-dsh/qq-card.png` (gitignored, local evidence).

### 3.2 QR request against the real Tencent endpoint

Clicking **扫码创建机器人** produced a real QR image and the text `等待扫码…`
(`.dev-userdata-dsh/qq-qr2.png`). This proves:

- the ESM `@tencent-connect/qqbot-connector` import works inside the Electron main process,
- the bind task is created and the QR URL comes back,
- the renderer renders it and no console QR is printed (`displayQrCodeToConsole: false`).

After the check the session was cancelled through the UI; no credential file was created
(`<userData>/qq` did not exist afterwards), which is the expected behaviour before a
successful scan.

### 3.3 Not tested — with reasons

| Item | Status | Reason |
| --- | --- | --- |
| QR scan completion → AppID/AppSecret obtained | **not tested** | requires the owner's phone QQ to scan; no phone account was available to this session |
| QQ private chat: send text → IDBots receives and replies | **not tested** | no bound bot / no QQ account; depends on the scan above |
| QQ group: @-bot → reply (and silence without @) | **not tested** | same; group behaviour is covered offline by tests 4, 5, 16 |
| QQ → IDBots image / file / video received and written to disk | **not tested** live | same; covered offline by tests 8, 12, 18, 19 with a fake CDN |
| IDBots → QQ image received | **not tested** live | same; covered offline by test 23 (SDK calls asserted) |
| SDK chunked upload (>5 MB) on a real network | **not tested** | no credentials and no upload endpoint session |
| Packaged (ASAR) ESM import | **not tested** | dev build only; plain Node import was verified separately |
| Group message with real `GROUP_AT_MESSAGE_CREATE` payload | **not tested** | no bot in a real group |
| Real group allowlist enforcement on a live group | **not tested** | same as above; covered offline by SEC-14/SEC-16 |
| Real stranger DM silence on a live QQ account | **not tested** | no second QQ account was available; covered offline by SEC-15 |
| Group attachment refusal against the real CDN | **not tested** | no live group; covered offline by SEC-17 (asserts zero fetch attempts) |
| Layer-3 grant end-to-end over QQ (files/shell) | **not tested** | deliberately OFF by default; enabling it needs the owner's decision |

The live rows above must stay "not tested" until an owner-scanned bot is available.

## 3.4 Group authorization round (2026-11-02, second pass)

Scope: replace "paste a 32-hex group OpenID" with "the bot silently records candidate
groups, the settings page offers 允许".

### What was verified, and how

| Claim | Evidence class | How it was checked |
| --- | --- | --- |
| The inbound group event carries **no** group name | **primary source (installed SDK)** | `node_modules/@tencent-connect/qqbot-nodejs@1.0.5/dist/protocol/types.d.ts → GroupMessageEvent` lists exactly `id/content/timestamp/author/group_openid/attachments?/mentions?/message_scene?/message_type?/msg_elements?`; `grep -rn "group_name\|groupName\|chat_name" dist/` returns nothing; `dist/protocol/api/routes.js` defines only message/file/upload/gateway/interaction paths |
| The platform **does** publish a name endpoint | **primary source (official docs)** | `GET /v2/groups/{group_openid}/info` → `group_openid, group_name, group_finger_memo, group_class_text, group_tags, group_member_num`, 30 QPM |
| That endpoint is whitelist-only | **primary source (official docs, error table)** | code **11253 「应用无接口访问权限 — 该接口仅白名单机器人可用，请联系平台运营申请权限」** |
| Recording is silent: no reply, no model turn, no tool, no memory, no attachment | executable | `tests/qqGroupCandidates.test.ts` CAND-01/02/03/04/05/06 assert `bot.sentTexts === []`, `delivered.length === 0`, and that the state file contains the id but **not** the message text or the sender id |
| Recording is not authorisation | executable | CAND-02 (second message still unanswered), CAND-08 (ignore → never answered), CAND-10 (removal → pending again) |
| Allow makes the group answerable, still layer-1 only | executable | CAND-07 asserts one reply and `trust = {level:'group', toolScope:'none', memoryRead:false, memoryWrite:false, attachmentPolicy:'reject'}` |
| No name is invented on refusal | executable | CAND-12 (fake 403 + code 11253 → `status:'forbidden'`, `name:null`), CAND-13 (no credentials → zero requests), CAND-14 (stale name cleared after a later refusal) |
| The remembered list is bounded | executable | CAND-17 — 112 ids recorded, 100 kept, oldest evicted |

### Gates re-run for this round

| Gate | Command | Result |
| --- | --- | --- |
| Electron compile | `pnpm run compile:electron` | **pass**, no diagnostics |
| Renderer typecheck | `npx tsc --noEmit -p tsconfig.json` | **pass**, no diagnostics |
| Full build | `pnpm run build` | **pass** (tsc + vite renderer + preload + twemoji invariant) |
| Lint (0 warnings) | `pnpm run lint` | **pass**, exit 0, no output |
| QQ suite | `pnpm run test:qq` | **87/87 pass** (32 gateway + 24 security + 12 classification + 19 candidates), 0 fail, no network |
| IPC contract | `node scripts/generate-ipc-contract.mjs --check` | **fresh**; 445 methods; four new channels carry a P2 tier (no untiered warnings) |
| IPC contract/registry tests | `node --test tests/ipcContract.test.mjs tests/ipcRegistry.test.mjs` | **10/10 pass** |
| Mobile channel + IM gateway tests | `node --test tests/mobileChannels.test.mjs tests/imGatewayConnectivity.test.mjs` | **15/15 pass** |

### Not tested (this round)

| Item | Status | Reason |
| --- | --- | --- |
| A real unauthorized group appearing in the settings list | **not tested live** | needs a bot bound to a real group; the local file write and the IPC read are covered offline |
| A real `GET /v2/groups/{openid}/info` 200 response with a real name | **not tested live** | the endpoint needs a whitelisted app; the `ok` / `forbidden` / `error` branches are covered with a fake transport |
| Clicking 允许 in the packaged UI | **not tested live** | the renderer side is compiled and typechecked; the effect (allowlist append) uses the pre-existing `im:config:set` path already exercised by the earlier round |

The claim "群名需白名单" is therefore a **documented platform limitation**, not an
observation of our own bot receiving 11253 — we never had a whitelisted app to test with.

## 3.5 Group rate limiting round (2026-11-02)

The gap this round closes: allowlisting decided *who* may trigger the bot, but nothing
limited *how often*. `src/main/im/qqRateLimit.ts` adds four rules at the message entry
point: 3/sender/group/minute, 10/group/minute, a configurable daily budget (default 500),
and consecutive-duplicate suppression. Every drop is silent; the audit line records
`rate-limited:<why>`; reception (the `message` event) still fires.

### Gates re-run for this round

| Gate | Command | Result |
| --- | --- | --- |
| Electron compile | `pnpm run compile:electron` | **pass**, no diagnostics |
| Renderer typecheck | `npx tsc --noEmit` | **pass**, no diagnostics |
| Full build | `pnpm run build` | **pass** (tsc + vite renderer + preload + twemoji invariant) |
| Lint (0 warnings) | `pnpm run lint` | **pass**, exit 0, no output |
| QQ suite | `pnpm run test:qq` | **102/102 pass** (32 gateway + 24 security + 12 classification + 19 candidates + **15 rate limit**), 0 fail, no network |
| i18n key parity | `node --test tests/i18nEnglishCoverage.test.mjs` | **3/3 pass** (new zh keys have English counterparts, no Chinese leakage) |

### New coverage (`tests/qqRateLimit.test.ts`, 15 tests)

1. RL-01 same sender: 4th message in one minute is silently dropped (model not called,
   reply empty, audit reason `rate-limited:per-sender`)
2. RL-02 the per-sender window is rolling: after 60 s the sender is served again
3. RL-03 single group: 11th message in one minute is dropped (`per-group`)
4. RL-04 daily budget blocks the 6th turn at `dailyReplyLimit=5`, and the cap is read live
5. RL-05 daily budget resets on the next local day
6. RL-06 consecutive identical content (whitespace-insensitive) is answered once; a
   different line resets the comparison
7. RL-07 duplicate suppression is per sender — another member saying the same thing is served
8. RL-08 a flooded group does not silence another group
9. RL-09 the owner is NOT exempt inside a group
10. RL-10 DMs are outside every group limit, including the daily cap
11. RL-11 every drop is silent: no "too fast"/"please wait" text, all audit replies empty
12. RL-12 the per-minute guards are hard-coded at 3 and 10; default daily is 500
13. RL-13 invalid daily values degrade to 500, never to unlimited
14. RL-14 content normalization ignores mention markers/whitespace only (case-sensitive)
15. RL-15 limiter state is group-scoped and `reset()` clears it

### Not tested (this round)

| Item | Status | Reason |
| --- | --- | --- |
| A real flood against a live QQ group | **not tested live** | would need a real bound bot and a disposable group; the decision path and audit are covered offline with a fake SDK |
| Editing the daily cap in the packaged UI | **not test-clicked** | the renderer change is covered by `tsc --noEmit` and `pnpm run build`; the IPC path is the pre-existing `im:config:set`, and the stored value is normalized on read by `IMStore.getQQConfig()` |
| Restart persistence | **not applicable by design** | counters are in-memory and intentionally reset on restart (documented product decision) |

## 4. Incident disclosure (not part of the QQ deliverable)

Launching the dev shell with a **fresh** userData profile triggered the app's own first-run
"create Twin Bot" flow. That flow pins the new bot's identity on-chain. Before I recognised
what the onboarding button did, three identity pins had been broadcast (a fourth, bio, was
in progress):

| Step | txid | pinId |
| --- | --- | --- |
| /info/name | `31c4fcbec8f9f03c0ea9d9fa4c8f8c81d2f923a0917a5766d7d34ae4f0bc758a` | `31c4fcbec8f9f03c0ea9d9fa4c8f8c81d2f923a0917a5766d7d34ae4f0bc758ai0` |
| /info/avatar | `8ca6216a8271e7fe02a60660f2dcff2dd8880ff6cdddf48467a45d1e645e4b0b` | `8ca6216a8271e7fe02a60660f2dcff2dd8880ff6cdddf48467a45d1e645e4b0bi0` |
| /info/chatpubkey | `d716c82eeda334e0a748c84c6fff8fff50508d2ec452a3f63c2293b3c24c7039` | `d716c82eeda334e0a748c84c6fff8fff50508d2ec452a3f63c2293b3c24c7039i0` |

I stopped the process immediately after step 4 started; no further pins were written. These
writes were **not requested by this task** and are disclosed here rather than hidden. The
affected dev database lives in the gitignored `.dev-userdata-dsh/` directory; the repo and
the QQ code are unaffected.

## 5. Artifacts

- Code: `src/main/im/qq*.ts`, wiring in `types.ts` / `imStore.ts` /
  `imGatewayManager.ts` / `main.ts` / `preload.ts`, renderer card in `IMSettings.tsx`,
  logo `public/qq.svg`.
- Tests: `tests/qqGateway.test.ts`, `tests/qqSecurity.test.ts` (24 security regressions),
  `tests/qqSessionClassification.test.ts` (12 classification regressions),
  `tests/qqGroupCandidates.test.ts` (19 candidate/authorisation regressions) — all under
  `pnpm run test:qq`.
- New code: `src/main/im/qqCandidates.ts` (candidate store),
  `src/main/im/qqGroupInfo.ts` (optional, whitelist-aware name lookup).
- Docs: `docs/qq-channel.md`, this file, `docs/qq-channel-pr.md`.
- Runtime evidence (gitignored): `.dev-userdata-dsh/qq-card.png`,
  `.dev-userdata-dsh/qq-qr2.png`, `.dev-userdata-dsh/qq-dev*.log`.
- `IDBots-dataguard/` in the worktree root is a dev-shutdown artifact of the app, not a
  deliverable; it is left in place because this task forbids deletions.
