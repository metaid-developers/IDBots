import { promises as fs } from 'node:fs';
import type { MetabotCommandResult } from '../core/contracts/commandResult';

export type Awaitable<T> = T | Promise<T>;

export interface CliDependencies {
  daemon?: {
    start?: () => Awaitable<MetabotCommandResult<unknown>>;
  };
  doctor?: {
    run?: () => Awaitable<MetabotCommandResult<unknown>>;
  };
  identity?: {
    create?: (input: { name: string }) => Awaitable<MetabotCommandResult<unknown>>;
  };
  network?: {
    listServices?: (input: { online?: boolean }) => Awaitable<MetabotCommandResult<unknown>>;
    listSources?: () => Awaitable<MetabotCommandResult<unknown>>;
    addSource?: (input: { baseUrl: string; label?: string }) => Awaitable<MetabotCommandResult<unknown>>;
    removeSource?: (input: { baseUrl: string }) => Awaitable<MetabotCommandResult<unknown>>;
  };
  services?: {
    publish?: (input: Record<string, unknown>) => Awaitable<MetabotCommandResult<unknown>>;
    call?: (input: Record<string, unknown>) => Awaitable<MetabotCommandResult<unknown>>;
  };
  chat?: {
    private?: (input: Record<string, unknown>) => Awaitable<MetabotCommandResult<unknown>>;
  };
  trace?: {
    get?: (input: { traceId: string }) => Awaitable<MetabotCommandResult<unknown>>;
  };
  ui?: {
    open?: (input: { page: string }) => Awaitable<MetabotCommandResult<unknown>>;
  };
}

export interface CliContext {
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  dependencies?: CliDependencies;
  readTextFile?: (filePath: string) => Promise<string>;
}

export interface CliRuntimeContext {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  readTextFile: (filePath: string) => Promise<string>;
  dependencies: CliDependencies;
}

export function createCliRuntimeContext(context: CliContext = {}): CliRuntimeContext {
  return {
    stdout: context.stdout ?? process.stdout,
    stderr: context.stderr ?? process.stderr,
    env: context.env ?? process.env,
    cwd: context.cwd ?? process.cwd(),
    readTextFile: context.readTextFile ?? ((filePath) => fs.readFile(filePath, 'utf8')),
    dependencies: context.dependencies ?? {},
  };
}
