/**
 * Socket.IO client for idchat.io message push.
 * Used by MetaWeb listener to receive group/private chat and protocol events.
 */

import { io, Socket } from 'socket.io-client';

export interface MetaWebSocketConfig {
  url: string;
  path: string;
  metaid: string;
  type: 'app' | 'pc';
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
}

export type MessageHandler = (data: unknown) => void;

export class SocketIOClient {
  private socket: Socket | null = null;
  private config: MetaWebSocketConfig;
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private isHeartbeatRunning = false;
  private onMessage: MessageHandler;

  constructor(config: MetaWebSocketConfig, onMessage: MessageHandler) {
    this.config = {
      heartbeatInterval: 30000,
      heartbeatTimeout: 10000,
      ...config,
    };
    this.onMessage = onMessage;
  }

  connect(): void {
    try {
      this.socket = io(this.config.url, {
        path: this.config.path,
        query: {
          metaid: this.config.metaid,
          type: this.config.type,
        },
      });

      this.socket.on('connect', () => {
        this.startHeartbeat();
      });

      this.socket.on('disconnect', (reason: string) => {
        this.stopHeartbeat();
      });

      this.socket.on('connect_error', (error: Error) => {
        this.stopHeartbeat();
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
    } catch (error) {
      console.error('[MetaWebSocket] connect failed:', error);
    }
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
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}
