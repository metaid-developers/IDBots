export const DEFAULT_P2P_LOCAL_PORT = 7281;
export const DEFAULT_P2P_LOCAL_BASE = `http://localhost:${DEFAULT_P2P_LOCAL_PORT}`;
export const P2P_LOCAL_BASE_ENV = 'IDBOTS_MAN_P2P_LOCAL_BASE';

export function getConfiguredP2PLocalBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[P2P_LOCAL_BASE_ENV]?.trim();
  if (!override) {
    return null;
  }
  return override.replace(/\/+$/, '');
}

export function getP2PLocalBase(env: NodeJS.ProcessEnv = process.env): string {
  return getConfiguredP2PLocalBase(env) ?? DEFAULT_P2P_LOCAL_BASE;
}

export function resolveP2PLocalListenAddress(base: string | null): string | null {
  if (!base) {
    return null;
  }

  try {
    const parsed = new URL(base);
    const host = parsed.hostname?.trim();
    const port = parsed.port ? Number(parsed.port) : DEFAULT_P2P_LOCAL_PORT;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return null;
    }
    return `${host}:${port}`;
  } catch {
    return null;
  }
}

export function applyP2PLocalListenAddressOverride(configContents: string, listenAddress: string): string {
  const portLine = `port = "${listenAddress}"`;
  if (/^port\s*=\s*"[^"]*"\s*$/m.test(configContents)) {
    return configContents.replace(/^port\s*=\s*"[^"]*"\s*$/m, portLine);
  }
  return `${configContents.trimEnd()}\n${portLine}\n`;
}
