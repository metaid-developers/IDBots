const SQLITE_WASM_BOUNDS_PATTERN = /memory access out of bounds/i;
/** sql.js / SQLite WASM often surfaces concurrent DB misuse as this message (see privateChatDaemon tick). */
const SQLITE_WASM_API_MISUSE_PATTERN = /bad parameter or other API misuse/i;

const getErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    return [
      error.name,
      error.message,
      typeof error.stack === 'string' ? error.stack : '',
    ].filter(Boolean).join('\n');
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export function isSqliteWasmBoundsError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current && !visited.has(current)) {
    visited.add(current);
    const text = getErrorText(current);
    if (
      SQLITE_WASM_BOUNDS_PATTERN.test(text)
      || SQLITE_WASM_API_MISUSE_PATTERN.test(text)
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}

export async function runWithSqliteWasmRecovery<T>(
  operationName: string,
  operation: () => T | Promise<T>,
  recover: (error: unknown, operationName: string) => void | Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isSqliteWasmBoundsError(error)) {
      throw error;
    }
    await recover(error, operationName);
    return operation();
  }
}
