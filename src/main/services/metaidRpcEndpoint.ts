export const DEFAULT_METAID_RPC_HOST = '127.0.0.1';
export const DEFAULT_METAID_RPC_PORT = 31200;
export const METAID_RPC_PORT_ENV = 'IDBOTS_METAID_RPC_PORT';

export function resolveMetaidRpcPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[METAID_RPC_PORT_ENV]?.trim();
  if (!raw) {
    return DEFAULT_METAID_RPC_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_METAID_RPC_PORT;
  }

  return parsed;
}

export function getMetaidRpcBase(env: NodeJS.ProcessEnv = process.env): string {
  return `http://${DEFAULT_METAID_RPC_HOST}:${resolveMetaidRpcPort(env)}`;
}
