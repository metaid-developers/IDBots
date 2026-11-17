/**
 * Reproducible 5-factor Task vs. Dialogue intent standard (`TaskIntentSpec v1`).
 *
 * Designed so that ANY AI agent (IDBots's JEV Cerebellum `/v1/systemone`,
 * Claude, GPT, DeepSeek, or external MetaBots) evaluates the same five
 * structural factors (0/1/2 points each, total 0..10) and reaches the same
 * deterministic verdict:
 *
 *   Step 0 — Existing Task Binding:
 *     Replies, rulings, revisions, or status follow-ups targeting an open task
 *     bind directly to that task (`bind_existing_task`) without creating a
 *     duplicate card or degrading to stateless chat.
 *
 *   Step 1 — Five Structural Factors (0 / 1 / 2 each, configurable weights):
 *     F1 Execution Topology     (single-shot reply vs multi-source vs multi-step/DAG/delegation)
 *     F2 Deliverable / Artifact (ephemeral chat text vs inline structured digest vs standalone addressable artifact)
 *     F3 Async & Lifecycle Span (sync turn vs background async/multi-turn polish vs cross-day/external-wait/resumable)
 *     F4 Verification & Ruling  (no done-ness vs implicit pick/approval vs explicit verifiable criteria/owner gate)
 *     F5 Side Effects & Spend   (light read-only vs heavy audit/local workspace write vs chain/merge/DM/persistent spend)
 *
 *   Verdict Rules (configurable):
 *     - Explicit user meta-override ("建个任务/立个项" vs "先别立项/随便聊聊") wins first.
 *     - Hard Task Triggers: F2 === 2 (standalone deliverable) OR F5 === 2
 *       (external write / chain / merge / DM) OR Worker delegation → `create_task`.
 *     - Weighted score >= taskThreshold (default 5) → `create_task` (silent creation, zero meta-question friction).
 *     - grayMinThreshold <= score < taskThreshold (default 3..4) → `gray_explore`
 *       (answer substantively first, append a non-blocking立项 offer).
 *     - score < grayMinThreshold (default <= 2) → `casual_dialogue` (zero task overhead).
 *
 * Pure and Electron-free so plain-Node tests and external harnesses can load it directly.
 */

export const TASK_INTENT_SPEC_VERSION = 'idbots.task-intent.v1' as const;

export type TaskIntentFactorKey = 'f1' | 'f2' | 'f3' | 'f4' | 'f5';

export const TASK_INTENT_FACTOR_KEYS: readonly TaskIntentFactorKey[] = ['f1', 'f2', 'f3', 'f4', 'f5'];

export type TaskIntentFactorScore = 0 | 1 | 2;

export type TaskIntentFactorScores = Record<TaskIntentFactorKey, TaskIntentFactorScore>;

export type TaskIntentChoiceBucket = 's0' | 's1' | 's2';

export const TASK_INTENT_CHOICE_BUCKETS: readonly TaskIntentChoiceBucket[] = ['s0', 's1', 's2'];

export type TaskIntentVerdict =
  | 'bind_existing_task'
  | 'create_task'
  | 'gray_explore'
  | 'casual_dialogue';

export type TaskIntentHardTrigger =
  | 'f2_deliverable'
  | 'f5_external_side_effect'
  | 'worker_delegation'
  | 'explicit_command'
  | 'explicit_chat_only';

export interface TaskIntentRubricConfig {
  weights: Record<TaskIntentFactorKey, number>;
  /** Minimum weighted total to auto-create a Task without asking (default 5). */
  taskThreshold: number;
  /** Minimum weighted total for the non-blocking exploratory gray zone (default 3). */
  grayMinThreshold: number;
  /** Force `create_task` whenever F2 === 2 (standalone deliverable requested). */
  hardTriggerOnDeliverableF2: boolean;
  /** Force `create_task` whenever F5 === 2 (external write, chain spend, merge, DM). */
  hardTriggerOnExternalWriteF5: boolean;
}

