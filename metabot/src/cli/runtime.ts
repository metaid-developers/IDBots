import { commandFailed, commandSuccess, type MetabotCommandResult } from '../core/contracts/commandResult';
import type { CliDependencies, CliRuntimeContext } from './types';

const DEFAULT_DAEMON_BASE_URL = 'http://127.0.0.1:4827';

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || DEFAULT_DAEMON_BASE_URL;
}

async function requestJson<T>(
  baseUrl: string,
  method: 'GET' | 'POST',
  routePath: string,
  body?: Record<string, unknown>
): Promise<MetabotCommandResult<T>> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json() as Promise<MetabotCommandResult<T>>;
}

export function createDefaultCliDependencies(context: CliRuntimeContext): CliDependencies {
  const baseUrl = normalizeBaseUrl(context.env.METABOT_DAEMON_BASE_URL);

  return {
    daemon: {
      start: async () => commandFailed(
        'not_implemented',
        'Daemon process startup is not wired yet. Start the daemon from a host adapter or set METABOT_DAEMON_BASE_URL.'
      ),
    },
    doctor: {
      run: async () => requestJson(baseUrl, 'GET', '/api/doctor'),
    },
    identity: {
      create: async (input) => requestJson(baseUrl, 'POST', '/api/identity/create', input),
    },
    network: {
      listServices: async (input) => {
        const query = input.online === undefined ? '' : `?online=${input.online ? 'true' : 'false'}`;
        return requestJson(baseUrl, 'GET', `/api/network/services${query}`);
      },
    },
    services: {
      publish: async () => commandFailed(
        'not_implemented',
        'Service publish is not wired to a daemon route yet.'
      ),
      call: async (input) => requestJson(baseUrl, 'POST', '/api/services/call', input),
    },
    chat: {
      run: async () => commandFailed('not_implemented', 'Chat command is not implemented yet.'),
    },
    trace: {
      get: async (input) => requestJson(baseUrl, 'GET', `/api/trace/${encodeURIComponent(input.traceId)}`),
    },
    ui: {
      open: async (input) => commandSuccess({
        page: input.page,
        localUiUrl: `${baseUrl}/ui/${input.page}`,
      }),
    },
  };
}

export function mergeCliDependencies(context: CliRuntimeContext): CliDependencies {
  const defaults = createDefaultCliDependencies(context);
  const provided = context.dependencies;
  return {
    daemon: { ...defaults.daemon, ...provided.daemon },
    doctor: { ...defaults.doctor, ...provided.doctor },
    identity: { ...defaults.identity, ...provided.identity },
    network: { ...defaults.network, ...provided.network },
    services: { ...defaults.services, ...provided.services },
    chat: { ...defaults.chat, ...provided.chat },
    trace: { ...defaults.trace, ...provided.trace },
    ui: { ...defaults.ui, ...provided.ui },
  };
}
