# Mobile splash concept specification

## Assignment and user need

Create three genuinely different visual directions for the IDBots native mobile launch screen. This is the screen seen immediately after tapping the application icon, before the remote PWA becomes usable. The current implementation makes the square robot artwork fill a tall launch surface, so the robot visibly distorts. The replacement must make aspect-ratio correctness feel intentional rather than merely repaired. The owner will compare rendered designs and select one direction; none of these concepts is approved for production integration yet.

The same owner supplied the 1080 × 1080 pixel robot in `public/logo.png` as the application icon reference. The launch concepts therefore need to create continuity between home-screen icon and application startup. Recognition should be immediate: the robot is the hero, IDBots is the only required wordmark, and the visual system must grow from the amber, cream, orange, and charcoal already present in the artwork. The design should feel crafted and native, not like a website landing page squeezed into a phone.

## Audience and usage context

The audience is IDBots mobile users returning to their persistent MetaBots many times per day. They may be opening a conversation, checking a background task, or responding to a Bot event. Startup is a brief transitional moment, not a teaching opportunity. The user should see a stable identity cue, not a marketing message, fake progress percentage, button, or interactive tutorial. The screen must remain understandable if displayed for only a few hundred milliseconds and remain calm if a slow network keeps it visible for several seconds.

## Shared content

- Required: the unmodified owner-supplied pixel robot.
- Required: the `IDBots` wordmark as text or carefully styled lettering.
- Optional: one short line such as `Your bots, always with you.` This is concept copy and may be omitted when the composition is stronger without it.
- Optional: a restrained static loading indicator. Do not simulate connection status, percentages, elapsed time, or fake boot logs.
- No other feature copy, statistics, navigation, notifications, user data, or fabricated UI.

## Output format

Produce one complete standalone HTML file per direction. Each HTML file must render a single 390 × 844 CSS px portrait launch screen, centered on a neutral comparison background when opened on a larger display. Embed the robot artwork as a base64 data URI. Use only HTML, CSS, and at most a small script that sets `window.__ready = true`; no network resources and no runtime dependencies. Capture one PNG screenshot per direction at exactly 390 × 844 CSS px. Keep the launch surface itself free of device frames, status bars, home indicators, captions, and watermarks. Labels may live outside the captured launch surface in a later comparison board.

## Hard technical constraints

- Preserve the source square at all times. Use equal dimensions and aspect-preserving containment.
- Never crop or redraw the robot. The whole supplied square artwork must be present and legible.
- Do not stretch the robot to the 390 × 844 viewport. Background color and separate decorative geometry may fill the viewport instead.
- Keep essential artwork and wordmark within conventional portrait safe margins of at least 24 CSS px horizontally and 48 CSS px vertically.
- All text must meet readable contrast and minimum sizes: labels at least 12 CSS px, any sentence at least 14 CSS px.
- Respect reduced-motion preferences. Static concepts are preferred; no animation is required for this selection round.
- The standalone HTML must work over `file://` without image or font requests.

## Form derived from content

The visual motif is the robot's native square pixel grid and its stacked head/body geometry. Each direction should interpret that structure rather than applying a generic AI visual skin. Possible expressions include registration marks derived from pixel edges, stacked amber panels echoing the robot's silhouette, or a charcoal field against which discrete amber pixels become a structural rhythm. Geometry must support the robot, not compete with it or pretend to be a replacement illustration.

## Direction separation

The three implementations share only this specification and the same source asset. They must have materially different composition skeletons, not three recolored center-aligned cards:

1. A restrained functional/system direction using precise alignment, fine rules, warm neutral space, and editorial hierarchy. It should feel calm, exact, and durable.
2. A bright companion direction anchored by a real-world product with excellent mascot-led startup or identity presentation. It should use the launch amber confidently and feel friendly without becoming childish.
3. A bespoke pixel-native direction using Susan Kare's design philosophy as the anchor: economical pixels, strong silhouettes, wit, and immediate recognition. It may use a charcoal field and asymmetric editorial composition to create the boldest interpretation while preserving the exact robot asset.

## Acceptance for this selection round

Three separate HTML files and three separate PNGs must exist and be visually inspected. Each direction must state its reference or design logic and one sentence explaining how its form comes from the pixel robot. Any console error, missing asset, distorted image, clipped wordmark, or wrong screenshot dimensions blocks delivery. After the three rendered directions are shown together, stop and wait for the owner's selection. Production Android, iOS, and PWA splash integration is explicitly out of scope until then.
