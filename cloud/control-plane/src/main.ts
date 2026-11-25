import fs from 'node:fs';
import https from 'node:https';
import { loadConfig } from './config.js';
import { openDb, ensureHostRow } from './db/index.js';
import { sha256Hex } from './crypto.js';
import { DockerClient } from './docker/client.js';
import { AliyunSmsProvider, FakeSmsProvider, type SmsProvider } from './sms.js';
import { createPublicServer, createMetricsServer } from './server.js';
import { TenantPoller } from './services/poller.js';
import { reconcileAtStartup } from './services/reconcile.js';
import { MetricsRegistry } from './metrics.js';
import type { AppContext } from './context.js';
import { PushDeliveryService } from './services/pushDelivery.js';
import { SqliteRolloutStore } from './rollout/sqliteStore.js';
import { PostgresRolloutStore } from './rollout/postgresStore.js';
import { RolloutManager } from './rollout/manager.js';
import { HostAgentGateway } from './agent/gateway.js';

/**
 * Process entry point: load config, open the database (running migrations),
 * seed the single v1 hosts row from config, reconcile the tenants table
 * against the containers that exist, start the status poller, then serve.
 * Graceful shutdown on SIGTERM/SIGINT.
 */

function parseListen(listen: string): { host: string; port: number } {
  const idx = listen.lastIndexOf(':');
  return { host: listen.slice(0, idx), port: Number(listen.slice(idx + 1)) };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = openDb(config.dbPath);

  const hostId = config.hostId ?? `h_${sha256Hex(config.dockerUrl).slice(0, 20)}`;
  ensureHostRow(db, {
    id: hostId,
    dockerUrl: config.dockerUrl,
    capacity: config.hostCapacity,
    status: 'active',
    environment: config.environment,
  });

  const docker = new DockerClient(config.dockerUrl);
  const localHostId = hostId;
  const sms: SmsProvider =
    config.smsMode === 'fake'
      ? new FakeSmsProvider(config.fakeSmsNumbers)
      : new AliyunSmsProvider(config.sms);

  const app: AppContext = { config, db, docker, sms, poller: null, metrics: new MetricsRegistry(), push: new PushDeliveryService(db, config) };
  app.localHostId = localHostId;
  app.metrics.gaugeFn('cp_host_agents_connected', () => app.hostAgents?.connectedHostIds().length ?? 0);
  app.push.start();
  const rolloutStore = config.rolloutDatabaseUrl
    ? await PostgresRolloutStore.connect(config.rolloutDatabaseUrl)
    : new SqliteRolloutStore(db);
  const rolloutManager = new RolloutManager(app, rolloutStore);
  app.rollouts = rolloutManager;
  await rolloutStore.requeueInFlight(Date.now());

  // REQ-B-11: reconcile before the poller takes over.
  await reconcileAtStartup(app).catch((err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        component: 'reconcile',
        msg: 'reconcile failed; continuing startup',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });

  const poller = new TenantPoller(app, {});
  app.poller = poller;
  poller.start();
  let agentServer: https.Server | null = null;
  if (config.agent) {
    const gateway = new HostAgentGateway(app, { requireMtls: true });
    app.hostAgents = gateway;
    agentServer = https.createServer({
      cert: fs.readFileSync(config.agent.tlsCertFile),
      key: fs.readFileSync(config.agent.tlsKeyFile),
      ca: fs.readFileSync(config.agent.tlsCaFile),
      requestCert: true,
      rejectUnauthorized: true,
    });
    gateway.attach(agentServer);
    const agentListen = parseListen(config.agent.listen);
    agentServer.listen(agentListen.port, agentListen.host);
  }
  await rolloutManager.start();

  const publicServer = createPublicServer(app);
  const metricsServer = createMetricsServer(app);
  const publicListen = parseListen(config.listen);
  const metricsListen = parseListen(config.metricsListen);

  publicServer.listen(publicListen.port, publicListen.host, () => {
    console.log(JSON.stringify({ msg: 'control-plane listening', listen: config.listen }));
  });
  metricsServer.listen(metricsListen.port, metricsListen.host);

  const shutdown = (signal: string): void => {
    console.log(JSON.stringify({ msg: 'shutting down', signal }));
    app.push.stop();
    void (async () => {
      await rolloutManager.stop();
      if (rolloutStore instanceof PostgresRolloutStore) await rolloutStore.close();
      await app.hostAgents?.close();
      if (agentServer) await new Promise<void>((resolve) => agentServer.close(() => resolve()));
      await poller.stop();
      await new Promise<void>((resolve) => publicServer.close(() => resolve()));
      await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    })().finally(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: 'fatal startup error', error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
