# IDBots Mobile Task Center Direction Specification

## Design read

This round redesigns the Tasks destination of the IDBots mobile PWA. It is not a production implementation, a new task model, or a visual reskin detached from the desktop product. The recent desktop change makes one unified task the first-class object: there is no user-facing distinction between long-term and standard tasks. A task has a durable goal and state; conversations are the carrier for execution, discussion, review, and decisions around it. The phone must express that relationship clearly rather than presenting the existing stacked Activity and Scheduled tasks sections with a new coat of paint.

The primary user is holding a phone in one hand, often away from the desktop, and wants a fast answer to three questions: what is actively moving, what requires me, and where can I continue the work. The secondary user need is deeper inspection: progress, current subtask, next action, participants, acceptance criteria, evidence, events, and the exact linked conversation. Scheduled work remains available but separate, because a recurring trigger is not the same object as a unified task with a goal and acceptance flow.

The desktop information model is preserved, while the desktop composition is not. Six kanban columns become a mobile status selector and structured lists or flows. The default status is In progress. Needs you remains visibly available as an attention entry so filtering to active execution does not hide an owner decision. No long-term badge, long-term filter, or standard filter appears.

## Shared functional scope

All three directions use the same sample records and expose the same functional inventory:

- A top title area and two secondary tabs: Tasks and Scheduled.
- A default Tasks view focused on In progress, with a visible Needs you entry and counts for the three live states.
- A status selector containing All, In progress, Needs you, Waiting external, Defining, Paused, and Done. Search covers task titles, subtasks, and progress text.
- Task presentation with title, participants, progress, accepted and active and pending counts, current subtask, live progress or waiting reason, next action, updated time, and parent context when relevant.
- Two explicit paths: open task details and open the linked conversation. The conversation path switches to the Chat destination in the local prototype and displays a task-context header so the relationship is visible.
- A task-detail surface with back navigation, goal, overall progress, participants, delegated-acceptance control, pause and resume, complete and cancel actions, ordered subtasks, a selected-subtask acceptance area, evidence, bound-session actions, and events. Verdict and destructive actions are represented as local prototype state changes only.
- New task leads to a chat-draft explanation rather than a separate desktop-style creation form.
- A Scheduled view with Schedules and History, create, enable and disable, run now, edit, delete, next run, last status, and result-session entry points.
- The existing four-item bottom navigation: Chat, Browser, Tasks, and Me. Tasks carries a small critical-attention badge only when a task needs the owner.
- Light and dark appearances, responsive behavior, 44px touch targets, visible focus, and reduced-motion support.

The HTML prototypes may implement local tab, filter, detail, sheet, and appearance interactions to make the design reviewable. They do not call real services or change production code. Sample content is deliberately product-specific and shared across directions so comparison is about hierarchy and flow rather than copy.

## Shared sample tasks

1. `Launch the mobile task center`: In progress, 2 of 5 accepted, current subtask `Compare three mobile task directions`, live note `Comparing one-handed filter and detail flows`, next action `Choose a direction and continue in Studio`.
2. `Publish the November product briefing`: Needs you, 3 of 4 accepted, current subtask `Approve the final briefing`, waiting note `Choose the compact or full changelog before publication`.
3. `Prepare the community weekly digest`: Waiting external, 1 of 3 accepted, current subtask `Collect chain highlights`, next automatic check at 14:30.
4. `Refresh the agent skill catalog`: In progress, 2 of 6 accepted, current subtask `Validate skill manifests`, live note `18 of 26 manifests checked`.
5. `Organize the research notes`: Defining, 0 of 4 accepted, next action `Finish scope and acceptance decisions in chat`.
6. `Migrate legacy task labels`: Paused, 2 of 5 accepted.
7. `Archive the October reports`: Done, 3 of 3 accepted.

The detailed task is `Launch the mobile task center`. Its goal is to let people review active work, make decisions, and return to the exact conversation from a phone. Subtasks cover mapping the desktop model, comparing directions, confirming a direction, implementing the PWA surface, and verifying chat links. Acceptance criteria include keeping all six states reachable, showing active work on entry, and providing a conversation path for every bound task.

