# Memory Scope Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the local memory system around explicit owner/contact/conversation scopes so cross-contact memory leakage stops, correct memories are written and recalled in each channel, and the local data model is ready for a later on-chain phase.

**Architecture:** Introduce a scoped memory domain in the main process, migrate existing `user_memories` rows to explicit scope metadata, and route all prompt assembly plus memory CRUD through shared scope-aware helpers. Then update IPC, preload, renderer settings, and tests so every memory entry point uses the same scope rules and the broken `test:memory` baseline becomes a real regression suite.

**Tech Stack:** Electron main process, TypeScript, sql.js SQLite persistence, React renderer, Node built-in test runner (`node --test`), ESLint

---

## Planned File Structure

**Create:**
- `src/main/memory/memoryScope.ts` — scope enums, usage/visibility enums, normalized scope keys, shared scope types
- `src/main/memory/memoryScopeResolver.ts` — resolve read/write scopes from session/channel/contact context
- `src/main/memory/memoryPromptBlocks.ts` — scope-aware prompt block builder for owner/contact/conversation recall
- `tests/memoryScopeResolver.test.mjs` — scope resolution regression coverage
- `tests/memoryMigrationInference.test.mjs` — schema/data migration backfill coverage
- `tests/memoryScopedCrud.test.mjs` — scope-bounded dedupe/list/update/delete/stats coverage
- `tests/memoryScopedRecall.test.mjs` — owner/contact/conversation recall filtering coverage
- `tests/memoryPromptBlocks.test.mjs` — local vs external prompt block coverage
- `tests/privateChatScopedMemory.test.mjs` — regression test proving owner facts do not leak into private chat prompts

**Modify:**
- `package.json` — repair `test:memory` to run the real memory test set
- `src/main/memory/memoryBackend.ts` — add scoped types and scope-aware backend APIs
- `src/main/sqliteStore.ts` — add schema columns/indexes and safe backfill migration helpers
- `src/main/coworkStore.ts` — implement scoped CRUD, migration plumbing, dedupe/delete/list filtering, scoped recall/write helpers
- `src/main/libs/coworkRunner.ts` — replace direct `<userMemories>` assembly with shared scoped prompt blocks and scoped write path
- `src/main/services/privateChatDaemon.ts` — stop manual owner-memory injection and use scoped recall/write helpers
- `src/main/services/orderPromptBuilder.ts` — replace warning-only memory wording with real scoped prompt blocks
- `src/main/services/privateChatOrderCowork.ts` — ensure order sessions persist enough context for scoped conversation writes
- `src/main/services/orchestratorCoworkBridge.ts` — tag group/orchestrator sessions with usable conversation metadata
- `src/main/im/imCoworkHandler.ts` — preserve IM conversation metadata needed by scope resolution
- `src/main/main.ts` — update memory IPC handlers to accept/derive scope
- `src/main/preload.ts` — expose scope-aware memory IPC surface
- `src/renderer/services/cowork.ts` — pass scope input through renderer service methods
- `src/renderer/services/i18n.ts` — add owner/contact/conversation labels and hints
- `src/renderer/types/cowork.ts` — add scope metadata to memory entry and request types
- `src/renderer/types/electron.d.ts` — update preload/electron API typings
- `src/renderer/components/Settings.tsx` — switch memory management from “MetaBot only” to “MetaBot + scope”

## Task 1: Define Scoped Memory Domain

**Files:**
- Create: `src/main/memory/memoryScope.ts`
- Create: `src/main/memory/memoryScopeResolver.ts`
- Modify: `src/main/memory/memoryBackend.ts`
- Test: `tests/memoryScopeResolver.test.mjs`

- [ ] **Step 1: Write the failing scope-resolution test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveMemoryScopes } = await import('../dist-electron/main/memory/memoryScopeResolver.js');

test('metaweb private sessions read contact scope and safe owner operational preferences only', () => {
  const resolved = resolveMemoryScopes({
    metabotId: 7,
    sourceChannel: 'metaweb_private',
    externalConversationId: 'metaweb-private:peer-123',
    peerGlobalMetaId: 'peer-123',
    sessionType: 'a2a',
  });

  assert.equal(resolved.writeScope.kind, 'contact');
  assert.deepEqual(resolved.readScopes.map((scope) => scope.kind), ['contact', 'owner']);
  assert.equal(resolved.allowOwnerOperationalPreferences, true);
});
```

- [ ] **Step 2: Run the resolver test to verify it fails**

Run: `npm run compile:electron && node --test tests/memoryScopeResolver.test.mjs`
Expected: FAIL because `memoryScopeResolver.js` and the new scope API do not exist yet

- [ ] **Step 3: Implement the shared scope domain**

```ts
export type MemoryScopeKind = 'owner' | 'contact' | 'conversation';
export type MemoryUsageClass = 'profile_fact' | 'preference' | 'operational_preference';
export type MemoryVisibility = 'local_only' | 'external_safe';

