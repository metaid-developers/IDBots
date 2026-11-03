# NS1 Native Lifecycle and Navigation — Independent Review Delivery Note

## 1. Delivery State

NS1 implementation is complete within the requested scope. The branch adds the typed local adapter, capability fallbacks, native lifecycle recovery, Android Back integration, native external/Alipay handoff, iOS-native recharge policy, and Android keyboard configuration. It does not include NS2/NS3 work, a native API client, product business logic, native account/token storage, signing, TestFlight, store work, push, deployment, or frozen-contract changes.

Root/mobile tests, Mock and real-C2 dual-browser regressions, Android/iOS staging Debug builds, and unauthenticated WebView smoke passed. Android also proved native Back and foreground/background event transport through CDP and adb. The external reviewer's DEF-1 cold-start recovery and DEF-2 root-Back defects are remediated; OBS-2 offline-banner feedback is also implemented. Authenticated re-review journeys and physical-device scenarios remain explicit NOT RUN items; this is not a claim of final native acceptance, production readiness, or owner sign-off.

No GitHub push, main merge, staging/production deployment, signing-key access, TestFlight upload, store submission, or owner-secret access was performed. `docs/cloud-mobile/01-interface-contracts.md` and `02-ipc-allowlist-v1.md` are unchanged.

## 2. Provenance

| Item | Value |
|---|---|
| Branch | `feat/mobile-native-lifecycle` |
| Worktree | `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/mobile-native-lifecycle` |
| Base SHA | `cf3eb764b4c96fdb93ffff4617cfeb777d84bf69` (NS0 merge on local `main`) |
| Implementation SHA | `77e526c2` (resolve with `git rev-parse 77e526c2`) |
| Review-remediation range | `6a0a5e49..77e526c2` on this branch |
| Final SHA | This delivery commit; resolve with `git rev-parse HEAD`. The exact final SHA and all journal pins are recorded in `mobile-shell/artifacts/ns1-handoff.json` after the commit and in the independent-review handoff. |
| Native package version | `0.1.0` |
| Native bridge version | `1` |
| C2 / allowlist version | `1.0.0` / `1.0.0` |
| Default flavor | `staging` → `https://staging.idbots.world/` |
| Explicit production flavor | `production` → `https://app.idbots.world/` (configuration tested; WebView NOT RUN) |
| Application ID | `com.idbots.world` |

The branch was created directly from the named local `main` SHA with `git worktree add -b feat/mobile-native-lifecycle .worktrees/mobile-native-lifecycle main`. No feature branch was used as its parent and no remote fetch was needed. The NS1 planning documents were read from the separate `docs/cloud-mobile-native-shell` worktree because they are not present on this `main`; that documentation branch was not modified or merged.

## 3. Commits and Development Journals

| Commit | Subject | On-chain journal pin |
|---|---|---|
| `d30c7ca408b239fbc55cf61c2ab72e50513e85de` | `feat: add native mobile adapter and external handoff` | `69167031ce73e4ff2dac8e8281dff48d779e417a3bc308a262fd34069be0d880i0` |
| `b3df77b03b52d06ed69ab2681582983b0a657291` | `feat: connect native lifecycle and Android back` | `23a008bf8462fe97d2b0e64c4ced3d42a3d7cc84ffec67da6d27e9be739c9454i0` |
| `3887d0d8670619421f29f56b1836ddbabf418485` | `feat: enforce native recharge and keyboard policies` | `9eeaf8e53374683c620e68c0902ee4c0625b4d5a15521b70d8198f42d51604d8i0` |
| `6a0a5e49` | `fix: restore mobile sessions on cold start` (DEF-1) | `6c2e354c3a3f99a23b36240096bd20ca56a477014a5d4637d54ef4791c1330dci0` |
| `063a4152` | `fix: exit Android product roots on back` (DEF-2) | `52640e4f21ff7fb32350bacc4e29596d3c52c0f9ccf9a27063539186bd6568edi0` |
| `d1911adb` | `fix: surface browser offline state immediately` (OBS-2) | `1ac3c27ab223e00404e1c4cea4be346dbd3c91a553686b35cd83a4717bae9d1ai0` |
| `77e526c2` | `fix: finish Android activity on root back` (DEF-2 real-device follow-up) | `f317fb7e335125c42199cee5c70326f86d6c5f9c576b82b86d84aa21f7734312i0` |
| This delivery commit | `docs: record NS1 review remediation` | Recorded with the final SHA in `mobile-shell/artifacts/ns1-handoff.json` |

