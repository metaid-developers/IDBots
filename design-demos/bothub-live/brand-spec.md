# IDBots BotHub brand spec

## Existing product audit

Reference screenshot: `assets/current-bothub.jpg`, captured read-only from the running local IDBots application.

The current product already has a recognizable dark shell, a compact BotHub/BotWorks switch, a left session column, and a large right browser canvas. The redesign preserves that structure. The design target is the right-side live process, not a new product identity.

## Required local assets

- IDBots logo: `assets/logo.png`, copied from `public/logo.png`.
- Current Twin Avatar: `assets/current-twin-avatar.jpg`, extracted read-only from the active local `AI_Sunny` Twin profile.
- Generic TwinBot fallback: `assets/twinbot.png`, copied from `src/renderer/assets/onboarding/hero-twinbot-v4.png`.
- Current UI reference: `assets/current-bothub.jpg`.

No third-party logo is shown. No stock photography is needed because the product interface and motion behavior are the content.

## Color tokens from the application

- Brand yellow: `#FFDC51`, used for primary action and the living Twin presence.
- Dark sidebar: `#0B1323`.
- Dark main surface: `#142030`.
- Dark panel: `#1F2937`.
- Primary dark-theme text: `#FFFFFF`, softened in the prototypes to off-white where large fields need less glare.
- Secondary dark-theme text: `#94A3B8`.
- Cyan activity token: `#22D3EE`, reserved for an actual network or browser signal when needed.
- Light surface family: `#F5F7F9` and `#FFFFFF`.
- Light primary text: `#303133`.
- Light secondary text: `#64748B`.

Each direction locks its own accent usage. Yellow remains the shared brand signature. Cyan is never used as a decorative second glow.

## Typography

The application stack is preserved: SF Pro, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, and system sans-serif fallbacks. Monospace is limited to actual event metadata and identifiers, not used as a science-fiction costume.

## Shape and material

- Existing product shell: compact dark surfaces and restrained rounded controls.
- Direction A+B: a WebGPU/WGSL liquid-glass shell carries the active Bot Avatar, with a Canvas2D fallback rather than claiming an official Apple material.
- Direction B: spatial cartography, fine structural lines, flat nodes, and camera movement.
- Direction C: white-gallery space, physical paper-like layers, soft contact shadows, and the pixel character.

## Interaction invariants

- Left text chat and bottom-left text input remain.
- The live stage never steals keyboard focus.
- Every motion direction honors reduced-motion preferences.
- The report is a separate final projection state. Back returns to the frozen live trace.
- Motion communicates activity, transition, delegation, verification, or readiness. It is not ambient decoration for its own sake.
