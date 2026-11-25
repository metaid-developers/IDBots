import fs from 'node:fs';
import { HostAgentClient } from './agent/client.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const url = required('AGENT_URL');
  const secure = url.startsWith('wss://');
  const certFile = process.env.AGENT_TLS_CERT_FILE;
  const keyFile = process.env.AGENT_TLS_KEY_FILE;
  const caFile = process.env.AGENT_TLS_CA_FILE;
  if (secure && (!certFile || !keyFile || !caFile)) {
    throw new Error('AGENT_TLS_CERT_FILE, AGENT_TLS_KEY_FILE, and AGENT_TLS_CA_FILE are required for wss');
  }
  const client = new HostAgentClient({
    url,
    hostId: required('AGENT_HOST_ID'),
    token: required('AGENT_TOKEN'),
    dockerUrl: process.env.AGENT_DOCKER_URL ?? 'http+unix:///var/run/docker.sock',
    ...(secure ? {
      tls: {
        cert: fs.readFileSync(certFile!),
        key: fs.readFileSync(keyFile!),
        ca: fs.readFileSync(caFile!),
        rejectUnauthorized: true,
      },
    } : {}),
  });
  await client.start();
  console.log(JSON.stringify({ level: 'info', component: 'host-agent', msg: 'connected', hostId: process.env.AGENT_HOST_ID }));
  const shutdown = (): void => {
    void client.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', component: 'host-agent', msg: 'fatal startup error', error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
