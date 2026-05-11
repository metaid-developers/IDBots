export type SqliteBackgroundJobState = 'ready' | 'recovering' | 'failed';

export interface SqliteBackgroundJobRunnerDeps {
  getState: () => SqliteBackgroundJobState;
  recover: (error: unknown, operationName: string) => void | Promise<void>;
  isRecoverableError: (error: unknown) => boolean;
  isUnavailableError: (error: unknown) => boolean;
  logWarn?: (message: string, error?: unknown) => void;
}

export class SqliteBackgroundJobRunner {
  private readonly activeJobs = new Set<Promise<void>>();

  constructor(private readonly deps: SqliteBackgroundJobRunnerDeps) {}

  run(
    operationName: string,
    failureMessage: string,
    operation: () => void | Promise<void>,
  ): Promise<void> | null {
    if (this.deps.getState() !== 'ready') {
      return null;
    }

    const activeJob = Promise.resolve().then(async () => {
      if (this.deps.getState() !== 'ready') {
        return;
      }
      try {
        await operation();
      } catch (error) {
        if (!this.deps.isRecoverableError(error)) {
          throw error;
        }

        this.activeJobs.delete(activeJob);
        await this.deps.recover(error, operationName);
      }
    });

    this.activeJobs.add(activeJob);
    void activeJob
      .catch((error) => {
        if (this.deps.isUnavailableError(error)) {
          const message = error instanceof Error ? error.message : String(error);
          this.deps.logWarn?.(`[SQLiteRecovery] Skipped ${operationName}: ${message}`);
          return;
        }
        this.deps.logWarn?.(failureMessage, error);
      })
      .finally(() => {
        this.activeJobs.delete(activeJob);
      });

    return activeJob;
  }

  async waitForActiveJobs(): Promise<void> {
    await Promise.allSettled([...this.activeJobs]);
  }

  getActiveJobCount(): number {
    return this.activeJobs.size;
  }
}
