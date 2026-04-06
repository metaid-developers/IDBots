import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandMissingFlag, commandUnknownSubcommand, hasFlag, readFlagValue } from './helpers';
import type { CliRuntimeContext } from '../types';

export async function runNetworkCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  if (args[0] === 'services') {
    const handler = context.dependencies.network?.listServices;
    if (!handler) {
      return commandFailed('not_implemented', 'Network services handler is not configured.');
    }

    return handler({
      online: hasFlag(args, '--online') ? true : undefined,
    });
  }

  if (args[0] !== 'sources') {
    return commandUnknownSubcommand(`network ${args.join(' ')}`.trim());
  }

  const subcommand = args[1];

  if (subcommand === 'list') {
    const handler = context.dependencies.network?.listSources;
    if (!handler) {
      return commandFailed('not_implemented', 'Network source list handler is not configured.');
    }
    return handler();
  }

  if (subcommand === 'add') {
    const handler = context.dependencies.network?.addSource;
    if (!handler) {
      return commandFailed('not_implemented', 'Network source add handler is not configured.');
    }
    const baseUrl = readFlagValue(args, '--base-url');
    if (!baseUrl) {
      return commandMissingFlag('--base-url');
    }
    const label = readFlagValue(args, '--label') ?? undefined;
    return handler({ baseUrl, label });
  }

  if (subcommand === 'remove') {
    const handler = context.dependencies.network?.removeSource;
    if (!handler) {
      return commandFailed('not_implemented', 'Network source remove handler is not configured.');
    }
    const baseUrl = readFlagValue(args, '--base-url');
    if (!baseUrl) {
      return commandMissingFlag('--base-url');
    }
    return handler({ baseUrl });
  }

  return commandUnknownSubcommand(`network ${args.join(' ')}`.trim());
}