Each implementation commit was published through the required user-scope `metabot-post-buzz` skill on MVC. No GitHub push occurred.

## 4. Changed Files and NS1 Requirement Mapping

| NS1 requirement | Implementation and evidence |
|---|---|
| Versioned local adapter, capability detection, and full Web fallback | `src/mobile/native/nativeAdapter.ts`, `idbotsNative.d.ts`, `mobile-shell/native/idbots-native-bootstrap.js`; browser/PWA no-op lifecycle/back fallback, web external opening, per-capability method fallback, and fail-closed native bootstrap validation. Tests: `tests/mobileNativeAdapter.test.ts`, `mobileNativeBootstrap.test.ts`, `mobile-shell/tests/bootstrap.test.mjs`. |
| Native app state uses existing reconnect/resync without blind writes | `src/mobile/app/hooks/useResync.ts` subscribes through the adapter. Online foreground runs the existing coalesced read-only resync; disconnected foreground calls only `reconnectNow()`, with `onReconnected` owning subsequent resync. Tests: `tests/mobileResync.test.ts`, adapter/bootstrap subscription tests. No session start, submit/retry, order, or chain call was added. |
| Android Back uses current routes, sheets, and navigation state | `src/mobile/app/nativeBack.ts`, `hooks/useNativeBackHandler.ts`, `MobileApp.tsx`, `components/BottomSheet.tsx`, and `screens/ChatScreen.tsx`. Mounted callbacks close drawer/sheets, recharge, then return Tasks/Me to Chat. An unhandled `/app/` or `/login` product root exits deterministically through `NativeBack.exitApp` (App plugin fallback), never history-returning to login; non-product-root WebView history remains available. Tests: `tests/mobileNativeBack.test.ts`, native bootstrap root/NativeBack tests, and real Android `ns1-android-root-exit.json`. No second route history exists. |
| External links and Alipay use native system capabilities while preserving PWA | `src/mobile/bridge/installShim.ts`, `src/mobile/app/hooks/useRecharge.ts`, and bootstrap `openExternal`. Main-frame navigation reaches the existing exact-origin Android/iOS system-handoff delegates. HTTP(S) web opening, same-tab Alipay, QR, timeout, and order-recovery behavior remain. Tests: adapter, shim, bootstrap, and existing recharge/E2E coverage. No second handoff is attempted after an uncertain native result. |
| WebView authentication, returning login, dual-device and logout isolation | Every cold login entry probes the existing C3 `getMe()` with the persisted HttpOnly cookie (`src/mobile/login/sessionRecovery.ts`). Ready/degraded opens `/app/` with `location.replace`, provisioning/failed uses the existing preparing flow, only `UNAUTHORIZED` opens login, and transient failures retry. No native account/session storage or logging was added. Tests: `tests/mobileSessionRecovery.test.ts`, returning-session login E2E, root login/logout API tests, and real-C2 browser regression. Authenticated native cookie, dual-device, and logout-isolation re-review are NOT RUN as detailed below. |
| Keyboard, safe areas, themes, offline/reconnect, and OS eviction | Android `AndroidManifest.xml` declares `adjustResize`. `GatewayClient` registers browser `offline` to show the existing offline banner immediately while retaining `online`/`reconnectNow()`. Existing visual-viewport composer inset, safe-area CSS, light/dark/system settings, and tenant session restoration are retained. iOS keeps Capacitor `bridge.reset()` + `webView.reload()` after WebContent termination; Android Activity recreation reloads the PWA. Tests: `tests/mobileGatewayClient.test.ts`, static/config/resync tests; native UI/OS-eviction specifics not exercised are NOT RUN. |
| Recharge hidden only in the iOS native shell | `src/mobile/native/rechargePolicy.ts`, `MobileApp.tsx`, `ChatScreen.tsx`, and `MeScreen.tsx` use only `window.idbotsMobile` `os`/`shell`. iOS Capacitor hides both entries and the overlay guard; iOS PWA, Android, browsers, and redeem remain. Tests: `tests/mobileRechargePolicy.test.tsx` and existing quota tests. |
| Browser/PWA and missing-capability degradation | The adapter validates version/capabilities per method and never requires Capacitor imports in root code. Mock 110/110 and real-C2 34/34 on iPhone WebKit and Pixel Chromium passed. Camera/photos/files/share/secureScreen remain false; no NS2 fallback was falsely presented as a native success. |

