import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { commandMissingFlag, commandUnknownSubcommand, readFlagValue, readJsonFile } from './helpers';
import type { CliRuntimeContext } from '../types';

export async function runServicesCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  const subcommand = args[0];

  if (subcommand === 'publish') {
    const payloadFile = readFlagValue(args, '--payload-file');
    if (!payloadFile) {
      return commandMissingFlag('--payload-file');
    }

    const handler = context.dependencies.services?.publish;
    if (!handler) {
      return commandFailed('not_implemented', 'Services publish handler is not configured.');
    }

    const payload = await readJsonFile(context, payloadFile);
    return handler(payload);
  }

  if (subcommand === 'call') {
    const requestFile = readFlagValue(args, '--request-file');
    if (!requestFile) {
      return commandMissingFlag('--request-file');
    }

    const handler = context.dependencies.services?.call;
    if (!handler) {
      return commandFailed('not_implemented', 'Services call handler is not configured.');
    }

    const request = await readJsonFile(context, requestFile);
    return handler(request);
  }

  return commandUnknownSubcommand(`services ${args.join(' ')}`.trim());
}
