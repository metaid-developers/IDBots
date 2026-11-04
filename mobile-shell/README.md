# IDBots Native Mobile Shell — NS2

This package contains the Android and iOS Capacitor shells for the deployed IDBots PWA. It is an independent pnpm package: the repository root `postinstall` does not install it, and Electron does not package it.

NS0 provides the native foundation, NS1 adds lifecycle and navigation integration, and NS2 adds system media and sharing capabilities:

- staging and production remote-PWA flavors;
- exact-origin privileged navigation and system handoff for approved external links and Alipay;
- a bundled bilingual offline/error page with retry;
- a versioned native bootstrap installed at document start, before React use;
- a typed local adapter with browser/PWA and per-capability fallbacks;
- native app-state recovery through the existing reconnect/read-only-resync flow;
- Android Back through current sheets, drawers, recharge state, and tabs without a second history;
- camera, photo-library, and multi-document selection into the existing upload pipeline;
- native system artifact sharing with current signed URLs and existing web fallbacks;
- Android secure screenshots and iOS opaque background/app-switcher masking;
- keyboard, safe-area, theme, and iOS-native recharge policy integration;
- focused static, adapter, lifecycle, navigation, origin-policy, build, and WebView evidence.

Push notifications, signing, TestFlight, and release rollout are intentionally not implemented. Physical-device and real-service acceptance is a separate gate, not implied by debug builds.

## Architecture

Normal use loads `https://staging.idbots.world/` or `https://app.idbots.world/` in the privileged WebView. Existing PWA `fetch`, WebSocket, HttpOnly cookie, and `window.electron`/C2 paths remain unchanged. The shell has no native API client, Agent, LLM, wallet, chain, memory, skill, session, or task implementation.

The bundled `www/` directory contains only the offline/error experience. It is not a cached PWA and has no service worker or offline Agent execution.

The shell installs `window.idbotsNative` at document start on the exact remote origin. The PWA entry guard in `src/mobile/native/` validates its version, origin, platform, phase, and capabilities before React mounts. `window.idbotsMobile` remains a separate client-fact surface. External pages leave the privileged WebView and do not receive the native surface.

## Toolchain

Verified NS0/NS1 toolchain versions:

| Component | Version / requirement |
|---|---|
| Node.js | `>=24 <27` (verified with 26.7.0) |
| pnpm | 11.24.0 |
| Capacitor core / CLI / Android / iOS | 8.5.3 |
| `@capacitor/app` | 8.1.2 |
| Android JDK | 21 |
| Android Gradle Plugin | 8.13.0 |
| Gradle | 8.14.3 |
| AndroidX WebKit | 1.14.0 |
| Android compile / target SDK | 36 |
| Android minimum SDK | 26 (Android 8) |
| Xcode | 26.0 or later (verified with 27.1) |
| CocoaPods | 1.16.x |
| iOS deployment target | 15.0 or later |

Install this package explicitly:

```bash
cd mobile-shell
pnpm install --frozen-lockfile
```

Set `JAVA_HOME` to a JDK 21 installation and `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) to the Android SDK. Android builds use `mobile-shell/.tooling/gradle` as `GRADLE_USER_HOME`, keeping generated caches inside this package. The build script also recognizes the optional local JDK at `.tooling/jdk-home/Home`; `.tooling/` is ignored and never committed.

If the host uses an HTTP(S) proxy, Java does not necessarily inherit the desktop setting. Supply standard non-secret Java proxy properties through `JAVA_TOOL_OPTIONS` and `GRADLE_OPTS`, for example `-Dhttps.proxyHost=<host> -Dhttps.proxyPort=<port>`. Do not place proxy credentials in this repository or delivery notes.

CocoaPods commands require UTF-8 locale settings. The iOS build script supplies `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8`.

## Flavors

Staging is the default. Production is always an explicit command.

| Flavor | Remote origin | Android variant |
|---|---|---|
| `staging` | `https://staging.idbots.world/` | `stagingDebug` |
| `production` | `https://app.idbots.world/` | `productionDebug` |

