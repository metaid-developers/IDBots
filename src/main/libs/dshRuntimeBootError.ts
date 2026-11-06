export const DSH_RUNTIME_BOOT_ERROR_CODE = 'DSH_RUNTIME_BOOT_FAILED';

export class DshRuntimeBootError extends Error {
  readonly code = DSH_RUNTIME_BOOT_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'DshRuntimeBootError';
  }
}

export function isDshRuntimeBootError(error: unknown): boolean {
  if (error instanceof DshRuntimeBootError) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'DshRuntimeBootError' || candidate.code === DSH_RUNTIME_BOOT_ERROR_CODE;
}