Root `package.json` and `.gitignore` register and track the new tests; `mobile-shell/README.md` documents the NS1 behavior, and this file is the review package. No control-plane, tenant, gateway, C2, IPC allowlist, Agent, LLM, skill, memory, wallet, chain, session, or task implementation was added or moved into the shell. Root `postinstall` and Electron packaging remain independent of `mobile-shell/`.

## 5. Toolchain and Dependency Provenance

| Component | Verified version / state |
|---|---|
| Node.js | 26.7.0 |
| pnpm | 11.24.0, frozen lockfiles |
| Capacitor core / CLI / Android / iOS | 8.5.3 |
| `@capacitor/app` | 8.1.2 |
| Android JDK | Azul Zulu 21.0.8 (`Zulu21.44+17-CA`), worktree-local |
| Android Gradle Plugin | 8.13.0 |
| Gradle | 8.14.3 |
| AndroidX WebKit | 1.14.0 |
| Android compile / target / minimum SDK | 36 / 36 / 26 |
| Android emulator | `test35`, Android 15, API 35, arm64 |
| Xcode | 27.1 (27A9275) |
| CocoaPods | 1.16.2 |
| iOS Simulator | `IDBots-NS0-iPhone-17`, iOS 26.5, WKWebView |

The host's default nested pnpm launcher belonged to Node 20, so an ignored worktree-local launcher invoked the same pnpm 11.24.0 with Node 26. No dependency or lockfile changed. The global Xcode DerivedData symlink pointed to an unmounted legacy external volume; an ignored worktree `xcodebuild` wrapper supplied the supported local DerivedData/scheme arguments. No global setting or symlink was changed.

Gradle's official distribution route stalled on the host. A Tencent mirror was used only after checking the archive against the official Gradle 8.14.3 `-all` SHA-256 published at `https://gradle.org/release-checksums/`: `ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c`. Google Maven also timed out, so an ignored `GRADLE_USER_HOME/init.gradle` selected Aliyun Maven mirrors for local dependency resolution. The wrapper's official distribution URL is restored after local verification; neither mirror configuration is committed in the delivery. Earlier environment-only attempts also rejected an `-I` value incorrectly placed in `GRADLE_OPTS` and then reported a missing explicit `ANDROID_HOME`; the corrected standard init-script/SDK configuration completed the same build and test tasks. No test was skipped, no assertion was removed, and no test timeout was increased.

## 6. Verification Commands and Actual Results

All commands ran on the deliverable worktree. The Node 26 pnpm launcher is omitted below for readability; commands otherwise match the listed package scripts.

