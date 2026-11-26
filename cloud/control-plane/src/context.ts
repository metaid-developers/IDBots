import type Database from 'better-sqlite3';
import type { ControlPlaneConfig } from './config.js';
import type { DockerClient } from './docker/client.js';
import type { SmsProvider } from './sms.js';
import type { TenantPoller } from './services/poller.js';
import type { MetricsRegistry } from './metrics.js';
import type { PushDeliveryService } from './services/pushDelivery.js';
import type { RolloutManager } from './rollout/manager.js';
import type { HostAgentGateway } from './agent/gateway.js';

/** Shared application context passed to routes and services. */
export interface AppContext {
  config: ControlPlaneConfig;
  db: Database.Database;
  docker: DockerClient;
  sms: SmsProvider;
  poller: TenantPoller | null;
  metrics: MetricsRegistry;
  push: PushDeliveryService;
  rollouts?: RolloutManager;
  hostAgents?: HostAgentGateway;
  localHostId?: string;
}
