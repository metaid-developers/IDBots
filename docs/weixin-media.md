# WeChat (Weixin) IM channel — images, files and video

Status: **v2 media scope implemented and unit-tested; live on-machine legs recorded
in §8 exactly as measured.** Added on top of the text channel documented in
`docs/weixin-channel.md`.

| In scope | Out of scope |
| --- | --- |
| Inbound image / file / **video** (download → AES decrypt → persist → `IMMessage.attachments`) | Voice (only `voice_item.text` is read as text; no audio transcoding) |
| Outbound image / file / **video** (`sendMedia`) | Group chats (`groupPolicy` is `disabled` server-side) |
| Image down-scale/re-encode before upload | Video transcoding / frame extraction |

Video is **not** a second pipeline: it is the same `downloadWeixinMedia()` call as
images and files. The only differences are a separate size cap, the media type
reported upward, and the (optional) `duration`.

---

## 1. Files

| File | Role |
| --- | --- |
| `src/main/im/weixinMedia.ts` | AES-128-ECB, CDN URL building/allow-listing, filename + path safety, item→ref parsing, `downloadWeixinMedia`, upload preparation, `item_list` builders, image compression decision |
| `src/main/im/weixinImage.ts` | Image re-encode helper used before upload (no new dependency; falls back to the original when no encoder is available) |
| `src/main/im/weixinGateway.ts` | `collectInboundMedia()` (download every kept ref, never throw) and `sendMedia()` (upload → `sendmessage`) |
| `src/main/im/weixinProtocol.ts` | Item types, priority rule (image > video > file), `toIMMessage()`, one-line attachment descriptions |
| `tests/weixinMedia.test.ts` | 32 offline tests: AES key formats, path traversal, caps, degradation, outbound item shape, gateway media paths |

---

## 2. Inbound

```
getupdates → msgs[].item_list
   │
   ├─ classify by item.type: IMAGE(2) / VOICE(3) / FILE(4) / VIDEO(5)
   ├─ priority: image > video > file   (mixed messages keep ONE kind; the rest are logged, not silently dropped)
   ├─ per item: media.encrypt_query_param | media.full_url  → download URL (host allow-list)
   │            media.aes_key (base64) or image_item.aeskey (hex)  → AES-128-ECB key
   ├─ GET ciphertext → AES-128-ECB/PKCS#7 decrypt → write to <mediaRoot>/weixin_<ts>_<rand><ext> (0600)
   └─ IMMediaAttachment { type, localPath, mimeType, fileName, fileSize, duration? }
```

* **Failure is per item, never per message.** A failed download increments a
  counter, logs `inbound media failed: <kind> <reason>` (credentials redacted) and
  the message still reaches the agent with `（附件下载失败：N 个）` appended, or with
  `用户发送了附件，但下载失败` when nothing survived.
* **Media-only messages** still produce a body: `用户发送了一个视频 12.3MB`,
  `用户发送了文件「报告.pdf」`, `用户发送了图片 1 张`.
* **Caps** (§5): image 30 MB, video 100 MB, file 100 MB, max 20 attachments per
  message. An over-cap item is discarded **with** a log line and the failed-count
  note — never silently.
* **Video metadata**: `duration` is filled only when the unit of
  `video_item.play_length` is proven (see §5). `width`/`height` are **not** filled:
  the protocol only carries `thumb_width` / `thumb_height`, which describe the
  thumbnail, not the video frame; copying them into `width`/`height` would be an
  invented fact.
* Video is persisted as-is: no transcoding, no frame extraction.

### AES key encodings (both supported)

| Where | Encoding | Handling |
| --- | --- | --- |
| `image_item.aeskey` | raw 16-byte key as 32 hex chars | `Buffer.from(hex, 'hex')` |
| `media.aes_key` | base64(raw 16 bytes) | base64-decode to 16 bytes |
| `media.aes_key` | base64(32-char hex string) | base64-decode, then hex-decode |

`parseWeixinAesKey()` accepts both `media.aes_key` shapes; a key that decodes to
anything other than 16 bytes fails closed (no file is written).

---

## 3. Outbound (`sendMedia(conversationId, filePath, opts?)`)

```
stat file → kind by extension/MIME (image | video | file)
   ├─ image: our own 4 MB / 4096 px guard → re-encode (optional encoder)
   ├─ POST ilink/bot/getuploadurl { filekey, media_type, to_user_id, rawsize, rawfilemd5,
   │                                filesize(padded), no_need_thumb: true, aeskey(hex) }
   ├─ AES-128-ECB encrypt → POST ciphertext to upload_full_url
   ├─ response header x-encrypted-param → media.encrypt_query_param
   └─ POST ilink/bot/sendmessage with ONE item:
        image → image_item { media, mid_size }
        video → video_item { media, video_size }      ← same path, no transcode
        file  → file_item  { media, file_name, len }
```

