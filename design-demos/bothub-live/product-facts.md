# Product facts

## Source of truth

IDBots is the local product in this repository. These prototypes use the checked-out source and the running local application as authorities, not external product claims.

- Product name: IDBots, from `src/main/appConstants.ts` and `electron-builder.json`.
- Current surface: BotHub combines an owner-to-Twin chat on the left with Bot Browser on the right.
- Current projector behavior: `docs/design/bot-internet-projector-mode.md` defines one self-contained HTML report per turn, in-place navigation, and browser history for earlier reports.
- Current assistant behavior: `src/main/libs/assistantModePrompt.ts` keeps chat as the textual companion and sends visual outcomes to the projector.
- Current live activity: `src/renderer/components/cowork/AssistantActivityIndicator.tsx` already derives working, thinking, writing, retry, and local-search states from runtime messages.
- Existing structured signals: `src/main/libs/dshKernel/dshEventMapper.ts` maps reasoning blocks, text deltas, tool calls, tool results, and turn completion from DSH events.

## Local sessions inspected read-only

The three requested BotHub browser sessions were found in the local IDBots SQLite database:

1. `你好问候`: greeting, digest, delegation, worker notifications, failure recovery, verification, owner decision, and final projection.
2. `需要你拍板跟进的事项`: local recall, task-board reads, repository checks, MetaWeb evidence, cross-session delegation, independent verification, owner decisions, and report projection.
3. `继续讨论BP并打开大屏幕`: prior-session recall, file operations, report preparation, browser projection, screenshots, click-through verification, and final delivery.

Private contact details, invitation codes, access tokens, full tool arguments, raw reasoning, and full tool results are excluded from the demos. Only anonymized task semantics and already user-visible milestone language are used.

## External visual references

- The user supplied the Siri-like liquid presence reference. A web check found that the newer Siri treatment moved from the old small orb to an edge-based animation, so direction A borrows the idea of a responsive presence without claiming to reproduce Siri.
- Active Theory's official site, https://activetheory.net/, describes a studio combining story, art, and technology. Direction B uses that spatial interactive-design standard as a reference, not as an asset source.
