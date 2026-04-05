import path from 'node:path';
import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';

export function readFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return typeof value === 'string' ? value : null;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export async function readJsonFile(
  context: CliRuntimeContext,
  filePath: string
): Promise<Record<string, unknown>> {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(context.cwd, filePath);
  const raw = await context.readTextFile(resolved);
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object input.');
  }
  return parsed as Record<string, unknown>;
}

export function commandMissingFlag(flag: string): MetabotCommandResult<never> {
  return commandFailed('missing_flag', `Missing required flag ${flag}.`);
}

export function commandUnknownSubcommand(command: string): MetabotCommandResult<never> {
  return commandFailed('unknown_command', `Unknown command: ${command}`);
}