`opts.text` is sent as a separate text message **before** the media (the official
plugin sends one item per message). `sendMedia` refuses empty files and files above
our client ceiling (§5); the error message names the byte counts.

Reply routing: a reply that references a local media path is detected by the
existing reply-media parser and handed to `sendMedia`; a missing file produces an
explicit "missing" line instead of silence.

---

## 4. Security

* No `token`, `aes_key`, `encrypt_query_param`, `upload_param` or derived URL is
  ever logged. `redactMediaSecrets()` scrubs credentials that may ride inside
  fetch/HTTP error strings before they reach a log line.
* Download hosts are allow-listed (`novac2c.cdn.weixin.qq.com`,
  `ilinkai.weixin.qq.com`) because `full_url` is server-supplied and therefore
  untrusted input.
* Remote file names are sanitized (separators on both platforms, control chars,
  Windows-reserved chars, leading dots, trailing dots/spaces, length cap) and are
  **display metadata only**: the on-disk name is generated locally.
* Every write goes through `resolveInsideDir()`, which refuses any path that
  resolves outside the media directory.
* Files are written with mode `0600`.

---

## 5. Limits — the number and where it comes from

Read from the official vendor plugin, **not** guessed. Source of record:
`@tencent-weixin/openclaw-weixin@2.4.10` (npm `latest` on 2026-11-02; fetched from
`https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.10.tgz`
and read in a scratch directory; it is **not** installed into this repo).

| Limit | Value | Evidence (file:line, quoted) | Kind |
| --- | --- | --- | --- |
| Inbound image | 30 MB | — (our own guard, Telegram parity) | **ours** |
| Inbound **video** | **100 MB** | `src/media/media-download.ts:9` `const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;` → VIDEO branch `src/media/media-download.ts:145` `saveMedia(buf, "video/mp4", mediaSubdir, WEIXIN_MEDIA_MAX_BYTES)` | vendor client guard |
| Inbound file | 100 MB | same constant, FILE branch `src/media/media-download.ts:120` | vendor client guard |
| Inbound attachments per message | 20 | — (Telegram parity) | **ours** |
| Outbound | 100 MB | vendor declares **no** send limit; we reuse 100 MB as a client ceiling so a send cannot pin the process on an absurd file | **ours** |
| Image re-encode | 4 MB / 4096 px | — | **ours** |

What the vendor code does **not** say, and therefore what we do **not** claim:

* `WEIXIN_MEDIA_MAX_BYTES` is a **client-side save guard** in the plugin. It is not
  a server-enforced transfer limit, and no vendor comment calls it one.
* `maxSingleMediaBytes: 25 * 1024 * 1024` (`src/config/config-schema.ts:44`) and
  `maxMediaBytesPerAccount: 256 MB` (`:39`) belong to `quoteCache` — a local budget
  for keeping **quoted** media on disk. They are **not** transfer limits; using
  25 MB as a video cap would be a misreading.
* Third-party web pages claim "video ≤ 25 MB unless sent as a file" and "files up to
  1 GB". Those are not vendor code and were **not** used; they are recorded here
  only so the next reader does not mistake them for evidence.

### `video_item.play_length` — unit unverified

`src/api/types.ts:139` declares `play_length?: number`, but the plugin **never
reads it** anywhere in `src/`. With no vendor consumer there is no unit to infer.
We therefore keep `WEIXIN_VIDEO_PLAY_LENGTH_UNIT = 'unknown'` and leave
`IMMediaAttachment.duration` empty rather than guess between seconds and
milliseconds. Flipping it to `'s'` or `'ms'` requires one observed sample: send a
video of known length and compare the raw `play_length` with the measured duration
(§8 records whatever was actually observed).

---

## 6. Not covered

* Voice download/transcode (voice `text` is still surfaced as text).
* Group chats (server-side `groupPolicy: disabled`).
* Video transcoding, thumbnails, frame extraction.
* Resumable/chunked uploads; the vendor plugin has none either.
* Any retry beyond what `fetch` and the gateway already do.

## 7. Deviations worth knowing

* The vendor plugin saves each inbound video as `video/mp4`; we do the same as a
  default but prefer a filename-derived MIME when `file_item.file_name` /
  extension is available.
* Inbound media is written to the gateway's `mediaRootDir`, mirroring how the
  Telegram channel stores attachments, so the upper layer (`imCoworkHandler`)
  picks them up unchanged.

---

## 8. Verification log

Unit tests (`npx tsx --test tests/weixinMedia.test.ts`): 32 passed / 0 failed —
offline, no real network (see the `FakeMediaNetwork` double).

Live on-machine legs are recorded in `docs/weixin-media-verification.md`, with the
raw log lines and absolute file paths for each of: WeChat → IDBots image, file,
video; IDBots → WeChat image, video. Any leg that could not be run is written there
as **未实测 + reason**, never as a pass.
