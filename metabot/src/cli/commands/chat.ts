import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandMissingFlag, commandUnknownSubcommand, readFlagValue, readJsonFile } from './helpers';
import type { CliRuntimeContext } from '../types';

export async function runChatCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  if (args[0] !== 'private') {
    return commandUnknownSubcommand(`chat ${args.join(' ')}`.trim());
  }

  const requestFile = readFlagValue(args, '--request-file');
  if (!requestFile) {
    return commandMissingFlag('--request-file');
  }

  const handler = context.dependencies.chat?.private;
  if (!handler) {
    return commandFailed('not_implemented', 'Chat private handler is not configured.');
  }

  const request = await readJsonFile(context, requestFile);
  return handler(request);
}
