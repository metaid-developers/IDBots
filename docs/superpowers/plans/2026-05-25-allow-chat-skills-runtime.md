# Allow Chat Skills Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow MetaBots to execute local enabled skills in ordinary MetaWeb private chat and group chat according to each bot's `allowChatSkills`, while Boss/owner senders can use all local enabled skills.

**Architecture:** Add one shared chat-skill authorization surface in `SkillManager`, then consume it from the existing private-chat daemon and group-chat cognitive orchestrator. Ordinary senders receive only the intersection of `allow_chat_skills` and locally enabled skills; owner/Boss senders receive all locally enabled skills. Skill execution reuses the existing Cowork Read/Bash skill-turn path and stays outside A2A service/order handling.

**Tech Stack:** Electron main process, TypeScript, sql.js-backed stores, local SKILLs registry, CoworkRunner, Node test runner.

---

### Task 1: Add chat-skill authorization to SkillManager

**Files:**
- Modify: `src/main/skillManager.ts`
- Test: `tests/chatSkillAuthorization.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/chatSkillAuthorization.test.mjs` using the same temp-root pattern as `tests/skillManagerOrderSkillPrompt.test.mjs`.

Cover these cases:
- Owner/Boss gets every local skill where `enabled === true` and `prompt` is non-empty.
- Non-owner gets only allowlisted enabled skills.
- Disabled skills are excluded even if allowlisted.
- Matching supports exact id, dash/underscore id variants, and exact display name.
- Duplicate allowlist entries resolve to one skill id in stable order.

Expected test helper shape:

```js
const ids = manager.resolveChatSkillIds({
  allowChatSkills: ['weather', 'Friendly Skill', 'foo_bar'],
  isOwner: false,
});
assert.deepEqual(ids, ['weather', 'friendly-skill', 'foo-bar']);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run compile:electron && node --test tests/chatSkillAuthorization.test.mjs`

Expected: FAIL because `SkillManager.resolveChatSkillIds(...)` does not exist yet.

- [ ] **Step 3: Implement minimal authorization API**

Add a public method to `SkillManager`:

```ts
resolveChatSkillIds(params: {
  allowChatSkills?: string[] | null;
  isOwner: boolean;
}): string[] {
  const enabled = this.listSkills().filter((skill) => skill.enabled && skill.prompt);
  if (params.isOwner) return enabled.map((skill) => skill.id);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.allowChatSkills ?? []) {
    const skill =
      this.resolveSkillById(raw, enabled) ||
      this.resolveSkillByName(raw, enabled);
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    out.push(skill.id);
  }
  return out;
}
```

