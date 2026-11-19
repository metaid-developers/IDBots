import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

/**
 * Synthetic event passed to handlers when an invoke arrives over the mobile
 * gateway instead of a renderer. Shape is frozen by REQ-A-13: handlers may
 * rely on `sender`/`senderFrame` being null and on `gateway.clientId`.
 */
export interface GatewayInvokeContext {
  clientId: string;
}

export interface SyntheticGatewayInvokeEvent {
  sender: null;
  senderFrame: null;
  gateway: GatewayInvokeContext;
}

export type RegisteredIpcHandler = (
  event: IpcMainInvokeEvent | SyntheticGatewayInvokeEvent,
  ...args: any[]
) => any;

/**
 * P0-a (#149): true when the invoke arrived over the gateway instead of a
 * renderer. Discriminates on the frozen REQ-A-13 shape — a synthetic gateway
 * event carries `gateway.clientId` with null sender/senderFrame, a renderer
 * invoke has a real sender frame and no `gateway`. Handlers that record WHO
 * acted must derive the status-event actor from this discriminator instead of
 * assuming the caller: a gateway invoke is the chair acting remotely, a
 * renderer invoke is the owner's UI action.
 */
export function isGatewayInvokeEvent(
  event: IpcMainInvokeEvent | SyntheticGatewayInvokeEvent,
): event is SyntheticGatewayInvokeEvent {
  const candidate = event as Partial<SyntheticGatewayInvokeEvent>;
  return typeof candidate.gateway?.clientId === 'string';
}

const handlers = new Map<string, RegisteredIpcHandler>();

/**
 * Single registration point for every invoke channel in the main process.
 * Desktop behavior is identical to calling `ipcMain.handle` directly; the
 * handler is additionally recorded so the gateway can dispatch to it without
 * a renderer (REQ-A-12).
 */
export function registerIpcHandler(channel: string, handler: RegisteredIpcHandler): void {
  ipcMain.handle(channel, handler);
  handlers.set(channel, handler);
}

export function getRegisteredIpcHandler(channel: string): RegisteredIpcHandler | undefined {
  return handlers.get(channel);
}

export function hasRegisteredIpcHandler(channel: string): boolean {
  return handlers.has(channel);
}

export function listRegisteredIpcChannels(): string[] {
  return [...handlers.keys()];
}

/**
 * Invoke a registered handler from the gateway with a synthetic event.
 * The return value is whatever the handler returns (already a promise of the
 * IPC result, as with a real renderer invoke).
 */
export async function invokeRegisteredHandler(
  channel: string,
  clientId: string,
  args: unknown[],
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No IPC handler registered for channel: ${channel}`);
  }
  const event: SyntheticGatewayInvokeEvent = {
    sender: null,
    senderFrame: null,
    gateway: { clientId },
  };
  return handler(event, ...args);
}
