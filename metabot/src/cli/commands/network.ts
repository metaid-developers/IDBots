import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandUnknownSubcommand, hasFlag } from './helpers';
import type { CliRuntimeContext } from '../types';

export async function runNetworkCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  if (args[0] !== 'services') {
    return commandUnknownSubcommand(`network ${args.join(' ')}`.trim());
  }

  const handler = context.dependencies.network?.listServices;
  if (!handler) {
    return commandFailed('not_implemented', 'Network services handler is not configured.');
  }

  return handler({
    online: hasFlag(args, '--online') ? true : undefined,
  });
}
