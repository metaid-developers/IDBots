export const DISABLE_SINGLE_INSTANCE_LOCK_ENV = 'IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK';

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function shouldAcquireSingleInstanceLock(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isTruthy(env[DISABLE_SINGLE_INSTANCE_LOCK_ENV]);
}
