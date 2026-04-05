#!/usr/bin/env node

import { commandFailed, type MetabotCommandResult } from '../core/contracts/commandResult';
import { runDaemonCommand } from './commands/daemon';
import { runDoctorCommand } from './commands/doctor';
import { runIdentityCommand } from './commands/identity';
import { runNetworkCommand } from './commands/network';
import { runServicesCommand } from './commands/services';
import { runChatCommand } from './commands/chat';
import { runTraceCommand } from './commands/trace';
import { runUiCommand } from './commands/ui';
import { commandUnknownSubcommand } from './commands/helpers';
import { createCliRuntimeContext, type CliContext } from './types';
import { mergeCliDependencies } from './runtime';

function resolveExitCode(result: MetabotCommandResult<unknown>): number {
  if (result.ok) return 0;
  if (result.state === 'waiting' || result.state === 'manual_action_required') return 2;
  return 1;
}

function writeJsonLine(context: ReturnType<typeof createCliRuntimeContext>, payload: unknown): void {
  context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export async function runCli(argv: string[], cliContext: CliContext = {}): Promise<number> {
  const context = createCliRuntimeContext(cliContext);
  context.dependencies = mergeCliDependencies(context);

  const [command, ...rest] = argv;
  let result: MetabotCommandResult<unknown>;

  try {
    switch (command) {
      case 'daemon':
        result = await runDaemonCommand(rest, context);
        break;
      case 'doctor':
        result = await runDoctorCommand(rest, context);
        break;
      case 'identity':
        result = await runIdentityCommand(rest, context);
        break;
      case 'network':
        result = await runNetworkCommand(rest, context);
        break;
      case 'services':
        result = await runServicesCommand(rest, context);
        break;
      case 'chat':
        result = await runChatCommand(rest, context);
        break;
      case 'trace':
        result = await runTraceCommand(rest, context);
        break;
      case 'ui':
        result = await runUiCommand(rest, context);
        break;
      case undefined:
        result = commandFailed('missing_command', 'No command provided.');
        break;
      default:
        result = commandUnknownSubcommand(command);
        break;
    }
  } catch (error) {
    result = commandFailed(
      'cli_execution_failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  writeJsonLine(context, result);
  return resolveExitCode(result);
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
