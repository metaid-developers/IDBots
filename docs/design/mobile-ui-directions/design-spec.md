# IDBots Mobile Chat UI Direction Specification

## Design read and mode

This is a visual overhaul of an existing consumer mobile chat experience, not a production implementation and not a marketing page. The audience is ordinary phone users who want a dependable personal assistant, rather than developers inspecting model, tool, or protocol details. The target is a polished consumer application with the familiarity and physical feedback of an iOS product. The existing information architecture remains recognizable: Chat, Tasks, and Me stay the three top-level destinations. The Twin Bot, yellow brand color, conversational workflow, task results, attachment entry, voice entry, and composer remain meaningful.

The current problem is not a lack of features. The problem is that the interface presents those features as stacked web blocks. Headers, messages, forms, notices, and navigation have similar visual weight, while repeated cards, borders, rectangular buttons, and generic Tailwind spacing make the product feel like a responsive desktop tool. The redesign must create hierarchy, touch comfort, continuity, and a distinctive product personality without hiding essential functionality.

Design dials for the overall exploration: variance 7/10, motion 4/10, density 5/10. Motion is limited to state feedback, sheet transitions, tab selection, and message insertion. There are no perpetual decorative animations, purple gradients, neon glows, or marketing-style hero compositions.

## Audience and usage scenario

The primary scenario is a user holding a phone in one hand and asking their Twin Bot to plan something personal. They should be able to understand the current conversation, notice that the Bot performed useful work, review a result, choose a follow-up, and continue typing without visual effort. Secondary tasks include checking task state and opening the Me section. The interface should feel calm, trustworthy, warm, and finished. It should not feel like an admin console, a model debugging surface, or an AI landing page.

## Shared sample content

All four directions use exactly the same sample content so the comparison is about design rather than copy:

- Conversation title: `Weekend in Hangzhou`.
- Bot name: `Twin Bot`.
- User request: `I want a relaxed two-day trip to Hangzhou this weekend. Tea houses, walking, and no early starts.`
- Assistant answer: `I would keep Saturday around West Lake and save Longjing for Sunday. Here is a calm plan with late starts and time to stop for tea.`
- Meaningful work summary: `I compared tea houses and kept the route compact.`
- Result title: `A slower weekend`.
- Result detail: `West Lake on Saturday, Longjing on Sunday. No alarms required.`
- Result action: `View plan`.
- Follow-up suggestions: `Make it food-focused`, `Add a museum`, `Save as a task`.
- Composer placeholder: `Message Twin`.
- Tabs: `Chat`, `Tasks`, `Me`.

The content is sample data for a design prototype. Do not add fake precision, fake social proof, technical version labels, protocol details, model names, token counts, or decorative metrics.

## Required output and dimensions

Produce four independent high-fidelity HTML files under `design-demos/`:

1. `cupertino.html`: classic iOS consumer chat.
2. `material.html`: a restrained tactile material interpretation.
3. `editorial.html`: content-first quiet composition.
4. `nocturne.html`: immersive dark companion experience.

Each direction is a complete standalone HTML document with inline CSS and JavaScript. It must open directly with `file://`. Brand images must be base64 data URLs. Use React with the provided iOS frame component when practical; a self-contained HTML/CSS/JavaScript implementation is acceptable if it reproduces the supplied iOS frame asset exactly rather than inventing a new status bar, Dynamic Island, home indicator, or bezel. The supplied frame uses a 393×852 logical-pixel screen. Do not manually create alternative iPhone chrome.

Each standalone page presents one interactive phone at actual size, with a small review label and a light/dark appearance control outside the phone. A separate `index.html` will aggregate all four for side-by-side comparison. The main screenshot for each direction should show the whole phone and review label without clipping.

## Shared interaction requirements

- Chat, Tasks, and Me tabs switch to real, simple local screens rather than triggering alerts.
- The main Chat screen is the visual priority. Tasks and Me can be lighter but must use the same design language.
- `View plan` opens a native-feeling detail sheet or detail view with useful sample itinerary content and a working close action.
- A follow-up suggestion inserts or sends that suggestion locally.
- The composer can add a local user message. No network request or fake AI response is needed.
- Attachment and voice controls provide visible local feedback rather than pretending that a native capability completed.
- Include meaningful pressed states, focus states, and a sheet transition. Honor `prefers-reduced-motion`.
- Use icons from the existing Heroicons family or another verified icon library. Do not invent decorative SVG paths or use emoji as interface icons.
- All visible copy defaults to English. Body text is at least 15px and supporting text at least 12px.
- Include semantic color tokens and a working appearance toggle outside the phone. Both appearances must preserve contrast.
- Avoid visible em dashes and en dashes used as separators.
- Add an HTML comment near the top describing assumptions, reasoning, sample-data status, and any placeholders.

