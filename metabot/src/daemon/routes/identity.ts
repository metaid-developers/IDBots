import { commandFailed } from '../../core/contracts/commandResult';
import type { RouteHandler } from './types';

export const handleIdentityRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;

  if (url.pathname !== '/api/identity/create') {
    return false;
  }

  if (req.method !== 'POST') {
    context.sendMethodNotAllowed(['POST']);
    return true;
  }

  const input = await context.readJsonBody();
  const result = handlers.identity?.create
    ? await handlers.identity.create({
        name: typeof input.name === 'string' ? input.name : '',
      })
    : commandFailed('not_implemented', 'Identity create handler is not configured.');
  context.sendJson(200, result);
  return true;
};