export const DEFAULT_TASK_INTENT_RUBRIC_CONFIG: TaskIntentRubricConfig = {
  weights: { f1: 1, f2: 1, f3: 1, f4: 1, f5: 1 },
  taskThreshold: 5,
  grayMinThreshold: 3,
  hardTriggerOnDeliverableF2: true,
  hardTriggerOnExternalWriteF5: true,
};

export interface TaskIntentAssessment {
  specVersion: typeof TASK_INTENT_SPEC_VERSION;
  verdict: TaskIntentVerdict;
  totalScore: number;
  maxScore: number;
  factors: TaskIntentFactorScores;
  hardTriggeredBy: TaskIntentHardTrigger[];
  boundTaskId?: string | null;
}

export interface EvaluateTaskIntentOptions {
  /** Set when Step 0 already matched an open task being answered/updated. */
  bindsExistingTaskId?: string | null;
  /** Explicit user override ('force_task' | 'force_dialogue'), or auto-detected from userText. */
  explicitOverride?: 'force_task' | 'force_dialogue' | null;
  /** Optional raw user text for explicit meta-command override detection. */
  userText?: string;
  /** True when the turn is explicitly delegating to a Worker Bot or Group Task. */
  workerDelegation?: boolean;
}

export interface CerebellumTaskIntentChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<TaskIntentChoiceBucket, string>;
}

export const CEREBELLUM_TASK_INTENT_QUESTION_IDS: Record<TaskIntentFactorKey, string> = {
  f1: 'intent_f1',
  f2: 'intent_f2',
  f3: 'intent_f3',
  f4: 'intent_f4',
  f5: 'intent_f5',
};

const FACTOR_SPECS: Record<
  TaskIntentFactorKey,
  {
    label: string;
    instructions: string;
    criteria: Record<TaskIntentChoiceBucket, string>;
  }
