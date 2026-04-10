import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandMissingFlag, commandUnknownSubcommand, readFlagValue } from './helpers';
import type { CliRuntimeContext } from '../types';

export async function runIdentityCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  if (args[0] !== 'create') {
    return commandUnknownSubcommand(`identity ${args.join(' ')}`.trim());
  }

  const name = readFlagValue(args, '--name');
  if (!name) {
    return commandMissingFlag('--name');
  }

  const handler = context.dependencies.identity?.create;
  if (!handler) {
    return commandFailed('not_implemented', 'Identity create handler is not configured.');
  }
  return handler({ name });
}
