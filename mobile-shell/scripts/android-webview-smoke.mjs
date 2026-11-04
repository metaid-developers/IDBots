import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] || 'bootstrap';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'artifacts');
const cdpBase = process.env.ANDROID_CDP_URL || 'http://127.0.0.1:9222';
const origin = 'https://staging.idbots.world';
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

mkdirSync(artifacts, { recursive: true });
const targets = await (await fetch(`${cdpBase}/json/list`)).json();
const target = targets.find((item) => item.type === 'page' && item.url.startsWith(origin));
assert.ok(target, `No staging WebView target found at ${cdpBase}`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener('open', resolveOpen, { once: true });
  socket.addEventListener('error', rejectOpen, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(message.error.message));
  else callback.resolve(message.result);
});

function call(method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveCall, reject: rejectCall });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'WebView evaluation failed');
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

const proofExpression = `(() => {
  const native = window.idbotsNative;
  const facts = window.idbotsMobile;
  return {
    origin: location.origin,
    nativeBridgeVersion: native?.nativeBridgeVersion,
    nativePhase: native?.bootstrap?.phase,
    platform: native?.bootstrap?.platform,
    capabilities: native?.getCapabilities(),
    shell: facts?.shell,
    os: facts?.os,
    pwaProof: window.idbotsNativeProof ?? null,
  };
})()`;

function assertBootstrap(proof) {
  assert.equal(proof.origin, origin);
  assert.equal(proof.nativeBridgeVersion, 1);
  assert.equal(proof.nativePhase, 'document-start');
  assert.equal(proof.platform, 'android');
  assert.equal(proof.shell, 'capacitor');
  assert.equal(proof.os, 'android');
  assert.equal(proof.capabilities.backButton, true);
  assert.equal(proof.capabilities.externalUrls, true);
  for (const capability of ['camera', 'photos', 'files', 'share', 'secureScreen']) {
    assert.equal(proof.capabilities[capability], true);
  }
}

async function capture(name) {
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(resolve(artifacts, name), Buffer.from(screenshot.data, 'base64'));
}

function record(name, value) {
  writeFileSync(resolve(artifacts, name), `${JSON.stringify(value, null, 2)}\n`);
}

await call('Page.enable');
await call('Runtime.enable');
const bootstrap = await evaluate(proofExpression);
assertBootstrap(bootstrap);

if (mode === 'bootstrap') {
  const secureScreenToggle = await evaluate(`(async () => {
    await window.idbotsNative.setSecureScreen(true);
    await window.idbotsNative.setSecureScreen(false);
    return true;
  })()`);
  assert.equal(secureScreenToggle, true);
  await capture('android-staging-login.png');
  record('android-bootstrap.json', { result: 'PASS', bootstrap, secureScreenToggle: 'PASS' });
} else if (mode === 'external') {
  await evaluate(`window.location.assign('https://example.com/')`);
  await sleep(2500);
  const after = await evaluate(proofExpression);
  assertBootstrap(after);
  record('android-external.json', {
    result: 'PASS',
    handoff: 'External navigation was cancelled in the privileged WebView and opened by the system',
    privilegedWebView: after,
  });
} else if (mode === 'offline') {
  await call('Network.enable');
  await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await call('Page.reload', { ignoreCache: true });
  await waitFor(`location.hostname === 'localhost' && location.pathname === '/offline.html'`);
  const offline = await evaluate(`(() => ({
    title: document.getElementById('title')?.textContent,
    retryPresent: Boolean(document.getElementById('retry')),
    nativeSurfacePresent: Boolean(window.idbotsNative),
    onlineAppCached: Boolean(document.querySelector('script[src*="/app/"]')),
  }))()`);
  assert.equal(offline.retryPresent, true);
  assert.equal(offline.nativeSurfacePresent, false);
  assert.equal(offline.onlineAppCached, false);
  await capture('android-offline.png');
  await call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate(`document.getElementById('retry').click()`);
  await waitFor(`location.origin === ${JSON.stringify(origin)}`);
  await waitFor(`window.idbotsNative?.bootstrap?.phase === 'document-start'`);
  const retry = await evaluate(proofExpression);
  assertBootstrap(retry);
  await capture('android-offline-retry.png');
  record('android-offline.json', { result: 'PASS', offline, retry });
} else {
  throw new Error(`Unknown smoke mode: ${mode}`);
}

socket.close();
console.log(`Android WebView ${mode}: PASS`);
