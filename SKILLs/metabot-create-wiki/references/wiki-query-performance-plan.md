# Wiki Query Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated wiki skills fast enough for day-to-day querying while improving retrieval quality with an IDBots-decoupled local persistent search index, real configurable embedding generation, persistent vector indexing, vector recall, and hybrid ranking.

**Architecture:** Treat the wiki skills as portable skill bundles, not as IDBots app features. Keep `metabot-create-wiki` as the generator and bundle the former `metabot-llm-wiki` runtime inside `metabot-create-wiki/assets/metabot-llm-wiki-runtime`; generated wiki skills carry their own `runtime/metabot-llm-wiki` copy. The generated wrapper should expose safe defaults for normal use while still preserving a one-command refresh path after users update source documents.

**Tech Stack:** Node.js CommonJS scripts, embedded wiki-runtime JSON/JSONL workspace files, self-contained JSONL/JSON persistent indexes by default, optional SQLite/FTS adapter only if bundled with the skill or available in the agent runtime, configurable embedding provider support, deterministic local hashing fallback for offline tests, persistent vector storage, and existing self-test style under `SKILLs/metabot-create-wiki/scripts/self-test.js`.

---

## Execution Mode

Use **superpowers:subagent-driven-development** for this phase.

- Dispatch one fresh implementer subagent per task.
- After each task, run two review passes:
  - Spec compliance review: must answer `PASS` or `NEEDS_FIX`.
  - Code quality review: must answer `PASS` or `NEEDS_FIX`.
- Do not start implementation on `main` without explicit human confirmation.
- Before creating a branch or worktree, ask the human for explicit confirmation, then create a dedicated local worktree branch from `main` according to this repository's `AGENTS.md` rules.
- Commit each task separately after tests pass and both reviewers pass.
- After every commit, post a development journal with the Codex `metabot-post-buzz` skill.

## Decoupling Requirements

- Do not require IDBots app services, Electron runtime, IDBots package scripts, or the repository root `node_modules` for generated wiki skills to work.
- The generated skill must run from a generic skills root without requiring a separate top-level `metabot-llm-wiki` skill.
- Runtime dependencies must be Node built-ins or files bundled inside the skill directory unless explicitly documented as optional.
- SQLite/FTS is allowed only as an optional adapter if the required module is bundled with the skill or available in the generic agent runtime. The portable default must still provide a persistent lexical index and vector index without SQLite.
- Real embedding generation must not call IDBots services. It must use either files bundled with the skill, a generic local command configured in `wiki.config.json`, or a documented generic local runtime.
- Built-in deterministic hashing is only the zero-dependency fallback for tests and offline operation; it must be reported as `local-hashing-v1`, not disguised as model embedding.
- Tests must include a temporary skills root that copies only the relevant skills, mirroring the current self-test pattern.

## File Structure

- Modify `SKILLs/metabot-create-wiki/assets/metabot-llm-wiki-runtime/scripts/index.js`
  - Add query refresh controls, change-aware index skipping, self-contained persistent lexical indexing, optional SQLite/FTS adapter, embedding provider support, vector indexing, vector recall, and hybrid ranking.
  - Preserve existing payload envelopes and action names.
- Modify `SKILLs/metabot-create-wiki/assets/wiki-skill/scripts/index.js.template`
  - Stop forcing `absorb` before every `query` by default.
  - Add explicit refresh options and pass them through to the runtime.
- Modify `SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js`
  - Generate `wiki.config.json` defaults for query refresh policy and search backend.
- Modify `SKILLs/metabot-create-wiki/SKILL.md`
  - Document the new normal workflow: update raw directory, run `absorb`, query quickly.
- Modify `SKILLs/metabot-create-wiki/scripts/self-test.js`
  - Cover fast query, explicit refresh query, no-change index skip, portable persistent-index query, vector recall, hybrid ranking, stale-index protection, and local publish regressions.

## Task 1: Add Explicit Query Refresh Policy

**Files:**
- Modify: `SKILLs/metabot-create-wiki/assets/wiki-skill/scripts/index.js.template`
- Modify: `SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/self-test.js`

- [ ] **Step 1: Write failing wrapper tests**

Add self-test assertions that:

