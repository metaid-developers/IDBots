---
name: maintain-idbots-project
description: Maintain the IDBots repository with secure-by-default and release-ready changes. Use when tasks require (1) hardening Electron security boundaries (CSP, preload API surface, shell/openExternal rules, navigation controls, Linux sandbox policy), (2) fixing lint/build/test blockers while preserving existing behavior, (3) suspending unfinished features such as MCP from renderer/preload/main IPC and public docs, or (4) running standardized maintenance validation before delivery.
---

# Maintain Idbots Project

## Overview

Apply conservative maintenance changes that keep currently usable features intact while reducing exposure and clearing delivery blockers.
Use reproducible checks instead of ad-hoc verification.

## Workflow

1. Run baseline checks to see current failures.
2. Implement the smallest safe change set for the requested maintenance target.
3. Re-run checks and stop only when lint/build/tests pass or when a documented external dependency blocks completion.
4. Summarize file-level impact and residual risks.

Run:

```bash
bash SKILLs/maintain-idbots-project/scripts/run-maintenance-checks.sh
```

## Security Hardening Rules

1. Keep Electron boundary narrow.
2. Remove generic IPC exposure from preload and expose only explicit APIs.
3. Restrict external URL handling to allowlisted protocols.
4. Reject non-http(s) URLs for fetch proxy channels.
5. Block unexpected window popups and cross-origin in-app navigation.
6. Avoid globally permissive CSP directives.
7. Avoid default `no-sandbox` on Linux; gate it behind explicit env flags.

Use [maintenance-checklist.md](references/maintenance-checklist.md) when touching security-sensitive code.

## Engineering Closure Rules

1. Fix production-path lint errors instead of suppressing them unless suppression is clearly justified.
2. Keep lint scope focused on source files that gate delivery.
3. Ensure script references in `package.json` point to real files.
4. Add missing tests for referenced core modules when scripts fail due to absent files.
5. Validate with:
   1. `npm run lint`
   2. `npm run build`
   3. `npm run test:memory`
   4. `npm run test:wallet`
   5. `npm run test:subsidy`

## Feature Suspension Rules (MCP Example)

1. Remove suspended feature from renderer entry points and visible navigation.
2. Remove suspended feature IPC from preload and main process.
3. Keep internal code only if needed for future re-enable, but do not expose it to UI or public docs.
4. Ensure no public README/docs claim availability.

## Resources

### scripts/
- `scripts/run-maintenance-checks.sh`: Run lint/build/tests and verify key security/suspension guards.

### references/
- `references/maintenance-checklist.md`: Manual checklist for security hardening, engineering closure, and MCP suspension.
