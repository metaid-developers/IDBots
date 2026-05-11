export type SqliteRecoveryState = 'ready' | 'recovering' | 'failed';

export class SqliteDatabaseUnavailableError extends Error {
  constructor(operationName: string) {
    super(`SQLite database is unavailable after recovery failure; restart IDBots before retrying ${operationName}.`);
    this.name = 'SqliteDatabaseUnavailableError';
  }
}

export interface SQLiteRecoveryCoordinatorDeps<TStore> {
  getStore: () => TStore | null;
  clearStore: () => void;
  closeStore: (store: TStore) => void | Promise<void>;
  resetRuntime: () => void;
  openStore: () => TStore | Promise<TStore>;
  publishStore: (store: TStore) => void;
  stopServices: () => void | Promise<void>;
  startServices: () => void | Promise<void>;
  isRecoverableError: (error: unknown) => boolean;
  logWarn?: (message: string, error?: unknown) => void;
  logInfo?: (message: string) => void;
  logError?: (message: string, error?: unknown) => void;
}

export class SQLiteRecoveryCoordinator<TStore> {
  private state: SqliteRecoveryState = 'ready';
  private recoveryPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly deps: SQLiteRecoveryCoordinatorDeps<TStore>) {}

  getState(): SqliteRecoveryState {
    return this.state;
  }

  getGeneration(): number {
    return this.generation;
  }

  isRecovering(): boolean {
    return this.state === 'recovering';
  }

  async runWithRecovery<T>(
    operationName: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    await this.waitIfRecovering(operationName);
    try {
      return await operation();
    } catch (error) {
      if (!this.deps.isRecoverableError(error)) {
        throw error;
      }
      await this.recover(error, operationName);
      return operation();
    }
  }

  async recover(error: unknown, operationName: string): Promise<void> {
    if (this.recoveryPromise) {
      await this.recoveryPromise;
      return;
    }

    this.recoveryPromise = this.performRecovery(error, operationName);
    await this.recoveryPromise;
  }

  private async waitIfRecovering(operationName: string): Promise<void> {
    this.throwIfUnavailable(operationName);
    if (this.recoveryPromise) {
      await this.recoveryPromise;
    }
    this.throwIfUnavailable(operationName);
  }

  private throwIfUnavailable(operationName: string): void {
    if ((this.state as SqliteRecoveryState) === 'failed') {
      throw new SqliteDatabaseUnavailableError(operationName);
    }
  }

  private async performRecovery(error: unknown, operationName: string): Promise<void> {
    this.state = 'recovering';
    this.generation += 1;
    this.deps.logWarn?.(`[SQLiteRecovery] Recovering after sql.js failure during ${operationName}:`, error);

    try {
      await this.deps.stopServices();
      const damagedStore = this.deps.getStore();
      this.deps.clearStore();
      if (damagedStore) {
        await this.deps.closeStore(damagedStore);
      }
      this.deps.resetRuntime();
      const nextStore = await this.deps.openStore();
      this.deps.publishStore(nextStore);
      this.state = 'ready';
      this.generation += 1;
      await this.deps.startServices();
      this.deps.logInfo?.(`[SQLiteRecovery] SQLite store recovered for ${operationName}.`);
    } catch (recoveryError) {
      this.state = 'failed';
      this.generation += 1;
      try {
        if (this.deps.getStore()) {
          this.deps.clearStore();
        }
      } catch {
        // Keep the first recovery error as the actionable failure.
      }
      this.deps.logError?.(`[SQLiteRecovery] Recovery for ${operationName} failed:`, recoveryError);
      throw recoveryError;
    } finally {
      this.recoveryPromise = null;
    }
  }
}
