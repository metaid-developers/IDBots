import { commandFailed } from '../../core/contracts/commandResult';
import type { RouteHandler } from './types';

function parseBoolean(value: string | null): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
}

export const handleNetworkRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;

  if (url.pathname !== '/api/network/services') {
    return false;
  }

  if (req.method !== 'GET') {
    context.sendMethodNotAllowed(['GET']);
    return true;
  }

  const result = handlers.network?.listServices
    ? await handlers.network.listServices({
        online: parseBoolean(url.searchParams.get('online')),
      })
    : commandFailed('not_implemented', 'Network services handler is not configured.');
  context.sendJson(200, result);
  return true;
};
