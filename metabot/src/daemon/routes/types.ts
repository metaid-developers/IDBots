import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MetabotCommandResult } from '../../core/contracts/commandResult';

export type Awaitable<T> = T | Promise<T>;

export type MetabotUiPageName = 'hub' | 'publish' | 'my-services' | 'trace' | 'refund';

export interface MetabotDaemonHttpHandlers {
  daemon?: {
    getStatus?: () => Awaitable<MetabotCommandResult<unknown>>;
    doctor?: () => Awaitable<MetabotCommandResult<unknown>>;
  };
  identity?: {
    create?: (input: { name: string }) => Awaitable<MetabotCommandResult<unknown>>;
  };
  network?: {
    listServices?: (input: { online?: boolean }) => Awaitable<MetabotCommandResult<unknown>>;
  };
  services?: {
    publish?: (input: Record<string, unknown>) => Awaitable<MetabotCommandResult<unknown>>;
    call?: (input: Record<string, unknown>) => Awaitable<MetabotCommandResult<unknown>>;
  };
  trace?: {
    getTrace?: (input: { traceId: string }) => Awaitable<MetabotCommandResult<unknown>>;
  };
  ui?: {
    renderPage?: (page: MetabotUiPageName) => Awaitable<string>;
  };
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  handlers: MetabotDaemonHttpHandlers;
  readJsonBody: () => Promise<Record<string, unknown>>;
  sendJson: (status: number, payload: unknown) => void;
  sendHtml: (status: number, html: string) => void;
  sendMethodNotAllowed: (allowed: string[]) => void;
}

export type RouteHandler = (context: RouteContext) => Promise<boolean>;
