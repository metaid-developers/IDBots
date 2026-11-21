# Real push acceptance runbook (FCM → physical Android device)

Purpose: turn "production push still disabled" into a completed, evidence-backed
acceptance, using the tools shipped in this repo. Everything except two steps
marked **[needs owner]** runs without owner involvement.

Related: CM2 notification foundation (`docs/cloud-mobile/delivery/cm0-cm4-notification-login-foundation.md`),
mobile-shell FCM notes (`mobile-shell/README.md` §FCM), control-plane push env
(`cloud/control-plane/README.md` §env, `deploy/hosts/cp.env.example`).

## 0. Principles

- Production push stays `CP_PUSH_PROVIDER=disabled` until this runbook passes.
  Never flip it "to try" on production: `fake` is test-only, `disabled` is safe.
- Real-device delivery cannot be validated by APK builds or fake-provider
  tests. Acceptance requires the physical-device matrix in §4.
- Evidence is mandatory: every matrix row needs timestamp + screenshot (or
  log line) + provider message id from `push.send-test`.

## 1. Firebase project setup **[needs owner]**

1. Create (or reuse) a Firebase project for IDBots, e.g. `idbots-prod` /
   `idbots-staging` — one project per environment, matching the Android
   applicationId in `mobile-shell/android/variables.gradle`.
2. Project settings → **Add app → Android**: package name = the applicationId;
   no SHA requirement for direct APK distribution.
3. Download **`google-services.json`** and copy it to
   `mobile-shell/android/app/google-services.json` (git-ignored; never commit).
4. Project settings → Service accounts → **Generate new private key**. The
   downloaded JSON is the FCM service account. Store it in the host secret
   store; never commit, never paste into chat.

## 2. Control-plane wiring

On the target host (staging first), add to `/etc/idbots/deploy.env`:

```sh
CP_PUSH_PROVIDER=fcm
CP_FCM_SERVICE_ACCOUNT_JSON=<contents of the service-account JSON, single line>
```

