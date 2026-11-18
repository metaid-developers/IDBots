# Mobile PWA polish — delivery note

- **Branch:** `feat/mobile-pwa-polish`
- **Scope:** Me → Models, composer focus and voice modes, chat-link contrast, and Studio activity copy
- **Contract change:** CR-WSE-001, allowlist 1.0.4 (R-store provider management; C2 transport unchanged)
- **Production deployment:** not performed from this branch; requested from the merged `main` commit only

## Requirements and evidence

| Requirement | Status | Evidence |
|---|---|---|
| REQ-E-11 touch-friendly shell | Implemented | 46 px model form controls, 44 px voice surfaces, safe-area composer preserved; visual review on Pixel 7 |
| REQ-E-12 chat | Implemented | Direct mic hold, tap-to-switch wide Hold to talk, keyboard return, draft-preserving voice send, lighter chat links, Studio activity phrases |
| REQ-E-14 Me | Implemented | Models secondary page with official/default model, seven mainstream presets, custom provider, API key/Base URL/API format/model ID |
| REQ-E-18 i18n | Implemented | New English and Chinese mobile keys; static parity and hard-coded-copy checks passed |
| REQ-E-20 credential handling | Implemented | Keys remain only in edit state and tenant config; no phone-storage persistence or saved-key echo; gateway reads remain redacted and relay settings stay pinned |
| REQ-E-25 unit coverage | Implemented | `test:mobile`: 436 TypeScript tests + 6 static tests + 64 session/login tests passed; gateway core/server: 72 tests passed; IPC contract test passed |
| REQ-E-26 browser coverage | Implemented | Model, focus, link, registry, and composer journeys passed on iPhone 14/WebKit and Pixel 7/Chromium; two full voice hold-to-send journeys passed on Pixel 7 |
| REQ-E-19 budgets | Implemented | `build:mobile` passed; login and initial-app gzip budgets remained within limits |
| R-store / CR-WSE-001 | Implemented | Provider add/edit, key replacement, redacted-key preservation, removal rejection, malformed-entry rejection, and relay-route pinning covered by gateway tests |

## Voice acceptance exercised

1. In text mode, holding the mic starts recording; release sends the final transcript as a new message without changing composer mode.
2. A short mic tap only switches to the wide **Hold to talk** surface. It does not start a tap-mode recording.
3. The wide surface supports the same hold/release/send and swipe-up cancel gestures.
4. The keyboard button restores the text composer. The pre-existing text draft survives the complete voice submission; ordinary text sends keep their existing clear-on-accept behavior.

## Model acceptance exercised

1. Save a custom provider and model through the real mobile bridge; readback confirms the new global default.
2. Existing provider edits preserve a redacted key when the field is blank and replace it only with a newly entered key.
3. Selecting the official provider never rewrites relay connection fields.
4. The custom-provider browser journey leaves neither the key in the form nor any key material in local/session storage.
5. Base URL and API format stay under Connection settings for presets and expand automatically for custom providers.

## Limits

- Voice browser tests use the deterministic synthetic microphone and voice stub; no physical-phone microphone claim is made.
- No real third-party API key or paid provider call was used in development tests.
- Production canary/fleet evidence belongs to the merged-`main` deployment report, not to this branch.