export interface MemoryScope {
  kind: MemoryScopeKind;
  key: string;
}
```

Implement:
- normalized scope-key builders
- scope-aware read/write resolution
- owner operational-preference gating
- shared types in `memoryBackend.ts` for scope-aware list/create/update/delete calls

- [ ] **Step 4: Run the resolver test to verify it passes**

Run: `npm run compile:electron && node --test tests/memoryScopeResolver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit the scoped-memory domain**

```bash
git add src/main/memory/memoryScope.ts src/main/memory/memoryScopeResolver.ts src/main/memory/memoryBackend.ts
git add -f tests/memoryScopeResolver.test.mjs
git commit -m "feat: add scoped memory resolver"
```

## Task 2: Add Schema Migration and Scoped Storage Semantics

**Files:**
- Modify: `src/main/sqliteStore.ts`
- Modify: `src/main/coworkStore.ts`
- Test: `tests/memoryMigrationInference.test.mjs`
- Test: `tests/memoryScopedCrud.test.mjs`

- [ ] **Step 1: Write the failing migration/backfill and scoped-CRUD tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const { SqliteStore } = await import('../dist-electron/sqliteStore.js');
const { CoworkStore } = await import('../dist-electron/coworkStore.js');

test('legacy memory rows backfill to contact scope when source channel identifies a stable peer', async () => {
  // seed a legacy DB row without scope fields, add a metaweb_private source,
  // run the compatibility/migration path, and assert scope_kind/scope_key were backfilled.
  assert.fail('not implemented');
});

