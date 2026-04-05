import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';

export async function runChatCommand(_args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  const handler = context.dependencies.chat?.run;
  if (!handler) {
    return commandFailed('not_implemented', 'Chat handler is not configured.');
  }
  return handler({});
}