## Output format and dimensions

Produce three independent standalone HTML documents under `docs/design/mobile-task-directions/design-demos/`:

1. `now-deck.html`: execution-first focus deck.
2. `native-library.html`: Apple-inspired grouped library and filter model.
3. `task-pulse.html`: continuous task and event flow.

Each file contains inline CSS and JavaScript and base64-embedded brand imagery. It opens with `file://` without a server. The logical mobile viewport is 393×852. On a narrow screen the prototype fills the viewport like a PWA; on desktop a small review header and appearance control surround the same 393×852 screen. A separate `index.html` aggregates the three directions for comparison.

Main screenshots use the actual 393×852 mobile viewport so spacing and density can be judged honestly. Additional captures show task detail and Scheduled where useful. Browser verification covers Tasks and Scheduled switching, status selection, search, task details, linked-chat navigation, appearance switching, overflow, and console errors.

## Direction A: Now Deck

Source logic: the seconds roulette selected style 15, Utility-First Colorful Docs. Its useful DNA is dense information, clear status classification, and functional color. That logic is constrained by the established IDBots consumer direction: no documentation-site sidebar, rainbow decoration, or developer-dashboard vocabulary.

Structure: a compact live-state summary leads into one expanded active-task deck, followed by other active tasks in a more compact stack. The status selector behaves like a bottom-sheet menu. The expanded card makes current work and next action the hero, while the compact cards preserve the same data without repeating a second large composition.

Form origin: the six desktop columns folded into an attention-ordered mobile stack. The signature detail is the transition from a three-state summary into an expanded current-work deck without losing one-handed reach.

## Direction B: Native Library

Source logic: benchmark migration from Apple Human Interface Guidelines and familiar iOS grouped-list navigation. The bottom tab bar remains top-level navigation, the Tasks and Scheduled control is a secondary segmented control, search and status filtering are predictable, and details arrive as a focused full-screen surface.

Structure: large title, segmented control, search field, status menu, then a grouped list with clear section labels. Rows use separators and typography rather than separate floating cards. Scheduled tasks use the same native list grammar. This is the lowest-risk and most directly implementable direction.

Form origin: a well-organized iOS library in which tasks are durable objects rather than notifications. The signature detail is the information-rich row that expands into a complete task without introducing desktop panes.

## Direction C: Task Pulse

Source logic: a bespoke reduction exercise using Jony Ive's material honesty and removal of unnecessary interface objects. The design begins with the task event journal and current subtask rather than a grid of cards. Native sans-serif remains the application face.

Structure: a quiet `Now` header, a minimal state selector, then full-width task chapters connected by a vertical activity rail. Each chapter shows the current step as the dominant content, with progress and actions arranged along the rail. Detail continues the same chronology into subtasks and events. Containers recede; time, state, and current work carry the composition.

Form origin: a task is a continuing line of work across conversations, not a static ticket. The signature detail is the visible connection between current execution, its event history, and the conversation that carries the next action.

## Form derivation answers shared by all directions

- Narrative role: the list is the operational overview; current execution is the hero; detail is the inspection and decision layer; chat is the execution carrier.
- Audience distance: handheld use at roughly 25–40cm. Immediate reading, short labels, and reachable actions take priority over simultaneous columns.
- Visual temperature: calm, capable, warm, and precise. Needs you is urgent without becoming alarming.
- Capacity: the initial 393×852 screen must show the secondary tabs, the active-state context, and at least one complete current-task presentation with a visible path to chat. Secondary metadata moves into detail or expansion rather than shrinking below legibility.
- Visual motif: a task with a live current step and a next action. Every direction derives its composition from that object, not from generic mobile cards or dashboard tiles.

## Review gate

Present all three real HTML directions and their screenshots together. Stop after presentation. The user may select one, mix elements, request revisions, or reject all three. Record the explicit selection in `direction-approved.md` only after that response. Do not modify production PWA task interactions or restyle the application in this round.