| Command / lane | Result |
|---|---|
| `pnpm install --frozen-lockfile` (root) | PASS; root postinstall and DSH/MVC patches completed |
| `pnpm install --frozen-lockfile` (`mobile-shell/`) | PASS; independent package, not added to root postinstall |
| Focused adapter/bootstrap/shim/recharge tests | PASS, 33/33 root tests and 16/16 native tests before commit `d30c7ca4` |
| Focused lifecycle/Back/resync/quota tests | PASS, 17/17 before commit `b3df77b0` |
| Focused recharge-policy/quota tests | PASS, 8/8 before commit `3887d0d8` |
| Focused DEF-1 recovery tests | PASS, 4/4 before commit `6a0a5e49` |
| Returning-session login E2E (`--grep "login sign-up flow"`) | PASS, 2/2 on iPhone WebKit + Pixel Chromium before commit `6a0a5e49` |
| Focused gateway offline/online tests | PASS, 32/32 before commit `d1911adb` |
| `pnpm run test:mobile` | PASS, 258/258 aggregated: 201 + 6 + 51; `tsc --noEmit` also passed |
| `pnpm test` (root) | PASS, 2,186/2,186 aggregated from 22 current suite summaries, 0 failed |
| `pnpm run lint` | PASS, repository ESLint with zero warnings |
| `pnpm run build:mobile` | PASS; login 62.7 KB gzip within 80 KB, app initial JS 93.6 KB gzip within 500 KB; mock-notice check passed |
| `pnpm run build:skills` | PASS |
| `pnpm test` (`mobile-shell/`) | PASS, 18/18 including adapter, Back/product-root/NativeBack, capability, offline, origin, package-boundary, and keyboard checks |
| `pnpm run test:e2e:mobile` | PASS, 110/110 across iPhone WebKit and Pixel Chromium, including returning-session login; the 2 pre-existing UX screenshot skips remained unchanged |
| `pnpm run test:e2e:mobile:gateway` | PASS, 34/34: 17/17 iPhone WebKit + 17/17 Pixel Chromium, no skipped test or increased timeout |
| `pnpm run build:ios:staging` | PASS after remediation, `** BUILD SUCCEEDED **`, Simulator Debug with `CODE_SIGNING_ALLOWED=NO` |
| `pnpm run build:android:staging` / underlying build script | PASS after remediation, `BUILD SUCCESSFUL in 2s`, 91 actionable tasks (24 executed, 67 up-to-date); earlier clean remediation build also passed |
| `./gradlew --no-daemon testStagingDebugUnitTest` | PASS; the `testStagingDebugUnitTest` task completed successfully in the preceding clean build |
| `git diff --check` and staged diff checks | PASS at every implementation commit and before delivery |
| Frozen-contract diff | No changes to either frozen file |

Evidence logs for the remediated mobile unit/static and dual-browser runs are in ignored `mobile-shell/artifacts/ns1-test-mobile.log` and `ns1-mock-real-c2.log` regenerated by the final rerun. Android build and WebView results are in `ns1-android-build.log`, `ns1-android-webview.log`, `android-bootstrap.json`, `android-external.json`, `android-offline.json`, `ns1-android-lifecycle.json`, and `ns1-android-root-exit.json`.

## 7. Native Artifacts

| Artifact | Type / flavor | SHA-256 |
|---|---|---|
| `mobile-shell/artifacts/idbots-ns1-ios-staging-simulator.tar.gz` | iOS Simulator Debug, staging, unsigned | `dbd6a900c2714abbac61c143bf134e7394cd94768c8978cde098c29be1c720b8` |
| `ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app/App` | iOS Simulator executable | `2e12226e0c9f15da563f7dde36989e5711e86bf28b0d7bb73ed71b3a5ee597b2` |
| `mobile-shell/artifacts/idbots-ns1-android-staging-debug.apk` | Android `stagingDebug` | `bf6cd3b37a0c13d6fa59219839cab2dc0b00f9d63ec3facb85e9165fa594edb6` |

These are local verification artifacts, not signed releases or deployment candidates. Android `apksigner verify --verbose` passed for the standard DEBUG signature (v2 true, one signer); no owner signing material was used. The iOS build used `CODE_SIGNING_ALLOWED=NO`. Packaged Android/iOS bootstrap files matched the remediated shared source SHA-256 (`7b5b5ac061128b76b21b05a9882900b994b5fbdd039813e5de54a96e06850ca1`).

## 8. WebView Evidence

Evidence is stored outside git under `mobile-shell/artifacts/`. No test account, phone number, tenant identifier, message content, or tenant secret was used.

### iOS — iPhone 17 Simulator / iOS 26.5 / WKWebView

