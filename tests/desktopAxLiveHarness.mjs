/**
 * Live harness for the mounted AX-first desktop layer (feat/agent-desktop-ax).
 *
 * This drives the REAL plugin through its REAL mount contract: `apply(ctx)` is
 * called with a minimal context, the tool it registers is executed exactly as
 * the kernel would execute it, and the plugin resolves the agent-desktop binary
 * through its own three-tier chain (AGD_BIN → dsh-runtime/node_modules → PATH)
 * — no injected runner, no test double for the CLI.
 *
 * Three cases, all on a real Chromium window:
 *   (a) an Electron button is resolved through the AX tree, clicked, and read
 *       back — the read → act → verify round trip stays at TWO process calls;
 *   (b) a control with NO AX exposure (a canvas widget) is detected as an AX
 *       miss, the CLI captures the window, the control is located IN THE PIXELS,
 *       the click lands, and an independent AX read confirms it;
 *   (c) the same target twice in a row gives the same result.
 *
 * Run:
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/desktopAxLiveHarness.mjs
 *
 * ELECTRON_RUN_AS_NODE=1 is exported by the IDBots host shell; with it set the
 * "electron" binary runs as plain node and this file never becomes a GUI app.
 * The guard at the bottom refuses to run in that state.
 */
import { app, BrowserWindow, nativeImage } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'tmp', 'ax-verify', 'out3');
const REPORT = path.join(OUT_DIR, 'live-report.json');

const AGD = process.env.AGD_BIN || 'agent-desktop';
const WINDOW_TITLE = 'AX Two-Layer Harness';

const log = (...parts) => process.stdout.write(parts.join(' ') + '\n');

