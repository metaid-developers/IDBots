import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { api } from './helpers.js';
import { setupProxyTest, type ProxyTest } from './proxyHarness.js';

const FIXTURE_PREFIX = (tenantId: string): string => `${tenantId} fixture file for proxy tests\n`;

describe('proxy HTTP routes (REQ-B-14, REQ-B-15)', () => {
  let t: ProxyTest;

  before(async () => {
    t = await setupProxyTest();
  });

  after(async () => {
    await t.close();
  });

  test('GET /files/{token} streams the fixture; Range requests return 206', async () => {
    const expected = FIXTURE_PREFIX(t.tenantId).repeat(128);

    const raw = await fetch(`${t.cpBase}/files/report.txt`, { headers: { Cookie: t.cookie } });
    assert.equal(raw.status, 200);
    assert.match(String(raw.headers.get('content-type')), /text\/plain/);
    assert.equal(String(raw.headers.get('cache-control')), 'no-store');
    assert.equal(await raw.text(), expected);

    const ranged = await fetch(`${t.cpBase}/files/report.txt`, {
      headers: { Cookie: t.cookie, Range: 'bytes=0-3' },
    });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), expected.slice(0, 4));
    assert.match(String(ranged.headers.get('content-range')), /bytes 0-3\/\d+/);
  });

  test('F-11 security: GET /files/{token} without a session cookie is rejected 401', async () => {
    // The signed token alone must not be enough: the browser route is
    // cookie-gated, so an unauthenticated client (no PWA session) cannot
    // pull tenant files even with a leaked token string.
    const noCookie = await fetch(`${t.cpBase}/files/report.txt`);
    assert.equal(noCookie.status, 401);
    const body = (await noCookie.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');

    // A garbage/foreign session cookie is rejected the same way.
    const badCookie = await fetch(`${t.cpBase}/files/report.txt`, {
      headers: { Cookie: 'idb_session=not-a-session' },
    });
    assert.equal(badCookie.status, 401);
  });

  test('malformed percent encoding on a :param route answers 400 BAD_REQUEST, not 500', async () => {
    // '%zz' makes decodeURIComponent throw URIError inside matchPath.
    // Unguarded, that throw escaped through handle()'s catch-all as
    // 500 INTERNAL on a pre-auth path; it is a client mistake and must read
    // as one — the same posture as the tenant gateway's decodePathSegment
    // (PR #175). Auth runs after routing, so no cookie is needed to observe
    // the status. The 5-segment POST route proves the guard is router-level,
    // not a /files special case.
    for (const pathname of ['/files/%zz', '/files/%E0%A4%A', '/files/%']) {
      const res = await fetch(`${t.cpBase}${pathname}`);
      assert.equal(res.status, 400, `${pathname} must answer 400, not 500`);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'BAD_REQUEST', `${pathname} must carry the C3 error envelope`);
    }
    const nested = await fetch(`${t.cpBase}/internal/v1/tenants/%zz/notifications`, { method: 'POST' });
    assert.equal(nested.status, 400, 'a malformed param on a 5-segment route answers 400 too');

    // The control plane is still serving after every malformed hit.
    const health = await fetch(`${t.cpBase}/health`);
    assert.equal(health.status, 200, 'the control plane must survive malformed percent encoding');

    // A well-formed param still routes (here: the usual 401 cookie gate).
    const wellFormed = await fetch(`${t.cpBase}/files/report.txt`);
    assert.equal(wellFormed.status, 401);
  });

  test('POST /upload streams to the tenant and reports path/size/mime', async () => {
    const content = 'hello proxy upload\n';
    const res = await fetch(`${t.cpBase}/upload?name=${encodeURIComponent('note.txt')}`, {
      method: 'POST',
      headers: {
        Cookie: t.cookie,
        Origin: t.origin,
        'Content-Type': 'text/plain',
      },
      body: content,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { path: string; size: number; mime: string };
    assert.equal(body.size, content.length);
    assert.equal(body.mime, 'text/plain');
    assert.match(body.path, /^\/data\/workspace\/uploads\//);

    // The bytes landed in the fake tenant's data dir.
    const containers = ([...t.fake.containers.values()] as unknown as Array<{ name: string; dataDir: string }>).filter(
      (c) => c.name === `idb-${t.tenantId}`,
    );
    assert.equal(containers.length, 1);
    const files = fs.readdirSync(containers[0].dataDir).filter((name: string) => name.endsWith('-note.txt'));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(`${containers[0].dataDir}/${files[0]}`, 'utf8'), content);
  });

  test('an upload over 25 MB is cut by the proxy with 413', async () => {
    const startedAt = Date.now();
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `${t.cpBase}/upload?name=big.bin`,
        {
          method: 'POST',
          headers: { Cookie: t.cookie, Origin: t.origin, 'Content-Type': 'application/octet-stream' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      // Stream 26 x 1 MB; the proxy must answer 413 well before this finishes.
      let sent = 0;
      const chunk = Buffer.alloc(1024 * 1024, 7);
      const writeNext = (): void => {
        if (sent >= 26) {
          req.end();
          return;
        }
        sent += 1;
        if (req.write(chunk)) {
          setImmediate(writeNext);
        } else {
          req.once('drain', writeNext);
        }
      };
      writeNext();
    });
    assert.equal(result.status, 413);
    assert.match(result.body, /PAYLOAD_TOO_LARGE/);
    assert.ok(Date.now() - startedAt < 20_000, '413 answered promptly, not after the full body');
  });

  test('GET /app/ serves the fixture bundle with cache headers', async () => {
    const index = await fetch(`${t.cpBase}/app/`, { headers: { Cookie: t.cookie } });
    assert.equal(index.status, 200);
    assert.match(await index.text(), /fake tenant app fixture/);
    assert.equal(index.headers.get('cache-control'), 'no-cache');

    const asset = await fetch(`${t.cpBase}/app/assets/app.fake123.js`, { headers: { Cookie: t.cookie } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  test('GET an app deep link without a cookie redirects to login with its return path', async () => {
    const res = await fetch(`${t.cpBase}/app/notifications/event-1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/login?returnTo=${encodeURIComponent('/app/notifications/event-1')}`);
  });

  test('POST /upload without an Origin is rejected 403', async () => {
    const res = await api(t.cpBase, '/upload?name=a.txt', {
      method: 'POST',
      cookie: t.cookie,
      origin: null,
      body: 'x',
    });
    assert.equal(res.status, 403);
    assert.equal((res.json as { error: { code: string } }).error.code, 'ORIGIN_NOT_ALLOWED');
  });

  test('REQ-B-15: query and header tenant hints never reroute HTTP routes', async () => {
    const res = await fetch(`${t.cpBase}/files/hint.txt?tenant=t_attacker`, {
      headers: { Cookie: t.cookie, 'X-IDBots-Tenant': 't_attacker' },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), FIXTURE_PREFIX(t.tenantId).repeat(128));
  });

  test('tenant not ready: /files and /upload answer 503 TENANT_NOT_READY; /app redirects', async () => {
    t.db.prepare("UPDATE tenants SET status = 'stopped' WHERE id = ?").run(t.tenantId);

    const files = await api(t.cpBase, '/files/report.txt', { cookie: t.cookie });
    assert.equal(files.status, 503);
    assert.equal((files.json as { error: { code: string } }).error.code, 'TENANT_NOT_READY');

    const upload = await api(t.cpBase, '/upload?name=a.txt', { method: 'POST', cookie: t.cookie, body: 'x' });
    assert.equal(upload.status, 503);
    assert.equal((upload.json as { error: { code: string } }).error.code, 'TENANT_NOT_READY');

    const appRes = await fetch(`${t.cpBase}/app/`, { headers: { Cookie: t.cookie }, redirect: 'manual' });
    assert.equal(appRes.status, 302);
    assert.equal(appRes.headers.get('location'), `/login?returnTo=${encodeURIComponent('/app/')}`);
  });
});
