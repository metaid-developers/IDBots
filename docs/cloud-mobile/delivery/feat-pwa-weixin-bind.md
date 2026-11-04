# Delivery note — PWA WeChat bot binding (Me → WeChat Bot)

- Branch: `feat/pwa-weixin-bind` (cut from `main` at `4e419f76`), worktree `.worktrees/pwa-weixin-bind`.
- Scope: the mobile/PWA side of the self-serve WeChat path — pay → cloud
  tenant → bind the WeChat bot from the phone → chat with the Twin bot inside
  WeChat. Everything below the phone already exists (server mode auto-starts
  enabled IM gateways, `src/main/main.ts:20991`; the weixin iLink QR flow is
  fully implemented in `src/main/im/`).

## What shipped

- New registry entry `weixinBind` (bots group, `me-entry-weixin-bind`) and
  page `src/mobile/app/screens/me/WeixinBindPage.tsx`, wired through the
  standard Me secondary-page stack.
- Flow: feature-detect the `im` facade (mock mode → permanent "not available"
  note, SSR-safe) → align `config.weixin.metabotId` to the tenant's Twin bot
  BEFORE any bind (first inbound message after scan-confirm reads this value;
  a late write could create a null-metabot session) → `im.weixinLoginStart`
  returns the iLink QR content → rendered client-side with the `qrcode` lib
  (no large payload crosses the gateway, so the 4000-char sanitize cap is
  irrelevant here) → poll `im.getStatus` + `im.weixinCheckCredentials` every
  2 s → `connected` flips on scan confirm (the main process auto-enables and
  auto-starts the channel, `imGatewayManager.ts` `startWeixinLogin`) → done
  view with a disable action (`im.stopGateway('weixin')`).
- Poll classification is a pure exported helper (`classifyWeixinPoll`): the
  status surface only reports `idle|wait|scanned`, so a quiet
  (`loginPending:false`) poll with no credentials reads as "QR died" — the
  manager clears `pendingQr` on every terminal state.
- Mid-binding unmount cancels the pending QR (no-op once confirmed).
- i18n: zh + en keys under `mobile.me.entry.weixinBind` /
  `mobile.me.weixin.*` in `src/mobile/i18n.ts` (UI default English per
  AGENTS.md; zh provided like the rest of the Me pages).

## Contract status

No frozen-contract change. Every channel used is already allowlist tier P2 in
`02`: `im:config:get/set`, `im:status:get`, `im:gateway:stop`,
`im:weixin:login:start/cancel`, `im:weixin:credentials:check`
(`src/main/gateway/allowlist.ts:285-293`).

## Tests

- `tests/mobileMeIa.test.tsx`: registry pins updated (seven entries; bots
  group = bots + weixinBind) + new SSR pin (unavailable shell never renders a
  bind button) + classifier unit cases. 13/13 green.
- Full `pnpm run test:mobile` gate (tsc + whitelist suites) run on the branch.

## Deliberately not in this slice

- Real-device acceptance: WeChat in-app browser long-press → recognize QR on
  the iLink content (owner judges this workable; save-screenshot is the
  fallback and is copy-supported in the page).
- e2e spec for the page (needs a real-gateway harness with the weixin flow
  stubbed); SSR + classifier coverage only for now.
- The pay → provision → deliver-entry-URL bridge (control-plane / Metaso
  billing side) and any SMS/deep-link delivery of the entry URL.
- Desktop parity is untouched: `IMSettings.tsx` remains the desktop surface.