Also tighten `buildAutoRoutingPromptForSkillIds(skillIds)` so it builds prompts only from enabled skills with non-empty prompt content. Do not change `buildAutoRoutingPromptForOrderSkill(...)`, because A2A service-order execution is outside this feature.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm run compile:electron && node --test tests/chatSkillAuthorization.test.mjs tests/skillManagerOrderSkillPrompt.test.mjs`

Expected: PASS. The order-skill prompt tests must continue to pass.

---

### Task 2: Pass active skill ids through the Cowork skill-turn bridge

**Files:**
- Modify: `src/main/services/orchestratorCoworkBridge.ts`
- Test: `tests/orchestratorCoworkBridgeSkillIds.test.mjs`

- [ ] **Step 1: Write the failing test**

Create a focused fake runner/store test for `runOrchestratorSkillTurn(...)`.

The fake store should capture:
- `createSession(..., activeSkillIds, metabotId)` receives the active ids.
- The initial user message metadata includes `{ skillIds: activeSkillIds }`.

The fake runner should capture:
- `startSession(...)` receives `skillIds: activeSkillIds`.
- `startSession(...)` receives `disableRemoteServicesPrompt: true`.

- [ ] **Step 2: Run test to verify RED**

Run: `npm run compile:electron && node --test tests/orchestratorCoworkBridgeSkillIds.test.mjs`

Expected: FAIL because the bridge currently creates sessions with `[]` and does not pass skill ids to `startSession`.

- [ ] **Step 3: Implement minimal bridge support**

Extend `RunOrchestratorSkillTurnParams`:

```ts
activeSkillIds?: string[];
sourceChannel?: 'metaweb_group' | 'metaweb_private' | 'orchestrator';
```

Use normalized `activeSkillIds` in:
- `store.createSession(..., activeSkillIds, metabotId ?? null)`
- initial user message metadata
- `runner.startSession(..., { skillIds: activeSkillIds, disableRemoteServicesPrompt: true, ... })`

Keep existing group-chat mapping behavior. Do not create or overwrite `metaweb_private` conversation mappings from this bridge.

- [ ] **Step 4: Run test to verify GREEN**

Run: `npm run compile:electron && node --test tests/orchestratorCoworkBridgeSkillIds.test.mjs`

Expected: PASS.

---

### Task 3: Enable allowChatSkills in group-chat replies without changing the attention gate

**Files:**
- Modify: `src/main/services/cognitiveOrchestrator.ts`
- Modify: `src/main/main.ts`
- Test: `tests/groupChatAllowChatSkillsRuntime.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/groupChatAllowChatSkillsRuntime.test.mjs` against `dist-electron/services/cognitiveOrchestrator.js` after compile.

Test these behaviors through `runTickOnce(...)` with a minimal fake DB:
- Non-Boss mention with `metabot.allow_chat_skills = ['weather']` calls `runSkillTurnViaCowork(...)` with `activeSkillIds: ['weather']` and broadcasts the returned text.
- Non-Boss mention with an empty allowlist does not call `runSkillTurnViaCowork(...)` and uses normal `performChatCompletion(...)`.
- Boss mention calls `runSkillTurnViaCowork(...)` with all ids returned by the injected chat-skill resolver.
- Non-mentioned messages still do not trigger only because they look skill-related. Preserve the existing attention gate.

- [ ] **Step 2: Run test to verify RED**

Run: `npm run compile:electron && node --test tests/groupChatAllowChatSkillsRuntime.test.mjs`

Expected: FAIL because group-chat skill execution is currently restricted to `triggerReason === 'Boss'` and does not read `allow_chat_skills`.

- [ ] **Step 3: Implement group-chat runtime wiring**

Update `MetabotInfo`:

```ts
allow_chat_skills?: string[];
```

Update `OrchestratorOptions`:

```ts
resolveChatSkillIds?: (params: {
  allowChatSkills?: string[] | null;
  isOwner: boolean;
}) => string[];
```

In `runReplyPipeline(...)`:
- Treat `triggerReason === 'Boss'` as owner/Boss for authorization.
- Resolve `chatSkillIds` from `metabot.allow_chat_skills` and `resolveChatSkillIds`.
- Build `skillsPrompt` whenever `chatSkillIds.length > 0`; do not require `triggerReason === 'Boss'`.
- Pass `activeSkillIds: chatSkillIds` to `runSkillTurnViaCowork(...)`.
- Keep normal LLM behavior when `chatSkillIds` is empty.
- Keep the existing attention gate in `tick(...)`: mention/probability/Boss logic only.

In `src/main/main.ts`, include `allow_chat_skills: m.allow_chat_skills ?? []` in the orchestrator metabot view, and pass:

```ts
resolveChatSkillIds: ({ allowChatSkills, isOwner }) =>
  skillMgr.resolveChatSkillIds({ allowChatSkills, isOwner }),
getSkillsPromptForIds: (ids) => skillMgr.buildAutoRoutingPromptForSkillIds(ids),
```

Remove the current `ids.length > 0 ? ids : all skills` fallback from the group-chat options.

- [ ] **Step 4: Run test to verify GREEN**

Run: `npm run compile:electron && node --test tests/groupChatAllowChatSkillsRuntime.test.mjs`

Expected: PASS.

---

### Task 4: Enable allowChatSkills in ordinary private chat only

**Files:**
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/main.ts`
- Test: `tests/privateChatAllowChatSkillsPrompt.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/privateChatAllowChatSkillsPrompt.test.mjs`.

At minimum cover:
- `buildPrivateChatA2ASystemPrompt(...)` without a skills prompt still includes the existing rule that regular private chat must not claim or execute local skills.
- `buildPrivateChatA2ASystemPrompt(...)` with a skills prompt does not include that prohibition, does include `<available_skills>`, and instructs the bot to use only listed skills when they clearly apply.

If practical, also add a small exported helper test proving owner/private-chat policy maps to all skills and non-owner maps to `allow_chat_skills`.

- [ ] **Step 2: Run test to verify RED**

Run: `npm run compile:electron && node --test tests/privateChatAllowChatSkillsPrompt.test.mjs`

Expected: FAIL because the prompt builder cannot accept a skills prompt yet.

- [ ] **Step 3: Implement private-chat runtime wiring**

