# BotHub live visualization design spec

## Product and audience

IDBots BotHub is a desktop meeting space between a non-technical owner and their TwinBot. The owner writes a request in the existing bottom-left composer. The left transcript remains the precise textual record. The right browser becomes a continuous visual account of what the Twin is doing, who is involved, what has changed, and when the owner needs to decide something.

The target audience is not a developer watching logs. It is an owner who wants confidence, orientation, and a sense of direct presence. The visualization must answer four questions at a glance: did the Twin understand me, what is it doing now, is anyone else involved, and what happens next. Technical tool names, raw arguments, hidden reasoning, and token-level output do not belong on the stage.

## Evidence and content

Three local sessions supply the shared scenarios. A greeting session shows that even a zero-tool turn can have a warm visual beginning and a useful welcome page. A decision session shows local recall, task-board inspection, repository checks, MetaWeb evidence, cross-session delegation, a worker report, independent verification, and four owner decisions. A BP session shows document preparation, browser projection, screenshot inspection, click-through verification, and final delivery.

The three prototypes use the same anonymized events and visible milestone content. They do not invent percentages, elapsed-time promises, completed results, or private data. A waiting state is shown as waiting, not as fake forward progress. A problem is not painted as success.

## Experience goals

1. Presence begins immediately when the owner submits. A deterministic stage acknowledgment appears without waiting for the visualization model.
2. One visual protagonist persists through the whole turn. The Twin core, Twin node, or Twin character morphs and moves instead of being replaced by unrelated scenes.
3. Tools become understandable actions. Local records gather around the Twin, MetaWeb evidence arrives from the network, a worker receives a delegation, evidence returns, and verification forms a visible relationship between claims and proof.
4. The left and right surfaces correspond without duplicating each other. The left carries exact wording. The right carries state, spatial relationships, emphasis, and rhythm.
5. The process does not reload HTML. A persistent stage receives semantic scene patches and animates existing DOM or Canvas elements.
6. The final report remains a curated result page. The live stage reaches a report-ready state, offers an explicit open action, and preserves a frozen final trace for Back.
7. A future setting can disable the generative live stage. The deterministic activity indicator and existing projector continue to work.

## Output format and dimensions

Each direction is a complete interactive HTML prototype at a reference viewport of 1440 by 900 pixels. The same IDBots shell and left transcript appear in all three. The right two-thirds is the design variable. Each file supports scenario selection, play and pause, previous and next event inspection, an Open report action, and a Back to live trace action. Screenshots are captured at the same viewport for comparison. The files also work by direct local opening, with a local HTTP server used only for automated browser verification.

## Direction A: Living Core

Reference logic: real-world benchmark, extending the user's Siri-like presence idea without cloning Siri. A responsive liquid membrane surrounds the real Twin character. The membrane inhales on acknowledgment, draws records inward during research, releases a satellite during delegation, receives a return pulse, and resolves into a calm verified state. Large plain-language captions sit in negative space rather than over the protagonist.

Dials: variance 7, motion 8, density 4. The stage is dark and continuous with the current shell. Yellow is the signature accent. The key question is whether this creates the strongest feeling of talking directly to a living Bot without becoming a screensaver.

## Direction B: Signal Atlas

Reference logic: top-tier custom spatial interaction, using Active Theory's story, art, and technology standard as the design anchor. The task is a map, not a ball. The Twin node travels between owner, sources, MetaWeb, worker, evidence, and report. Camera pans and changes in scale reveal relationships. Delegation is spatial separation, return is a visible path, and verification is convergence.

Dials: variance 8, motion 7, density 6. The stage uses structural lines and meaningful nodes, not a generic particle field. The key question is whether owners understand complex multi-Bot work more clearly here than in the other directions.

## Direction C: Quiet Presence

Reference logic: seconds roulette. The roll was 19 seconds, producing web style 20, Kenya Hara White Gallery. This direction deliberately tests a calm alternative to conventional science-fiction neon. A white-gallery stage gives the pixel Twin physical presence through contact shadows, paper-like layers, large verbs, and precise changes in composition. Motion is slower and fewer elements move, but every transition has a clear cause.

Dials: variance 6, motion 5, density 3. The key question is whether restraint creates a more premium and sustainable everyday experience than continuous spectacle.

## Form derivation

The narrative role is a live companion, not a final infographic. Viewing distance is roughly one meter on a laptop, so current-state headings must remain readable without studying small labels. The emotional register is capable, warm, honest, and future-facing. The content supports at most one protagonist and three active supporting elements per frame. The visual motif comes from the product itself: the pixel Twin is the persistent body, and its relationships with sources, workers, evidence, and the owner are the story. No decorative city, robot face, spacecraft, or invented data visualization is needed.

## Constraints and evaluation

All directions preserve the current brand and left-side workflow. No new frontend dependency is required for the prototypes. Motion uses CSS, Canvas, and the Web Animations model only. Reduced-motion mode removes loops and makes state changes immediate. Body text remains at least 14 pixels and supporting labels at least 12 pixels.

The first evaluation is comparative, not a claim of final perfection. We are looking for the strongest direction or hybrid, the states that feel unclear or excessive, and the perceived difference between watching a Bot work and reading a log. Token cost is addressed in the architecture proposal and must be measured in a later instrumented MVP; these local scripted prototypes make no LLM calls and therefore provide no fake cost measurement.
