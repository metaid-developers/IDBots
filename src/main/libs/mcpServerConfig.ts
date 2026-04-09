export type UserConfiguredMcpServerDefinition = {
  name: string;
  transportType: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export type UserConfiguredMcpServerConfig =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: 'sse' | 'http';
      url: string;
      headers?: Record<string, string>;
    };

function normalizeRecord<T extends Record<string, string> | undefined>(value: T): T | undefined {
  if (!value || Object.keys(value).length === 0) {
    return undefined;
  }
  return { ...value } as T;
}

export function buildUserConfiguredMcpServerConfigs(
  servers: UserConfiguredMcpServerDefinition[],
  existingServerNames: Set<string> = new Set(),
): Record<string, UserConfiguredMcpServerConfig> {
  const configs: Record<string, UserConfiguredMcpServerConfig> = {};

  for (const server of servers) {
    const name = String(server.name || '').trim();
    if (!name || existingServerNames.has(name) || name in configs) {
      continue;
    }

    switch (server.transportType) {
      case 'stdio': {
        const command = String(server.command || '').trim();
        if (!command) {
          continue;
        }
        const args = Array.isArray(server.args) && server.args.length > 0
          ? [...server.args]
          : undefined;
        configs[name] = {
          type: 'stdio',
          command,
          args,
          env: normalizeRecord(server.env),
        };
        break;
      }
      case 'sse':
      case 'http': {
        const url = String(server.url || '').trim();
        if (!url) {
          continue;
        }
        configs[name] = {
          type: server.transportType,
          url,
          headers: normalizeRecord(server.headers),
        };
        break;
      }
      default:
        break;
    }
  }

  return configs;
}
