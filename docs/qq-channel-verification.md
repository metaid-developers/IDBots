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
| Offline QQ suite | `pnpm run test:qq` | **32/32 pass**, 0 fail, ~0.3 s, no network |
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

The live rows above must stay "not tested" until an owner-scanned bot is available.

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
- Tests: `tests/qqGateway.test.ts` (`pnpm run test:qq`).
- Docs: `docs/qq-channel.md`, this file, `docs/qq-channel-pr.md`.
- Runtime evidence (gitignored): `.dev-userdata-dsh/qq-card.png`,
  `.dev-userdata-dsh/qq-qr2.png`, `.dev-userdata-dsh/qq-dev*.log`.
- `IDBots-dataguard/` in the worktree root is a dev-shutdown artifact of the app, not a
  deliverable; it is left in place because this task forbids deletions.
