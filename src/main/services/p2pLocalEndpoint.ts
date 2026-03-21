export const DEFAULT_P2P_LOCAL_PORT = 7281;
export const DEFAULT_P2P_LOCAL_BASE = `http://localhost:${DEFAULT_P2P_LOCAL_PORT}`;
export const P2P_LOCAL_BASE_ENV = 'IDBOTS_MAN_P2P_LOCAL_BASE';

export function getP2PLocalBase(): string {
  const override = process.env[P2P_LOCAL_BASE_ENV]?.trim();
  if (!override) {
    return DEFAULT_P2P_LOCAL_BASE;
  }
  return override.replace(/\/+$/, '');
}
