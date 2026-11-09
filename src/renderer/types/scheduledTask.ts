// 调度类型
export interface ScheduleAt {
  type: 'at';
  datetime: string; // ISO 8601
}

export interface ScheduleInterval {
  type: 'interval';
  intervalMs: number;
  unit: 'minutes' | 'hours' | 'days';
  value: number;
}

export interface ScheduleCron {
  type: 'cron';
  expression: string; // 5段 CRON 表达式
}

export type Schedule = ScheduleAt | ScheduleInterval | ScheduleCron;

// 任务状态
export type TaskLastStatus = 'success' | 'error' | 'running' | 'max_fires_reached' | null;

// Who created the task: 'human' = the settings UI; 'agent' = a bot through
// the skill script / inline tool / proxy API; null = legacy row.
export type TaskOrigin = 'human' | 'agent' | null;

export interface TaskState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: TaskLastStatus;
  lastError: string | null;
  lastDurationMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

// IM 通知平台类型
export type NotifyPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord';

// Per-task memory-surface opt-in (mirrors the main-process
// SCHEDULED_TASK_MEMORY_ACCESS_LEVELS; 'none' = legacy full blackout).
export type ScheduledTaskMemoryAccess = 'none' | 'read-only' | 'read-write';

// Where a recurring task's fires run when no session is bound (mirrors the
// main-process SCHEDULED_TASK_SESSION_MODES): 'series' = one standing
// conversation "[定时] <name>" (the default; rotated to "（2）" when long),
// 'fresh' = a new session per fire. Null/legacy = 'series'.
export type ScheduledTaskSessionMode = 'series' | 'fresh';

// 定时任务
export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  metabotId: number | null;
  coworkSessionId: string | null;
  targetSessionId: string | null; // bound cowork session id; null = use sessionMode
  sessionMode: ScheduledTaskSessionMode; // recurring execution venue; 'series' = standing conversation (default)
  seriesSessionId: string | null; // the standing conversation a 'series' task currently continues in
  /** Memory-surface opt-in for the task's session; 'none' = legacy blackout. */
  memoryAccess: ScheduledTaskMemoryAccess;
  expiresAt: string | null; // ISO 8601 日期（精确到天），null 表示不过期
  notifyPlatforms: NotifyPlatform[]; // 任务完成后通知的 IM 平台
  // Lifecycle provenance & death clause (null origin = legacy row)
  origin: TaskOrigin;
  originSessionId: string | null; // session the task was created from
  originContext: string | null; // host-stamped creation context ('ui'/'chat'/'surf'/'a2a'/'group-task:<id>'/…)
  exitCondition: string | null; // natural-language retire clause
  maxFires: number | null; // total fire budget; null = unlimited
  fireCount: number; // real executions so far
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

// Skip reason codes (mirrors the main-process SCHEDULED_TASK_SKIP_REASONS)
export type ScheduledTaskSkipReason =
  | 'already_running'
  | 'expired'
  | 'disabled'
  | 'stuck_running';

// 运行记录
export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: 'running' | 'success' | 'error' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  trigger: 'scheduled' | 'manual';
  skipReason: ScheduledTaskSkipReason | null;
}

// 带任务名称的运行记录（用于全局历史列表）
export interface ScheduledTaskRunWithName extends ScheduledTaskRun {
  taskName: string;
}

// 表单输入
export interface ScheduledTaskInput {
  name: string;
  description: string;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  metabotId?: number | null;
  targetSessionId?: string | null; // bound cowork session id; null/undefined = use sessionMode
  /** Optional; absent defaults to 'series' (the standing conversation). */
  sessionMode?: ScheduledTaskSessionMode;
  /** Optional; absent/invalid values store as 'none' (legacy blackout). */
  memoryAccess?: ScheduledTaskMemoryAccess;
  expiresAt: string | null; // ISO 8601 日期（精确到天），null 表示不过期
  notifyPlatforms: NotifyPlatform[]; // 任务完成后通知的 IM 平台
  enabled: boolean;
  // Optional on the human surface: humans keep unlimited recurring tasks.
  exitCondition?: string | null;
  maxFires?: number | null;
}

// IPC 事件
export interface ScheduledTaskStatusEvent {
  taskId: string;
  state: TaskState;
}

export interface ScheduledTaskRunEvent {
  run: ScheduledTaskRun;
}

// UI 视图模式
export type ScheduledTaskViewMode = 'list' | 'create' | 'edit' | 'detail';