| Check | Evidence and result |
|---|---|
| Staging login loads | `ns1-ios-staging-login.png`; native log confirms the exact staging origin |
| NS1 bootstrap and client facts | `ns1-ios-webview.log`: `nativeBridgeVersion=1`, `document-start`, `platform=ios`, `shell=capacitor`, `os=ios` |
| Capability honesty | `appState=true`, `backButton=false`, `externalUrls=true`; camera/photos/files/share/secureScreen=false |
| External content leaves the privileged WebView | `ns1-ios-external.png` and `NS0_EXTERNAL_HANDOFF scheme=https host=example.com`; Safari displays example.com |
| Offline/error UI | `ns1-ios-offline.png` and `NS0_OFFLINE page=bundled`; bilingual bundled retry page, no cached online app |
| Retry restores staging | `ns1-ios-offline-retry.png` and repeated bootstrap/offline log sequence; offline → retry → staging login/bootstrap |

The deployed staging PWA was not changed. It does not contain this branch's NS1 PWA integration, so these checks prove the new native shell/bootstrap around the currently deployed login bundle, not authenticated NS1 PWA behavior. The bootstrap log has no `pwaProof` claim.

### Android — Android 15 / API 35 emulator

The `test35` emulator booted successfully (`sys.boot_completed=1`). The new staging Debug APK was installed and verified through the forwarded real WebView CDP socket.

| Check | Evidence and result |
|---|---|
| Staging login and bootstrap | `android-staging-login.png` and `android-bootstrap.json`: exact origin, `nativeBridgeVersion=1`, `document-start`, `platform=android`, `shell=capacitor`, `os=android` |
| Capability honesty | `appState=true`, `backButton=true`, `externalUrls=true`; camera/photos/files/share/secureScreen=false |
| Real Android Back event | `ns1-android-lifecycle.json`: CDP subscription recorded one `back` event after `adb shell input keyevent 4`; the temporary handler consumed it |
| Real Android product-root Back exit | `ns1-android-root-exit.json`: with an unconsumed Back callback at `/login` and again at authenticated `/app/`, hardware Back closed MainActivity and focus returned to Launcher. `pidof` may retain the Android-cached process; UI/Activity exit is the product check. CDP instrumentation also proved the bootstrap selected `exitApp` rather than history. |
| Real Android Tasks-tab DOM repro | `ns1-android-task-repro.mjs`: authorized synthetic login followed by a DOM click on Tasks set `activeTab=tasks` and rendered the Tasks screen; this resolves OBS-3 as a coordinate/input issue, not a product defect. Test credentials were supplied only through process environment and were not committed. |
| Real foreground/background events | The same evidence records `appState active=false` after HOME and `active=true` after returning to the existing Activity |
| External content leaves the privileged WebView | `android-external.json`: system handoff completed while the privileged WebView retained the staging bootstrap |
| Offline/error UI and retry | `android-offline.png`, `android-offline.json`, and `android-offline-retry.png`: bundled page had retry/no native surface/no cached app; network restoration returned to staging bootstrap |

The offline leg initially paused because the external handoff had left the app in the background; returning the existing Activity to the foreground allowed the unchanged smoke script to finish. No timeout or assertion was changed. As on iOS, `pwaProof` is null because the currently deployed staging PWA does not include this branch. These results prove native bootstrap, event transport, product-root Back exit, and Tasks DOM behavior; authenticated reconnect/resync and branch-PWA cold-start restore still require the reviewer re-run described below.

### PWA / browser

The adapter tests prove presence/absence, version mismatch, capability/method fallback, external schemes, subscriptions, and Back behavior. Mock and real-C2 suites passed on both browser profiles. These are shared PWA regressions, not substitutes for native-device acceptance.

## 9. Security, Storage, and Log Review

