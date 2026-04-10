import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandMissingFlag, commandUnknownSubcommand, readFlagValue } from './helpers';
import type { CliRuntimeContext } from '../types';

export async function runUiCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  if (args[0] !== 'open') {
    return commandUnknownSubcommand(`ui ${args.join(' ')}`.trim());
  }

  const page = readFlagValue(args, '--page');
  if (!page) {
    return commandMissingFlag('--page');
  }

  const handler = context.dependencies.ui?.open;
  if (!handler) {
    return commandFailed('not_implemented', 'UI open handler is not configured.');
  }
  return handler({ page });
}
