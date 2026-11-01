# Weixin media — delegated worker's on-machine record

Date: 2026-11-02 (local, Asia/Shanghai)
Worktree: `.worktrees/feat-weixin-media` · branch `feat/weixin-media`
Code under test: branch HEAD `1f5328f` (see §7 for commit attribution)

This record is written by the delegated worker that implemented the base of this
branch. It only claims what that worker measured itself; legs measured by the
other session that was editing the same worktree are attributed explicitly in §6
and are **not** presented as this worker's own measurements. Nothing here is
reported as passing without a log line or a file on disk behind it.

---

## 1. Worktree and inheritance

| Item | Value |
| --- | --- |
| Worktree | `/Users/pamper/idbots/project/bots/1/2026-10-30/idbots-weixin/IDBots/.worktrees/feat-weixin-media` |
| Branch | `feat/weixin-media`, created from `main` (`61d11c4`) |
| Inheritance of the text channel | `merge --no-ff feat/weixin-channel` → merge commit `78bf768`; `main`'s working tree was never touched |
| Ahead of `origin/main` | 21 commits |
| Push / PR | none (`git status -sb` shows no upstream; no PR was opened) |

## 2. Gates at HEAD `1f5328f` (re-run by this worker)

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc --project electron-tsconfig.json --noEmit` | PASS |
| Electron build | `pnpm run compile:electron` | PASS (`tsc` exit 0 + `copy-electron-js` ran) |
| Lint | `npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0` | PASS, zero output, `--max-warnings 0` |
| Unit tests | `npx tsx --test tests/weixinGateway.test.ts tests/weixinMedia.test.ts` | PASS — 46 tests, 46 pass, 0 fail, 0 skipped; no socket opened |
| Dev app boot | `env -u ELECTRON_RUN_AS_NODE -u IDBOTS_ELECTRON_PATH pnpm run electron:dev:dsh` | PASS — Vite 127.0.0.1:5185 + Electron; `[Weixin Gateway] Started { accountId: 'default', baseUrl: 'https://ilinkai.weixin.qq.com', hasCursor: true }`, `renderer initialization complete` |

The two `env -u` unsets are required on this machine: the host shell exports
`ELECTRON_RUN_AS_NODE=1`, which otherwise runs the main bundle as plain Node.

## 3. Live leg A — WeChat → IDBots image: PASS (measured by this worker)

Log: `.dev-userdata-dsh/weixin-media-task/dev.log` (run started 01:03).

```
[Weixin Gateway] inbound media saved {
  kind: 'image',
  mimeType: 'image/png',
  fileSize: 19186,
  fileName: 'weixin-image.png',
  localPath: '.../.dev-userdata-dsh/weixin-inbound/weixin_1793552755185_d3c925ba.png'
}
[IMGatewayManager] Using Cowork mode for message processing
[IMCoworkHandler] 处理消息: {
  "platform": "weixin",
  "conversationId": "o9cq80_Jrfc-0O8gZ-LMBPlsQZyk@im.wechat",
  "originalContent": "用户发送了图片 1 张",
  "formattedContent": "用户发送了图片 1 张\n\n[附件信息]\n- 类型: image, 路径: .../weixin_1793552755185_d3c925ba.png, 提示: 可调用 describe_image …, 文件名: weixin-image.png, MIME: image/png, 大小: 18.7KB",
  "attachments": [ { "type": "image", "localPath": ".../weixin_1793552755185_d3c925ba.png",
                     "mimeType": "image/png", "fileName": "weixin-image.png", "fileSize": 19186 } ]
}
```

Independent verification of the written file (not just the log line):

```
bytes 19186   sha256 b74bed9b4f2ddb944696d28083ba9c4eaa8d9ffd68f8965958afe9c4195f37fe
PNG signature 89504e470d0a1a0a   IHDR dimensions 294 x 156   bit depth 8, colour type 2
```

The decrypted bytes are a real, well-formed PNG — a failed AES key would have
produced either an exception or garbage, never a valid IHDR. The agent's own reply
described the picture's actual content, which is the strongest available proof that
decryption produced the true image rather than noise:

```
[IMCoworkHandler] 会话完成: { "reply": "看懂了。这是一张截屏的局部，内容是通讯录或聊天列表里的一条：\n- 昵称：**WuFenG** …" }
```

## 4. Live leg B — IDBots → WeChat image: call chain PASS, human receipt NOT verified

`getuploadurl → AES-128-ECB → CDN POST → sendmessage` was driven through the real
gateway (`sendMedia`, no app instance involved) against the live endpoint:

```
[Weixin Gateway] media sent { kind: 'image', bytes: 94600, fileName: 'outbound-live.png' }
SEND-MEDIA-OK {"conversationId":"o9cq80_Jrfc-0O8gZ-LMBPlsQZyk@im.wechat",
               "file":"outbound-live.png","bytes":94600,"elapsedMs":1401}
