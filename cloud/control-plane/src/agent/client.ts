import { randomBytes } from 'node:crypto';
import WebSocket, { type ClientOptions } from 'ws';
import { openDb } from '../db/index.js';
import { loadConfig } from '../config.js';
import { DockerClient } from '../docker/client.js';
import { encryptSecret } from '../crypto.js';
import { FakeSmsProvider } from '../sms.js';
import { MetricsRegistry } from '../metrics.js';
import { PushDeliveryService } from '../services/pushDelivery.js';
import { upgradeTenants } from '../services/upgrade.js';
import type { AppContext } from '../context.js';
import type { AgentRequestMessage, AgentResponseMessage, RemoteUpgradeResult, RemoteUpgradeTask } from './protocol.js';

export class HostAgentClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: {
    url: string;
    hostId: string;
    token: string;
    dockerUrl: string;
    tls?: Pick<ClientOptions, 'cert' | 'key' | 'ca' | 'rejectUnauthorized'>;
  }) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const url = new URL(this.options.url);
    url.searchParams.set('hostId', this.options.hostId);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        ...this.options.tls,
        headers: { 'x-idbots-agent-token': this.options.token },
      });
      this.socket = socket;
      socket.on('open', () => resolve());
      socket.on('error', (error) => reject(error));
      socket.on('message', (data) => {
        void this.handle(data.toString()).catch(() => undefined);
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        if (!this.stopped) {
          this.reconnectTimer = setTimeout(() => {
            void this.connect().catch(() => undefined);
          }, 5000);
          this.reconnectTimer.unref();
        }
      });
    });
  }

  private async handle(raw: string): Promise<void> {
    const message = JSON.parse(raw) as AgentRequestMessage;
    if (message.type !== 'request') return;
    const response: AgentResponseMessage = { type: 'response', id: message.id, ok: true };
    try {
      if (message.action === 'preflight') {
        const { image } = message.payload as { image: string };
        const docker = new DockerClient(this.options.dockerUrl);
        try {
          await docker.imageInspect(image);
        } catch {
          await docker.pullImage(image);
          await docker.imageInspect(image);
        }
        response.payload = { ready: true };
      } else {
        response.payload = await this.upgrade(message.payload as RemoteUpgradeTask);
      }
    } catch (err) {
      response.ok = false;
      response.error = err instanceof Error ? err.message : String(err);
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(response));
  }

  private async upgrade(task: RemoteUpgradeTask): Promise<RemoteUpgradeResult> {
    const db = openDb(':memory:');
    try {
      const masterKey = randomBytes(32);
      const now = Date.now();
      db.prepare("INSERT INTO users (id, phone_e164, display_name, locale, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
        .run(task.user.id, `agent-${task.user.id}`, task.user.displayName, task.user.locale, now);
      db.prepare(`INSERT INTO tenants (
        id, user_id, host_id, container_name, volume_name, image, previous_image,
        gateway_secret_enc, status, app_version, contract_version, image_digest, created_at, updated_at
      ) VALUES (?, ?, 'remote', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          task.tenant.id,
          task.user.id,
          task.tenant.containerName,
          task.tenant.volumeName,
          task.tenant.image,
          task.tenant.previousImage,
          encryptSecret(masterKey, task.gatewaySecret),
          task.tenant.status,
          task.tenant.appVersion,
          task.tenant.contractVersion,
          task.tenant.imageDigest,
          now,
          now,
        );
      const env: NodeJS.ProcessEnv = {
        CP_PUBLIC_ORIGIN: task.config.publicOrigin,
        CP_DB_PATH: ':memory:',
        CP_MASTER_KEY: masterKey.toString('base64'),
        CP_DOCKER_URL: this.options.dockerUrl,
        CP_TENANT_IMAGE: task.newImage,
        CP_TENANT_NETWORK: task.config.tenantNetwork,
        CP_TENANT_MEMORY_MB: String(task.config.tenantMemoryMb),
        CP_TENANT_CPUS: String(task.config.tenantCpus),
        CP_SMS_MODE: 'fake',
        CP_SMS_FAKE_ORIGIN_EXPLICIT: 'true',
        CP_FAKE_SMS_NUMBERS: '+8613900000000',
      };
      for (const [key, value] of Object.entries(task.config.tenantEnv)) env[`CP_TENANT_ENV_${key}`] = value;
      const config = loadConfig(env);
      const app: AppContext = {
        config,
        db,
        docker: new DockerClient(this.options.dockerUrl),
        sms: new FakeSmsProvider([]),
        poller: null,
        metrics: new MetricsRegistry(),
        push: new PushDeliveryService(db, config),
      };
      const [result] = await upgradeTenants(app, [task.tenant.id], task.newImage, {
        operator: 'host-agent',
        readyTimeoutMs: task.readyTimeoutMs,
        readyPollMs: task.readyPollMs,
      });
      const tenant = db.prepare(`SELECT status, image, previous_image, image_digest,
        app_version, contract_version, last_error FROM tenants WHERE id = ?`).get(task.tenant.id) as RemoteUpgradeResult['tenant'];
      return { result, tenant };
    } finally {
      db.close();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (!this.socket) return;
    await new Promise<void>((resolve) => {
      this.socket!.once('close', () => resolve());
      this.socket!.close(1000, 'agent shutdown');
      setTimeout(resolve, 2000).unref();
    });
  }
}