> = {
  f1: {
    label: 'Execution Topology',
    instructions:
      'Rate factor F1 (Execution Topology) for the user message at `current_message`. ' +
      '`s0`: single-shot conversational reply or at most one light lookup closes the request completely. ' +
      '`s1`: requires synthesizing multiple read-only sources (repo/history/chain) or one clarifying parameter check before a single action. ' +
      '`s2`: inherently multi-step pipeline with ordered/parallel sub-steps, Worker delegation, or an execute-verify-revise loop.',
    criteria: {
      s0: '0 — single-step direct answer or one lightweight read query; no sub-steps needed',
      s1: '1 — multi-source read synthesis or 1-round parameter clarification before a single step',
      s2: '2 — multi-step workflow, sub-task decomposition, Worker delegation, or build-verify-iterate loop',
    },
  },
  f2: {
    label: 'Deliverable / Artifact',
    instructions:
      'Rate factor F2 (Standalone Deliverable / Artifact) for the user message at `current_message`. ' +
      '`s0`: expects only an ephemeral in-chat reply, explanation, small talk, companionship, or open opinion exchange. ' +
      '`s1`: produces a structured in-chat summary/comparison/inventory useful for reference, without asking for a standalone file or reusable asset. ' +
      '`s2`: explicitly asks to produce or modify a standalone addressable artifact (proposal/plan doc, article, code branch/fix, design images/video/slides, HTML page/MetaApp, or on-chain pin/skill/NFT).',
    criteria: {
      s0: '0 — ephemeral chat answer, concept explanation, casual talk, or open discussion with no artifact',
      s1: '1 — structured inline checklist/inventory in chat without requesting a saved file or standalone deliverable',
      s2: '2 — standalone addressable deliverable requested: plan/proposal doc, code patch, images/media, HTML/MetaApp, or on-chain asset',
    },
  },
  f3: {
    label: 'Async & Lifecycle Span',
    instructions:
      'Rate factor F3 (Async & Lifecycle Span) for the user message at `current_message`. ' +
      '`s0`: finishes synchronously in seconds within this single turn; closing the window ends the matter. ' +
      '`s1`: runs asynchronously in the background for minutes (allowing parallel Studio topics while a Worker or tool pipeline runs) or spans 2+ iterative refinement turns. ' +
      '`s2`: spans hours/days/sessions, involves external waits (block confirmations, counterparty replies, scheduled windows), or expects pause/resume across devices or entries.',
    criteria: {
      s0: '0 — synchronous single-turn closure; ends immediately once answered',
      s1: '1 — minute-scale background async work or 2+ turns of iterative refinement within the workspace',
      s2: '2 — multi-hour/multi-day/cross-session lifecycle, external waits, or pause-and-resume continuity',
    },
  },
  f4: {
    label: 'Verification & Ruling Gate',
    instructions:
      'Rate factor F4 (Verification & Owner Ruling Contract) for the user message at `current_message`. ' +
      '`s0`: no notion of pass/fail or acceptance; once answered, nothing needs verification. ' +
      '`s1`: involves subjective owner selection or review (e.g. drafting a proposal for review, generating 3 image candidates to pick from, or "revise if off"). ' +
      '`s2`: has explicit checkable acceptance criteria (tests green, sha256 match, chain confirmation, security checklist) or formal milestone sign-off.',
    criteria: {
      s0: '0 — no acceptance or verification gate; pure Q&A, status check, or casual chat',
      s1: '1 — implicit owner review or candidate selection (review a draft plan, pick 1 of 3 designs)',
      s2: '2 — explicit checkable acceptance criteria, formal verification proof, or milestone ruling gate',
    },
  },
  f5: {
    label: 'Side Effects & Resource Commitment',
    instructions:
      'Rate factor F5 (Side Effects & Persistent Resource Commitment) for the user message at `current_message`. ' +
      '`s0`: pure conversation or lightweight read-only lookup with zero writes and zero spend. ' +
      '`s1`: heavy read-only audit (codebase security review, multi-repo inspection) or local workspace file creation/editing. ' +
      '`s2`: external state mutation or persistent resource spend (on-chain broadcast/sats/ME spend, sending DMs/group messages, merging into main, hiring/creating a Bot, or registering persistent schedules/services).',
    criteria: {
      s0: '0 — pure chat or light read-only lookup; zero local/external writes and zero spend',
      s1: '1 — heavy read-only codebase/chain audit or local workspace file generation/modification',
      s2: '2 — external side effects or persistent resource spend: chain write, DM/post, git main merge, Bot creation, or persistent service',
    },
  },
};

const EXPLICIT_FORCE_DIALOGUE_RE =
  /(?:先别立项|先不立项|不用立项|不用建任务|先别建任务|不建任务|不要建任务|先随便聊聊|只是随便聊聊|纯闲聊|先不动手|\bjust chatting\b|\bdo not create a task\b|\bdon't create a task\b)/i;

const EXPLICIT_FORCE_TASK_RE =
  /(?:(?:帮我|请|麻烦)?(?:新建|创建|建立|开|列)一?个?任务(?:卡)?|(?:帮我|请|麻烦)?立一?个?项|正式立项|立项推进|记成任务|\bcreate a task\b|\bopen a new task\b)/i;

export function detectExplicitTaskIntentOverride(
  text: string,
): 'force_task' | 'force_dialogue' | null {
  const normalized = String(text ?? '').trim();
  if (!normalized) return null;
  if (EXPLICIT_FORCE_DIALOGUE_RE.test(normalized)) return 'force_dialogue';
  if (EXPLICIT_FORCE_TASK_RE.test(normalized)) return 'force_task';
  return null;
}

function clampFactorScore(raw: unknown): TaskIntentFactorScore {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num >= 2) return 2;
  return 1;
}