test('dedupe and delete matching stay inside one metabot + scope bucket', async () => {
  assert.fail('not implemented');
});
```

- [ ] **Step 2: Run the migration/storage tests to verify they fail**

Run: `npm run compile:electron && node --test tests/memoryMigrationInference.test.mjs tests/memoryScopedCrud.test.mjs`
Expected: FAIL because scope columns, backfill logic, and scope-bounded CRUD semantics are not implemented

- [ ] **Step 3: Implement schema migration and scoped persistence**

```ts
ALTER TABLE user_memories ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE user_memories ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'owner:self';
ALTER TABLE user_memories ADD COLUMN usage_class TEXT NOT NULL DEFAULT 'profile_fact';
ALTER TABLE user_memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'local_only';
CREATE INDEX IF NOT EXISTS idx_user_memories_scope_status_updated
  ON user_memories(metabot_id, scope_kind, scope_key, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_memories_scope_fingerprint
  ON user_memories(metabot_id, scope_kind, scope_key, fingerprint);
CREATE INDEX IF NOT EXISTS idx_user_memories_usage_visibility
  ON user_memories(metabot_id, usage_class, visibility, status, updated_at DESC);
```

In `CoworkStore`:
- backfill scope metadata idempotently
- infer scope in order: `user_memory_sources` -> session metadata -> conversation mappings -> owner fallback
- special-case `cowork_ui` mappings back to owner scope even though they have a conversation mapping row
- add a dedicated migration marker/version for scoped-memory backfill instead of reusing the legacy `MEMORY.md` import key
- constrain dedupe/delete/list/stats to `metabot_id + scope_kind + scope_key`
- keep legacy wrappers, but make them default to owner scope when no context exists

- [ ] **Step 4: Run the migration/storage tests to verify they pass**

Run: `npm run compile:electron && node --test tests/memoryMigrationInference.test.mjs tests/memoryScopedCrud.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit the migration layer**

```bash
git add src/main/sqliteStore.ts src/main/coworkStore.ts
git add -f tests/memoryMigrationInference.test.mjs tests/memoryScopedCrud.test.mjs
git commit -m "feat: migrate memories to scoped storage"
```

## Task 3: Build Scoped Recall and Prompt Blocks

**Files:**
- Create: `src/main/memory/memoryPromptBlocks.ts`
- Modify: `src/main/coworkStore.ts`
- Modify: `src/main/libs/coworkRunner.ts`
- Test: `tests/memoryScopedRecall.test.mjs`
- Test: `tests/memoryPromptBlocks.test.mjs`

- [ ] **Step 1: Write the failing scoped-recall and prompt-block tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const { rankScopedMemoryEntries } = await import('../dist-electron/main/memory/memoryPromptBlocks.js');
const { buildScopedMemoryPromptBlocks } = await import('../dist-electron/main/memory/memoryPromptBlocks.js');

test('scoped recall excludes owner profile facts from external memory sets', () => {
  const entries = rankScopedMemoryEntries({
    requestChannel: 'metaweb_private',
    ownerEntries: [{ text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' }],
    contactEntries: [{ text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' }],
    currentUserText: 'remember the client prefers English',
  });

  assert.equal(entries.some((entry) => entry.text.includes('Alice')), false);
});

test('external sessions do not include owner profile facts', () => {
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'metaweb_private',
    ownerEntries: [{ text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' }],
    contactEntries: [{ text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' }],
  });

  assert.match(xml, /<contactMemories>/);
  assert.doesNotMatch(xml, /Alice/);
});
```

- [ ] **Step 2: Run the prompt-block test to verify it fails**

Run: `npm run compile:electron && node --test tests/memoryScopedRecall.test.mjs tests/memoryPromptBlocks.test.mjs`
Expected: FAIL because shared recall/prompt-block helpers do not exist yet

- [ ] **Step 3: Implement scoped recall and prompt composition**

```ts
const scopedEntries = memoryBackend.listUserMemoriesForScopes({
  metabotId,
  scopes: resolved.readScopes,
  queryText: currentUserText,
  limitByBlock: { ownerOperationalPreferences: 3, contact: 12 },
});
```

Update `CoworkRunner` so:
- local sessions emit `<ownerMemories>`
- external sessions emit `<contactMemories>` or `<conversationMemories>`
- external sessions may add `<ownerOperationalPreferences>` only for `operational_preference + external_safe`
- generic owner `<userMemories>` injection is removed
- emit structured logs for resolved scope, prompt block composition, and per-block counts

- [ ] **Step 4: Run the prompt-block test to verify it passes**

Run: `npm run compile:electron && node --test tests/memoryScopedRecall.test.mjs tests/memoryPromptBlocks.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit scoped recall and prompt blocks**

```bash
git add src/main/memory/memoryPromptBlocks.ts src/main/coworkStore.ts src/main/libs/coworkRunner.ts
git add -f tests/memoryScopedRecall.test.mjs tests/memoryPromptBlocks.test.mjs
git commit -m "feat: add scoped memory prompt blocks"
```

## Task 4: Route External Memory Writes Through Scoped Context

**Files:**
- Modify: `src/main/coworkStore.ts`
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/services/orderPromptBuilder.ts`
- Modify: `src/main/services/privateChatOrderCowork.ts`
- Modify: `src/main/services/orchestratorCoworkBridge.ts`
- Modify: `src/main/im/imCoworkHandler.ts`
- Modify: `src/main/main.ts`
- Test: `tests/privateChatScopedMemory.test.mjs`

- [ ] **Step 1: Write the failing private-chat regression test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildPrivateReplySystemPrompt } = await import('../dist-electron/services/privateChatDaemon.js');

test('private chat prompt does not inject owner profile facts', () => {
  assert.fail('extract or add a testable helper that returns the private-chat prompt context');
});
```

- [ ] **Step 2: Run the private-chat regression test to verify it fails**

Run: `npm run compile:electron && node --test tests/privateChatScopedMemory.test.mjs`
Expected: FAIL because the current private-chat path still injects raw MetaBot-level memories

- [ ] **Step 3: Implement scoped external write/read behavior**

```ts
const result = await memoryBackend.applyTurnMemoryUpdatesForScope({
  sessionId,
  metabotId,
  resolvedScope,
  userText,
  assistantText,
  implicitEnabled: isStableOneToOneChannel,
});
```

Required changes:
- `privateChatDaemon` stops manually building owner memory context
- `orderPromptBuilder.ts` switches from warning about owner `<userMemories>` to using real scoped block semantics
- direct private chat reads current contact scope plus safe owner operational preferences only
- order/group/shared flows default to conversation scope and explicit-only writes
- IM session setup persists enough metadata to distinguish direct vs group scope resolution instead of defaulting every IM session to local-owner-style `standard`
- session creation/mapping paths preserve enough metadata for later scope resolution
- memory IPC resolves scope instead of just `metabotId`
- scoped write paths emit structured logs for resolved target scope and write-batch counts

- [ ] **Step 4: Run the private-chat regression test to verify it passes**

Run: `npm run compile:electron && node --test tests/privateChatScopedMemory.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit the external-scope integration**

```bash
git add src/main/coworkStore.ts src/main/services/privateChatDaemon.ts src/main/services/orderPromptBuilder.ts src/main/services/privateChatOrderCowork.ts
git add src/main/services/orchestratorCoworkBridge.ts src/main/im/imCoworkHandler.ts src/main/main.ts
git add -f tests/privateChatScopedMemory.test.mjs
git commit -m "fix: scope external memory flows"
```

## Task 5: Update Preload, Renderer APIs, and Memory Management UI

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/services/i18n.ts`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/components/Settings.tsx`

- [ ] **Step 1: Write the failing type/API expectations**

```ts
type MemoryScopeInput = {
  sessionId?: string;
  metabotId?: number;
  scopeKind?: 'owner' | 'contact' | 'conversation';
  scopeKey?: string;
};
```

Add type assertions or renderer-facing tests near the affected modules if lightweight tests are feasible. Otherwise use compile-time failures as the guard for this task.

- [ ] **Step 2: Run compile to verify the new scope fields are missing**

Run: `npm run compile:electron`
Expected: FAIL after adding the new typed API surface to one side only

- [ ] **Step 3: Implement scope-aware renderer and preload surfaces**

```ts
listMemoryEntries(input: MemoryScopeInput & {
  query?: string;
  status?: 'created' | 'stale' | 'deleted' | 'all';
})
```

Update the Settings memory UI so it:
- selects MetaBot and scope
- shows whether the user is editing owner/contact/conversation memory
- routes create/update/delete/list through the current scope
- exposes migrated scoped records clearly enough for manual correction

- [ ] **Step 4: Run compile to verify the UI/API updates pass**

Run: `npm run compile:electron`
Expected: PASS

- [ ] **Step 5: Commit the UI/API layer**

```bash
git add src/main/preload.ts src/renderer/services/cowork.ts src/renderer/services/i18n.ts src/renderer/types/cowork.ts src/renderer/types/electron.d.ts src/renderer/components/Settings.tsx
git commit -m "feat: add scoped memory management ui"
```

## Task 6: Repair `test:memory`, Verify End-to-End, and Finalize

**Files:**
- Modify: `package.json`
- Verify: `tests/memoryScopeResolver.test.mjs`
- Verify: `tests/memoryMigrationInference.test.mjs`
- Verify: `tests/memoryScopedRecall.test.mjs`
- Verify: `tests/memoryPromptBlocks.test.mjs`
- Verify: `tests/privateChatScopedMemory.test.mjs`

- [ ] **Step 1: Update `test:memory` to run the new suite**

```json
{
  "test:memory": "npm run compile:electron && node --test tests/memoryScopeResolver.test.mjs tests/memoryMigrationInference.test.mjs tests/memoryScopedRecall.test.mjs tests/memoryPromptBlocks.test.mjs tests/privateChatScopedMemory.test.mjs"
}
```

- [ ] **Step 2: Run the memory suite**

Run: `npm run test:memory`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Verify observability output is present**

Run: `npm run test:memory`
Expected: PASS and the touched runtime/helpers expose structured scope logs for:
- migration/backfill counts
- resolved read/write scope decisions
- prompt block names/counts
- scoped write-batch totals

- [ ] **Step 5: Review git status and stage only scoped-memory work**

Run: `git status --short`
Expected: only scoped-memory code, tests, and the plan/spec docs are intentionally staged

- [ ] **Step 6: Commit the verification and test-baseline repair**

```bash
git add package.json src/main src/renderer
git add -f tests/memoryScopeResolver.test.mjs tests/memoryMigrationInference.test.mjs tests/memoryScopedRecall.test.mjs tests/memoryPromptBlocks.test.mjs tests/privateChatScopedMemory.test.mjs
git add -f docs/superpowers/specs/2026-03-27-memory-scope-phase1-design.md docs/superpowers/plans/2026-03-27-memory-scope-phase1.md
git commit -m "test: repair scoped memory regression suite"
```

## Verification Checklist

- `npm run compile:electron`
- `npm run test:memory`
- `npm run lint`

## Notes for the Implementer

- `docs/` and `tests/` are currently ignored by `.gitignore`; use `git add -f` for new spec/plan/test files unless the ignore policy is intentionally changed.
- Do not reintroduce generic MetaBot-wide memory recall anywhere. All new read/write paths must go through scope resolution first.
- Preserve upgrade safety: migrations must be idempotent and safe against partially upgraded local DBs.
- Prefer extracting small helpers over growing `coworkStore.ts`, `coworkRunner.ts`, or `privateChatDaemon.ts` further.
