# NS2 Native Media and System Capabilities — Delivery Note

## 1. Delivery State

NS2 implementation is complete within the planned camera/photo/file/share and secure-screen scope. The package preserves the remote-PWA/Capacitor architecture, the existing C2 upload route, per-session attachment drafts, artifact signing, and browser fallbacks. It adds no native API client, Agent, LLM, wallet, chain, memory, skill, session, or task implementation.

Automated tests, production PWA builds, Android and iOS debug builds, Android JVM tests, and Android WebView smoke pass. Physical-device behavior and real tenant/model/chain/payment acceptance are NOT RUN. iOS Simulator build and process launch succeeded, but visible PWA/bootstrap evidence was not obtained, so iOS WebView acceptance is also NOT RUN. This is not a claim of native acceptance, production readiness, or owner sign-off.

No GitHub push, main merge, staging/production deployment, signing-key access, TestFlight upload, store submission, or frozen-contract change was performed.

## 2. Provenance

| Item | Value |
|---|---|
| Branch | `feat/mobile-native-capabilities` |
| Worktree | `.worktrees/mobile-native-capabilities` |
| Base SHA | `6bded546` |
| Final SHA | Resolve with `git rev-parse HEAD` after the delivery commit |
| Native package version | `0.1.0` |
| Native bridge version | `1` |
| C2 / allowlist version | `1.0.0` / `1.0.0` |
| Verified build flavor | `staging` → `https://staging.idbots.world/` |
| Application ID | `com.idbots.world` |

The required English on-chain development-journal pins are recorded with the final report.

## 3. Requirement Mapping

| Requirement | Implementation |
|---|---|
| Camera and photo selection | Android `ACTION_IMAGE_CAPTURE`/`ACTION_OPEN_DOCUMENT`; iOS `UIImagePickerController` with camera/photo permission handling |
| Multi-document selection | Android ordered `ClipData`/single URI handling; iOS `UIDocumentPickerViewController` with security-scoped URLs |
| Existing upload pipeline | Bootstrap converts bounded native reads into ordinary `File` objects; `installShim` retains the existing size/type checks, image re-encoding, ordered progress, and session drafts |
| Selection outcomes | Cancellation, `PERMISSION_DENIED`, `UNAVAILABLE`, `TOO_LARGE`, and `NATIVE_FAILED` are distinct; selection-time failures create a visible upload error item without invoking upload |
| Artifact sharing | `MobileArtifactPreview` tries native system sharing with the current signed URL, then Web Share/clipboard fallbacks; cancellation does not become a false success |
| Secure screen | Android `FLAG_SECURE`; iOS opaque background/app-switcher masking through `SceneDelegate`, not a screenshot-prevention claim |
| Origin and backend boundaries | Exact-origin bootstrap and existing navigation policies remain unchanged; no new C2/IPC channel or native business backend |
| Temporary data | Only app-created camera files are deleted after reads/cancellation; document URIs and selected content are not persisted |

Primary files are `mobile-shell/android/.../NativeCapabilitiesPlugin.java`, `mobile-shell/ios/App/App/NativeCapabilitiesPlugin.swift`, `mobile-shell/native/idbots-native-bootstrap.js`, `src/mobile/native/`, `src/mobile/bridge/installShim.ts`, `src/mobile/app/hooks/useChatAttachments.ts`, and `src/mobile/app/components/MobileArtifactPreview.tsx`.

## 4. Verification Commands and Results

| Check | Result |
|---|---|
| `mobile-shell`: `pnpm test` | PASS, 20/20 |
| Root focused TypeScript + adapter/shim/attachment/artifact tests | PASS, 38/38 |
| `pnpm run test:mobile` | PASS, 426/426 (360 + 6 + 60), including TypeScript no-emit |
| `pnpm run test:e2e:mobile` | PASS, 134 passed, 10 existing skips across iPhone WebKit and Pixel Chromium |
| `pnpm run test:e2e:mobile:gateway` | PASS, 34/34 across both profiles |
| `pnpm test` | PASS, complete standard repository chain |
| `pnpm run lint` | PASS, zero warnings |
| `pnpm run build:mobile` | PASS; login 68.7 KB gzip, app initial JS 100.2 KB gzip; all budgets/no-mock/Twemoji checks pass |
| `pnpm run build:skills`, DSH dependency and kernel-patch checks | PASS; all 11 fingerprints verified |
| `pnpm run build:android:staging` | PASS, `BUILD SUCCESSFUL` |
| `./gradlew --no-daemon testStagingDebugUnitTest` | PASS, `BUILD SUCCESSFUL` |
| `pnpm run build:ios:staging` | PASS, `BUILD SUCCEEDED`, unsigned Simulator Debug |
| `git diff --check` | PASS |

