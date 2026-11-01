# PR draft — feat: QQ official bot channel

> This file is a **draft**. Nothing was pushed and no PR was opened (task brief §7).
> Branch: `feat/qq-channel` · worktree `.worktrees/feat-qq-channel` · based on `4e05b1ad`.

## Title

`feat: QQ official bot channel — C2C, group @-reply, media in/out, QR + manual credentials`

## Summary

Adds the QQ channel on the existing IM gateway framework, using Tencent's **official**
QQ Open Platform SDK (`@tencent-connect/qqbot-nodejs@1.0.5`) and QR connector
(`@tencent-connect/qqbot-connector@1.2.0`).

- Direct chat (C2C) text; group chat answered only when the bot is @-mentioned.
- Inbound image / file / video downloaded to a per-conversation media directory with
  sanitized remote names, path containment, HTTPS-only fetches, and size guards.
- Outbound image / video / file through the SDK's helpers, including its automatic
  chunked upload above 5 MB.
- Two onboarding paths: QR bind (AppID + AppSecret obtained from the scan) and a manual
  AppID/AppSecret form.
- AppSecret is write-only over IPC and stored in a 0600 file; it never enters the config
  table, a status object, a log line, a buzz, or this PR.
- Per-conversation FIFO so two messages from one chat can never write the same cowork
  session in parallel (the Weixin `session already owned by an active write handle` bug
  class).
- A QQ card in Settings → IM with scan, manual credentials, status, connectivity test,
  and disconnect.

## Commits and development-journal (buzz) records

Each commit has one English development buzz, published as **AI_沈知珩**.

| # | Commit | Subject | Buzz |
| --- | --- | --- | --- |
| 0 | `da8ad785` | chore: drop stale eslint-disable directive in mvcTokenSellAssembly | `pin://8f17feb5630936855b9a6941c4b115e9f2b84c89a61fbc755b4fd00bbbf0030ci0` |
| 1 | `1d981b6b` | feat: add QQ protocol helpers, credential store, and media guards | `pin://3c306ca7fee4d5846e49e586f0fe782b5c723c724f7327844fc1f03556a1d485i0` |
| 2 | `2c1315fe` | feat: add QQ gateway with c2c, group mention gate, and per-conversation queue | `pin://ea7d023353629061d972886b17668a48a9f77e62c9caa67fff72f928fd394a9di0` |
| 3 | `916f23c8` | feat: wire QQ channel into IM gateway manager and IPC | `pin://2bb898856c1618c2cc3571337bd0a66e3bb6ea67f03a432a67be16f1e74fa6efi0` |
| 4 | `44238765` | feat: add QQ channel card to IM settings | `pin://52fc4e12c81aec0c4bf86a1d3f5edd980e48883f3194611d92386518a0173f4bi0` |
| 5 | `44f9ea5f` | test: add offline QQ gateway test suite | `pin://0dca174ad2aa0d64e9bce34755558d192c8fae617487f688f632703dc7e602b6i0` |
| 6 | `f955f537` | docs: document QQ channel architecture and verification | `pin://4ff2e2df0b911a7d23d861897afba21a65df0ee561d692c1ee96d23a8bc669c3i0` |

## Attribution

**Executing bot:** AI_沈知珩 (技术总监 / software architect)
**MetaID:** `metaid://idq1dzxxvlkfnx07vsv7rr9chq3rjnf8dxdugj0jy9`
**Repository account:** `Pamper.Metaid` (the repo-configured git identity used for the
commits; the on-chain journal entries above are signed by the executing bot, not by that
account).

Per-block ownership — all blocks were executed by AI_沈知珩; the column exists so review
can be assigned later without re-deriving the split:

| Block | Owner | Buzz |
| --- | --- | --- |
| Protocol / types / credential store / media safety | AI_沈知珩 | `pin://3c306ca7fee4d5846e49e586f0fe782b5c723c724f7327844fc1f03556a1d485i0` |
| Gateway (lifecycle, QR, queue, reconnect, send) | AI_沈知珩 | `pin://ea7d023353629061d972886b17668a48a9f77e62c9caa67fff72f928fd394a9di0` |
| Manager / config / IPC / allowlist | AI_沈知珩 | `pin://2bb898856c1618c2cc3571337bd0a66e3bb6ea67f03a432a67be16f1e74fa6efi0` |
| Settings card | AI_沈知珩 | `pin://52fc4e12c81aec0c4bf86a1d3f5edd980e48883f3194611d92386518a0173f4bi0` |
| Tests | AI_沈知珩 | `pin://0dca174ad2aa0d64e9bce34755558d192c8fae617487f688f632703dc7e602b6i0` |
| Docs / verification | AI_沈知珩 | `pin://4ff2e2df0b911a7d23d861897afba21a65df0ee561d692c1ee96d23a8bc669c3i0` |

## Verification

- `pnpm run compile:electron` — pass.
- `npx tsc -p tsconfig.json --noEmit` — pass.
- `pnpm run lint` — exit 0, no warnings (includes a one-line out-of-scope unblock: a stale
  `eslint-disable` in `mvcTokenSellAssembly.ts`).
- `pnpm run test:qq` — 32/32 pass, fully offline.
- `pnpm run electron:dev:dsh` — app starts; Settings → IM shows the QQ card; the scan
  button returns a real QR from Tencent's bind endpoint.

**Not tested (and not claimed):** QR scan completion, live C2C text, live group @-reply,
live inbound/outbound media, chunked upload on a real network, ASAR-packaged ESM import.
Reasons are listed in `docs/qq-channel-verification.md` §3.3.

## Risks / follow-ups

1. `@tencent-connect/qqbot-connector@1.2.0` declares `license: UNLICENSED`; review before
   a distributed release.
2. Passive replies rely on the 5-minute `msgId` window; later answers degrade to
   quota-limited active pushes.
3. QQ's attachment CDN host set is undocumented; the SSRF guard is property-based rather
   than an allowlist (DNS rebinding out of scope, documented).
4. The runtime `import()` escape hatch for ESM needs a packaged-build smoke test.
5. A fresh dev profile's onboarding can write identity pins (see the verification doc's
   incident section); that is an app-level first-run behaviour, not this channel.

## Review guide

1. `src/main/im/qqProtocol.ts` — conversion + mention gate + constants.
2. `src/main/im/qqGateway.ts` — supervisor, queue, send paths.
3. `src/main/im/qqMedia.ts` — path/SSRF/size guards.
4. `src/main/im/qqStore.ts` + `imStore.stripQQSecret` — secret handling.
5. `tests/qqGateway.test.ts` — the behavioural contract.
