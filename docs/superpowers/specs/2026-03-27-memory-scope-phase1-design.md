# Memory Scope Phase 1 Design

**Date:** 2026-03-27

**Status:** Proposed and user-approved for planning

**Goal:** Eliminate cross-memory leakage in the current memory system, make memory writes and recalls happen in the correct contexts, and lay stable local metadata foundations for a later on-chain memory phase.

## Problem Summary

The current memory system stores and recalls memories primarily at the `metabot_id` level. That creates several correctness problems:

- Different contacts talking to the same MetaBot can see or influence the same recalled memory set.
- Some external conversation paths bypass existing memory isolation assumptions and inject owner memories directly into prompts.
- Memory CRUD and tool paths use a scope model that is too coarse for safe editing.
- Current storage does not explicitly encode ownership, visibility, or intended external safety, which makes a later on-chain phase harder.

The result is a real risk of cross-contact memory leakage, incorrect recalls, and memory writes landing in the wrong domain.

## Phase 1 Scope

Phase 1 is a hardening pass on the local memory system. It does not implement on-chain writes yet.

Phase 1 includes:

- explicit local memory scope modeling
- scoped memory read/write APIs
- migration of existing local memory records into scoped records
- prompt assembly changes for local and external conversations
- UI and tooling changes so memory management reflects the new scope model
- regression coverage for scope resolution, migration, recall filtering, and external prompt safety
- repair of the broken `npm run test:memory` baseline

Phase 1 does not include:

- writing memories on-chain
- syncing memories across devices
- a fully generalized multi-tier memory strategy beyond the minimum needed for safe isolation

## Design Goals

1. Prevent contact A from affecting contact B's recalled memories under the same MetaBot.
2. Keep owner memories available for local cowork sessions.
3. Allow only a small, controlled subset of owner operational preferences to appear in external prompts.
4. Ensure write behavior follows the current conversation context automatically.
5. Keep database migration safe, idempotent, and compatible with upgraded user data.
6. Add durable ownership and visibility metadata needed for a later on-chain phase.

## Recommended Scope Model

Memory becomes a first-class scoped entity instead of a loosely sourced `metabot_id` record.

Each memory record remains attached to a MetaBot, but now also carries an explicit local scope:

- `scope_kind`
  - `owner`
  - `contact`
  - `conversation`
- `scope_key`
  - a normalized stable key within the scope kind
- `usage_class`
  - `profile_fact`
  - `preference`
  - `operational_preference`
- `visibility`
  - `local_only`
  - `external_safe`

`metabot_id` remains part of the record for local bot-level isolation, but it is no longer sufficient by itself for recall, edit, delete, dedupe, or migration decisions.

## Scope Semantics

### Owner Scope

Owner scope represents stable facts and preferences about the local operator.

- default for local `cowork_ui` standard sessions
- readable in local sessions
- not readable in external sessions unless the memory is explicitly marked as `operational_preference + external_safe`

Owner scope uses a stable key:

- `scope_kind = owner`
- `scope_key = owner:self`

### Contact Scope

Contact scope represents stable facts and preferences about a single remote counterpart.

- default for stable 1:1 external conversations
- readable only for that same contact context under the same MetaBot
- safe choice for `metaweb_private`, IM P2P, and similar direct channels with a stable peer identity

Example key:

- `scope_kind = contact`
- `scope_key = metaweb_private:peer:<globalMetaId>`

### Conversation Scope

Conversation scope is the fallback when the system has a stable external conversation identity but not a stable single-contact identity.

- used for order/group/shared contexts that should not collapse into owner scope
- protects against broad leakage when the source is multi-party or identity is weak
- should be treated as narrower than MetaBot scope and separate from owner scope

Example key:

- `scope_kind = conversation`
- `scope_key = metaweb_order:conversation:<externalConversationId>`

## Scope Resolution

Introduce a single resolver component, tentatively `MemoryScopeResolver`, that converts runtime context into:

