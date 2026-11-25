import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AppContext } from '../context.js';
import { sha256Hex } from '../crypto.js';
import type { AgentResponseMessage, RemoteUpgradeResult, RemoteUpgradeTask } from './protocol.js';

interface PendingRequest {
  hostId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function fingerprint(socket: unknown): string | null {
  const certificate = (socket as TLSSocket).getPeerCertificate?.();
  const value = certificate?.fingerprint256;
  return value ? value.replaceAll(':', '').toUpperCase() : null;
}

export class HostAgentGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly app: AppContext, private readonly options: { requireMtls: boolean }) {}

  attach(server: http.Server, path = '/internal/v1/host-agent'): void {
    server.on('upgrade', (req, socket: Duplex, head) => {
      void this.authorize(req, socket).then((hostId) => {
        if (!hostId) return;
        this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(hostId, ws));
      });
    });
    server.on('request', (req, res) => {
      if (req.url?.split('?')[0] === path) {
        res.writeHead(426, { Connection: 'Upgrade', Upgrade: 'websocket' });
        res.end();
      }
    });
  }

  private async authorize(req: http.IncomingMessage, socket: Duplex): Promise<string | null> {
    const reject = (status: number): null => {
      socket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return null;
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const hostId = url.searchParams.get('hostId') ?? '';
    const host = this.app.db.prepare('SELECT id, agent_token_hash, agent_fingerprint FROM hosts WHERE id = ? AND status = \'active\'')
      .get(hostId) as { id: string; agent_token_hash: string | null; agent_fingerprint: string | null } | undefined;
    if (!host) return reject(403);
    const token = String(req.headers['x-idbots-agent-token'] ?? '');
    if (host.agent_token_hash && sha256Hex(token) !== host.agent_token_hash) return reject(403);
    if (!host.agent_token_hash && !this.options.requireMtls) return reject(403);
    if (this.options.requireMtls) {
      const actual = fingerprint(socket);
      const expected = host.agent_fingerprint?.replaceAll(':', '').toUpperCase();
      if (!actual || !expected || actual !== expected) return reject(403);
    }
    return hostId;
  }

  private connected(hostId: string, socket: WebSocket): void {
    this.sockets.get(hostId)?.close(1001, 'replaced by a new agent connection');
    this.sockets.set(hostId, socket);
    this.app.db.prepare('UPDATE hosts SET agent_last_seen_at = ? WHERE id = ?').run(Date.now(), hostId);
    socket.on('message', (data: RawData) => {
      try {
        const message = JSON.parse(data.toString()) as AgentResponseMessage;
        if (message.type !== 'response') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.payload);
        else pending.reject(new Error(message.error ?? 'host agent request failed'));
      } catch {
        // Invalid frames are ignored; they never become executable requests.
      }
    });
    socket.on('close', () => {
      if (this.sockets.get(hostId) === socket) this.sockets.delete(hostId);
      for (const [id, pending] of this.pending) {
        if (pending.hostId !== hostId) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`host agent ${hostId} disconnected`));
      }
    });
  }

  connectedHostIds(): string[] {
    return [...this.sockets.keys()];
  }

  private request(hostId: string, action: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const socket = this.sockets.get(hostId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`host agent ${hostId} is not connected`));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host agent ${hostId} ${action} timed out`));
      }, timeoutMs);
      this.pending.set(id, { hostId, resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'request', id, action, payload }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async preflight(hostId: string, image: string): Promise<void> {
    await this.request(hostId, 'preflight', { image }, 30 * 60_000);
  }

  async upgrade(hostId: string, task: RemoteUpgradeTask): Promise<RemoteUpgradeResult> {
    return await this.request(hostId, 'upgrade', task, Math.max(300_000, (task.readyTimeoutMs ?? 300_000) * 2 + 60_000)) as RemoteUpgradeResult;
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('host agent gateway is shutting down'));
    }
    this.pending.clear();
    for (const socket of this.sockets.values()) socket.close(1001, 'control plane shutdown');
    this.sockets.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
