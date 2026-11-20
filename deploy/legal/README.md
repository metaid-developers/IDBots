# Legal pages (`/terms`, `/privacy`, `/custody`, `/support`)

Production-ready legal page set for the IDBots mobile launch. These are the
pages the login flow and the app link to (`src/mobile/legal.ts` →
`https://<host>/terms|privacy|custody|support`).

| File | Page | Content basis |
|---|---|---|
| `terms.html` | 用户协议 | upgrades the published draft v1.1 (2026-10-29) to launch copy |
| `privacy.html` | 隐私政策 | upgrades the published draft v1.1 (owner-approved conservative HK cross-border wording kept verbatim in §5) |
| `custody.html` | 托管与资产披露 | new; the "custodial disclosure" the go-live checklist requires (`60-acceptance-and-go-live.md` §Legal) |
| `support.html` | 支持与客服 | new; covers "Refund and support policy written" checklist item |

## Status: candidate copy, owner/legal sign-off required

Everything was written to be definitive launch copy, but a few facts were
**not derivable from the repo** and must be confirmed before publish:

1. **Effective dates** — all pages say 生效日期 2026-12-01. Confirm or move.
2. **support@idbots.world / security@idbots.world** — mailboxes must exist and
   be monitored before publish (15-ops-procurement.md wanted a Feishu/WeChat
   group link; an email channel was chosen as the production-shape default).
3. **Refund policy §7 of terms** — reasonable default (7-day window for
   service failure / duplicate charge, Apple-channel refunds for iOS). Legal
   should confirm.
4. **Governing law / venue (terms §11)** — HK law + operator domicile court.
   The draft flagged this as needing legal attention; the chosen default is
   the conservative common structure but must be legally confirmed.
5. **Backup residue window (privacy §6.3)** — 30 days stated as a product
   commitment; verify ops can honor it.
6. **Age 18+ (terms §4.1, privacy §9)** — drives the iOS age rating; confirm
   with owner before App Store submission.

## How these get served

On the staging host, `/terms` and `/privacy` are served by Caddy as static
files (server: Caddy, outside the control-plane proxy); `/custody` and
`/support` currently 404 through the control plane. The reference Caddyfile
(`deploy/hosts/Caddyfile`) now includes a `handle /{terms,privacy,custody,support}`
block that serves this directory from `/srv/legal` on the host.

Deploy steps:

```sh
# from a checkout of this branch
rsync -av --chmod=F644 deploy/legal/ host:/srv/legal/
# then reload caddy if the Caddyfile on the host was updated to match
ssh host 'caddy reload --config /etc/caddy/Caddyfile'
```

Verify: `curl -fsS https://staging.idbots.world/{terms,privacy,custody,support}`
all return 200 HTML (and after the next production deploy, the same on
`app.idbots.world`).

## Versioning

Bump the `版本` line in each page's `.meta` block and this README together.
Keep old drafts for the audit trail (they live at the host's previous
`srv` location or in the 2026-10-28 workorder attachments).
