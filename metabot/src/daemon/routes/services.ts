import { commandFailed } from '../../core/contracts/commandResult';
import type { RouteHandler } from './types';

export const handleServicesRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;

  if (url.pathname === '/api/services/publish') {
    if (req.method !== 'POST') {
      context.sendMethodNotAllowed(['POST']);
      return true;
    }

    const input = await context.readJsonBody();
    const result = handlers.services?.publish
      ? await handlers.services.publish(input)
      : commandFailed('not_implemented', 'Services publish handler is not configured.');
    context.sendJson(200, result);
    return true;
  }

  if (url.pathname === '/api/services/call') {
    if (req.method !== 'POST') {
      context.sendMethodNotAllowed(['POST']);
      return true;
    }

    const input = await context.readJsonBody();
    const result = handlers.services?.call
      ? await handlers.services.call(input)
      : commandFailed('not_implemented', 'Services call handler is not configured.');
    context.sendJson(200, result);
    return true;
  }

  if (url.pathname === '/api/services/execute') {
    if (req.method !== 'POST') {
      context.sendMethodNotAllowed(['POST']);
      return true;
    }

    const input = await context.readJsonBody();
    const result = handlers.services?.execute
      ? await handlers.services.execute(input)
      : commandFailed('not_implemented', 'Services execute handler is not configured.');
    context.sendJson(200, result);
    return true;
  }

  return false;
};