Toolchain evidence: Node 26.7.0, pnpm 11.24.0, Capacitor 8.5.3, Android JDK 21.0.13, Gradle 8.14.3, Xcode 27.2, CocoaPods 1.16.2.

## 5. WebView Evidence

Evidence is under ignored `mobile-shell/artifacts/`; no account, phone number, tenant identifier, message content, cookie, signed URL, or token is included in the delivery note.

### Android — `test35` emulator

| Check | Evidence and result |
|---|---|
| Exact-origin document-start bootstrap and before-React proof | `android-bootstrap.json`: all NS2 capabilities true, `shell=capacitor`, `os=android` |
| Secure-screen enable/disable through the real bridge | `android-bootstrap.json`: `secureScreenToggle=PASS` |
| External navigation leaves the privileged WebView | `android-external.json`: PASS; privileged origin/capabilities remain intact |
| Offline page and retry | `android-offline.json`: no native surface or cached online app on the bundled offline page; retry restores the NS2 bootstrap |

`android-staging-login.png`, `android-offline.png`, and `android-offline-retry.png` are local evidence only. These are emulator results, not physical-device camera/file/share acceptance.

### iOS — IDBots-NS0-iPhone-17 Simulator / iOS 26.5

The final unsigned Simulator build succeeded and `simctl install`/`launch` returned a process ID. The captured SpringBoard did not expose a visible PWA page or `NS0_BOOTSTRAP` evidence. Therefore bootstrap, login, picker, share, and secure-screen behavior are **NOT RUN**, not failed silently and not marked as passed.

## 6. Artifact Hashes

| Artifact | Type | SHA-256 |
|---|---|---|
| `android/app/build/outputs/apk/staging/debug/app-staging-debug.apk` | Android staging Debug | `83527dc36737917bfd480801f4e5a06a9edf936ac8239d8274c3d5354d19b529` |
| `ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app/App` | iOS Simulator executable | `aa8ec17043c29d14b69d5de1caf20b0a7f8e12b9124de81a16486c19c826c220` |

These are local verification artifacts, not signed releases or deployment candidates.

## 7. Security and Data Review

- No arbitrary-origin capability exposure was added. External pages never receive `window.idbotsNative`.
- Native file reads are limited to selected content URIs and app-owned camera files. Arbitrary filesystem paths are not accepted.
- Both platforms check the 25 MiB limit before reads where metadata exists and while bytes are consumed. Native selection completes before the existing uploader starts, so an oversize later selection cannot trigger a partial upload.
- Signed artifact URLs are passed only to the system share flow in memory. They are not written to native preferences, logs, diagnostics, or this note.
- Android sharing reports chooser handoff because Android has no reliable cancellation result. iOS uses the actual activity completed/cancelled value.
- iOS masking is opaque and lifecycle-driven. No iOS screenshot-blocking claim is made.
- No new native persistent account/product storage, HTTP client, WebSocket client, analytics payload, or native token handling was introduced.

## 8. Explicit NOT RUN and Acceptance Blockers

| Item | State |
|---|---|
| Physical Android/iPhone camera, gallery, permission, keyboard, safe-area, and system-share journeys | NOT RUN — physical hardware required |
| Real 20 MB PDF upload and rejected 26 MB file on device | NOT RUN — deterministic unit/native bounds pass; physical evidence required |
| Image/PDF/Markdown/other artifact preview and system share on physical devices | NOT RUN |
| iOS WebView bootstrap, login, picker, share, and background mask | NOT RUN — build/process launch only; visible PWA/bootstrap evidence unavailable |
| Authenticated two-device, logout, ordinary chat, reconnect, and OS-eviction journeys | NOT RUN in NS2 |
| Real tenant, model, chain, payment, and staging acceptance | NOT RUN — no real account or owner secret used |
| Signed Android release, TestFlight, store submission | NOT RUN — NS3 and owner credentials required |
| Push notifications | NOT RUN — MA3, outside NS2 |

No S1/S2 code defect is known in the implemented scope. The missing evidence above blocks native acceptance and any release claim.

## 9. Next Step

Review and merge only with owner approval. Build further verification from the reviewed `main` SHA, then complete the physical-device and real-service matrix. Do not deploy this feature branch. Remote-PWA rollback and native-binary rollback remain separate release concerns.