- the write target scope
- the readable scopes for the current prompt
- the fallback behavior when context is incomplete

Inputs may include:

- `sessionId`
- `metabotId`
- `sourceChannel`
- `externalConversationId`
- `sessionType`
- `peerGlobalMetaId`
- `peerName`

Resolver output should include:

- `writeScope`
- `readScopes`
- `allowOwnerOperationalPreferences`
- trace metadata for logs

### Resolution Rules

1. Local `cowork_ui` standard sessions
- write to `owner`
- read from `owner`
- do not read contact or conversation memories by default

2. Stable direct external conversations
- write to `contact`
- read from current `contact`
- additionally allow a small number of owner memories only when `usage_class = operational_preference` and `visibility = external_safe`

3. Group/order/shared contexts without a stable single peer
- write to `conversation`
- read from current `conversation`
- optionally read safe owner operational preferences

4. Missing or weak context
- default read/write behavior must be conservative
- unresolved legacy calls should default to `owner`
- unresolved external paths must never widen to all memories for a MetaBot

## Prompt Assembly

Phase 1 must stop relying on ad hoc prompt stitching for different call sites.

Replace direct memory injection with a shared prompt builder, tentatively `buildScopedMemoryPrompt(context)`.

### Prompt Blocks

Local sessions:

- `<ownerMemories>`

External sessions:

- `<contactMemories>` or `<conversationMemories>`
- `<ownerOperationalPreferences>`

Rules:

- owner profile facts and long-term owner preferences never go into external prompts
- only `operational_preference + external_safe` owner memories may appear externally
- external sessions must never receive a generic owner `<userMemories>` block

This design replaces the current unsafe pattern where `privateChatDaemon` manually adds a memory block to an `a2a` conversation and bypasses the existing A2A owner-memory protection in `CoworkRunner`.

## Recall Strategy

Recall moves from "latest N memories for this MetaBot" to "scoped and ranked memories for this context."

The recall flow should be:

1. resolve readable scopes
2. query only records in those scopes
3. rank by:
- textual relevance to the current user turn
- explicit memories before implicit memories
- recent use
- update time
4. apply per-block caps

The ranking can stay lightweight in Phase 1. The important part is correct scope filtering before ranking.

## Write Strategy

All writes should go through a shared scoped write path, tentatively `applyScopedTurnMemoryUpdates(context)`.

### Default Write Policy by Source

Local `cowork_ui` standard sessions:

- explicit writes enabled
- implicit writes enabled
- target scope: `owner`

Stable 1:1 external sessions:

- explicit writes enabled
- implicit writes enabled
- target scope: `contact`

Order/group/multi-party/uncertain sources:

- explicit writes enabled
- implicit writes disabled by default
- target scope: `conversation`

### Explicit Commands and Tools

Natural-language commands like "记住这个" and tool calls like `memory_user_edits` should operate on the current writable scope by default:

- local session explicit memory commands write to owner
- direct external session explicit memory commands write to current contact
- group/order explicit memory commands write to current conversation

Phase 1 should not add complex cross-scope editing from chat prompts. Manual scope correction belongs in the UI.

## Data Model Changes

The existing `user_memories` table should be extended with explicit scope metadata.

Add:

- `scope_kind TEXT NOT NULL DEFAULT 'owner'`
- `scope_key TEXT NOT NULL DEFAULT 'owner:self'`
- `usage_class TEXT NOT NULL DEFAULT 'profile_fact'`
- `visibility TEXT NOT NULL DEFAULT 'local_only'`

Add indexes for:

- `(metabot_id, scope_kind, scope_key, status, updated_at DESC)`
- `(metabot_id, scope_kind, scope_key, fingerprint)`
- `(metabot_id, usage_class, visibility, status, updated_at DESC)`

All near-duplicate matching, delete matching, list filtering, stats, and paging should be constrained within:

- `metabot_id + scope_kind + scope_key`

and never run across all memories for the same MetaBot.

