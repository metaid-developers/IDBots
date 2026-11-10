# Direction approval

## Initial options shown

At commit `582be6b9`:

- A: `screenshots/living-core.png`
- B: `screenshots/signal-atlas.png`
- C: `screenshots/quiet-presence.png`

The same paths are updated by this selected iteration; the initial versions remain available in that commit.

## Owner selection

The owner selected a hybrid of A and B:

> 我是倾向 A+B，碰到分发任务或是长期任务中有很多步骤等等，这些有关系的有结构的那一些任务的时候，就采用更像 B 的形式。

The owner also supplied the liquid-glass reference:

> 另外关于 A的动态效果是我是希望看看能不能融合一下这个效果：https://github.com/LerSent001/orb 就是一个liquid glass orb的效果，这个效果非常有代入感。

The agreed direction is one persistent stage, not two pages. A carries ordinary conversation and unstructured activity. B appears as structured relationships emerge, including delegation, multi-Bot coordination, long-term dependencies, and evidence graphs. The orb remains the Twin's continuous body while the topology expands around it and collapses after the structured work settles.

## Avatar clarification

The owner asked whether the orb shows the current conversation Bot's Avatar. The first prototypes used the generic official TwinBot character, not the actual current Bot Avatar. The corrected contract is:

- Use the active conversation Bot's Avatar inside the liquid glass presence and in the transcript.
- The prototype uses the local `AI_Sunny` JPEG extracted read-only from the current Twin profile at `assets/current-twin-avatar.jpg`.
- Fall back to `assets/twinbot.png` only when the active Avatar cannot be loaded.
- Never substitute another Bot's Avatar when switching between Twin and worker nodes.

## Reference license

`https://github.com/LerSent001/orb` is MIT licensed, copyright 2026 LerSent001. The WGSL shader and license are vendored in `shared/liquid-orb-effect.wgsl` and `shared/liquid-orb-LICENSE.txt`. The renderer integration is adapted to the IDBots scene-patch model. Brand colors, Avatar identity, topology transitions, deterministic fallback, and reduced-motion behavior remain host-controlled.