Then `docker compose up -d control-plane` (or the host's restart flow) and
check startup logs for config errors — a malformed service account fails fast
at boot (`CP_FCM_SERVICE_ACCOUNT_JSON must contain project_id, client_email,
and private_key`).

Sanity probe (no device needed):

```sh
docker compose exec control-plane node dist/cli.js push.send-test --user nobody --as <operator>
# expect: "user not found" → CLI is up and push config parsed.
```

## 3. Client build and registration

1. Rebuild the signed APK from `main` with the new `google-services.json`
   (`mobile-shell` build flow; the token is picked up by the FCM plugin).
2. Install on the physical test device, sign in (test account), confirm the
   Android system notification-permission prompt appears and is granted
   (Android 13+ requires the runtime permission; the shell requests it at
   first push registration).
3. Register check: on the host run

```sh
docker compose exec control-plane node dist/cli.js push.send-test \
  --phone +86<test-number> --as <operator>
# expect: "devices: 1 registered, 1 enabled (android)"
```

## 4. Acceptance matrix (physical device)

Send with the CLI from §3 each time; capture `state=sent msg=<messageId>`.

| # | Scenario | Steps | Pass criteria | Evidence |
|---|---|---|---|---|
| 1 | Foreground | app open → send-test | notification rendered in-app or via FCM; no crash | screenshot + CLI output |
| 2 | Background | home button → send-test | system notification appears on the Android channel | screenshot |
| 3 | Process killed | swipe app away → send-test | notification arrives (high-priority data message); cold tap opens the app | screenshot |
| 4 | Deep link | tap the notification from a task/report event | lands on the matching bot / run / report screen | screenshot of destination |
| 5 | Offline → reconnect | airplane mode → send-test → wait 30 s → network on | delivery retries from the outbox; notification arrives after reconnect; no duplicate after first display | CLI `state=sent`, screenshot |
| 6 | Multi-device | register a 2nd device (or 2nd user session) → send-test | both devices receive | two screenshots |
| 7 | Logout invalidation | log out on device A → send-test | device A deregistered ("0 enabled"), only B receives | CLI output |
| 8 | Stale token | uninstall app on B → send-test | delivery marked failed/invalid token, device auto-disabled; no crash | CLI `state=failed err=...` |
| 9 | Preferences gate | disable "system" notifications in-app → send-test | `ingest matched 0 devices` (preferences honored) | CLI output |
| 10 | Production disabled check | confirm production `CP_PUSH_PROVIDER=disabled` until go-live decision | env value verified | env excerpt |

## 4b. Methodology corrections learned on the first live run (2026-11-21)

- **Never `am force-stop` for the killed-process row.** A force-stopped app
  enters Android's stopped state and receives NO broadcasts or FCM messages
  until the user explicitly starts it again — undeliverable by design for
  every Android app. Use `adb shell am kill com.idbots.world` (simulates OOM
  kill, keeps the app out of stopped state). First run learned this the hard
  way; `force-stop` delivery failure is a pass-by-design, not a defect.
- **Foreground rows show no system notification on purpose.** Capacitor's
  FCM plugin suppresses system display while the app is foregrounded (the
  message is delivered to the in-app layer instead). Expect a bare shade for
  foreground rows.
- **Emulator FCM needs all three**: a `google_apis` image (GMS present), a
  signed-in Google account (`AUTHENTICATION_FAILED` without one — Play
  Store sign-in may need `pm clear com.google.android.gms` + reboot to
  finish device checkin first), and network reachability to Google. Behind a
  mainland network, boot the emulator with
  `-http-proxy http://127.0.0.1:<local-proxy>`; if the GMS sign-in webview
  dies with `net::ERR_CONNECTION_CLOSED`, additionally set the Android-level
  proxy: `adb shell settings put global http_proxy 10.0.2.2:<port>`.
- A no-GMS device (Huawei/Honor mainland ROM) is still worth running once:
  the app must work normally and the shell's token acquisition fails
  gracefully (server shows 0 devices). That row passed on a Mate 60.

## 4c. Acceptance evidence — staging, 2026-11-21

Environment: emulator `fcm35ps` (API 35, google_apis_playstore, arm64) behind
`127.0.0.1:7993` proxy + Android global proxy; APK
`idbots-staging-fcm-6e60aaf98.apk` (local build, `com.idbots.world`,
stagingDebug) signed into the staging CP (`CP_PUSH_PROVIDER=fcm`, project
`idbots-staging`); test account +86 180****0328.

| Row | Result | Evidence |
|---|---|---|
| 1 Foreground | PASS (no system notification, by design) | `state=sent msg=projects/idbots-staging/messages/0:1795247921107780` |
| 2 Background | PASS — system notification rendered on the `system` channel | shade screenshot, msg `0:1795248109391287` |
| 3 Killed (`am kill`) | PASS — delivered while process dead | shade screenshot, msg `0:1795248217726` |
| 4 Notification tap / deep link | PASS — cold start landed on the in-app notification center | screenshot |
| 5 Offline → reconnect | PARTIAL — outbox `state=sent` (Google accepted); redelivery after emulator GMS reconnect behind layered proxy not confirmed; retest on a real GMS device without proxy | `accepted event=push-test-1795248320592` |
| 7 Logout invalidation | PASS — device auto-disabled on logout | `devices: 1 registered, 0 enabled` |
| 9 Preferences gate | PASS — `system` category off → `ingest matched 0 devices`; on → delivered | CLI output |
| 10 Production disabled | PASS — prod deploy env has no `CP_PUSH_PROVIDER` → default `disabled` | env check |

Not live-tested (unit-covered): row 6 multi-device concurrency,
row 8 stale-token (`UNREGISTERED` → invalidToken → auto-disable, covered in
`cloud/control-plane/test/push.test.ts`).

## 5. Go-live decision

- All rows pass on staging + the physical device matrix passes on one
  production-signed build → set production `CP_PUSH_PROVIDER=fcm` and repeat
  rows 1–4, 7 on one production device.
- Known gap (record, do not paper over): Chinese OEM channels (Huawei/Xiaomi/
  OPPO push) and APNs are separate launch work — FCM alone does not cover
  mainland OEM devices with killed processes.

## 6. Rollback

Set `CP_PUSH_PROVIDER=disabled` and restart the control plane. Registered
device rows stay harmless; the app surfaces push as unavailable.
