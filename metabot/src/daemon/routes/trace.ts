import { commandFailed } from '../../core/contracts/commandResult';
import type { RouteHandler } from './types';

const TRACE_ROUTE_PREFIX = '/api/trace/';

export const handleTraceRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;

  if (!url.pathname.startsWith(TRACE_ROUTE_PREFIX)) {
    return false;
  }

  if (req.method !== 'GET') {
    context.sendMethodNotAllowed(['GET']);
    return true;
  }

  const traceId = decodeURIComponent(url.pathname.slice(TRACE_ROUTE_PREFIX.length)).trim();
  const result = handlers.trace?.getTrace
    ? await handlers.trace.getTrace({ traceId })
    : commandFailed('not_implemented', 'Trace handler is not configured.');
  context.sendJson(200, result);
  return true;
};