`scripts/select-flavor.mjs` updates `capacitor.config.json`, copies the shared bootstrap template into both native projects, and writes the iOS `NativeShellFlavor.plist`. Android also has native `staging` and `production` product flavors whose `BuildConfig.NATIVE_REMOTE_ORIGIN` is authoritative for navigation and bootstrap. Production selection does not deploy anything.

```bash
pnpm run sync                 # staging, both platforms
pnpm run sync:staging
pnpm run sync:production      # explicit production selection

pnpm run build:android        # staging debug APK
pnpm run build:android:staging
pnpm run build:android:production

pnpm run build:ios            # staging Simulator debug app
pnpm run build:ios:staging
pnpm run build:ios:production
```

iOS builds are Simulator Debug builds with `CODE_SIGNING_ALLOWED=NO`. Production-flavor debug builds are not production releases. No signing key, Apple credential, store submission, TestFlight upload, staging deployment, or production deployment is used.

For a particular iOS Simulator, set `IDBOTS_IOS_DESTINATION`, for example `platform=iOS Simulator,id=<device-udid>`.

## Verification

```bash
pnpm test
cd android && ./gradlew --no-daemon testStagingDebugUnitTest
```

Run the repository regression checks from the root after changing `src/mobile/`:

```bash
pnpm test
pnpm run test:mobile
pnpm run lint
pnpm run build:mobile
pnpm run build:skills
pnpm run test:e2e:mobile
pnpm run test:e2e:mobile:gateway
```

## Native Surface

`nativeBridgeVersion` is `1`. `getCapabilities()` returns a fresh object with these values:

| Capability | Value | Meaning |
|---|---|---|
| `camera`, `photos` | `true` when `NativeCapabilities.pickPhoto` exists | System camera/photo-library selection is available; hardware or permission failure is reported separately |
| `files` | `true` when `pickFiles` and `readFile` exist | Ordered multi-document selection and bounded reads are available |
| `share` | `true` when `shareArtifact` exists | Current signed HTTP(S) artifact URLs can enter the system share flow |
| `appState` | `true` when the App listener exists | Native foreground/background events are available; otherwise the adapter falls back |
| `backButton` | Android when the App listener exists | Current UI handlers run first; product roots exit rather than history-returning to login |
| `externalUrls` | `true` | Native exact-origin policy and system handoff are implemented |
| `secureScreen` | `true` when `setSecureScreen` exists | Android uses `FLAG_SECURE`; iOS uses an opaque background/app-switcher mask |

The bootstrap also records `phase: 'document-start'`, the expected origin, and the platform. The PWA adds a separate `before-react` proof after validation. Browser and PWA execution do not require or synthesize `window.idbotsNative`; the local adapter supplies no-op lifecycle/back fallbacks and normal browser external opening. A native bootstrap that is missing, late, from the wrong origin/platform, or has an unsupported bridge version remains fail-closed before React.

## NS2 Media, Sharing, and Privacy

Native selection returns ordinary `File` objects to the existing picker → size/type checks → image re-encoding → ordered upload progress → per-session draft pipeline. Each file is read sequentially. Both native layers enforce the same 25 MiB limit before and during reads; they do not persist document URIs or selected content. Only app-created camera files are temporary and are removed after reads or cancellation.

Picker cancellation resolves without an error. Permission denial, unsupported capability, oversize input, and native failure remain distinct result categories. A native failure does not open a second picker or replay an upload. Browser file selection, Web Share, clipboard, download, and open-new-tab behavior remain available when the corresponding native capability is absent.

Android sharing reports that the system chooser was handed the signed URL; Android does not expose a reliable user-cancellation result. iOS reports the `UIActivityViewController` completed/cancelled result. Signed URLs are never logged or persisted by the shell. iOS secure screen is an opaque background mask, not a claim that screenshots can be prevented.

