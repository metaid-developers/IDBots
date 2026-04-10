import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandMissingFlag, commandUnknownSubcommand, readFlagValue } from './helpers';
import type { CliRuntimeContext } from '../types';

export async function runTraceCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  if (args[0] !== 'get') {
    return commandUnknownSubcommand(`trace ${args.join(' ')}`.trim());
  }

  const traceId = readFlagValue(args, '--trace-id');
  if (!traceId) {
    return commandMissingFlag('--trace-id');
  }

  const handler = context.dependencies.trace?.get;
  if (!handler) {
    return commandFailed('not_implemented', 'Trace handler is not configured.');
  }
  return handler({ traceId });
}
