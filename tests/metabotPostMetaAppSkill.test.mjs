import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const postMetaAppScript = path.join(repoRoot, 'SKILLs/metabot-post-metaapp/scripts/index.js');

async function createRpcServer() {
  const uploads = [];
  const publishes = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const parsed = body ? JSON.parse(body) : {};

    if (req.method === 'POST' && req.url === '/api/idbots/files/upload-largefile') {
      uploads.push(parsed);
      const index = uploads.length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        pinId: `upload-${index}i0`,
        fileName: path.basename(parsed.file_path || ''),
        size: 123 + index,
        contentType: parsed.content_type,
        uploadMode: 'direct',
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/metaid/create-pin') {
      publishes.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        pinId: 'metaapp-pin-i0',
        txid: 'metaapp-tx',
        totalCost: 321,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  return {
    uploads,
    publishes,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function runPostMetaApp(args, rpcUrl) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [postMetaAppScript, ...args], {
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

test('prepare uploads runtime, source, icon, and cover files into a confirmed MetaApp payload', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'idbots-post-metaapp-'));
  const runtimeDir = path.join(tempDir, 'runtime');
  const sourceDir = path.join(tempDir, 'source');
  await mkdir(runtimeDir);
  await mkdir(sourceDir);
  await writeFile(path.join(runtimeDir, 'index.html'), '<h1>Hello MetaApp</h1>', 'utf8');
  await writeFile(path.join(sourceDir, 'app.js'), 'console.log("source");', 'utf8');
  const iconPath = path.join(tempDir, 'icon.png');
  const coverPath = path.join(tempDir, 'cover.jpg');
  await writeFile(iconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const requestFile = path.join(tempDir, 'request.json');
  const outputFile = path.join(tempDir, 'prepared.json');
  await writeFile(requestFile, JSON.stringify({
    title: 'Simple MetaApp',
    appName: 'simple-metaapp',
    intro: 'A tiny test app',
    version: '1.0.0',
    tags: ['demo'],
    content: runtimeDir,
    code: sourceDir,
    icon: iconPath,
    coverImg: coverPath,
  }, null, 2), 'utf8');

  const result = await runPostMetaApp(['--prepare-request', requestFile, '--output', outputFile], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.uploads.length, 4);
  assert.deepEqual(rpc.uploads.map((entry) => entry.content_type), [
    'application/zip',
    'application/zip',
    'image/png',
    'image/jpeg',
  ]);
  assert.match(rpc.uploads[0].file_path, /runtime.*\.zip$/);
  assert.match(rpc.uploads[1].file_path, /source.*\.zip$/);

  const output = JSON.parse(await readFile(outputFile, 'utf8'));
  assert.equal(output.success, true);
  assert.equal(output.path, '/protocols/metaapp');
  assert.equal(output.payload.title, 'Simple MetaApp');
  assert.equal(output.payload.appName, 'simple-metaapp');
  assert.equal(output.payload.runtime, 'browser');
  assert.equal(output.payload.indexFile, 'index.html');
  assert.equal(output.payload.contentType, 'application/zip');
  assert.equal(output.payload.codeType, 'application/zip');
  assert.equal(output.payload.content, 'metafile://upload-1i0');
  assert.equal(output.payload.code, 'metafile://upload-2i0');
  assert.equal(output.payload.icon, 'metafile://upload-3i0');
  assert.equal(output.payload.coverImg, 'metafile://upload-4i0');
  assert.match(output.payload.contentHash, /^[a-f0-9]{64}$/);
});

test('prepare rejects requests where content and code are both empty', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'idbots-post-metaapp-empty-'));
  const requestFile = path.join(tempDir, 'request.json');
  await writeFile(requestFile, JSON.stringify({
    title: 'No Artifact',
    appName: 'no-artifact',
    intro: 'missing content and code',
    version: '1.0.0',
    content: '',
    code: '',
  }, null, 2), 'utf8');

  const result = await runPostMetaApp(['--prepare-request', requestFile], rpc.url);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /content and code cannot both be empty/i);
  assert.equal(rpc.uploads.length, 0);
  assert.equal(rpc.publishes.length, 0);
});

test('publish-prepared writes confirmed payload to the MetaApp protocol path', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'idbots-post-metaapp-publish-'));
  const preparedFile = path.join(tempDir, 'prepared.json');
  const payload = {
    title: 'Confirmed App',
    appName: 'confirmed-app',
    prompt: '',
    icon: '',
    coverImg: '',
    introImgs: [],
    intro: 'ready',
    runtime: 'browser',
    version: '1.0.0',
    contentType: 'application/zip',
    content: 'metafile://contenti0',
    indexFile: 'index.html',
    code: '',
    contentHash: 'abc',
    metadata: '',
    tags: [],
    disabled: false,
    codeType: 'application/zip',
  };
  await writeFile(preparedFile, JSON.stringify({ path: '/protocols/metaapp', payload }, null, 2), 'utf8');

  const result = await runPostMetaApp(['--publish-prepared', preparedFile], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.uploads.length, 0);
  assert.equal(rpc.publishes.length, 1);
  assert.equal(rpc.publishes[0].metaidData.path, '/protocols/metaapp');
  assert.equal(rpc.publishes[0].metaidData.contentType, 'application/json');
  assert.deepEqual(JSON.parse(rpc.publishes[0].metaidData.payload), payload);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.success, true);
  assert.equal(output.pinId, 'metaapp-pin-i0');
  assert.equal(output.txid, 'metaapp-tx');
});
