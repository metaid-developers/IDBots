# WeChat media — on-machine verification log

Companion record: `docs/weixin-media-delegated-verification.md` covers the base
image/file implementation written by the parallel step that built it. This file is
the record for the **video** legs, the two outbound legs, and the final-build
re-run.

Date: 2026-11-02 (Asia/Shanghai), live WeChat account, no mocks.
Code under test: branch `feat/weixin-media` in
`IDBots/.worktrees/feat-weixin-media`; final build at commit `1f5328f`
(the inbound image was measured on `ade8c41`, the inbound file on `ccf19ec`;
what changed afterwards is listed in §4).

Runtime: `pnpm run electron:dev:dsh` (vite 5185 + Electron), userData
`<dev-userdata>`, media root `<dev-userdata>/weixin-inbound`.
The WeChat bot token was **reused** from the previous `feat/weixin-channel` work
(copied into this worktree's userData at 01:03); **no new QR scan was performed in
this session**. Conversation: `<REDACTED_CONVERSATION_ID>` (the
"WeChat ClawBot" chat in the desktop client).

---

## 1. Result summary

| # | Leg | Result | Evidence |
| --- | --- | --- | --- |
| 1 | WeChat → IDBots **image** | **PASS** | §2.1 — 19,186 B PNG on disk, attachment reached the agent |
| 2 | WeChat → IDBots **file** | **PASS** | §2.2 — 86 B `.txt` on disk, `fileName` preserved, attachment reached the agent |
| 3 | WeChat → IDBots **video** | **PASS** (3 samples) | §2.3 — 654,534 B MP4 on disk, `duration: 9`, agent described the clip |
| 4 | IDBots → WeChat **image** | **PASS** | §2.4 — `SEND-MEDIA-OK`, visible in the WeChat client |
| 5 | IDBots → WeChat **video** | **PASS** (2 samples) | §2.5 — `SEND-MEDIA-OK`, rendered as a 0:03 video message in WeChat |

---

## 2. Raw evidence

### 2.1 Inbound image (01:05:55)

`dev.log:447`

```
[1] [Weixin Gateway] inbound media saved {
[1]   kind: 'image',
[1]   mimeType: 'image/png',
[1]   fileSize: 19186,
[1]   fileName: 'weixin-image.png',
[1]   localPath: '.../<dev-userdata>/weixin-inbound/weixin_1793552755185_d3c925ba.png'
[1] }
```

File: `<dev-userdata>/weixin-inbound/weixin_1793552755185_d3c925ba.png`,
19,186 bytes, mtime 01:05:55.

### 2.2 Inbound file (01:13:13)

`dev-video2.log:224`

```
[1] [Weixin Gateway] inbound media saved {
[1]   kind: 'file',
[1]   mimeType: 'text/plain',
[1]   fileSize: 86,
[1]   fileName: '新建文本文档.txt',
[1]   duration: undefined,
[1]   playLength: null,
[1]   localPath: '.../<dev-userdata>/weixin-inbound/weixin_1793553193804_9b27e1a2.bin'
[1] }
```

Agent body: `用户发送了文件「新建文本文档.txt」` + `[附件信息] … MIME: text/plain,
大小: 0.1KB`.

**Defect found by this run:** the file landed as `.bin` because
`EXTENSION_BY_MIME` had no `text/plain` entry — a text file looked like an opaque
blob to the agent. Fixed in `a1e1d13` (mapping added for `.txt/.md/.csv/.json`);
the live sample above is therefore the *pre-fix* build, and the fix is covered by
unit tests rather than by a second live file.

### 2.3 Inbound video (3 samples)

Sample A — 01:10:25, 654,534 bytes (`dev-video.log:186`):

```
[1] [Weixin Gateway] inbound media saved {
[1]   kind: 'video',
[1]   mimeType: 'video/mp4',
[1]   fileSize: 654534,
[1]   fileName: 'weixin-video.mp4',
[1]   duration: undefined,
[1]   localPath: '.../<dev-userdata>/weixin-inbound/weixin_1793553025167_57ea6b5a.mp4'
[1] }
```

The agent then described the clip unprompted (proving the upper layer received the
attachment):

> 这次收到了，视频正常解析出来了 … 时长大约 8 秒。

Sample B — 01:14:49, same clip (`dev-video3.log:187`), used to settle the unit:

```
[1]   duration: undefined,
[1]   playLength: 9,
```

`ffprobe` on that file: `duration=9.041667`, `codec_name=hevc`, `width=720`,
`height=1280`. ⇒ `video_item.play_length` is **seconds, truncated**.

Sample C — 01:17, **final build** (`dev-final.log:186`):

```
[1] [Weixin Gateway] inbound media saved {
[1]   kind: 'video',
[1]   mimeType: 'video/mp4',
[1]   fileSize: 654534,
[1]   fileName: 'weixin-video.mp4',
[1]   duration: 9,
[1]   playLength: 9,
[1]   localPath: '.../<dev-userdata>/weixin-inbound/weixin_1793553440763_48526ea7.mp4'
[1] }
```

and the message handed to the agent (`dev-final.log:196`):

```
"originalContent": "用户发送了一个视频 639KB",
"[附件信息] … 类型: video, 路径: …/weixin_1793553440763_48526ea7.mp4, … 时长: 9秒, 大小: 639.2KB"
"attachments": [{ "type": "video", … "fileSize": 654534, "duration": 9 }]
```

No transcoding and no frame extraction was performed: the bytes on disk are the
sender's original HEVC MP4 (65 bytes of MP4 header + payload; `ffprobe` agrees).

### 2.4 Outbound image

Command (real gateway code, live credentials):

```
node <dev-userdata>/weixin-media-task/outbound-live.cjs \
  "<REDACTED_CONVERSATION_ID>" /tmp/weixin-media-fixtures/weixin-test-image.png
```

Output:

```
[Weixin Gateway] media sent { kind: 'image', bytes: 1969, fileName: 'weixin-test-image.png' }
SEND-MEDIA-OK {"conversationId":"<REDACTED_CONVERSATION_ID>","file":"weixin-test-image.png","bytes":1969,"elapsedMs":1467}
```

Visual confirmation: the 640×480 orange test image appears in the WeChat
"微信 ClawBot" chat with the caption sent alongside it.

### 2.5 Outbound video

```
node …/outbound-live.cjs "<REDACTED_CONVERSATION_ID>" /tmp/weixin-media-fixtures/weixin-test-video.mp4
```

Output (final build):

```
[Weixin Gateway] media sent { kind: 'video', bytes: 15063, fileName: 'weixin-test-video.mp4' }
SEND-MEDIA-OK {"conversationId":"<REDACTED_CONVERSATION_ID>","file":"weixin-test-video.mp4","bytes":15063,"elapsedMs":1339}
```

Visual confirmation: WeChat renders it as a **video message** (play triangle,
duration `0:03`, first-frame test pattern) — i.e. it went out as
`video_item`, not as a generic file.

---

## 3. What this run proves, and what it does not

Proves: the live WeChat iLink service accepts our `getuploadurl` → AES-128-ECB →
CDN POST → `sendmessage` flow for image **and** video; and that inbound
image/file/video items decrypt, persist, and reach the agent with the right
`IMMediaAttachment` fields.

Does **not** prove:

* the 100 MB video cap in a live transfer — no 100 MB clip was sent; the cap is
  only exercised by unit tests (`inbound video reuses the shared pipeline but a
  separate 100 MB cap`). Sending hundreds of MB over the same account was out of
  scope and would have been the only way to observe the server's own behaviour;
* any failure branch against the live service (CDN 4xx/5xx, missing
  `x-encrypted-param`, key mismatch) — those are unit-tested only;
* voice and group chat — out of scope;
* the `.txt` extension fix against a live file (§2.2);
* a second WeChat account / another client version — one account, one client
  build (`WeChat.app`, macOS).

## 4. Code changes this live run forced

| Change | Why |
| --- | --- |
| `WEIXIN_VIDEO_PLAY_LENGTH_UNIT: 'unknown' → 's'` | sample B/C: `play_length = 9` for a 9.0417 s clip |
| `EXTENSION_BY_MIME` gained text-ish types | §2.2: a `.txt` file landed as `.bin` |
| `play_length` added to the inbound debug log | needed to settle the unit at all |