## Migration Strategy

Migration must be safe for existing local databases and idempotent across repeated launches.

### Step 1: Schema Migration

- add new columns
- add new indexes
- keep old data readable during transition

### Step 2: Data Migration

Backfill existing memory records with inferred scope metadata using the following order:

1. inspect `user_memory_sources.source_channel + external_conversation_id`
2. inspect `user_memory_sources.session_id` and the linked session metadata
3. inspect `cowork_conversation_mappings`
4. fall back to `owner`

### Backfill Rules

- if a stable peer identity exists, use `contact`
- if only an external conversation identity exists, use `conversation`
- if inference remains uncertain, use `owner`

This deliberately tolerates a small amount of inference error while remaining conservative for uncertain records.

### Usage Class and Visibility Backfill

Backfill should not rewrite memory text.

Instead:

- derive `usage_class` conservatively from the existing text
- set `visibility = external_safe` only for obvious owner operational preferences such as default language, reply format, or output style
- otherwise default to `local_only`

### Legacy Memory Files

Existing `MEMORY.md` / `memory.md` migration should continue, but imported entries should be treated as owner memories by default unless future provenance exists.

## API and Tooling Changes

The memory backend should gain scope-aware operations. Legacy methods can remain temporarily as compatibility wrappers, but they must route into the new scope-aware implementation.

Required capabilities:

- resolve current scope from session context
- list memories by scope
- create/update/delete memories by scope
- build scoped prompt blocks
- apply scoped turn memory updates

`memory_user_edits`, IPC handlers, and renderer services should accept explicit scope input or derive it from session context. Legacy calls that only pass `metabotId` should default to owner scope rather than silently broadening access.

## UI Changes

The Settings memory management area should stop presenting memory as "just this MetaBot."

Phase 1 UI should expose:

- selected MetaBot
- selected memory scope
  - `Owner`
  - `Contact / Current Source`
  - `Conversation` when relevant

The UI should make it clear which scope is being listed, edited, or deleted so users can correct migrated records and manage scoped memories intentionally.

## Logging and Observability

Phase 1 should add structured logs for:

- resolved memory scope for each read/write path
- prompt block composition and counts
- target scope for each write batch
- migration counts by inferred destination

This is required for safe rollout and later debugging.

## Tests

Repair `npm run test:memory` and make it cover the minimum viable regression set:

1. scope resolution tests
2. migration inference tests
3. scoped recall filtering tests
4. prompt block composition tests for local vs external sessions
5. private chat regression tests proving owner facts are not injected into remote prompts

Tests should verify both positive and negative behavior. The negative assertions matter here because the main bug class is leakage.

## Acceptance Criteria

Phase 1 is complete when all of the following are true:

1. Contact-scoped memories no longer leak between different contacts under the same MetaBot.
2. Owner memories are not injected into external prompts except for a tightly limited set of `external_safe` operational preferences.
3. Local cowork sessions still retain useful owner memory write and recall behavior.
4. Direct external sessions can write and recall contact memories correctly.
5. Group/order/shared contexts no longer perform unsafe implicit writes.
6. Memory CRUD, tools, and UI operations are scope-aware and cannot accidentally edit another scope.
7. Existing user data upgrades safely and repeatably.
8. The local data model now stores ownership, scope, usage class, and visibility metadata needed for a future on-chain phase.

## Open Decisions Already Resolved

These decisions were confirmed during design:

- default isolation model is `MetaBot + contact/external source`, with owner memory managed separately
- external conversations may read a small subset of owner operational preferences
- migration should infer scope where possible and fall back to owner when uncertain

## Implementation Notes for Planning

The implementation plan should prioritize:

1. schema and scope resolver
2. scoped storage and migration
3. shared prompt/read/write helpers
4. call-site conversion for `CoworkRunner`, `privateChatDaemon`, order flows, IPC, and tools
5. renderer memory-management updates
6. tests and baseline repair