export function resolveTaskIntentConfig(
  partial?: Partial<TaskIntentRubricConfig> | null,
): TaskIntentRubricConfig {
  if (!partial) return DEFAULT_TASK_INTENT_RUBRIC_CONFIG;
  const weights: Record<TaskIntentFactorKey, number> = {
    f1: Number.isFinite(partial.weights?.f1) ? Math.max(0, Number(partial.weights!.f1)) : 1,
    f2: Number.isFinite(partial.weights?.f2) ? Math.max(0, Number(partial.weights!.f2)) : 1,
    f3: Number.isFinite(partial.weights?.f3) ? Math.max(0, Number(partial.weights!.f3)) : 1,
    f4: Number.isFinite(partial.weights?.f4) ? Math.max(0, Number(partial.weights!.f4)) : 1,
    f5: Number.isFinite(partial.weights?.f5) ? Math.max(0, Number(partial.weights!.f5)) : 1,
  };
  const taskThreshold = Number.isFinite(partial.taskThreshold)
    ? Number(partial.taskThreshold)
    : DEFAULT_TASK_INTENT_RUBRIC_CONFIG.taskThreshold;
  const grayMinThreshold = Number.isFinite(partial.grayMinThreshold)
    ? Number(partial.grayMinThreshold)
    : DEFAULT_TASK_INTENT_RUBRIC_CONFIG.grayMinThreshold;
  return {
    weights,
    taskThreshold,
    grayMinThreshold: Math.min(grayMinThreshold, taskThreshold),
    hardTriggerOnDeliverableF2:
      partial.hardTriggerOnDeliverableF2 ?? DEFAULT_TASK_INTENT_RUBRIC_CONFIG.hardTriggerOnDeliverableF2,
    hardTriggerOnExternalWriteF5:
      partial.hardTriggerOnExternalWriteF5 ?? DEFAULT_TASK_INTENT_RUBRIC_CONFIG.hardTriggerOnExternalWriteF5,
  };
}

export function evaluateTaskIntentScores(
  rawFactors: Partial<Record<TaskIntentFactorKey, number>>,
  options: EvaluateTaskIntentOptions = {},
  partialConfig?: Partial<TaskIntentRubricConfig> | null,
): TaskIntentAssessment {
  const config = resolveTaskIntentConfig(partialConfig);
  const factors: TaskIntentFactorScores = {
    f1: clampFactorScore(rawFactors.f1),
    f2: clampFactorScore(rawFactors.f2),
    f3: clampFactorScore(rawFactors.f3),
    f4: clampFactorScore(rawFactors.f4),
    f5: clampFactorScore(rawFactors.f5),
  };

  const rawTotal =
    factors.f1 * config.weights.f1 +
    factors.f2 * config.weights.f2 +
    factors.f3 * config.weights.f3 +
    factors.f4 * config.weights.f4 +
    factors.f5 * config.weights.f5;
  const maxRaw =
    2 * (config.weights.f1 + config.weights.f2 + config.weights.f3 + config.weights.f4 + config.weights.f5);
  const totalScore = Math.round(rawTotal * 100) / 100;
  const maxScore = Math.round(maxRaw * 100) / 100;

  const boundTaskId = String(options.bindsExistingTaskId ?? '').trim() || null;
  if (boundTaskId) {
    return {
      specVersion: TASK_INTENT_SPEC_VERSION,
      verdict: 'bind_existing_task',
      totalScore,
      maxScore,
      factors,
      hardTriggeredBy: [],
      boundTaskId,
    };
  }

  const explicitOverride =
    options.explicitOverride !== undefined
      ? options.explicitOverride
      : options.userText
        ? detectExplicitTaskIntentOverride(options.userText)
        : null;

  if (explicitOverride === 'force_dialogue') {
    return {
      specVersion: TASK_INTENT_SPEC_VERSION,
      verdict: 'casual_dialogue',
      totalScore,
      maxScore,
      factors,
      hardTriggeredBy: ['explicit_chat_only'],
    };
  }

  const hardTriggeredBy: TaskIntentHardTrigger[] = [];
  if (explicitOverride === 'force_task') {
    hardTriggeredBy.push('explicit_command');
  }
  if (config.hardTriggerOnDeliverableF2 && factors.f2 === 2) {
    hardTriggeredBy.push('f2_deliverable');
  }
  if (config.hardTriggerOnExternalWriteF5 && factors.f5 === 2) {
    hardTriggeredBy.push('f5_external_side_effect');
  }
  if (options.workerDelegation === true) {
    hardTriggeredBy.push('worker_delegation');
  }

  let verdict: TaskIntentVerdict;
  if (hardTriggeredBy.length > 0 || totalScore >= config.taskThreshold) {
    verdict = 'create_task';
  } else if (totalScore >= config.grayMinThreshold) {
    verdict = 'gray_explore';
  } else {
    verdict = 'casual_dialogue';
  }

  return {
    specVersion: TASK_INTENT_SPEC_VERSION,
    verdict,
    totalScore,
    maxScore,
    factors,
    hardTriggeredBy,
  };
}

