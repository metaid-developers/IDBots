# IDBots Mobile Task Design Brand Specification

## Core assets

- App icon source: `src/mobile/app/public/icon-512.png`.
- Small app icon source for embedding: `docs/design/mobile-ui-directions/assets/logo-64.png`.
- Default Twin Bot source: `public/default_metabot.png`.
- Small Twin Bot source for embedding: `docs/design/mobile-ui-directions/assets/twin-bot-32.png`.
- Every standalone HTML direction embeds the app icon and Twin Bot image as data URLs. No network request or relative asset path is required when opening the file directly.
- Do not replace the IDBots pixel identity with a generic robot, an emoji, or generated artwork. Other participant fallbacks follow the product pattern of restrained initials when no avatar exists.

## Existing visual tokens

- Brand yellow: `#FFDC51`, from the mobile `--twin-accent` token.
- Light canvas: `#F2F3F5`, from `--twin-bg-canvas`.
- Light surface: `#FFFFFF`, from `--twin-surface`.
- Light primary text: `#242425`, from `--twin-text-primary`.
- Light secondary text: `#626267`, from `--twin-text-secondary`.
- Dark canvas: `#111112`, from the current dark mobile theme.
- Dark surface: `#19191B`, from the current dark mobile theme.
- Dark primary text: `#F4F3EF`, from the current dark mobile theme.

The three directions may adjust neutral harmony and semantic status colors, but yellow remains the IDBots action and selection accent. Status colors carry meaning and are not decorative: blue for active execution, amber for owner attention, violet for external waiting, green for completion, and neutral gray for paused or draft states.

## Typography and shape

- Use the native application stack: `-apple-system`, `BlinkMacSystemFont`, `SF Pro Text`, `SF Pro Display`, `PingFang SC`, `Segoe UI`, sans-serif.
- Task titles must remain readable at handheld distance. Body copy is at least 15px in the primary flow; supporting text and labels are at least 12px.
- Use 8px, 12px, 16px, 20px, and capsule radii deliberately. Do not place every section inside an identical rounded card.
- Primary touch targets are at least 44px. Icon-only actions have accessible names.

## Product qualities to preserve

- Tasks are the primary objects. Chats are the places where work, discussion, and decisions happen around them.
- The first screen answers what is moving now, what the Bot is doing, and what needs the owner.
- Twin Bot is a dependable companion rather than a generic model or an administrative console.
- The interface remains one-handed, legible, and calm even though the underlying task model is rich.
- Chat, Browser, Tasks, and Me remain the four top-level destinations in the current product.

## Patterns to avoid

- A horizontally scrolling desktop kanban shrunk onto a phone.
- Long-term and standard task labels or filters in the user-facing mobile design.
- Repeated bordered white cards for every small fragment of information.
- Large yellow surfaces without an action or selection role.
- Generic purple gradients, neon dark-mode glow, decorative icons, emoji icons, and dashboard-style metric tiles without a task decision behind them.
- Tiny desktop metadata rows, hover-only actions, and controls smaller than 44px.

## Accessibility and appearance

- Every direction supports both light and dark appearances using the same information architecture.
- Text contrast meets WCAG AA. State is never communicated by color alone; every status also has a text label.
- Pressed, selected, expanded, and focus-visible states are visible. Reduced-motion preferences are honored.
- The prototypes are responsive PWA screens. They do not invent iOS status bars, Dynamic Islands, home indicators, or native-only chrome.
