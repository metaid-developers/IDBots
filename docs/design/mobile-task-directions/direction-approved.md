# Direction Approval

## Presented directions

- Direction A: Now Deck, `design-demos/now-deck.html`, `screenshots/now-deck.png`.
- Direction B: Native Library, `design-demos/native-library.html`, `screenshots/native-library.png`.
- Direction C: Task Pulse, `design-demos/task-pulse.html`, `screenshots/task-pulse.png`.
- Combined overview: `index.html`, `screenshots/overview.png`.
- Additional review captures include each direction's task detail, linked chat, Scheduled view, and dark appearance under `screenshots/`.

## User selection

The user selected a mixed direction on 2026-11-19:

> C有点太复杂了，我觉得是B 的列表＋A 的当前步骤卡比较合适
> 然后合并设计分支，开始新分支实施‘B 的列表＋A 的当前步骤卡’ 这个方案，注意要做好深色浅色模式，以及 i18n

## Approved implementation scope

- Use Direction B's native grouped-list information architecture, search, status menu, secondary Tasks and Scheduled tabs, and focused task-detail surfaces.
- Use Direction A's expanded current-step card treatment for the leading active task, with compact treatments for subsequent list rows.
- Default to In progress while keeping Needs you visible.
- Do not adopt Direction C's timeline presentation.
- Preserve direct paths to task details and the bound conversation.
- Implement complete light and dark appearances using the mobile theme tokens.
- Implement English and Chinese UI copy through the mobile i18n service.
- Merge the design branch, then implement from a fresh branch based on the updated `main`.