export function buildBundledTaskIntentQuestions(): Record<string, CerebellumTaskIntentChoiceQuestion> {
  const out: Record<string, CerebellumTaskIntentChoiceQuestion> = {};
  for (const key of TASK_INTENT_FACTOR_KEYS) {
    const spec = FACTOR_SPECS[key];
    out[CEREBELLUM_TASK_INTENT_QUESTION_IDS[key]] = {
      type: 'choice',
      instructions: spec.instructions,
      criteria: { ...spec.criteria },
    };
  }
  return out;
}

function bucketToScore(bucket: TaskIntentChoiceBucket): TaskIntentFactorScore {
  if (bucket === 's2') return 2;
  if (bucket === 's1') return 1;
  return 0;
}

function parseSingleFactorScore(record: unknown): TaskIntentFactorScore | null {
  if (!record || typeof record !== 'object') return null;
  const probabilities = (record as Record<string, unknown>).probabilities;
  if (probabilities && typeof probabilities === 'object') {
    let bestBucket: TaskIntentChoiceBucket = 's0';
    let bestProb = -1;
    let known = 0;
    for (const bucket of TASK_INTENT_CHOICE_BUCKETS) {
      const val = (probabilities as Record<string, unknown>)[bucket];
      if (typeof val !== 'number' || !Number.isFinite(val)) continue;
      const clamped = Math.max(0, Math.min(1, val));
      known += 1;
      // Conservative tie-break: strictly greater required to move to a higher score.
      if (clamped > bestProb) {
        bestProb = clamped;
        bestBucket = bucket;
      }
    }
    if (known > 0) {
      return bucketToScore(bestBucket);
    }
  }
  const choice = (record as Record<string, unknown>).choice;
  if (typeof choice === 'string' && (TASK_INTENT_CHOICE_BUCKETS as readonly string[]).includes(choice)) {
    return bucketToScore(choice as TaskIntentChoiceBucket);
  }
  return null;
}

export function parseTaskIntentAnswers(
  payload: unknown,
  options: EvaluateTaskIntentOptions = {},
  partialConfig?: Partial<TaskIntentRubricConfig> | null,
): TaskIntentAssessment | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers as Record<string, unknown> | undefined;
  if (!answers || typeof answers !== 'object') return null;

  const parsed: Partial<TaskIntentFactorScores> = {};
  for (const key of TASK_INTENT_FACTOR_KEYS) {
    const questionId = CEREBELLUM_TASK_INTENT_QUESTION_IDS[key];
    const score = parseSingleFactorScore(answers[questionId]);
    if (score === null) return null;
    parsed[key] = score;
  }

  return evaluateTaskIntentScores(parsed, options, partialConfig);
}

/**
 * Format a compact per-turn hint block for the Twin Bot so it follows the
 * exact 5-factor intent ruling while retaining semantic Step-0 authority
 * (binding follow-ups/revisions to an already-open task on the radar).
 */
