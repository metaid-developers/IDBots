# Delivery Note — Credit Pull & Apply (plan B) · `feat/credit-pull-apply`

**Status:** implemented on this branch, unit- and integration-tested (control plane 232/232,
tenant credit suite 8/8, full-stack e2e green). **Production application of the existing
50 GB row is NOT executed here** — it needs the CP + tenant images deployed and one 50 GB
upstream redeem code attached (runbook below). No secret, mnemonic or wallet row was read.

Base commit: `a674e93f` (`main`, 2026-11-05). Branch is not merged to `main`.

---

## 1. Why this shape (and the premise this slice corrects)

The owner's plan B: the tenant discovers its own pending credit and applies it with the
credential it already owns; the control plane never holds a key that can mint credit on any
account.

**Correction to the premise carried into this slice.** "The tenant calls redeemCode" is only
half the mechanism: the upstream traffic service adds bytes through exactly five channels —
registration grant, free-grant campaign, recharge order (payment), bundle order (payment),
admin grant (operator token) and redeem code. Of those, the only one the tenant can invoke
with a credential it legitimately owns (the user's MetaID identity) is **redeem code** — and
a redeem code is a *single-use value that must exist upstream*. There is no identity-signed
"grant N bytes" endpoint, and the control plane must not hold the upstream admin token
(that is precisely the key plan B excludes). Therefore:

- a **manual** ledger grant becomes applicable only once an operator attaches the one
  upstream code that grant is worth (`credit attach-code`);
- its bytes come from the upstream code, not from the control plane — the control plane
  never mints value, it only stores which single-use code belongs to which grant;
- a **bundle-order** grant is `not-required`: the payment webhook already credited the
  traffic upstream before the ledger row is written, and applying it again would
  double-credit. Migration 4 backfills existing bundle-order rows the same way.

Without this correction the "apply" step would either double-credit paid orders or have
nothing to redeem.

## 2. Control plane

### Schema (migration 4, `credit-apply`)

`credit_ledger` gains: `apply_state` (`pending | applied | not-required`), `apply_code_enc`
(AES-256-GCM under `CP_MASTER_KEY`, never returned by any read route), `applied_at`,
`applied_by` (tenant id), `applied_bytes`, `applied_evidence` (JSON: codeId / trafficBytes /
balanceAfter as reported by the tenant), `apply_attempts`, `last_apply_error`,
`last_apply_at`. Backfill: `source = 'bundle-order' → not-required`; everything else stays
`pending`. Existing rows are never rewritten or dropped.

### Tenant-authenticated routes (`src/routes/tenantCredit.ts`)

| Route | Auth | Behaviour |
|---|---|---|
| `GET /api/v1/tenant/credit/pending` | `Authorization: Bearer <IDBOTS_GATEWAY_SECRET>` + `X-Tenant-Id` | rows of THIS tenant's user with `apply_state = 'pending'`; each row carries its single-use `code`; rows without a code come back under `blocked` with `NO_APPLICATION_CODE` |
| `POST /api/v1/tenant/credit/:creditId/apply-result` | same | `{ok:true, evidence}` flips the row `pending → applied` **once** (conditional UPDATE scoped by `user_id`); `{ok:false, error}` increments `apply_attempts` + `last_apply_error` and keeps the row pending |

- The user is resolved from the `tenants` row, never from the request body → a tenant can
  only read or mark its own user's credits. A creditId outside that scope answers
  `404 CREDIT_NOT_FOUND`.
- One uniform `401 TENANT_UNAUTHORIZED` for missing credentials, unknown tenant and
  undecryptable secret — no tenant-id oracle.
- These routes skip the Origin gate (`Route.skipOriginCheck`) because they are
  server-to-server and authenticated by an explicit bearer secret; no cookie is involved, so
  the CSRF reason for the gate does not apply. User-session routes are unchanged.
- The code value never appears in a log line or in the admin list response.
- **Edge exposure:** the pending response carries single-use codes, which are bearer values
  (first redeemer wins). `deploy/hosts/Caddyfile` therefore answers `404` for
  `/api/v1/tenant/*` on the public host: these routes exist only on the internal tenants
  network (`tenant → http://<cp-ip>:8080`). Caddyfile validated with
  `caddy validate --adapter caddyfile` (Valid configuration).

### Operator surfaces

- `POST /api/v1/admin/credit` accepts the optional `applyCode` at grant time.
- `POST /api/v1/admin/credit/:creditId/code` `{ code, operator? }` attaches/replaces the code
  of a **pending** grant (`409 CREDIT_NOT_PENDING` otherwise — an applied grant is never
  re-armed).
- CLI: `credit grant … [--code IDB-…]`, `credit attach-code --id N --code IDB-… --as NAME`
  (mutating → `--as` required, `audit_log` action `credit.attach_code`, code value never
  recorded).

## 3. Tenant (`src/main/services/creditPullService.ts`)

- Config: `IDBOTS_CONTROL_PLANE_URL` + `IDBOTS_TENANT_ID` + `IDBOTS_GATEWAY_SECRET`; any
  missing piece disables the loop with an explicit warning naming the three variables (no
  guessed URL, no silent no-op).
- Starts in server mode after the bootstrap begins (first tick +45 s so the traffic account
  exists), then every 5 minutes. Ticks never overlap.
- Per pending row: `redeemTrafficCode(code)` (identity-signed, the existing client path) →
  report `{ok:true, evidence}`; on any error report `{ok:false, error}` and retry on a later
  tick with exponential backoff (60 s → 30 min) that is in-memory pacing only.
- Idempotency survives a crash between redeem and report: upstream redemption of the same
  code by the same account is idempotent, and the ledger UPDATE is conditional on `pending`,
  so the retry credits once and marks once.

## 4. Verification (what was actually run)

| Check | Command | Result |
|---|---|---|
| CP unit + integration (incl. this slice) | `cd cloud/control-plane && npx tsx --test test/**/*.test.ts` | **232/232 pass** (one timing flake on the first run — `status-machine` integration — passed on re-run and in isolation) |
| This slice's CP suite | `npx tsx --test test/credit-apply.test.ts` | **17/17 pass** |
| Existing credit/bundle suites | `npx tsx --test test/credit.test.ts test/bundle-order-credit.test.ts` | **17/17 pass** |
| CP lint | `npx eslint src test` | clean |
| Tenant credit suite | `node --test tests/creditPullService.test.mjs` | **8/8 pass** |
| Tenant typecheck / lint | `tsc --noEmit -p electron-tsconfig.json`, `eslint` on changed files | clean |
| **Full-stack e2e (real CP + real tenant code)** | `node scripts/credit-apply-e2e.mjs` | **ALL CHECKS PASSED** |

The e2e transcript (abridged):

```
tenant upstream before     60000000 bytes
ledger grant               #1 53687091200 bytes apply=pending code=true
tick 1 applied             [1]
upstream after tick 1      53747091200 bytes
redeem calls               1
tick 2 applied             []            ← idempotent, no second redeem
ledger state               applied by=t_e2e_credit bytes=53687091200
ledger evidence            {"codeId":501,"trafficBytes":53687091200,"balanceAfter":53747091200}
```

The only stand-in is the upstream traffic service (fake redeem endpoint implementing the
production rule: same account + same code = idempotent, one grant). Both the control-plane
and the tenant side are the shipped modules.

The CP suite also covers the exact production record shape: a v3 database containing
`smoke-20261105-plus50gb` (53687091200 bytes, `manual`) migrates to `pending` unchanged, and
a `bundle-order` row migrates to `not-required`.

## 5. Production baseline (read-only, verified 2026-11-05 ~04:05 +08:00)

- `credit_ledger` has exactly one row: `id=1, bytes_total=53687091200, source=manual,
  reference_key=smoke-20261105-plus50gb`; the table still has only the 8 original columns
  (migration 4 not deployed yet).
- Control plane `idbots-prod-control-plane-1` is `172.31.0.2` on `idbots-prod_tenants`;
  tenant `idb-t_f6sgyrzdw76vh7centap` is `172.31.0.5` on the same network.
- From inside the tenant container: `GET http://172.31.0.2:8080/health` → `{"ok":true,…}`,
  and `GET …/api/v1/tenant/credit/pending` → `404 NOT_FOUND` (the new route is not deployed
  yet — this is the honest starting point, not a failure).

## 6. Production runbook (what remains, in order)

1. **Build + deploy the control-plane image** carrying this branch (same path as the credit
   ledger deployment: `gh workflow run cloud-images` → update `CP_IMAGE_TAG` → recreate the
   `control-plane` service). Startup runs migration 4.
2. **Tell tenants where the control plane is.** In `/etc/idbots/cp-prod.env`:
   `CP_TENANT_ENV_IDBOTS_CONTROL_PLANE_URL=http://172.31.0.2:8080` (internal tenants
   network; verified reachable from the tenant, and it keeps the gateway secret and the
   redeem codes off the public edge). Recreate the control plane once so the env reaches
   new/recreated tenants. Apply the same `/api/v1/tenant/* → 404` rule to the production
   Caddyfile (deploy runbook: `deploy/hosts/Caddyfile`).
3. **Mint the 50 GB code** on the traffic service (operator admin token):
   ```
   curl -s -X POST https://www.metaso.network/assist-open-api/v1/admin/traffic/codes/generate \
     -H "Authorization: Bearer $ASSIST_ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"count":1,"trafficBytes":53687091200,"note":"idbots credit #1 smoke-20261105-plus50gb"}'
   ```
4. **Attach it to the existing row** (no new grant, no new row):
   ```
   docker exec idbots-prod-control-plane-1 node dist/cli.js credit attach-code \
     --id 1 --code IDB-XXXX-XXXX-XXXX --as ops
   ```
5. **Deploy the tenant image** carrying this branch to the target tenant
   (`node dist/cli.js tenant upgrade --all --image <tag> --as ops`, or just that one tenant).
   The first tick runs ~45 s after boot.
6. **Verify the acceptance number, upstream-side**: `traffic.account.grantedBytesTotal` for
   the target account must move `60000000 → 53747091200` (60 MB + 50 GB) and
   `credit_ledger.apply_state` must read `applied` with `applied_bytes = 53687091200`.

If step 3 is not possible (no admin token at hand), the ledger row stays `pending` and the
tenant reports it under `blocked` — visible, not silent. That is the designed failure mode.

## 7. Rollback

- Code: revert the merge commit; the ledger columns stay but become inert (no reader).
- Ledger: rows are append-only. A wrong application is corrected with a counter-grant, never
  by rewriting history.
- Migration 4 is forward-only, like 1–3; it adds columns and a backfill UPDATE only
  (`bundle-order → not-required`). No row is deleted, no existing column changes.

## 8. Not done / boundaries

- No production deploy, no production container restart (out of this slice's permission).
- No 50 GB code minted; no secret, mnemonic or `metabot_wallets` column read.
- `bundle-order` grants are deliberately excluded from application (they are already
  credited upstream by the payment webhook); they are not a gap.
- Concurrency across multiple tenant instances of the same user is out of scope: one tenant
  container per user is the C1 invariant.