## Lifecycle and Navigation

Native foreground events call the existing `reconnectNow()` when the gateway is not online. If the gateway is already online, they run the existing coalesced read-only resync; reconnect completion uses the same path through `onReconnected`. Background events do no recovery work. No native lifecycle handler starts a session, submits or retries a message, creates an order, or performs a chain write.

Every cold login entry probes the existing C3 `getMe()` with the persisted HttpOnly cookie. Ready/degraded tenants open `/app/` with `location.replace`, provisioning/failed tenants continue through the existing preparing flow, only `UNAUTHORIZED` opens the login form, and transient failures offer retry. Browser `offline` moves a non-terminal gateway connection to the existing offline banner immediately; `online` still calls `reconnectNow()`.

Android Back closes the highest-priority mounted BottomSheet or session drawer, then closes recharge or returns Tasks/Me to Chat. An unhandled `/app/` or `/login` product root exits through `App.exitApp()` instead of history-returning to login; non-product-root WebView history remains available. The dispatcher stores mounted callbacks, not navigation entries, so browser/PWA history remains unchanged.

Approved HTTP(S) and Alipay URLs use main-frame navigation to reach the NS0 native system-handoff delegates. The PWA keeps `window.open` for HTTP(S), same-tab Alipay navigation, QR fallback, and existing order recovery. A failed native handoff is not blindly repeated through a second path.

Android declares `adjustResize`; the PWA retains its visual-viewport composer inset, safe-area padding, connection banners, and light/dark/system themes. Recharge is hidden only when the existing client facts report `shell=capacitor` and `os=ios`; iOS PWA, Android native, browsers, and redeem-code behavior remain unchanged. OS eviction reloads the remote PWA through the existing native delegates and restores authoritative tenant state rather than a native session snapshot.

## DEBUG WebView Smoke

DEBUG builds log only non-secret bootstrap fields: origin, platform, bridge version, phase, capability booleans, and client facts. They do not log cookies, query strings, account identifiers, phone numbers, message content, signed URLs, or native storage.

For iOS Simulator smoke runs, `NS0_SMOKE` is honored only in DEBUG and only when explicitly supplied:

```bash
SIMCTL_CHILD_NS0_SMOKE=external xcrun simctl launch booted com.idbots.world
SIMCTL_CHILD_NS0_SMOKE=offline xcrun simctl launch booted com.idbots.world
SIMCTL_CHILD_NS0_SMOKE=offline-retry xcrun simctl launch booted com.idbots.world
```

- `external` asks the privileged WebView to navigate to `https://example.com/`; native policy cancels it and hands it to the system browser.
- `offline` presents the bundled error page.
- `offline-retry` presents the bundled page and activates its retry button, returning to the staging login page.

For Android, enable WebView debugging in the DEBUG build, forward its DevTools socket, then run the CDP smoke script:

```bash
adb forward tcp:9222 "localabstract:webview_devtools_remote_$(adb shell pidof com.idbots.world | tr -d '\r')"
node scripts/android-webview-smoke.mjs bootstrap
node scripts/android-webview-smoke.mjs external
node scripts/android-webview-smoke.mjs offline
```

The Android smoke checks the actual staging bootstrap, verifies that external navigation leaves the privileged WebView, emulates an unreachable network, captures the bundled offline page, and restores the network before activating retry.

Normal launches and Release builds do not run these actions. Screenshots and logs belong in `mobile-shell/artifacts/`, which is ignored and outside git.

## Storage and Secrets

NS0 and NS1 add no custom native persistent storage and no native preferences for account or product data. Capacitor may keep non-secret binary-version bookkeeping; the WebView owns the existing HttpOnly session cookie. No session cookie is copied into native preferences, files, logs, JavaScript bridge values, or analytics.

Do not place signing keys, Apple credentials, device tokens, phone numbers, message contents, mnemonics, provider keys, redeem codes, payment QR payloads, signed file URLs, or session tokens in this package or its evidence.
