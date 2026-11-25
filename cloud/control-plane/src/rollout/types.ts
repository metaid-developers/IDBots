export type RolloutJobStatus = 'paused' | 'running' | 'completed' | 'cancelled';
export type RolloutItemStatus = 'pending' | 'leased' | 'succeeded' | 'failed' | 'rolled-back' | 'skipped';

export interface RolloutWave {
  index: number;
  label: string;
  soakMs: number;
}

export interface RolloutJob {
  id: string;
  releaseId: string;
  mode: 'upgrade' | 'rollback';
  status: RolloutJobStatus;
  currentWave: number;
  globalConcurrency: number;
  perHostConcurrency: number;
  failureThresholdPercent: number;
  failureThresholdCount: number;
  consecutiveFailureLimit: number;
  stopReason: string | null;
  operator: string;
  waveStartedAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface RolloutItem {
  jobId: string;
  tenantId: string;
  hostId: string;
  waveIndex: number;
  status: RolloutItemStatus;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  outcome: string | null;
  error: string | null;
}

export interface RolloutJobView {
  job: RolloutJob;
  waves: RolloutWave[];
  items: RolloutItem[];
}

export interface NewRolloutJob {
  id: string;
  releaseId: string;
  mode: 'upgrade' | 'rollback';
  globalConcurrency: number;
  perHostConcurrency: number;
  failureThresholdPercent: number;
  failureThresholdCount: number;
  consecutiveFailureLimit: number;
  operator: string;
  waves: RolloutWave[];
  items: Array<Pick<RolloutItem, 'tenantId' | 'hostId' | 'waveIndex'>>;
}

export interface RolloutStore {
  createJob(input: NewRolloutJob): Promise<RolloutJobView>;
  getJob(id: string): Promise<RolloutJobView | null>;
  listJobs(limit?: number): Promise<RolloutJobView[]>;
  setJobStatus(id: string, status: RolloutJobStatus, reason?: string | null): Promise<void>;
  advanceWave(id: string, wave: number, now: number): Promise<void>;
  claimItems(jobId: string, workerId: string, limit: number, leaseMs: number, now: number): Promise<RolloutItem[]>;
  completeItem(jobId: string, tenantId: string, workerId: string, status: RolloutItemStatus, outcome: string, error: string | null, now: number): Promise<void>;
  heartbeat(jobId: string, tenantId: string, workerId: string, leaseMs: number, now: number): Promise<void>;
  listPreflightHosts(jobId: string, wave: number): Promise<Array<{ hostId: string; status: string; error: string | null }>>;
  markPreflightHost(jobId: string, hostId: string, wave: number, status: 'ready' | 'failed', error: string | null, now: number): Promise<void>;
  retryFailed(jobId: string): Promise<number>;
  hasRunningItem(tenantId: string): Promise<boolean>;
  requeueInFlight(now: number): Promise<number>;
}
