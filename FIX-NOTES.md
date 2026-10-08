# FIX-NOTES: 做梦管线超时成片失败（fix/dream-consolidation-timeout）

- 分支：`fix/dream-consolidation-timeout`，基于 fork（WuFenG-Hub/IDBots）最新 main `9d221ac9`（"Merge branch 'fix/mac-x64-artifact-naming'"）。
- 范围：只改做梦管线（dreamService / dreamRetryPolicy / dreamPrompt 调度侧 / dreamStore 读径一行 / main.ts UI 下一行）。不 push、不建 PR（Mon 验收后执行）。

## 1. 根因（对齐 Mon 尸检）

1. **固定超时过窄**：`dreamService.ts` 的合成/自认调用固定 `DREAM_SYNTHESIS_TIMEOUT_MS = 600_000`（10 分钟，此前为 180s），而深度合并调用实测合法耗时 8–38 分钟（30K+ token 提示 + flash 档 ~20-25 tok/s 出全量梦 JSON）。爆量日合法调用撞墙，`The operation was aborted due to timeout` 成片出现（10-07 周期 4/7 failed）。
2. **无原地退避**：重试在 run 内/窗口内原地对同一饱和 provider 连撞；失败运行时长清一色钉在 30 分钟（=run 级总预算被超时切片耗尽的形态特征）。
3. **终态过早**：重试预算（`DREAM_RETRY_MAX_ATTEMPTS = 5`）耗尽后超时类失败与确定性 4xx 同判 `terminal-failed`——超时本质是「窗口太小/换窗口可解」，不应终态。

## 2. 改动

### `src/main/libs/dreamRetryPolicy.ts`（新增策略层，不动 classifyDreamError 语义）
- `DREAM_ATTEMPT_TIMEOUT_TIERS_MS = [10min, 20min, 38min]` + `resolveDreamAttemptTimeoutMs(attemptCount)`：按 run 的 attemptCount 自适应升级单次调用窗口；38 分钟顶档按实测最坏合法调用取整，再慢即真卡死、应中止。
- `DREAM_RUN_BUDGET_MS = 30min` + `DREAM_MIN_CALL_WINDOW_MS = 10min` + `remainingRunBudgetMs()`：run 级墙。剩余预算不足以让一次合法全量调用**开工**时，直接以可重试哨兵把日期交还调度器跨窗口再试，而不是在本 run 内再排一场注定超时的调用。
- `isRateLimitError()`（锚定 `LLM request failed: <status>` 透传 + rate-limit 文案）、`isTimeoutError()`（`aborted due to timeout` 文案 / `TimeoutError` name / run 预算哨兵）。
- `computeDreamBackoffDelayMs()`：指数退避阶梯 **2/5/15 分钟**；429/限流或连续超时（≥2 次）拉长到 **≥10 分钟**（`DREAM_BACKOFF_RATE_LIMIT_FLOOR_MS`）。

### `src/main/services/dreamService.ts`
- 合成与自认调用窗口改为 `resolveSynthesisTimeoutMs(runStartedAtMs, attemptCount)`：尝试档位 ∩ 剩余 run 预算（下限 60s）；剩余 < 10 分钟时抛可重试哨兵 `dream run budget exhausted …`（保留 fallback 路径行为不变——per-attempt 窗口仍走 llmFallback 的 primary→fallback 双窗）。
- catch 分支：超时类失败（含预算哨兵）**永不 terminal-failed**，无论 attemptCount 是否 ≥ 上限——跨窗口保留「待重试」；确定性 4xx 的 H-80 终态语义原样保留。
- 片段调用仍用 lean 默认（`DREAM_LLM_TIMEOUT_MS = 180s`，实测每片 ≤80s），`DREAM_SYNTHESIS_TIMEOUT_MS` 常量保留为第一档锚点（测试/外部接线兼容）。