```

What this proves: `getuploadurl` accepted the request shape, the CDN accepted the
ciphertext and returned `x-encrypted-param`, and `sendmessage` returned `ret=0` for
an `image_item` carrying `encrypt_type: 1` and `mid_size = 94600` padded to
`94608`. What it does **not** prove: that the image rendered in the recipient's
WeChat client. No human confirmation of receipt was obtained, so this leg is
recorded as **链路成功 / 人眼回执未确认 (human receipt NOT verified)**.

## 5. Live leg C — WeChat → IDBots file: PASS in the other session's run, file verified here

The file leg was captured by the concurrent session's app run (its log
`dev-video2.log`), not by this worker's run, so it is attributed rather than
claimed:

```
[Weixin Gateway] inbound media saved { kind: 'file', mimeType: 'text/plain', fileSize: 86,
  fileName: '新建文本文档.txt',
  localPath: '.../.dev-userdata-dsh/weixin-inbound/weixin_1793553193804_9b27e1a2.bin' }
[IMCoworkHandler] 处理消息: { "originalContent": "用户发送了文件「新建文本文档.txt」",
  "formattedContent": "… 类型: document, … 文件名: 新建文本文档.txt, MIME: text/plain, 大小: 0.1KB" }
```

The file itself was re-checked here: 86 bytes, UTF-8 text beginning
`账号：TianMei…`, `sha256 6b13e687e8e97289e406414a45c608db…`. So the bytes really are
the sender's text file, not a decryption artifact.

One real-world finding from this leg: WeChat supplied `file_item.file_name` but no
MIME, and the file was initially stored with a `.bin` extension. That mismatch was
fixed on this branch (`a1e1d13 fix: keep the extension of inbound text-like files
instead of .bin`), so a text/plain attachment now lands as `.txt`.

## 6. Live legs measured by the concurrent session (not claimed here)

While this worker was running, a second session was editing the same worktree and
driving the same WeChat account through its own app instance (cowork session
`2c805601-07fb-4c27-98b0-8efb5e68c930`). Its logs are in the same directory:

| Leg | Evidence | Attributed to |
| --- | --- | --- |
| inbound video 654,534 B → `…/weixin_1793553025167_57ea6b5a.mp4` | `dev-video.log` | concurrent session |
| inbound file 86 B → `…/weixin_1793553193804_9b27e1a2.bin` | `dev-video2.log` | concurrent session |
| inbound video 654,534 B → `…/weixin_1793553289036_1e62ea78.mp4`, description `用户发送了一个视频 639KB` | `dev-video3.log` | concurrent session |

Two app instances cannot poll the same account safely (they share
`weixin/accounts/default.sync.json`), and both this worker's app runs were
terminated with `SIGTERM` by the other side. That is a coordination defect of this
run, not a code defect; it is recorded here because it affects how much of §3–§5
can be reproduced by re-running a single instance.

## 7. Commit attribution on this branch

| Commit | Author of the change |
| --- | --- |
| `9359ae7`, `3119839`, `ade8c41` | this worker (media helpers, protocol/gateway wiring, tests) |
| `705a920`, `ade7ef2`, `820d5ba`, `ccf19ec`, `a1e1d13`, `1f5328f` | concurrent session (inbound video cap, play_length handling, vendor-provenance limits doc, `.bin` extension fix) |

All commits, including the concurrent session's, were re-verified by this worker at
`1f5328f` with the gates in §2 — the tree is coherent and green. This worker does
not claim authorship of, or live measurement for, the concurrent session's commits.

## 8. Summary of the three required live legs

| Required leg | Status | Basis |
| --- | --- | --- |
| 微信发图片 → IDBots 收到并落盘 | **PASS** | §3: log + 19,186-byte valid PNG at an absolute path, hash re-checked, content described correctly by the agent |
| 微信发文件 → IDBots 收到并落盘 | **PASS (captured by the concurrent session)** | §5: log + 86-byte UTF-8 file re-checked here; not this worker's own run |
| IDBots 回发图片 → 微信能收到 | **链路 PASS / 人眼回执未确认** | §4: CDN upload + `sendmessage` `ret=0`; nobody confirmed the image appeared on the phone |

Nothing in this table is rounded up: the third row is deliberately not a clean
"pass" because "微信能收到" is a claim about a human's screen, and no human
confirmed it in this run.
