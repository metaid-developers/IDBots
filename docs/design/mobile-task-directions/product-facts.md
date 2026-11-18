# Product Facts

## IDBots task model verified in the local repository

- The current desktop task board is implemented in `src/renderer/components/longTermTasks/LongTermTasksBoard.tsx`. Its legacy internal names do not define the mobile UI vocabulary.
- A task is a first-class entity with a goal, participants, ordered subtasks, acceptance criteria, evidence, events, and linked sessions. Conversations carry execution and decisions around the task.
- The desktop board exposes six columns: Needs you, In progress, Waiting external, Defining, Paused, and Done.
- Desktop cards expose participants, accepted and active and pending counts, progress, the current subtask, live progress, the next action, and timestamps. Parent and child task relationships are supported.
- Desktop details expose task stage controls, delegated acceptance, a goal and plan artifact, subtasks, selected-subtask acceptance and evidence, bound sessions, owner verdicts, and an event stream.
- Task creation and definition edits intentionally lead to a conversation rather than a separate task-authoring form.
- Scheduled tasks remain a separate management surface with schedules, enable and disable, run now, edit, delete, run history, and result-session links.
- The current mobile client already reads the same task board and can open a bound session. Its Tasks screen currently stacks Activity and results above Scheduled tasks.
- The current mobile bottom navigation has four destinations: Chat, Browser, Tasks, and Me.

## Existing mobile design context

- The previously approved mobile direction is Nocturne, with both dark and light appearances. It favors quiet surfaces, native typography, floating navigation, restrained yellow accents, and consumer-friendly presentation.
- The current mobile theme uses brand yellow `#FFDC51`, neutral surfaces, and at least 44-pixel primary touch targets.

## Verified external reference

- Apple Human Interface Guidelines, Tab bars: https://developer.apple.com/design/human-interface-guidelines/tab-bars
- Apple describes tab bars as navigation between top-level sections, recommends short visible labels, and permits badges for critical information. The Tasks and Scheduled control in this design is therefore a secondary segmented control, while the existing four-item bottom tab bar remains the top-level navigation.

## Scope facts

- This round produces design prototypes only. It does not modify the production PWA, gateway, IPC contracts, native shell, or task business logic.
- All task names, records, timestamps, and conversation content in the prototypes are sample design data, not live user data.

Verified against branch `feat/mobile-pwa-task-designs`, based on `main` commit `9b0f47b4a`, and the Apple documentation above on 2026-11-19.