## Direction A: Friendly tactile companion

Source logic: constrained interpretation of Friendly Geometric Candy from the design-direction library, adapted to the user's mature iOS requirement. Keep the friendly geometry and physical button feedback, but remove childish candy colors, cartoon decoration, and excessive elevation. The real IDBots pixel icon supplies personality.

Structure: a compact companion header with the real Bot avatar, rounded message groups with one intentionally asymmetric result module, a raised but refined composer accessory, and a bottom tab bar with a tactile selected state. The result module should feel like a useful object the Bot handed to the user, not a dashboard card. Use one yellow accent with cool neutral surfaces. This direction is the warmest and most approachable, but it must not look like a game.

Form origin: the physical sensation of a companion handing over a finished plan. The signature detail is the tactile result module and its pressed/open transition.

## Direction B: Cupertino clarity

Source logic: benchmark migration from Apple's current Human Interface Guidelines and familiar iOS messaging patterns. This is the most native and lowest-risk direction.

Structure: a conventional iOS navigation bar with a text-based conversation back affordance, centered Bot identity, and a trailing new-conversation action. Messages use familiar grouped bubbles and restrained timestamps. The itinerary result is integrated into the assistant turn rather than floating as a separate dashboard widget. The composer sits in a distinct input accessory above a floating or material tab bar. Use material only for navigation and controls, not for every content bubble.

Form origin: the clarity of a well-designed iOS messaging conversation. The signature detail is the precise alignment and separation between transcript, input accessory, and tab bar.

## Direction C: Quiet content editorial

Source logic: a custom reduction exercise inspired by Jony Ive's material honesty and removal of unnecessary interface objects. It is not a serif-driven marketing interpretation. Native sans-serif remains the body face.

Structure: replace some conventional bubbles with full-width assistant reading blocks, use spacing and typography instead of nested containers, and make the user's own messages the clearest yellow objects. The itinerary becomes a typographic plan preview with a strong title and one action. The top chrome is minimal and the bottom navigation can be more text-led than the other directions. It should still feel like a phone app, not a web article, so the composer and tab bar must remain fixed and tactile.

Form origin: a personal note written by someone who knows the user's preferences. The signature detail is the transition from conversational text into a calm, readable plan without adding a heavy card.

## Direction D: Nocturne companion

Source logic: a fourth custom exploration for users who associate a personal assistant with a private, focused, low-light environment. Avoid generic developer dark mode, navy dashboards, cyan glows, and terminal motifs.

Structure: a near-black neutral canvas with a soft elevated transcript region, assistant turns separated by spacing rather than bright panels, warm off-white text, and muted yellow accents. The result is presented as a compact evening itinerary sheet. The composer is a floating capsule with clear separation from the tab navigation. Use depth sparingly and preserve OLED-friendly empty space. Include a light appearance that retains the same structural idea rather than simply inverting colors.

Form origin: the feeling of speaking with a trusted companion late at night. The signature detail is the quiet floating composer and the warm, legible result sheet.

## Form derivation answers

- Narrative role: the screen is the ongoing working conversation, with the itinerary result as the hero object.
- Audience distance: handheld phone use at roughly 25-40cm, so touch targets, short labels, and immediate reading hierarchy matter more than decorative detail.
- Visual temperature: calm, trustworthy, warm, and precise; the dark direction adds privacy and focus.
- Capacity: one user request, one assistant response, one meaningful work summary, one result, three follow-up actions, composer, and three tabs must fit without crowding a 393×852 screen. Secondary detail belongs in a sheet or scrollable transcript.
- Visual motif: the Bot hands the user a usable plan. Each direction expresses that handoff differently: tactile object, integrated message, quiet note, or evening sheet.

## Verification and selection gate

The four directions must be shown together with real screenshots. Test each prototype's tab switching, plan detail opening and closing, follow-up action, local message insertion, and appearance toggle. Check browser console errors, overflow, contrast, and the full phone at screenshot size. After presentation, stop and wait for the user to select, mix, or reject directions. Do not begin production PWA restyling until a direction is explicitly chosen.