### `src/main/libs/dreamPrompt.ts`（调度侧）+ `src/main/dreamStore.ts` + `src/main/main.ts`
- `computeDreamRetryDelayMs(attemptCount, lastError?)` 改骑新阶梯（旧实现为 30min 基数、6h 封顶，跨窗口等太久且与 2/5/15 要求冲突）；带 lastError 时按限流/连续超时升级 ≥10min。旧常量 `DREAM_RETRY_BASE_DELAY_MS / MAX_DELAY_MS` 保留导出（兼容）。
- `DreamRunStateLike` 增加 `error?`；`dreamStore.getRunStates` SELECT 增加 `error` 列；`computeDueDreamDates` 把错误文本喂给退避计算。
- `main.ts` dream-failure-fallback 的 `nextRetryAt` 同步传 `run.error`（DreamRun 本就带 error 字段，无 schema 改动）。

### 未改动但相关（披露）
- `memoryHygieneService.ts` 的 `DEEP_CONSOLIDATION_LLM_TIMEOUT_MS` 同为 600s 固定值，属同一症状族；本单授权范围是做梦管线，未动它。若 10-07 的 "unparseable output (30k+)" 侧仍复发，建议下一单按同一档位机制对齐。

## 3. 测试证据

- 更新 3 个断言旧 30min 基线的既有用例（dreamPrompt.test.mjs ×2、dreamRetryPolicy.test.mjs ×1），预期值改为新阶梯，注释标明变更原因。
- 新增用例：
  - `dreamRetryPolicy.test.mjs`：档位函数（1→600s/2→1200s/≥3→2280s/垃圾值归一）、`remainingRunBudgetMs`、`isTimeoutError`/`isRateLimitError` 真实样本（含 1429ms 数字陷阱）、`computeDreamBackoffDelayMs` 阶梯+升级、调度器级「超时行等 ≥10min、429 行 ≥10min、普通 500 行走 5min 档」。
  - `dreamService.test.mjs`：①attempt 2 的合成调用实测拿到 1_200_000 窗口（自适应生效）；②超时类错误在 attempt ≥ cap 时终态为 `failed`（可跨窗口重试）而非 `terminal-failed`；③非回归：确定性 400 在 cap 处仍 terminal-failed。
- 运行结果（本机编译后 `node --test`）：
  - `dreamRetryPolicy + dreamPrompt`：**42/42 pass**
  - `dreamService.test.mjs`：**19/19 pass**
  - `dreamStore + dreamTelemetrySeries`：**11/11 pass**
  - `memoryHygieneService + llmFallback + cognitiveChatCompletion`：30 pass / 0 fail / **3 cancelled**——该 3 例为 `tests/llmFallback.test.mjs` 存量 flake（"Promise resolution is still pending…"），在未改动的 pristine checkout（llmFallback.ts 与 fork/main 零 diff）复跑同样 3 cancelled，与本改动无关；已按《引用标准协议》登记至 `idbots-longterm-retro-issue-log.md` M-32。

## 4. 环境注记
- 本工作树（git worktree）无 node_modules，编译用符号链接指回主 checkout 的 `IDBots/node_modules`（`ln -s ../IDBots/node_modules node_modules`，未改动主 checkout 任何文件）；pnpm 不在 PATH，直接以 `npx -p typescript@5 tsc --project electron-tsconfig.json && node scripts/copy-electron-js.cjs` 等价复刻 `compile:electron`。

## 5. 行为变化摘要（验收速查）
| 场景 | 旧行为 | 新行为 |
|---|---|---|
| 爆量日合成调用（合法 8–38min） | 10min 固定窗撞墙，双脑连爆 | 档位 10/20/38min 随 attempt 升级，∩run 剩余预算 |
| 429/限流重试 | 30min 基数指数退避，无感知限流 | 2/5/15min 阶梯；限流拉到 ≥10min |
| 连续超时重试 | 原地连撞直到预算烧完 | ≥2 次连续超时退避 ≥10min，跨窗口错峰 |
| 超时类失败烧完 5 次尝试 | terminal-failed 终态 | 永远 `failed`（待重试），跨窗口自动再试 |
| run 级预算耗尽 | 继续排注定超时的调用直至 30min 整 | 剩余 <10min 即哨兵让位，跨窗口再试 |