```js
const fastQueryRes = runNode(runtimeScript, {
  action: 'query',
  payload: { question: 'MetaID 是做什么的？', autoAbsorb: false, minScore: 0.01 },
}, { SKILLS_ROOT: skillsRoot });
assert.equal(fastQueryRes.code, 0);

fs.writeFileSync(path.join(rawSourceDir, 'fresh.md'), '新的资料内容：快速查询不应自动吸收。\\n', 'utf8');
const noRefreshQueryRes = runNode(runtimeScript, {
  action: 'query',
  payload: { question: '新的资料内容', autoAbsorb: false, minScore: 0.01 },
}, { SKILLS_ROOT: skillsRoot });
assert.equal(noRefreshQueryRes.json?.data?.insufficient, true);

const refreshQueryRes = runNode(runtimeScript, {
  action: 'query',
  payload: { question: '新的资料内容', autoAbsorb: true, minScore: 0.01 },
}, { SKILLS_ROOT: skillsRoot });
assert.equal(refreshQueryRes.json?.success, true);
assert.equal(refreshQueryRes.json?.data?.insufficient, false);
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
```

Expected: FAIL because current wrapper always absorbs before query.

- [ ] **Step 3: Implement wrapper policy**

In `index.js.template`, change the `query` branch:

```js
case 'query':
  if (baseInput.payload.autoAbsorb === true || baseInput.payload.refresh === true) {
    runRuntime(
      runtimeScript,
      buildActionPayload({ ...baseInput, action: 'absorb' }, config, workspaceRoot, registryHome)
    );
  }
  return runRuntime(runtimeScript, buildActionPayload(baseInput, config, workspaceRoot, registryHome));
```

Generated defaults should set:

```json
{
  "queryAutoAbsorb": false
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
PYTHONPATH=/tmp/codex-pyyaml-qPYM9j /Users/tusm/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 SKILLs/skill-creator/scripts/quick_validate.py SKILLs/metabot-create-wiki
```

Expected: self-test passed; skill valid.

- [ ] **Step 5: Commit**

```bash
git add SKILLs/metabot-create-wiki/assets/wiki-skill/scripts/index.js.template SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js SKILLs/metabot-create-wiki/scripts/self-test.js
git commit -m "feat: add explicit wiki query refresh policy"
```

## Task 2: Skip Re-index When Raw Files Did Not Change

**Files:**
- Modify: `SKILLs/metabot-llm-wiki/scripts/index.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/self-test.js`

- [ ] **Step 1: Write failing runtime test**

Extend self-test to run `absorb` twice without changing raw files and assert the second run reports no index rebuild:

```js
const firstAbsorb = runNode(runtimeScript, { action: 'absorb' }, { SKILLS_ROOT: skillsRoot });
assert.equal(firstAbsorb.json?.success, true);

const secondAbsorb = runNode(runtimeScript, { action: 'absorb' }, { SKILLS_ROOT: skillsRoot });
assert.equal(secondAbsorb.json?.success, true);
assert.equal(secondAbsorb.json?.data?.index?.skipped, true);
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
```

Expected: FAIL because `actionIndex` currently rewrites chunks/index every time.

- [ ] **Step 3: Implement no-change index skip**

In `actionIngest`, include `changed` in returned data:

```js
const hasVersionChange = docsNew + docsUpdated + docsRemoved > 0;
...
data: { ..., changed: hasVersionChange }
```

In `actionAbsorb`, skip `actionIndex` when ingest reports no changes and `input.payload.forceIndex !== true`:

```js
let indexResult = null;
if (ingestResult.data.changed || input.payload.forceIndex === true) {
  const stateAfterIngest = loadState(paths, input.kbId);
  indexResult = actionIndex({ ...input, payload: { mode: 'incremental' } }, paths, stateAfterIngest);
} else {
  indexResult = {
    message: 'Index skipped',
    data: { skipped: true, reason: 'No raw document changes detected.', kbVersion: state.kbVersion },
    warnings: [],
    metrics: { elapsedMs: 0 },
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
```

Expected: self-test passed.

- [ ] **Step 5: Commit**

```bash
git add SKILLs/metabot-llm-wiki/scripts/index.js SKILLs/metabot-create-wiki/scripts/self-test.js
git commit -m "feat: skip unchanged wiki index rebuilds"
```

## Task 3: Add Portable Persistent Search Backend

**Files:**
- Modify: `SKILLs/metabot-llm-wiki/scripts/index.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/self-test.js`

- [ ] **Step 1: Write decoupling guard test**

The self-test must run in a temporary skills root without relying on the IDBots repository root. Do not set `NODE_PATH` to the repo `node_modules` for this test path. The generated skill must still ingest, index, and query.

