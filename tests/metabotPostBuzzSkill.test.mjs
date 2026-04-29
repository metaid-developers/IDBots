import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const postBuzzScript = path.join(repoRoot, 'SKILLs/metabot-post-buzz/scripts/post-buzz.js');

async function createRpcServer() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/metaid/create-pin') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'not found' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const parsed = JSON.parse(body);
    calls.push(parsed);
    const pathName = parsed?.metaidData?.path;
    const index = calls.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      pinId: pathName === '/file' ? `file-pin-${index}` : `buzz-pin-${index}`,
      txid: pathName === '/file' ? `file-tx-${index}` : `buzz-tx-${index}`,
      totalCost: 100 + index,
    }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function runPostBuzz(args, rpcUrl) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [postBuzzScript, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        IDBOTS_METABOT_ID: '1',
        IDBOTS_RPC_URL: rpcUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('post-buzz request file preserves shell-significant text content', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'idbots-post-buzz-request-'));
  const requestFile = path.join(tempDir, 'request.json');
  const content = 'quotes " double, single \', backtick `, dollar $HOME, newline\nunicode \u4e2d\u6587';
  await writeFile(requestFile, JSON.stringify({ content }, null, 2), 'utf8');

  const result = await runPostBuzz(['--request-file', requestFile], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].metaidData.path, '/protocols/simplebuzz');
  const payload = JSON.parse(rpc.calls[0].metaidData.payload);
  assert.equal(payload.content, content);
  assert.deepEqual(payload.attachments, []);
});

test('post-buzz request file passes metafile attachments directly to simplebuzz', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'idbots-post-buzz-metafile-'));
  const requestFile = path.join(tempDir, 'request.json');
  await writeFile(requestFile, JSON.stringify({
    content: 'hello metafile',
    attachments: ['metafile://existing-pin-1.png'],
  }, null, 2), 'utf8');

  const result = await runPostBuzz(['--request-file', requestFile], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].metaidData.path, '/protocols/simplebuzz');
  const payload = JSON.parse(rpc.calls[0].metaidData.payload);
  assert.deepEqual(payload.attachments, ['metafile://existing-pin-1.png']);
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output.attachments, ['metafile://existing-pin-1.png']);
});

test('post-buzz attachment flag accepts metafile URIs without uploading them', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const result = await runPostBuzz([
    '--content',
    'hello from argv',
    '--attachment',
    'metafile://existing-pin-2.jpg',
  ], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].metaidData.path, '/protocols/simplebuzz');
  const payload = JSON.parse(rpc.calls[0].metaidData.payload);
  assert.deepEqual(payload.attachments, ['metafile://existing-pin-2.jpg']);
});
