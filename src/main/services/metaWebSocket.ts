/**
 * Socket.IO client for idchat.io message push.
 * Used by MetaWeb listener to receive group/private chat and protocol events.
 */

import { io, Socket } from 'socket.io-client';

export interface MetaWebSocketEndpoint {
  url: string;
  path: string;
}

export interface MetaWebSocketConfig {
  url: string;
  path: string;
  metaid: string;
  type: 'app' | 'pc';
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  endpoints?: MetaWebSocketEndpoint[];
}

export type MessageHandler = (data: unknown) => void;

export class SocketIOClient {
  private socket: Socket | null = null;
  private config: MetaWebSocketConfig;
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private isHeartbeatRunning = false;
  private onMessage: MessageHandler;
  private endpoints: MetaWebSocketEndpoint[];
  private endpointIndex = 0;
  private hasConnected = false;

  constructor(config: MetaWebSocketConfig, onMessage: MessageHandler) {
    this.config = {
      heartbeatInterval: 30000,
      heartbeatTimeout: 10000,
      ...config,
    };
    this.onMessage = onMessage;
    this.endpoints = this.resolveEndpoints();
  }

  connect(): void {
    try {
      this.hasConnected = false;
      this.endpointIndex = 0;
      this.connectToEndpoint(this.endpointIndex);
    } catch (error) {
      console.error('[MetaWebSocket] connect failed:', error);
    }
  }

  private resolveEndpoints(): MetaWebSocketEndpoint[] {
    if (Array.isArray(this.config.endpoints) && this.config.endpoints.length > 0) {
      return this.config.endpoints;
    }
    return [{ url: this.config.url, path: this.config.path }];
  }

  private connectToEndpoint(index: number): void {
    const endpoint = this.endpoints[index];
    if (!endpoint) {
      return;
    }

    this.cleanupSocket();
    this.socket = io(endpoint.url, {
      path: endpoint.path,
      query: {
        metaid: this.config.metaid,
        type: this.config.type,
      },
    });

    this.socket.on('connect', () => {
      this.hasConnected = true;
      this.endpointIndex = index;
      this.startHeartbeat();
    });

    this.socket.on('disconnect', (_reason: string) => {
      this.stopHeartbeat();
      if (!this.hasConnected && this.tryFallback(index)) {
        return;
      }
    });

    this.socket.on('connect_error', (_error: Error) => {
      this.stopHeartbeat();
      if (!this.hasConnected && this.tryFallback(index)) {
        return;
      }
    });

    this.socket.on('message', (data: unknown) => {
      this.onMessage(data);
    });

    this.socket.on('heartbeat_ack', () => {
      if (this.heartbeatTimeoutId) {
        clearTimeout(this.heartbeatTimeoutId);
        this.heartbeatTimeoutId = null;
      }
    });

    this.socket.on('reconnect', () => {
      this.startHeartbeat();
    });
  }

  private tryFallback(currentIndex: number): boolean {
    if (currentIndex >= this.endpoints.length - 1) {
      return false;
    }
    this.endpointIndex = currentIndex + 1;
    this.connectToEndpoint(this.endpointIndex);
    return true;
  }

  private startHeartbeat(): void {
    if (this.isHeartbeatRunning) return;
    this.isHeartbeatRunning = true;
    this.stopHeartbeat();
    this.heartbeatIntervalId = setInterval(
      () => this.sendHeartbeat(),
      this.config.heartbeatInterval!
    );
    this.sendHeartbeat();
  }

  private stopHeartbeat(): void {
    this.isHeartbeatRunning = false;
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
    if (this.heartbeatTimeoutId) {
      clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.socket?.connected) return;
    try {
      this.socket.emit('ping');
    } catch (error) {
      console.error('[MetaWebSocket] heartbeat failed:', error);
    }
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.cleanupSocket();
    this.hasConnected = false;
  }

  isConnected(): boolean {
    return Boolean(this.socket?.connected);
  }

  private cleanupSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }
}