```js
const portableEnv = { SKILLS_ROOT: skillsRoot, NODE_PATH: '' };
const portableAbsorbRes = runNode(runtimeScript, { action: 'absorb', payload: { forceIndex: true } }, portableEnv);
assert.equal(portableAbsorbRes.code, 0, portableAbsorbRes.stderr || portableAbsorbRes.stdout);
```

Expected: FAIL if the implementation accidentally depends on IDBots root packages.

- [ ] **Step 2: Write failing persistent-index tests**

Add tests that verify a persistent portable index is written and query uses it:

```js
const indexRes = runNode(runtimeScript, { action: 'absorb', payload: { forceIndex: true } }, { SKILLS_ROOT: skillsRoot });
assert.equal(indexRes.json?.success, true);
assert.ok(fs.existsSync(path.join(generatedConfig.workspaceRoot, 'index', 'lexical-postings.json')));

const indexedQueryRes = runNode(runtimeScript, {
  action: 'query',
  payload: { question: '合同违约', autoAbsorb: false, searchBackend: 'portable', minScore: 0.01 },
}, { SKILLS_ROOT: skillsRoot });
assert.equal(indexedQueryRes.json?.success, true);
assert.equal(indexedQueryRes.json?.data?.query?.searchBackend, 'portable-lexical');
assert.ok(indexedQueryRes.json?.metrics?.candidateChunks < indexRes.json?.data?.index?.chunkCount);
```

- [ ] **Step 3: Implement portable persistent index writing**

During `actionIndex`, write:

```text
workspace/index/lexical-postings.json
workspace/index/chunk-store.json
```

The portable index must store:

```json
{
  "generatedAt": "iso",
  "chunkCount": 10,
  "docCount": 3,
  "postings": {
    "合同": [{ "chunkId": "doc_x#c1", "tf": 2 }],
    "违约": [{ "chunkId": "doc_x#c1", "tf": 1 }]
  },
  "docFreq": { "合同": 1 }
}
```

`chunk-store.json` must map `chunkId` to the citation data needed for query results. This avoids scanning every chunk body for normal lexical search.

- [ ] **Step 4: Add optional SQLite/FTS adapter without coupling**

If a SQLite module is available inside the skill/runtime, write `workspace/index/search.sqlite` as an additional optimization. If no module is available, continue with the portable JSON index and report `searchBackend: "portable-lexical"`.

- [ ] **Step 5: Implement query path selection**

In `actionQuery`, choose:

```js
const searchBackend = safeTrim(input.payload.searchBackend) || config.searchBackend || 'auto';
```

Use portable persistent search by default. Use SQLite/FTS only when available and requested or selected by `auto`. Fall back to current `scoreChunks(question, chunks, hybridAlpha)` only when index files are missing or disabled. The query response must report:

```js
data.query.searchBackend = 'portable-lexical' // or 'sqlite-fts'
metrics.candidateChunks = rows.length
metrics.totalChunks = chunks.length
```

- [ ] **Step 6: Run tests**

Run:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
```

Expected: self-test passed, portable index files exist, and query response reports a persistent backend in `data.query.searchBackend`.

- [ ] **Step 7: Commit**

```bash
git add SKILLs/metabot-llm-wiki/scripts/index.js SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js SKILLs/metabot-create-wiki/scripts/self-test.js
git commit -m "feat: add portable wiki search index"
```

## Task 4: Add Embedding Provider Support And Persistent Vector Index

**Files:**
- Modify: `SKILLs/metabot-llm-wiki/scripts/index.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/self-test.js`

- [ ] **Step 1: Write failing vector index tests**

Add tests that verify a vector index is written and vector query returns expected citations:

```js
const vectorIndexPath = path.join(generatedConfig.workspaceRoot, 'index', 'vectors.json');
assert.ok(fs.existsSync(vectorIndexPath));
const vectorIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8'));
assert.equal(vectorIndex.provider, 'local-hashing-v1');
assert.ok(vectorIndex.dimension >= 128);
assert.ok(vectorIndex.vectors.length > 0);