Extend `buildPrivateChatA2ASystemPrompt(...)`:

```ts
skillsPrompt?: string | null;
```

When `skillsPrompt` is absent, keep the existing no-tools/no-skills rule.

When `skillsPrompt` is present:
- Replace the no-tools/no-skills rule with a constrained local-skill rule.
- Append the provided skills prompt.
- Make it explicit that only listed skills may be used.

Extend `startPrivateChatDaemon(...)` / `processOne(...)` with a small chat skill runtime dependency:

```ts
type PrivateChatSkillRuntime = {
  resolveChatSkillIds(input: { allowChatSkills?: string[] | null; isOwner: boolean }): string[];
  getSkillsPromptForIds(skillIds: string[]): string | null;
  skillsRoots: string[];
  runSkillTurn(input: {
    systemPrompt: string;
    userMessage: string;
    cwd: string;
    metabotId: number;
    activeSkillIds: string[];
    sourceChannel: 'metaweb_private';
  }): Promise<string>;
};
```

In the ordinary private-chat branch only:
- After `autoReplyPolicy` allows a reply, compute `isOwner = autoReplyPolicy.reason === 'owner'`.
- Resolve `chatSkillIds` from `metabot.allow_chat_skills`.
- If `conversationAnalysis.shouldForceBye` is true, keep replying `bye` directly.
- If `chatSkillIds.length > 0`, build the skills prompt and call `runSkillTurn(...)`.
- If no chat skills are authorized, keep the current `performChat(...)` path.
- If the skill turn throws, log it, mark the message processed, and do not fall back to a misleading non-skill answer.

Do not modify:
- `[ORDER]` seller service execution.
- buyer delivery/rating/order protocol handling.
- `PrivateChatOrderCowork`.
- remote service delegation.

In `src/main/main.ts`, pass a private-chat runtime backed by `skillMgr.resolveChatSkillIds(...)`, `skillMgr.buildAutoRoutingPromptForSkillIds(...)`, `skillMgr.getAllSkillRoots()`, and `runOrchestratorSkillTurn(...)`.

- [ ] **Step 4: Run test to verify GREEN**

Run: `npm run compile:electron && node --test tests/privateChatAllowChatSkillsPrompt.test.mjs`

Expected: PASS.

---

### Task 5: Full verification, cleanup, commit, and journal

**Files:**
- Verify all files changed by Tasks 1-4.
- No source files outside this IDBots worktree may be modified.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm run compile:electron
node --test \
  tests/chatSkillAuthorization.test.mjs \
  tests/orchestratorCoworkBridgeSkillIds.test.mjs \
  tests/groupChatAllowChatSkillsRuntime.test.mjs \
  tests/privateChatAllowChatSkillsPrompt.test.mjs \
  tests/skillManagerOrderSkillPrompt.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run build and diff checks**

Run:

```bash
npm run build
git diff --check
git status --short
```

Expected: build succeeds, diff check reports no whitespace errors, and status contains only intentional files.

- [ ] **Step 3: Manual review checklist**

Verify in the diff:
- `allowChatSkills` runtime applies only to ordinary private chat and group chat.
- A2A skill-service/order branches are untouched except shared helper availability.
- Boss/owner gets all enabled skills.
- Non-owner gets only `allow_chat_skills`.
- Group chat attention gate is unchanged.
- Private chat no-skill behavior is unchanged.
- Remote service prompt is disabled for chat skill turns.

- [ ] **Step 4: Commit**

Stage only files changed for this feature and commit:

```bash
git add \
  src/main/skillManager.ts \
  src/main/services/orchestratorCoworkBridge.ts \
  src/main/services/cognitiveOrchestrator.ts \
  src/main/services/privateChatDaemon.ts \
  src/main/main.ts \
  tests/chatSkillAuthorization.test.mjs \
  tests/orchestratorCoworkBridgeSkillIds.test.mjs \
  tests/groupChatAllowChatSkillsRuntime.test.mjs \
  tests/privateChatAllowChatSkillsPrompt.test.mjs \
  docs/superpowers/plans/2026-05-25-allow-chat-skills-runtime.md
git commit -m "feat: allow chat skills in MetaBot chats"
```

- [ ] **Step 5: Post development journal**

After the commit succeeds, post an on-chain development journal using Codex's `metabot-post-buzz` skill, not the repo-local `SKILLs/metabot-post-buzz` implementation. Include the commit hash, changed runtime surfaces, verification commands, and explicit note that A2A service-order flows were left unchanged.
