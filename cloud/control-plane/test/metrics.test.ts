import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { api, waitFor } from './helpers.js';
import { frameCollector, setupProxyTest, type ProxyTest } from './proxyHarness.js';
import { upgradeTenants } from '../src/services/upgrade.js';

async function scrape(url: string): Promise<string> {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.text();
}

describe('metrics and request logging (REQ-B-20)', () => {
  let t: ProxyTest;

  before(async () => {
    t = await setupProxyTest();
  });

  after(async () => {
    await t.close();
  });

  test('/metrics is not on the public port', async () => {
    const res = await fetch(`${t.cpBase}/metrics`);
    assert.equal(res.status, 404);
  });

  test('tenant gauges, provisioning histogram, request counter, sms counter, open sockets', async () => {
    // The harness tenant provisioned to ready during setup.
    let text = await scrape(t.app.metricsUrl);
    assert.match(text, /cp_tenants_by_status\{status="ready"\} 1/);
    assert.match(text, /cp_tenants_by_kind\{kind="customer"\} 1/);
    t.db.prepare("INSERT INTO hosts (id, docker_url, capacity, status, environment) VALUES ('h_testhost', 'http://docker.test', 27, 'active', 'staging')").run();
    text = await scrape(t.app.metricsUrl);
    assert.match(text, /cp_host_capacity\{host_id="h_testhost",environment="staging"\} 27/);
    assert.match(text, /cp_provisioning_duration_seconds_count\{?\}? 1/);
    assert.match(text, /cp_open_sockets 0/);

    // Drive the request counter and the sms counter.
    const me = await api(t.cpBase, '/api/v1/me', { cookie: t.cookie });
    assert.equal(me.status, 200);
    t.db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(t.phone);
    const send = await api(t.cpBase, '/api/v1/reverify/send', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic' },
    });
    assert.equal(send.status, 200);

    // Open a ws socket and watch the gauge move.
    const ws = new WebSocket(`${t.cpBase.replace(/^http/, 'ws')}/ws`, {
      headers: { Cookie: t.cookie, Origin: t.origin },
    });
    const { waitFrame } = frameCollector(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await waitFrame((f) => f.type === 'welcome');
    text = await scrape(t.app.metricsUrl);
    assert.match(text, /cp_open_sockets 1/);
    assert.match(text, /cp_http_requests_total\{route="\/api\/v1\/me",status="200"\} 1/);
    assert.match(text, /cp_sms_sends_total\{purpose="reverify",result="ok"\} 1/);
    ws.close();

    await waitFor(async () => {
      const text = await scrape(t.app.metricsUrl);
      return /cp_open_sockets 0/.test(text) ? true : null;
    });
  });

  test('an upgrade moves the upgrade duration histogram', async () => {
    await fetch(`${t.fake.url()}/fake/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: 'tenant:2.0.0',
        labels: { 'org.idbots.version': '2.0.0', 'org.idbots.rollback-safe-to': '' },
      }),
    });
    const results = await upgradeTenants(t.app.app, [t.tenantId], 'tenant:2.0.0', {
      operator: 'metrics-test',
      readyTimeoutMs: 8000,
      readyPollMs: 100,
    });
    assert.deepEqual(
      results.map((r) => r.outcome),
      ['upgraded'],
    );
    const text = await scrape(t.app.metricsUrl);
    assert.match(text, /cp_upgrade_duration_seconds_count\{result="upgraded"\} 1/);
  });
});