const vectorQueryRes = runNode(runtimeScript, {
  action: 'query',
  payload: { question: '身份 内容 索引', autoAbsorb: false, searchBackend: 'vector', minScore: 0.01 },
}, { SKILLS_ROOT: skillsRoot });
assert.equal(vectorQueryRes.json?.success, true);
assert.equal(vectorQueryRes.json?.data?.query?.searchBackend, 'vector');
assert.ok(vectorQueryRes.json?.data?.citations?.length > 0);
```

- [ ] **Step 2: Add configurable embedding provider interface**

Add provider selection:

```json
{
  "embeddingEnabled": true,
  "embeddingProvider": "local-hashing-v1",
  "embeddingModel": "local-hashing-v1",
  "embeddingCommand": ""
}
```

Supported providers for this phase:

- `local-hashing-v1`: built-in zero-dependency fallback.
- `command-json-v1`: optional generic local command that receives JSON `{ "texts": [...] }` on stdin and returns `{ "vectors": [[...]] }` on stdout. This is how users can plug in a real local embedding model without coupling the skill to IDBots.

- [ ] **Step 3: Implement deterministic local hashing fallback**

Add a local embedding provider that is deterministic, offline, and suitable for tests:

```js
function embedTextLocalHashing(text, dimension = 256) {
  const tokens = tokenize(text);
  const vector = new Array(dimension).fill(0);
  for (const token of tokens) {
    const digest = crypto.createHash('sha256').update(token).digest();
    const bucket = digest.readUInt32BE(0) % dimension;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  return normalizeVector(vector);
}
```

This must be persisted and reported as `local-hashing-v1`. It is the portable fallback, not a substitute name for real model embeddings.

- [ ] **Step 4: Implement command-json-v1 embedding provider**

When `embeddingProvider: "command-json-v1"` and `embeddingCommand` is configured, spawn the command with JSON stdin:

```json
{ "model": "configured-model-name", "texts": ["chunk text"] }
```

Expect JSON stdout:

```json
{ "vectors": [[0.1, 0.2, 0.3]] }
```

Validate vector dimensions, normalize vectors before storage, and fail with a clear `embedding_failed` error if the command fails.

- [ ] **Step 5: Persist vectors during indexing**

Write:

```text
workspace/index/vectors.json
```

with:

```json
{
  "provider": "local-hashing-v1",
  "model": "local-hashing-v1",
  "dimension": 256,
  "vectors": [
    {
      "chunkId": "doc_x#c1",
      "docId": "doc_x",
      "sourcePath": "raw/a.md",
      "docTitle": "a",
      "vector": [0, 0.12, -0.2]
    }
  ]
}
```

- [ ] **Step 6: Implement vector recall**

In `actionQuery`, when `searchBackend` is `vector` or `hybrid`, load `vectors.json`, embed the query using the same local provider, compute cosine similarity, and return top candidates.

- [ ] **Step 7: Run tests**

Run:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
```

Expected: vector index exists and vector query returns citations.

- [ ] **Step 8: Commit**

```bash
git add SKILLs/metabot-llm-wiki/scripts/index.js SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js SKILLs/metabot-create-wiki/scripts/self-test.js
git commit -m "feat: add local wiki vector index"
```

## Task 5: Add Hybrid Ranking And Quality Fixtures

**Files:**
- Modify: `SKILLs/metabot-llm-wiki/scripts/index.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/self-test.js`

- [ ] **Step 1: Write quality regression tests**

Add fixtures with Chinese multi-character terms and exact phrases:

```js
fs.writeFileSync(path.join(rawSourceDir, 'legal.md'), '合同违约责任包括继续履行、采取补救措施或者赔偿损失。\\n', 'utf8');
...
const legalQueryRes = runNode(runtimeScript, {
  action: 'query',
  payload: { question: '合同违约责任', autoAbsorb: true, searchBackend: 'hybrid', minScore: 0.01 },
}, { SKILLS_ROOT: skillsRoot });
assert.equal(legalQueryRes.json?.data?.citations?.[0]?.sourcePath?.endsWith('legal.md'), true);
assert.equal(legalQueryRes.json?.data?.query?.searchBackend, 'hybrid');
```

- [ ] **Step 2: Add phrase-aware scoring**

Keep current tokenizer as fallback, but add phrase and bigram boosts:

```js
const phraseBoost = chunk.text.includes(question) ? 1 : 0;
const cjkBigramBoost = countSharedCjkBigrams(question, chunk.text);
score = score + phraseBoost + cjkBigramBoost * 0.05;
```

- [ ] **Step 3: Implement hybrid scoring**

Combine portable lexical score, phrase score, and vector cosine:

```js
score = lexicalWeight * lexicalScore
  + vectorWeight * vectorScore
  + phraseWeight * phraseScore;
```

Default weights:

```json
{
  "searchBackend": "hybrid",
  "embeddingEnabled": true,
  "embeddingProvider": "local-hashing-v1",
  "embeddingModel": "local-hashing-v1",
  "lexicalWeight": 0.55,
  "vectorWeight": 0.35,
  "phraseWeight": 0.10
}
```

Do not leave embedding as a placeholder. Query responses must include `data.query.vectorProvider` and `metrics.vectorCandidates` when hybrid/vector mode is used.

- [ ] **Step 4: Run tests**

Run:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
```

Expected: quality fixture returns the correct citation first and query response reports `searchBackend: "hybrid"`.

- [ ] **Step 5: Commit**

```bash
git add SKILLs/metabot-llm-wiki/scripts/index.js SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js SKILLs/metabot-create-wiki/scripts/self-test.js
git commit -m "feat: add hybrid wiki retrieval ranking"
```

## Task 6: Update Skill Interaction Guidance

**Files:**
- Modify: `SKILLs/metabot-create-wiki/SKILL.md`
- Modify: generated `SKILL.md` template in `SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js`
- Modify: `SKILLs/metabot-create-wiki/scripts/self-test.js`

- [ ] **Step 1: Update creator skill guidance**

Document the new workflow:

```markdown
- 日常查询默认不重建索引。
- 用户把新资料放进 rawSourceDir 后，先运行 `absorb`。
- 如果用户明确要求“边更新边查”，query 可传 `autoAbsorb:true`。
```

- [ ] **Step 2: Update generated skill text**

Generated `SKILL.md` should say:

```markdown
资料更新流程：
1. 把文件放进绑定的 rawSourceDir。
2. 运行 `absorb` 刷新索引。
3. 再运行 `query` 快速查询。
```

- [ ] **Step 3: Assert generated docs mention workflow**

In self-test, read generated `SKILL.md` and assert it mentions `autoAbsorb` and `absorb`.

- [ ] **Step 4: Run validation**

Run:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
PYTHONPATH=/tmp/codex-pyyaml-qPYM9j /Users/tusm/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 SKILLs/skill-creator/scripts/quick_validate.py SKILLs/metabot-create-wiki
```

Expected: self-test passed; skill valid.

- [ ] **Step 5: Commit**

```bash
git add SKILLs/metabot-create-wiki/SKILL.md SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js SKILLs/metabot-create-wiki/scripts/self-test.js
git commit -m "docs: document wiki refresh workflow"
```

## Final Verification

- [ ] Run full self-test:

```bash
node SKILLs/metabot-create-wiki/scripts/self-test.js
```

- [ ] Run skill validation:

```bash
PYTHONPATH=/tmp/codex-pyyaml-qPYM9j /Users/tusm/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 SKILLs/skill-creator/scripts/quick_validate.py SKILLs/metabot-create-wiki
```

- [ ] Run a manual generated-skill smoke test:

```bash
TMP_ROOT="$(mktemp -d)"
mkdir -p "$TMP_ROOT/raw" "$TMP_ROOT/SKILLs"
printf 'MetaID 资料用于身份和内容索引。\\n' > "$TMP_ROOT/raw/metaid.txt"
SKILLS_ROOT="$TMP_ROOT/SKILLs" node SKILLs/metabot-create-wiki/scripts/scaffold-wiki-skill.js --payload "{\"skillName\":\"metaid-fast-wiki\",\"title\":\"MetaID Fast Wiki\",\"description\":\"快速 MetaID wiki\",\"rawSourceDir\":\"$TMP_ROOT/raw\",\"targetRoot\":\"$TMP_ROOT/SKILLs\"}"
SKILLS_ROOT="$TMP_ROOT/SKILLs" node "$TMP_ROOT/SKILLs/metaid-fast-wiki/scripts/index.js" --payload '{"action":"absorb"}'
SKILLS_ROOT="$TMP_ROOT/SKILLs" node "$TMP_ROOT/SKILLs/metaid-fast-wiki/scripts/index.js" --payload '{"action":"query","payload":{"question":"MetaID","autoAbsorb":false,"minScore":0.01}}'
```

- [ ] Verify one-step search optimization deliverables:

```bash
node - <<'NODE'
const fs = require('node:fs');
const root = process.argv[1];
for (const rel of ['index/lexical-postings.json', 'index/chunk-store.json', 'index/vectors.json']) {
  const abs = `${root}/${rel}`;
  if (!fs.existsSync(abs)) throw new Error(`missing ${abs}`);
  console.log(`ok ${abs}`);
}
NODE "$TMP_ROOT/SKILLs/metaid-fast-wiki/workspace"
```

- [ ] Request subagent review with a strict `PASS` or `NEEDS_FIX` verdict.

- [ ] Post development journal with `metabot-post-buzz`.

- [ ] Commit final verification/docs cleanup if needed.
