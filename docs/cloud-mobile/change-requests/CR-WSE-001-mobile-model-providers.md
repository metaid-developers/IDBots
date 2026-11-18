# CR-WSE-001 — Mobile user-owned model providers

- **Status:** Approved by the owner through the mobile PWA change request on 2026-11-19
- **Date:** 2026-11-19
- **Contract:** `02-ipc-allowlist-v1.md` R-store; allowlist version 1.0.3 → 1.0.4
- **Affected parties:** WS-A (gateway restrictions), WS-E (mobile model settings), acceptance
- **Compatibility:** Backward-compatible expansion of accepted `store:set('app_config')` writes; existing readers, field-scoped preference writes, redaction, and provider-removal denial are unchanged

## Current text before this CR

R-store freezes every provider's `apiKey`, `baseUrl`, and `apiFormat` and rejects provider additions. The phone can read a redacted catalog and select existing models, but cannot configure a user-owned provider. `save-api-config` remains tier N and is not used by this change.

## Approved change

1. Keep `store:get('app_config')` redaction unchanged: no stored provider credential is returned to the phone.
2. Let `store:set('app_config')` add and edit user-owned provider entries. Existing provider entries cannot be removed.
3. Treat an omitted or `"__redacted__"` `apiKey` as "keep the stored credential". A new non-empty key replaces only that user-owned provider's key.
4. Keep the relay-managed `idbots` / `metaid-free` provider's `apiKey`, `baseUrl`, and `apiFormat` pinned to the stored values.
5. Validate new provider keys and provider field shapes. New entries require a non-empty Base URL and a supported API format (`anthropic`, `openai`, or `responses`).
6. The mobile Me → Models screen writes only `providers` and the global default `model` selection. Existing sessions and Bot-specific model bindings are not rewritten.

## Reason

The owner requires phone users to choose an official model or configure a mainstream/custom provider with their own API key, Base URL, API format, and model ID. Reusing R-store avoids adding a duplicate provider-management IPC surface.

## Migration and acceptance

- No stored-config migration is required. Existing provider entries and credentials remain in the tenant database.
- The key is held only in component state while editing and is never persisted in phone storage or logged. Readback shows only whether a key exists.
- Gateway tests cover provider addition, edit, redacted-key preservation, replacement, removal rejection, malformed-entry rejection, and relay-route pinning.
- Mobile tests cover preset/custom form behavior, default-model readback, and no key echo after saving.
- Regenerate `src/mobile/generated/ipc-contract.json` with allowlist version 1.0.4.
