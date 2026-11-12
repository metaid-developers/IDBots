# IDBots Mobile Design Brand Specification

## Core assets

- Primary app icon: `assets/logo.png`, copied from the repository's `src/mobile/app/public/icon-512.png`.
- Default MetaBot image: `assets/twin-bot.png`, copied from the repository's `public/default_metabot.png`.
- Every standalone HTML direction must embed these images as data URLs so it works when opened directly with `file://`.
- Do not substitute a generic robot illustration, a generated mascot, an emoji, or a hand-drawn face for these assets.

## Existing visual tokens

- Brand yellow: `#FFDC51`, from the current renderer theme token `--color-primary`.
- Current light background: `#F5F7F9`.
- Current light panel: `#FFFFFF`.
- Current primary text: `#303133`.
- Current secondary text: `#64748B`.
- Current dark background: `#142030`.
- Current dark panel: `#1F2937`.

These tokens are a starting point, not a requirement to preserve the current visual composition. New directions should retain recognizable yellow accents while improving neutral color harmony, typography, spacing, depth, and interaction feedback.

## Typography

- Use the native system stack for application text: `-apple-system`, `BlinkMacSystemFont`, `SF Pro Text`, `SF Pro Display`, `PingFang SC`, `Segoe UI`, sans-serif.
- Native typography is intentional because the user specifically wants an iOS-like consumer app.
- A direction may introduce a restrained display face only when it improves the content concept. It must remain readable and must not turn the product into a marketing page.

## Product qualities to preserve

- Twin Bot is a personal companion, not a generic chat model.
- The app can show meaningful work: itinerary results, task state, generated files, and permission or progress feedback.
- Chat, Tasks, and Me remain the three top-level destinations in this design round.
- The interface must remain suitable for one-handed phone use.

## Patterns to retire

- Repeated white cards with generic gray borders.
- Dense rows of identical rectangular controls.
- Large yellow fills without a clear semantic role.
- Excessive labels, metadata, status dots, and tool-oriented language.
- Generic AI purple, neon glow, decorative gradients, emoji icons, and dashboard-style composition.
- Web-page-like centered columns, full-width hairlines around every section, and uniformly weighted UI elements.

## Asset and accessibility constraints

- No external stock image is needed for this chat-screen comparison. The brand icon and Bot image are the only required imagery; additional decorative photography would not improve content comprehension.
- Body text must be at least 15px in the phone mockups, supporting text at least 12px, with WCAG AA contrast.
- Primary touch targets must be at least 44px.
- Every light direction needs a considered dark appearance, and the dark direction needs a legible light appearance for comparison.
