# Maintenance Checklist

## When to use

- Apply when maintenance requests ask for security hardening, lint/test/build closure, or temporary feature suspension.

## Security hardening checklist

- Confirm `src/main/main.ts` does not use `connect-src *`.
- Confirm `shell:openExternal` validates protocol and rejects unsupported URLs.
- Confirm API proxy channels reject non-http(s) URLs.
- Confirm renderer popups are blocked with `setWindowOpenHandler`.
- Confirm non-app navigation is blocked with `will-navigate`.
- Confirm Linux `no-sandbox` is gated behind explicit environment flags.
- Confirm preload does not expose a generic `ipcRenderer` bridge.

## Engineering closure checklist

- Run `npm run lint`.
- Run `npm run build`.
- Run `npm run test:memory`.
- Run `npm run test:wallet`.
- Run `npm run test:subsidy`.
- Ensure all package scripts point to existing files.
- Prefer fixing source lint errors over blanket suppression.

## MCP suspension checklist

- Remove MCP entries from preload API.
- Remove MCP IPC handlers from main process.
- Remove MCP UI entry points/navigation.
- Keep repository docs free of MCP exposure claims.

## Regression notes

- Keep changes minimal and scoped.
- Preserve existing user-visible flows unless explicitly asked to change behavior.
- Report any intentional compatibility tradeoffs in final delivery notes.