export function formatTaskIntentPromptHint(assessment: TaskIntentAssessment): string {
  const { factors, totalScore, maxScore, verdict, hardTriggeredBy } = assessment;
  const factorSummary = `F1=${factors.f1},F2=${factors.f2},F3=${factors.f3},F4=${factors.f4},F5=${factors.f5}`;
  const triggers = hardTriggeredBy.length > 0 ? ` triggers="${hardTriggeredBy.join(',')}"` : '';
  const guidance =
    verdict === 'bind_existing_task'
      ? `Follow-up bound to task ${assessment.boundTaskId}: update/advance that task instead of creating a duplicate card.`
      : verdict === 'create_task'
        ? 'Action: First check <active_tasks_radar>; if this message is answering, revising, or continuing an existing open task, update/advance that task. Otherwise, this is a NEW deliverable task — call `task_create` immediately to register an active task card (do NOT ask whether to create a task), execute or delegate via `local_worker_delegate`, and present detailed deliverables/plans in `waiting_owner` for the owner to review and approve.'
        : verdict === 'gray_explore'
          ? 'Action: Exploratory discussion (gray zone). First check if it updates an open task; otherwise answer substantively right away WITHOUT creating a task card or interrupting with a modal, and add one brief closing line offering to open a tracked task once the direction settles.'
          : 'Action: Casual dialogue / Q&A / status check. Unless the owner is replying to a pending decision on <active_tasks_radar>, answer directly in chat with zero task-creation overhead.';
  return [
    `<task_intent_assessment spec="${assessment.specVersion}" score="${totalScore}/${maxScore}" factors="${factorSummary}" verdict="${verdict}"${triggers}>`,
    guidance,
    '</task_intent_assessment>',
  ].join('\n');
}

/**
 * Portable specification block any AI agent can execute reproducibly when no
 * separate Cerebellum classifier pre-scored the message.
 */
export function buildPortableTaskIntentRubricSpec(
  partialConfig?: Partial<TaskIntentRubricConfig> | null,
): string {
  const cfg = resolveTaskIntentConfig(partialConfig);
  return [
    `## Task vs. Dialogue Intent Standard (${TASK_INTENT_SPEC_VERSION})`,
    'Before acting on any owner message, classify intent in two deterministic steps:',
    '1. **Step 0 (Existing Task Binding)**: Check active/pending tasks first. If the message answers a pending ruling, adjusts requirements, or asks about/continues an existing task, bind to that `taskId` — never create a duplicate card.',
    '2. **Step 1 (5-Factor Scoring, 0–2 pts each)**:',
    '   - **F1 Execution Topology**: 0=single-shot answer/lookup; 1=multi-source read synthesis or 1-round param check; 2=multi-step/DAG/Worker delegation/iterate loop.',
    '   - **F2 Deliverable / Artifact**: 0=chat text/opinion/small talk only; 1=inline structured summary; 2=standalone addressable artifact (plan/proposal doc, code fix, design images/media, HTML/MetaApp, chain pin/skill/NFT).',
    '   - **F3 Async & Span**: 0=sync single-turn closure; 1=background async minutes or multi-turn refinement; 2=cross-day/cross-session/external-wait/resumable.',
    '   - **F4 Verification & Ruling**: 0=no pass/fail check; 1=owner review/candidate pick; 2=checkable acceptance criteria or milestone sign-off.',
    '   - **F5 Side Effects & Resources**: 0=zero writes/spend; 1=heavy audit or local workspace file write; 2=chain write/spend, DM/post, git main merge, Bot creation, persistent service.',
    `3. **Verdict**: Score >= ${cfg.taskThreshold}${cfg.hardTriggerOnDeliverableF2 ? ' OR F2=2' : ''}${cfg.hardTriggerOnExternalWriteF5 ? ' OR F5=2' : ''} OR Worker delegation → **Task** (auto-create immediately via \`task_create\`, never ask "should I create a task?"). Score ${cfg.grayMinThreshold}–${cfg.taskThreshold - 1} → **Exploratory** (answer first, lightly offer to open a task once direction is set). Score < ${cfg.grayMinThreshold} → **Dialogue** (reply directly, no task card).`,
  ].join('\n');
}