function sh(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function findWindow(title) {
  const r = await sh(AGD, ['list-windows']);
  const windows = JSON.parse(r.stdout)?.data;
  return (Array.isArray(windows) ? windows : []).find((w) => w.title === title && w.accessible === true) ?? null;
}

/** Largest connected region of `rgb` inside `region` (BGRA bitmap). */
function largestColourComponent(bitmap, width, height, rgb, tolerance, region) {
  const [r, g, b] = rgb;
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(width, Math.ceil(region.x + region.width));
  const y1 = Math.min(height, Math.ceil(region.y + region.height));
  const matches = (x, y) => {
    const i = (y * width + x) * 4;
    return (
      Math.abs(bitmap[i + 2] - r) <= tolerance &&
      Math.abs(bitmap[i + 1] - g) <= tolerance &&
      Math.abs(bitmap[i] - b) <= tolerance
    );
  };
  const seen = new Uint8Array(width * height);
  let best = null;
  const queue = [];
  for (let sy = y0; sy < y1; sy += 1) {
    for (let sx = x0; sx < x1; sx += 1) {
      const seed = sy * width + sx;
      if (seen[seed] || !matches(sx, sy)) continue;
      queue.length = 0;
      queue.push(seed);
      seen[seed] = 1;
      let area = 0;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      while (queue.length) {
        const index = queue.pop();
        const x = index % width;
        const y = (index - x) / width;
        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const next = ny * width + nx;
          if (seen[next] || !matches(nx, ny)) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }
      if (!best || area > best.area) best = { area, minX, minY, maxX, maxY };
    }
  }
  if (!best) return null;
  return { ...best, centreX: (best.minX + best.maxX) / 2, centreY: (best.minY + best.maxY) / 2 };
}

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${WINDOW_TITLE}</title>
<style>
  html, body { margin: 0; font: 14px -apple-system, system-ui, sans-serif; background: #111111; color: #eeeeee; }
  #wrap { padding: 18px; display: flex; flex-direction: column; gap: 14px; }
  button { font: inherit; padding: 10px 16px; width: 240px; }
  .status { font-family: ui-monospace, monospace; }
  #canvasPad { width: 240px; height: 96px; background: #2a2a2a; border: 1px dashed #666; }
</style></head>
<body>
  <div id="wrap">
    <button id="inc" aria-label="计数器 +1">计数器 +1（AX）</button>
    <div class="status" role="status" id="status">count=0</div>
    <canvas id="canvasPad" width="240" height="96" aria-hidden="true"></canvas>
    <div class="status" role="status" id="canvasStatus">pad=idle</div>
  </div>
<script>
  let count = 0;
  document.getElementById('inc').addEventListener('click', () => {
    count += 1;
    document.getElementById('status').textContent = 'count=' + count;
  });
  const pad = document.getElementById('canvasPad');
  const padStatus = document.getElementById('canvasStatus');
  const ctx = pad.getContext('2d');
  function paint(hit, at) {
    ctx.fillStyle = hit ? '#1d3b1d' : '#2a2a2a';
    ctx.fillRect(0, 0, pad.width, pad.height);
    ctx.fillStyle = hit ? '#8bd88b' : '#9a9a9a';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(hit ? 'PAD CLICKED' : 'custom control (no AX)', 14, 54);
    if (hit && at) ctx.fillText(at, 14, 74);
  }
  paint(false);
  pad.addEventListener('pointerdown', (ev) => {
    const r = pad.getBoundingClientRect();
    const x = Math.round(ev.clientX - r.left);
    const y = Math.round(ev.clientY - r.top);
    paint(true, x + ',' + y);
    padStatus.textContent = 'pad=hit@' + x + ',' + y;
  });
</script>
</body></html>`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = { startedAt: new Date().toISOString(), cases: {}, verdict: {} };

  const win = new BrowserWindow({ width: 720, height: 460, title: WINDOW_TITLE, show: true });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((resolve) => setTimeout(resolve, 700));

  const record = await findWindow(WINDOW_TITLE);
  if (!record) throw new Error(`window "${WINDOW_TITLE}" is not visible to the CLI`);
  const windowId = record.id;
  log(`window=${windowId} bounds=${JSON.stringify(record.bounds)}`);

  // Drive the REAL plugin through its REAL mount contract.
  const { apply } = await import('../dsh-runtime/plugins/idbots-desktop-ax.mjs');
  const registered = [];
  const sections = [];
  apply({
    tools: { register: (tool) => { registered.push(tool); return () => {}; } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
  });
  if (registered.length !== 1) throw new Error(`expected exactly one registered tool, got ${registered.length}`);
  const tool = registered[0];
  report.mount = {
    toolName: tool.name,
    promptSection: sections[0]?.name ?? null,
    promptMentionsVerify: /expect_text/.test(sections[0]?.text ?? ''),
  };
  log(`mounted tool=${tool.name} section=${report.mount.promptSection}`);

  const run = async (args) => tool.execute(args, {});

  const domCount = async () => win.webContents.executeJavaScript("document.getElementById('status').textContent");
  const domPad = async () => win.webContents.executeJavaScript("document.getElementById('canvasStatus').textContent");

  // ---------------- case (a): AX hit, two process calls ----------------
  const before = await domCount();
  const a = await run({
    action: 'click',
    window_id: windowId,
    role: 'button',
    query_text: '计数器',
    expect_role: 'statictext',
    expect_text: 'count=1',
  });
  const after = await domCount();
  report.cases.a = {
    layer: a.layer,
    verified: a.verified,
    verification: a.verification,
    binarySource: a.binary,
    ref: a.ref,
    processCalls: a.calls,
    callLog: a.callLog,
    domBefore: before,
    domAfter: after,
    ok: a.layer === 'ax' && a.calls === 2 && a.verified === 'verified' && before === 'count=0' && after === 'count=1',
  };
  log(`(a) layer=${a.layer} verified=${a.verified} calls=${a.calls} binary=${a.binary} dom ${before} -> ${after}`);

  // ---------------- case (b): no AX control, visual fallback ----------------
  const padBefore = await domPad();
  const b = await run({ action: 'click', window_id: windowId, query_text: 'custom control' });
  const shot = b.screenshot;
  let vision = null;
  let padAfter = padBefore;
  if (b.layer === 'visual' && shot?.path && fs.existsSync(shot.path)) {
    const image = nativeImage.createFromBuffer(fs.readFileSync(shot.path));
    const { width, height } = image.getSize();
    const bitmap = image.getBitmap();
    // Content area = the #111111 page background; the pad = the #2a2a2a block.
    const content = largestColourComponent(bitmap, width, height, [0x11, 0x11, 0x11], 3, { x: 0, y: 0, width, height });
    const pad = content
      ? largestColourComponent(bitmap, width, height, [0x2a, 0x2a, 0x2a], 6, {
          x: content.minX,
          y: content.minY,
          width: content.maxX - content.minX,
          height: content.maxY - content.minY,
        })
      : null;
    const point = pad && content
      ? {
          x: (pad.centreX - content.minX) / shot.scaleFactor,
          y: (pad.centreY - content.minY) / shot.scaleFactor,
        }
      : null;
    vision = {
      imageSize: { width, height },
      scaleFactor: shot.scaleFactor,
      contentBoxPx: content ? { x: content.minX, y: content.minY, w: content.maxX - content.minX, h: content.maxY - content.minY } : null,
      padBoxPx: pad ? { x: pad.minX, y: pad.minY, w: pad.maxX - pad.minX, h: pad.maxY - pad.minY, area: pad.area } : null,
      pointInContent: point,
    };
    if (point) {
      // Delivery stays with the existing background pixel route; this harness
      // uses Electron's own renderer input because moving the physical cursor
      // is prohibited in this environment.
      win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      padAfter = await domPad();
    }
  }
  const bReadback = await run({ action: 'locate', window_id: windowId, role: 'statictext', query_text: 'pad=hit' });
  report.cases.b = {
    layer: b.layer,
    reason: b.reason,
    detail: b.detail,
    processCalls: b.calls,
    callLog: b.callLog,
    screenshot: shot,
    vision,
    padBefore,
    padAfter,
    axReadback: bReadback.layer === 'ax' ? bReadback.ref : null,
    ok: b.layer === 'visual'
      && b.reason === 'no_ax_match'
      && Boolean(shot?.path)
      && /^pad=hit@\d+,\d+$/.test(padAfter)
      && bReadback.layer === 'ax',
  };
  log(`(b) layer=${b.layer} reason=${b.reason} shot=${shot?.path ? 'yes' : 'no'} pad ${padBefore} -> ${padAfter}`);

  // ---------------- case (c): same target twice, same result ----------------
  const run1 = await run({ action: 'click', window_id: windowId, role: 'button', query_text: '计数器', expect_text: 'count=2' });
  const dom1 = await domCount();
  const run2 = await run({ action: 'click', window_id: windowId, role: 'button', query_text: '计数器', expect_text: 'count=3' });
  const dom2 = await domCount();
  report.cases.c = {
    run1: { layer: run1.layer, verified: run1.verified, calls: run1.calls, callLog: run1.callLog, dom: dom1 },
    run2: { layer: run2.layer, verified: run2.verified, calls: run2.calls, callLog: run2.callLog, dom: dom2 },
    sameLayer: run1.layer === run2.layer,
    sameVerified: run1.verified === run2.verified,
    sameCallCount: run1.calls === run2.calls,
    ok: run1.layer === 'ax' && run2.layer === 'ax'
      && run1.verified === 'verified' && run2.verified === 'verified'
      && run1.calls === 2 && run2.calls === 2
      && dom1 === 'count=2' && dom2 === 'count=3',
  };
  log(`(c) run1 ${dom1} run2 ${dom2} sameLayer=${report.cases.c.sameLayer}`);

  report.verdict = {
    a_ax_click_readback: report.cases.a.ok,
    b_visual_fallback: report.cases.b.ok,
    c_repeatable: report.cases.c.ok,
    all: report.cases.a.ok && report.cases.b.ok && report.cases.c.ok,
  };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  log('\nVERDICT ' + JSON.stringify(report.verdict));
  log('report -> ' + REPORT);
  return report.verdict.all;
}

// ELECTRON_RUN_AS_NODE trap guard: without this the file runs under plain node,
// `electron` is undefined, and the failure looks like a broken import.
if (!process.versions.electron) {
  console.error(
    'desktopAxLiveHarness: process.versions.electron is undefined — this is NOT an Electron main process.\n'
    + 'Most likely ELECTRON_RUN_AS_NODE=1 leaked in from the host shell. Re-run with:\n'
    + '  env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/desktopAxLiveHarness.mjs',
  );
  process.exit(2);
}

// Keep the harness profile inside the repo: launching any Electron app otherwise
// creates/refreshes ~/Library/Application Support/Electron in the user's home.
// (Not the IDBots user data directory — this harness never opens that profile.)
app.setPath('userData', path.join(OUT_DIR, 'electron-userdata'));

app.whenReady().then(async () => {
  let pass = false;
  try {
    pass = await main();
  } catch (error) {
    log('HARNESS_ERROR ' + (error && error.stack ? error.stack : String(error)));
  }
  app.exit(pass ? 0 : 1);
});
