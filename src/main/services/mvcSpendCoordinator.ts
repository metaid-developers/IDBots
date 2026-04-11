export interface RunMvcSpendJobParams<T> {
  metabotId: number;
  action: string;
  execute: () => Promise<T>;
}

export class MvcSpendCoordinator {
  private readonly queues = new Map<number, Promise<unknown>>();

  async runMvcSpendJob<T>(params: RunMvcSpendJobParams<T>): Promise<T> {
    const { metabotId, execute } = params;
    const previous = this.queues.get(metabotId) ?? Promise.resolve();

    let releaseCurrent: (() => void) | null = null;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const currentChain = previous.then(() => current);
    this.queues.set(metabotId, currentChain);

    await previous.catch(() => undefined);
    try {
      return await execute();
    } finally {
      releaseCurrent?.();
      if (this.queues.get(metabotId) === currentChain) {
        this.queues.delete(metabotId);
      }
    }
  }
}

let sharedMvcSpendCoordinator: MvcSpendCoordinator | null = null;

export function getMvcSpendCoordinator(): MvcSpendCoordinator {
  if (!sharedMvcSpendCoordinator) {
    sharedMvcSpendCoordinator = new MvcSpendCoordinator();
  }
  return sharedMvcSpendCoordinator;
}
