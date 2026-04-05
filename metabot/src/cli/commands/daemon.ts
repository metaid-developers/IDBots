import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandUnknownSubcommand } from './helpers';
import type { CliRuntimeContext } from '../types';

export async function runDaemonCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  if (args[0] !== 'start') {
    return commandUnknownSubcommand(`daemon ${args.join(' ')}`.trim());
  }

  const handler = context.dependencies.daemon?.start;
  if (!handler) {
    return commandFailed('not_implemented', 'Daemon start handler is not configured.');
  }

  return handler();
}
