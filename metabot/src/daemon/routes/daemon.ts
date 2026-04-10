import { commandFailed } from '../../core/contracts/commandResult';
import type { RouteHandler } from './types';

export const handleDaemonRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;

  if (url.pathname === '/api/daemon/status') {
    if (req.method !== 'GET') {
      context.sendMethodNotAllowed(['GET']);
      return true;
    }

    const result = handlers.daemon?.getStatus
      ? await handlers.daemon.getStatus()
      : commandFailed('not_implemented', 'Daemon status handler is not configured.');
    context.sendJson(200, result);
    return true;
  }

  if (url.pathname === '/api/doctor') {
    if (req.method !== 'GET') {
      context.sendMethodNotAllowed(['GET']);
      return true;
    }

    const result = handlers.daemon?.doctor
      ? await handlers.daemon.doctor()
      : commandFailed('not_implemented', 'Doctor handler is not configured.');
    context.sendJson(200, result);
    return true;
  }

  return false;
};
