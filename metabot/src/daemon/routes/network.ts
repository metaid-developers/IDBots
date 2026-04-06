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

  if (url.pathname === '/api/network/services') {
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
  }

  if (url.pathname !== '/api/network/sources') {
    return false;
  }

  if (req.method === 'GET') {
    const result = handlers.network?.listSources
      ? await handlers.network.listSources()
      : commandFailed('not_implemented', 'Network source list handler is not configured.');
    context.sendJson(200, result);
    return true;
  }

  if (req.method === 'POST') {
    const input = await context.readJsonBody();
    const result = handlers.network?.addSource
      ? await handlers.network.addSource({
          baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : '',
          label: typeof input.label === 'string' ? input.label : undefined,
        })
      : commandFailed('not_implemented', 'Network source add handler is not configured.');
    context.sendJson(200, result);
    return true;
  }

  if (req.method === 'DELETE') {
    const input = await context.readJsonBody();
    const result = handlers.network?.removeSource
      ? await handlers.network.removeSource({
          baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : '',
        })
      : commandFailed('not_implemented', 'Network source remove handler is not configured.');
    context.sendJson(200, result);
    return true;
  }

  context.sendMethodNotAllowed(['GET', 'POST', 'DELETE']);
  return true;
};