- Exact-origin privileged navigation remains unchanged. External pages leave the privileged WebView and never receive `idbotsNative`.
- Native `openExternal` accepts only HTTP(S)/Alipay URLs with a host and no userinfo; dangerous schemes are rejected before either native or web opening.
- No custom native persistent storage, native preference, cookie export, session snapshot, token file, native API client, or analytics payload was introduced. Existing WebView cookies and local PWA state remain under their current ownership. The mock-only login marker is a synthetic phone string in browser tab `sessionStorage`, enabled only by `VITE_MOBILE_MOCK=1`; it is not a credential, native storage, or a production path.
- Lifecycle recovery performs only existing reconnect/read-only resync operations. In-flight invokes are never replayed; session starts, submissions, orders, and chain writes are not blindly retried.
- DEBUG evidence logs contain only origin, platform, bridge version, phase, capability booleans, and client facts. No cookie, token, phone number, message content, signed URL, QR payload, mnemonic, provider key, redeem code, or account identifier was logged.
- No keystore, certificate, provisioning profile, `.env`, private-key, signing-secret, or owner-account file was added or read.
- Root Electron packaging excludes `mobile-shell/`; root postinstall does not install it. No Capacitor dependency entered the root package.
- Frozen contracts and existing CSP/CORS/Origin/gateway/IPC policies were not weakened.

## 10. Explicit NOT RUN and Open Findings

| Item | State / owner |
|---|---|
| Android build, JVM, unauthenticated WebView smoke, native Back/app-state transport, authenticated `/app/` root Back, and Tasks DOM repro | PASS — see Sections 6–8; reconnect/resync and branch-PWA cold-start restore remain separate |
| Native authenticated login and returning login cookie persistence | DEF-1 code/tests complete; native re-review requires the reviewer's authorized synthetic account and a branch-matched deployed PWA |
| Native ordinary chat, older-session restore, duplicate/lost-message checks | NOT RUN — authenticated staging account and branch-matched remote PWA required |
| Native background/foreground reconnect/resync and network recovery | NOT RUN — native event transport and offline banner passed, but authenticated reconnect/resync acceptance requires a branch-matched deployed PWA |
| Native Android Back through nested routes/sheets | `/login` and authenticated `/app/` product-root exit passed on real Android; nested route/sheet behavior requires the branch-matched PWA and an authorized synthetic account |
| Two-device behavior and logout isolation | NOT RUN — owner/staging test account and second client required |
| OBS-1 Me balance refresh in native WebView | OPEN — evidence shows a failure banner while chat works; insufficient evidence to distinguish tenant relay state from WebView transport. No speculative code change; owner/tenant-state recheck required |
| OBS-3 one missed Tasks-tab tap | RESOLVED — DOM repro successfully selected Tasks and set `activeTab=tasks`; the observation was coordinate/input related, not a product defect |
| iOS-native recharge UI and Android/PWA recharge parity in WebViews | NOT RUN — branch PWA was not deployed; pure policy/render tests passed |
| Real Alipay app handoff and payment/order behavior | NOT RUN — owner-approved staging account/order required; no order was created |
| Native keyboard, safe areas, light/dark themes | NOT RUN — physical/interactive native UI evidence unavailable; configuration and existing shared tests passed |
| OS eviction and control-plane restart recovery | NOT RUN — authenticated native session and controlled eviction/restart required |
| Physical Android/iOS hardware | NOT RUN — all current native evidence is emulator/Simulator only |
| Production-flavor WebView | NOT RUN — no production deployment or release was authorized |
| Signed Android release, TestFlight, store submission | NOT RUN — NS3 and owner credentials, explicitly out of scope |
| Camera, photos, files, system share, permissions, secure screen | NOT RUN — NS2, capabilities correctly report false |
| Push notifications | NOT RUN — outside NS0–NS3 |
| S1 | None found in the implemented NS1 code scope |
| S2 | None found in the implemented NS1 code scope; required NOT RUN evidence blocks corresponding native acceptance |
| S3 | No additional NS1 defect recorded |

## 11. Rollback and Next Step

There is no deployed artifact to roll back. Deleting the local APK, Simulator app, artifacts, or feature branch does not affect staging or production. The remote PWA was not changed or deployed, so no remote-PWA rollback is required. Native-binary and remote-PWA rollback remain separate NS3 release concerns.

Stop for independent NS1 review and acceptance. Do not start NS2 until the owner accepts and merges NS1.
