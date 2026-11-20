# IDBots mobile splash brand specification

## Required asset

- Official owner-supplied artwork: `../../../public/logo.png` (1080 × 1080 px).
- Absolute worktree path for design tools: `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/mobile-ui-experience/public/logo.png`.
- This exact pixel robot must appear in all three concepts. Do not redraw it, replace it, change its colors, stretch it, crop it, or upscale it beyond its native 1080 px size.
- Each standalone HTML concept must embed the image as a data URI so the file remains self-contained.

## Colors sampled from the artwork

- Launch amber: `#FEB338` (pixel at 10,10).
- Robot cream: `#FFDBA0` (pixel at 540,540).
- Robot orange: `#F46A21` (pixel at 300,500).
- Pixel charcoal: `#303133` (pixel at 250,360).

These are the only brand chromatic anchors. Neutral tints may be derived from cream and charcoal. Do not introduce generic purple/blue AI gradients, neon cyan, or unrelated accent colors.

## Typography

No separate licensed brand-font specification was found. Concepts may use high-quality system or locally available open font stacks. Body copy must remain at least 14 CSS px and labels at least 12 CSS px. A launch screen should contain very little copy: wordmark, one short line at most, and an optional non-animated loading affordance.

## Composition and prohibitions

- Target viewport: 390 × 844 CSS px, portrait.
- Preserve the source artwork's square aspect ratio with `object-fit: contain` and explicit equal width/height.
- No `object-fit: cover`, `background-size: cover`, non-uniform transforms, face-only crops, or raster stretching.
- Keep all meaningful pixels visible inside the artwork frame. Decorative background geometry is allowed only when it does not obscure or replace the robot.
- No fake operating-system status bar, home indicator, app chrome, button, carousel, marketing feature list, or fabricated product metrics. This is a native launch image, not an onboarding screen.
- No emoji, generic robot SVG, glassmorphism dashboard, purple AI gradient, or decorative card collection.

## Emotional range

All concepts should feel like the same product: warm, recognizable, slightly playful, and confident. The three directions vary composition and temperature rather than brand assets: restrained system precision, bright companion warmth, and charcoal pixel-native confidence.
