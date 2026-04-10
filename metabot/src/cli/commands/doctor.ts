import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';

export async function runDoctorCommand(_args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  const handler = context.dependencies.doctor?.run;
  if (!handler) {
    return commandFailed('not_implemented', 'Doctor handler is not configured.');
  }
  return handler();
}
