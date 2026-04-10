import { commandFailed } from '../../core/contracts/commandResult';
import type { RouteHandler } from './types';

export const handleChatRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;

  if (url.pathname !== '/api/chat/private') {
    return false;
  }

  if (req.method !== 'POST') {
    context.sendMethodNotAllowed(['POST']);
    return true;
  }

  const input = await context.readJsonBody();
  const result = handlers.chat?.private
    ? await handlers.chat.private(input)
    : commandFailed('not_implemented', 'Chat private handler is not configured.');
  context.sendJson(200, result);
  return true;
};
