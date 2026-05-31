# MetaApp Protocol Reference

Authoritative path: `/protocols/metaapp`

Primary SOT: https://manapi.metaid.io/pin/220c8d93f39b8058ed16c97499fa42694abadcf520e6ba6670c12e576a2213efi0

Standard sample: https://manapi.metaid.io/pin/8544d8a15126296abe36a0bad740a4f293580575b5b00d345029bf99b74c78eci0

Local mirror: `SKILLs/metabot-omni-caster/references/02-content-app.md`

## Publishing Model

The MetaApp wrapper pin itself is JSON on `/protocols/metaapp`. Heavy artifacts are uploaded first, then referenced from the wrapper with `metafile://<pinId>`.

For this skill, runtime `content` and source `code` are published as ZIP files by default:

- `contentType`: `application/zip`
- `codeType`: `application/zip`
- `contentHash`: SHA256 hex digest of the final content ZIP bytes. Leave empty when `content` is empty or when the user provides an already uploaded content URI without a trusted hash.

`content` and `code` are each allowed to be empty, but not both at the same time.

## Payload Schema

```json
{
  "title": "Example App Title",
  "appName": "Example App",
  "prompt": "AI generation prompt",
  "icon": "metafile://pinid",
  "coverImg": "metafile://pinid",
  "introImgs": [
    "metafile://pinid1",
    "metafile://pinid2"
  ],
  "intro": "This is a sample introduction text for the application...",
  "runtime": "browser/android/ios",
  "version": "1.0.0",
  "contentType": "application/zip",
  "content": "metafile://pinid",
  "indexFile": "index.html",
  "code": "metafile://pinid",
  "contentHash": "sha256_hash_here",
  "metadata": "any data",
  "tags": [
    "tag1",
    "tag2"
  ],
  "disabled": false,
  "codeType": "application/zip"
}
```

## Field Notes

- `title`: user-facing display title.
- `appName`: app name or stable identifier.
- `prompt`: original generation prompt when the app was AI-generated; otherwise empty string.
- `icon`, `coverImg`, `introImgs`: local image paths must be uploaded first. Existing `metafile://` URIs may pass through.
- `runtime`: slash-separated supported environments. Default to `browser` if the user gives no preference.
- `indexFile`: entry file inside content ZIP. Default to `index.html`.
- `metadata`: protocol examples use a string. If the user provides structured metadata, stringify it before publishing unless they explicitly want a different representation.
- `disabled`: boolean. Default `false`.
