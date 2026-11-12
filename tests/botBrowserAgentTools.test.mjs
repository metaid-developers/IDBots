import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);
const { buildBotBrowserAgentTools, buildBotBrowserScreenshotTool, buildSearchMetaAppsAgentTools, formatBotBrowserTabs } = require('../dist-electron/main/libs/botBrowserAgentTools.js');
const { MetaAppValidatedBasisUnavailableError } = require('../dist-electron/main/services/metaAppSearchService.js');

function makeHarness(overrides = {}) {
  const calls = { execute: [], openUri: [], forkMetaApp: [], search: [] };
  const control = {
    execute: async (command) => {
      calls.execute.push(command);
      return {
        action: command.action,
        tabs: [
          { id: 1, uri: 'metaid://aaa', title: 'Agent A', isActive: true },
          { id: 2, uri: 'metaapp://bbb', title: 'Game B', isActive: false },
        ],
        activeTab: { id: 1, uri: 'metaid://aaa', title: 'Agent A', isActive: true },
        ...(overrides.executeResult ?? {}),
      };
    },
    openUri: async (input) => {
      calls.openUri.push(input);
    },
    forkMetaApp: async (input) => {
      calls.forkMetaApp.push(input);
      return {
        dir: '/workspace/metaapp-forks/game-b-bbb-20260726',
        indexFile: 'index.html',
        sourcePinId: 'bbb',
        sourceUri: 'metaapp://bbb',
        title: 'Game B',
        ...(overrides.forkResult ?? {}),
      };
    },
    searchMetaApps: async (input) => {
      calls.search.push(input);
      return overrides.searchResult ?? { items: [], hasMore: false };
    },
    listMetaAppForks: async (input) => {
      calls.search.push({ forks: input.pinId });
      return overrides.forksResult ?? { items: [], hasMore: false };
    },
    ...overrides.control,
  };
  if (overrides.withoutFork) {
    delete control.forkMetaApp;
  }
  if (overrides.withoutSearch) {
    delete control.searchMetaApps;
    delete control.listMetaAppForks;
  }
  const tools = buildBotBrowserAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    controlBotBrowser: control,
    sessionId: 'session-1',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, tools, byName };
}

const SEARCH_CANDIDATE = {
  pinId: 'c'.repeat(64) + 'i0',
  sourcePinId: 'c'.repeat(64) + 'i0',
  chainName: 'mvc',
  title: 'Buzz Client',
  appName: 'buzz-client',
  intro: '查看和发布 Buzz 的应用',
  tags: ['simplebuzz'],
  runtime: 'browser',
  version: '1.0.0',
  content: 'metafile://x.zip',
  indexFile: 'index.html',
  forkedFrom: '',
  disabled: false,
  publisherGlobalMetaId: 'idq1own123456789',
  publisherMetaId: '',
  publisherAddress: '',
  publisherName: 'Loop Bot',
  publisherAvatarId: '',
  createdAt: 1768284841,
  updatedAt: 1768284841,
  isOwn: true,
};

test('builds bot_browser_tabs, bot_browser_open_uri and bot_browser_preview_local tools', () => {
  const { byName } = makeHarness();
  assert.ok(byName.bot_browser_tabs);
  assert.ok(byName.bot_browser_open_uri);
  assert.ok(byName.bot_browser_preview_local);
});

test('bot_browser_tabs list maps to get-tabs and formats the tab list', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_tabs.handler({ action: 'list' });
  assert.deepEqual(calls.execute, [{ action: 'get-tabs', uri: undefined, tabId: undefined }]);
  const text = result.content[0].text;
  assert.match(text, /Open tabs/);
  assert.match(text, /\*\s+\[1\] Agent A — metaid:\/\/aaa/);
  assert.match(text, /\[2\] Game B — metaapp:\/\/bbb/);
  assert.equal(result.isError, undefined);
});

test('bot_browser_tabs validates required args before touching the bridge', async () => {
  const { calls, byName } = makeHarness();
  const openResult = await byName.bot_browser_tabs.handler({ action: 'open' });
  assert.equal(openResult.isError, true);
  assert.match(openResult.content[0].text, /requires a uri/);

  const closeResult = await byName.bot_browser_tabs.handler({ action: 'close' });
  assert.equal(closeResult.isError, true);
  assert.match(closeResult.content[0].text, /requires a numeric tabId/);

  assert.equal(calls.execute.length, 0);
});

test('bot_browser_tabs switch/close pass tabId through to the bridge', async () => {
  const { calls, byName } = makeHarness();
  await byName.bot_browser_tabs.handler({ action: 'switch', tabId: 2 });
  await byName.bot_browser_tabs.handler({ action: 'close', tabId: 2 });
  assert.deepEqual(calls.execute[0], { action: 'switch-tab', uri: undefined, tabId: 2 });
  assert.deepEqual(calls.execute[1], { action: 'close-tab', uri: undefined, tabId: 2 });
});

test('bot_browser_open_uri navigates the session tab by default', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_open_uri.handler({ uri: 'metaid://abc' });
  assert.deepEqual(calls.execute, [{ action: 'navigate-tab', uri: 'metaid://abc', sessionId: 'session-1', activate: true }]);
  assert.equal(calls.openUri.length, 0);
  assert.match(result.content[0].text, /metaid:\/\/abc/);
});

test('bot_browser_open_uri newTab=true goes through open-tab', async () => {
  const { calls, byName } = makeHarness();
  await byName.bot_browser_open_uri.handler({ uri: 'metaapp://xyz', newTab: true });
  assert.deepEqual(calls.execute, [{ action: 'open-tab', uri: 'metaapp://xyz' }]);
  assert.equal(calls.openUri.length, 0);
});

test('bridge failures degrade to a friendly error result', async () => {
  const { byName } = makeHarness({
    control: {
      execute: async () => { throw new Error('Bot Browser tab command timed out'); },
      openUri: async () => { throw new Error('No IDBots window is available'); },
    },
  });
  const tabsResult = await byName.bot_browser_tabs.handler({ action: 'list' });
  assert.equal(tabsResult.isError, true);
  assert.match(tabsResult.content[0].text, /timed out/);
  assert.match(tabsResult.content[0].text, /switch to Bot Browser mode/);

  const openResult = await byName.bot_browser_open_uri.handler({ uri: 'metaid://abc' });
  assert.equal(openResult.isError, true);
  assert.match(openResult.content[0].text, /timed out/);
});

test('formatBotBrowserTabs handles an empty tab set', () => {
  assert.equal(formatBotBrowserTabs({ tabs: [], activeTab: null }), 'No open tabs.');
});

test('bot_browser_preview_local opens preview-metaapp URI in a new tab by default', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_preview_local.handler({ path: process.cwd() });
  assert.deepEqual(calls.execute, [{ action: 'open-tab', uri: `preview-metaapp://localhost${process.cwd()}` }]);
  assert.equal(calls.openUri.length, 0);
  assert.match(result.content[0].text, /preview-metaapp|preview/i);
});

test('bot_browser_preview_local newTab=false navigates the session tab', async () => {
  const { calls, byName } = makeHarness();
  await byName.bot_browser_preview_local.handler({ path: process.cwd(), newTab: false });
  assert.deepEqual(calls.execute, [{ action: 'navigate-tab', uri: `preview-metaapp://localhost${process.cwd()}`, sessionId: 'session-1', activate: true }]);
  assert.equal(calls.openUri.length, 0);
});

test('bot_browser_preview_local rejects relative and missing paths before touching the bridge', async () => {
  const { calls, byName } = makeHarness();
  const relative = await byName.bot_browser_preview_local.handler({ path: 'some/relative/dir' });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /absolute path/);

  const missing = await byName.bot_browser_preview_local.handler({ path: '/definitely/not/here-12345' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/);

  assert.equal(calls.execute.length, 0);
  assert.equal(calls.openUri.length, 0);
});

test('bot_browser_fork_current_app forks an explicit metaapp URI', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_fork_current_app.handler({ uri: 'metaapp://bbb' });
  assert.deepEqual(calls.forkMetaApp, [{ sessionId: 'session-1', uri: 'metaapp://bbb' }]);
  assert.match(result.content[0].text, /Forked "Game B"/);
  assert.match(result.content[0].text, /metaapp-forks/);
});

test('bot_browser_fork_current_app falls back to the active tab URI', async () => {
  const { calls, byName } = makeHarness({
    executeResult: {
      activeTab: { id: 3, uri: 'metaapp://ccc', title: 'C', isActive: true },
    },
  });
  await byName.bot_browser_fork_current_app.handler({});
  assert.deepEqual(calls.execute, [{ action: 'get-active-tab' }]);
  assert.deepEqual(calls.forkMetaApp, [{ sessionId: 'session-1', uri: 'metaapp://ccc' }]);
});

test('bot_browser_fork_current_app rejects non-metaapp pages', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_fork_current_app.handler({ uri: 'metaid://aaa' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not a MetaApp/);
  assert.equal(calls.forkMetaApp.length, 0);
});

test('bot_browser_fork_current_app is not registered when the host has no fork support', () => {
  const { byName } = makeHarness({ withoutFork: true });
  assert.equal(byName.bot_browser_fork_current_app, undefined);
});

test('bot_browser_read_page returns visible text for first-party pages', async () => {
  const { byName } = makeHarness({
    executeResult: {
      content: {
        tabId: 1,
        uri: 'metaid://aaa',
        title: 'Agent A',
        contentType: 'text/html',
        text: 'Hello from the homepage',
        html: '<p>Hello</p>',
        truncated: false,
        extractedAt: 1,
      },
    },
  });
  const result = await byName.bot_browser_read_page.handler({});
  assert.match(result.content[0].text, /Agent A/);
  assert.match(result.content[0].text, /Hello from the homepage/);
  assert.equal(result.isError, undefined);
});

test('bot_browser_read_page points MetaApp tabs at their local source directory', async () => {
  const metaappUri = 'metaapp://' + 'b'.repeat(64) + 'i0';
  const { byName } = makeHarness({
    executeResult: {
      content: {
        tabId: 2,
        uri: metaappUri,
        title: 'Game B',
        contentType: 'text/html',
        text: '',
        html: '',
        truncated: false,
        extractedAt: 1,
      },
      info: {
        id: 2, uri: metaappUri, title: 'Game B', isActive: false,
        current: { renderer: { type: 'html-iframe', url: 'http://127.0.0.1:9123/browser-cache/metaapp-preview/p-1/index.html' } },
      },
    },
    control: {
      locateSourceByRenderUrl: async () => ({
        dir: '/cache/artifacts/game-b',
        indexFile: 'index.html',
        title: 'Game B',
      }),
    },
  });
  const result = await byName.bot_browser_read_page.handler({});
  assert.match(result.content[0].text, /sandboxed frame/);
  assert.match(result.content[0].text, /\/cache\/artifacts\/game-b/);
});

test('bot_browser_read_page resolves metaapp-rendered bot pages (metaid:// uri) to source', async () => {
  const { calls, byName } = makeHarness({
    executeResult: {
      content: {
        tabId: 1,
        uri: 'metaid://idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47',
        title: 'Bob',
        contentType: 'text/html',
        text: '',
        html: '',
        truncated: false,
        extractedAt: 1,
      },
      info: {
        id: 1, uri: 'metaid://idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47', title: 'Bob', isActive: true,
        current: { renderer: { type: 'html-iframe', url: 'http://127.0.0.1:8899/bob-homepage/index.html' } },
      },
    },
    control: {
      locateSourceByRenderUrl: async ({ url }) => {
        calls.renderUrl = url;
        return { dir: '/METAAPPs/bob-homepage', indexFile: 'index.html', title: 'Bob Homepage' };
      },
    },
  });
  const result = await byName.bot_browser_read_page.handler({});
  // Must NOT conclude the page is empty: the renderer is a MetaApp.
  assert.doesNotMatch(result.content[0].text, /No readable text/);
  assert.match(result.content[0].text, /Bob Homepage/);
  assert.match(result.content[0].text, /\/METAAPPs\/bob-homepage/);
  assert.equal(calls.renderUrl, 'http://127.0.0.1:8899/bob-homepage/index.html');
});

test('bot_browser_read_page suggests fetching remote renderer URLs when no local source exists', async () => {
  const { byName } = makeHarness({
    executeResult: {
      content: { tabId: 1, uri: 'map://x', title: 'Remote', contentType: 'text/html', text: '', html: '', truncated: false, extractedAt: 1 },
      info: { id: 1, uri: 'map://x', title: 'Remote', isActive: true, current: { renderer: { type: 'html-iframe', url: 'https://example.com/app/index.html' } } },
    },
    control: {
      locateSourceByRenderUrl: async () => null,
    },
  });
  const result = await byName.bot_browser_read_page.handler({});
  assert.match(result.content[0].text, /https:\/\/example\.com\/app\/index\.html/);
  assert.match(result.content[0].text, /fetch/i);
});

test('bot_browser_read_page reports empty only for first-party pages without text', async () => {
  const { byName } = makeHarness({
    executeResult: {
      content: { tabId: 1, uri: 'metaid://empty', title: null, contentType: 'text/html', text: '', html: '', truncated: false, extractedAt: 1 },
      info: { id: 1, uri: 'metaid://empty', title: null, isActive: true, current: { renderer: { type: 'bot-homepage' } } },
    },
  });
  const result = await byName.bot_browser_read_page.handler({});
  assert.match(result.content[0].text, /No readable text/);
  assert.match(result.content[0].text, /bot-homepage/);
});

test('search_metaapps returns formatted candidates with isOwn marking and open guidance', async () => {
  const { calls, byName } = makeHarness({
    searchResult: { items: [SEARCH_CANDIDATE], hasMore: false },
  });
  const result = await byName.search_metaapps.handler({ query: 'buzz', sinceDays: 7, limit: 5 });
  assert.deepEqual(calls.search.length, 1);
  assert.equal(calls.search[0].keyword, 'buzz');
  assert.equal(typeof calls.search[0].since, 'number');
  assert.equal(calls.search[0].limit, 5);
  const text = result.content[0].text;
  assert.match(text, /Buzz Client/);
  assert.match(text, /simplebuzz/);
  assert.match(text, /your MetaBot/);
  assert.match(text, new RegExp(`metaapp://${SEARCH_CANDIDATE.pinId}`));
  // Publisher renders as a full-length metaid link with the display name — never shortened.
  assert.match(text, new RegExp(`\\[Loop Bot\\]\\(metaid://${SEARCH_CANDIDATE.publisherGlobalMetaId}\\)`));
  assert.doesNotMatch(text, /…/);
  assert.match(text, /2–3 alternatives/);
});

test('search_metaapps degrades an empty multi-token query once then reports honestly', async () => {
  const { calls, byName } = makeHarness({ searchResult: { items: [], hasMore: false } });
  const result = await byName.search_metaapps.handler({ query: 'buzz video player' });
  // First attempt with the full query, retry with the last token dropped.
  assert.deepEqual(calls.search.map((input) => input.keyword), ['buzz video player', 'buzz video']);
  assert.match(result.content[0].text, /No on-chain MetaApps matched/);
  assert.match(result.content[0].text, /do NOT invent/);
});

test('search_metaapps forks mode lists direct remixes of an app', async () => {
  const pinId = 'd'.repeat(64) + 'i0';
  const { calls, byName } = makeHarness({
    forksResult: { items: [{ ...SEARCH_CANDIDATE, isOwn: false }], hasMore: false },
  });
  const result = await byName.search_metaapps.handler({ mode: 'forks', pinId: `metaapp://${pinId}` });
  assert.deepEqual(calls.search, [{ forks: pinId }]);
  assert.match(result.content[0].text, /direct remix/);
  assert.match(result.content[0].text, /Buzz Client/);
});

test('search_metaapps forks mode requires a valid pinId', async () => {
  const { byName } = makeHarness();
  const result = await byName.search_metaapps.handler({ mode: 'forks', pinId: 'not-a-pin' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /valid pinId/);
});

test('search_metaapps is not registered when the host has no search support', () => {
  const { byName } = makeHarness({ withoutSearch: true });
  assert.equal(byName.search_metaapps, undefined);
});

test('search_metaapps on the install surface points at skill_tool extract_metaapp', async () => {
  const tools = buildSearchMetaAppsAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    searchMetaApps: async () => ({ items: [SEARCH_CANDIDATE], hasMore: false }),
    nextStep: 'install',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const result = await byName.search_metaapps.handler({ query: '视频' });
  assert.match(result.content[0].text, /skill_tool/);
  assert.match(result.content[0].text, /extract_metaapp/);
  assert.doesNotMatch(result.content[0].text, /bot_browser_open_uri/);
});

// --- bot_browser_screenshot (Phase 2: clip + format) ---

function makeScreenshotHarness(overrides = {}) {
  const calls = { execute: [], openUri: [], screenshot: [] };
  const control = {
    execute: async (command) => {
      calls.execute.push(command);
      return { action: command.action, tabs: [], activeTab: null, ...(overrides.executeResult ?? {}) };
    },
    openUri: async (input) => { calls.openUri.push(input); },
    screenshot: async (input) => {
      calls.screenshot.push(input ?? {});
      return overrides.screenshotResult ?? {
        data: 'Zm9v', // base64 of "foo"
        mimeType: input?.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        width: 800,
        height: 600,
      };
    },
    ...overrides.control,
  };
  const tools = buildBotBrowserScreenshotTool({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    controlBotBrowser: control,
    sessionId: 'session-1',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, tools, byName };
}

test('bot_browser_screenshot returns an image content block and calls screenshot once', async () => {
  const { calls, byName } = makeScreenshotHarness();
  assert.ok(byName.bot_browser_screenshot);
  const result = await byName.bot_browser_screenshot.handler({});
  assert.equal(calls.screenshot.length, 1);
  assert.deepEqual(calls.screenshot[0], { fullSurface: undefined, clip: undefined, format: 'png', quality: undefined });
  const image = result.content.find((b) => b.type === 'image');
  assert.ok(image, 'expected an image content block');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(typeof image.data, 'string');
  const text = result.content.find((b) => b.type === 'text').text;
  assert.match(text, /800x600/);
  assert.match(text, /PNG/);
});

test('bot_browser_screenshot forwards clip to screenshot', async () => {
  const { calls, byName } = makeScreenshotHarness();
  await byName.bot_browser_screenshot.handler({ clip: { x: 10, y: 20, width: 100, height: 80 } });
  assert.deepEqual(calls.screenshot[0].clip, { x: 10, y: 20, width: 100, height: 80 });
});

test('bot_browser_screenshot forwards format jpeg + quality and returns image/jpeg', async () => {
  const { calls, byName } = makeScreenshotHarness();
  const result = await byName.bot_browser_screenshot.handler({ format: 'jpeg', quality: 60 });
  assert.equal(calls.screenshot[0].format, 'jpeg');
  assert.equal(calls.screenshot[0].quality, 60);
  const image = result.content.find((b) => b.type === 'image');
  assert.equal(image.mimeType, 'image/jpeg');
});

test('bot_browser_screenshot rejects an invalid clip before capturing', async () => {
  const { calls, byName } = makeScreenshotHarness();
  const result = await byName.bot_browser_screenshot.handler({ clip: { x: -1, y: 0, width: 10, height: 10 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /clip must have/);
  assert.equal(calls.screenshot.length, 0);
});

test('bot_browser_screenshot rejects out-of-range quality before capturing', async () => {
  const { calls, byName } = makeScreenshotHarness();
  const result = await byName.bot_browser_screenshot.handler({ quality: 150 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /quality must be between 0 and 100/);
  assert.equal(calls.screenshot.length, 0);
});

test('bot_browser_screenshot navigates the session tab by uri then captures', async () => {
  const { calls, byName } = makeScreenshotHarness();
  await byName.bot_browser_screenshot.handler({ uri: 'metaapp://xyz', waitMs: 0 });
  assert.deepEqual(calls.execute, [{ action: 'navigate-tab', uri: 'metaapp://xyz', sessionId: 'session-1', activate: true }]);
  assert.equal(calls.openUri.length, 0);
  assert.equal(calls.screenshot.length, 1);
});

test('bot_browser_screenshot savePath writes the image bytes to disk', async () => {
  const file = path.join(os.tmpdir(), `bot-browser-shot-${Date.now()}.png`);
  try {
    const { byName } = makeScreenshotHarness();
    const result = await byName.bot_browser_screenshot.handler({ savePath: file });
    const text = result.content.find((b) => b.type === 'text').text;
    assert.match(text, /Saved to/);
    const written = await fs.promises.readFile(file, 'utf8');
    assert.equal(written, 'foo');
  } finally {
    await fs.promises.rm(file, { force: true });
  }
});

test('bot_browser_screenshot surfaces bridge errors with the surface hint', async () => {
  const { byName } = makeScreenshotHarness({
    control: {
      screenshot: async () => { throw new Error('Bot Browser capture request timed out'); },
    },
  });
  const result = await byName.bot_browser_screenshot.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /timed out/);
  assert.match(result.content[0].text, /switch to Bot Browser mode/);
});

// ---------------------------------------------------------------------------
// Motion-video preference evidence (search_metaapps + search_preference_comparisons)
// ---------------------------------------------------------------------------

const MV_CANDIDATE = {
  ...SEARCH_CANDIDATE,
  pinId: 'm'.repeat(64) + 'i0',
  title: 'Ukiyo-e Loop',
  tags: ['motion-video'],
  currentPinId: 'n'.repeat(64) + 'i0',
  prompt: 'ukiyo-e ten second loop',
  motionVideo: {
    videoFile: 'metafile://' + 'o'.repeat(64) + 'i0.mp4',
    videoSha256: 'b8113ccc77c592466f8c67b7ff775cb9c57927a516c34989e8611a1d09f81674',
    learning: { sourceIncluded: true, hasPrompt: true, status: 'declared' },
  },
  preference: {
    open: { score: 0.73, scoreVersion: 'motion-video-open-pref-v1', state: 'established', comparisons: 18, judges: 5 },
    validated: { score: null, state: 'unavailable' },
  },
};

test('search_metaapps preference sorting requires an explicit chainName', async () => {
  const { byName } = makeHarness();
  const result = await byName.search_metaapps.handler({ sort: 'preference' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires an explicit chainName/);
});

test('search_metaapps passes preference filters and surfaces evidence summaries', async () => {
  const { calls, byName } = makeHarness({
    searchResult: { items: [MV_CANDIDATE], hasMore: false },
  });
  const result = await byName.search_metaapps.handler({
    tag: 'motion-video',
    sort: 'preference',
    chainName: 'mvc',
    order: 'desc',
    basis: 'open',
    minJudges: 3,
    learning: 'declared',
  });
  assert.deepEqual(calls.search.at(-1), {
    keyword: undefined,
    tag: 'motion-video',
    publisher: undefined,
    since: undefined,
    limit: 8,
    chainName: 'mvc',
    sort: 'preference',
    order: 'desc',
    basis: 'open',
    minJudges: 3,
    learning: 'declared',
  });
  const text = result.content[0].text;
  assert.match(text, /strongest open preference first \(chain mvc\)/);
  assert.match(text, /pref\(open\): 0\.73 \(18 cmp \/ 5 judges, established\)/);
  assert.match(text, /learning: declared \(publisher-declared, not verified\)/);
  assert.match(text, new RegExp('version: metaapp://' + 'n'.repeat(64) + 'i0'));
  assert.equal(result.isError, undefined);
});

test('search_metaapps labels unjudged items honestly', async () => {
  const { byName } = makeHarness({
    searchResult: {
      items: [{
        ...MV_CANDIDATE,
        preference: {
          open: { score: null, scoreVersion: 'motion-video-open-pref-v1', state: 'unjudged' },
          validated: { score: null, state: 'unavailable' },
        },
      }],
    },
  });
  const result = await byName.search_metaapps.handler({ sort: 'preference', chainName: 'mvc' });
  assert.match(result.content[0].text, /pref\(open\): unjudged/);
});

test('search_metaapps maps validated-basis unavailability to a readable message', async () => {
  const { byName } = makeHarness({
    control: {
      searchMetaApps: async () => {
        throw new MetaAppValidatedBasisUnavailableError('preference_validated_basis_unavailable');
      },
    },
  });
  const result = await byName.search_metaapps.handler({ sort: 'preference', chainName: 'mvc', basis: 'validated' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Validated preference aggregation is not yet available/);
});

test('search_preference_comparisons formats open contrasts with reasons', async () => {
  const sha = 'b8113ccc77c592466f8c67b7ff775cb9c57927a516c34989e8611a1d09f81674';
  const { byName } = makeHarness({
    control: {
      listPreferenceComparisons: async (input) => {
        comparisonsCalls.push(input);
        return {
          items: [{
            feedbackPinId: 'f'.repeat(64) + 'i3',
            chainName: 'mvc',
            basis: 'open',
            isMempool: false,
            confirmedAt: 1792832839,
            a: {
              chainName: 'mvc',
              app: 'metaapp://' + '1'.repeat(64) + 'i0',
              version: 'metaapp://' + '2'.repeat(64) + 'i0',
              video: 'metafile://' + '3'.repeat(64) + 'i0.mp4',
              videoSha256: sha,
            },
            b: {
              chainName: 'mvc',
              app: 'metaapp://' + '4'.repeat(64) + 'i0',
              version: 'metaapp://' + '5'.repeat(64) + 'i0',
              video: 'metafile://' + '6'.repeat(64) + 'i0',
              videoSha256: '9'.repeat(64),
            },
            pick: 'b',
            reason: 'left side motion was jittery',
            dims: null,
            signerGlobalMetaId: 'idq1judge',
            clientArtifact: 'metaapp://arena',
            clientMode: 'arena',
            subject: sha,
            outcome: 'rejected',
            excluded: false,
            excludedReason: null,
          }],
          nextCursor: 'cmp-2',
          hasMore: true,
        };
      },
    },
  });
  var comparisonsCalls = [];
  const result = await byName.search_preference_comparisons.handler({
    chainName: 'mvc',
    subject: sha,
    outcome: 'rejected',
  });
  const text = result.content[0].text;
  assert.match(text, /1 open comparison\(s\) for subject/);
  assert.match(text, /pick: preferred B/);
  assert.match(text, /reason: left side motion was jittery/);
  assert.match(text, /signer: idq1judge/);
  assert.match(text, /client: metaapp:\/\/arena \(arena\)/);
  assert.match(text, /cursor=cmp-2/);
  assert.equal(result.isError, undefined);
});

test('search_preference_comparisons requires a subject for directional outcomes', async () => {
  const { byName } = makeHarness({
    control: { listPreferenceComparisons: async () => ({ items: [], nextCursor: null, hasMore: false }) },
  });
  const result = await byName.search_preference_comparisons.handler({ chainName: 'mvc', outcome: 'preferred' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires a subject videoSha256/);
});

test('search_preference_comparisons reports honest empties and unavailable validated basis', async () => {
  const { byName } = makeHarness({
    control: { listPreferenceComparisons: async () => ({ items: [], nextCursor: null, hasMore: false }) },
  });
  const empty = await byName.search_preference_comparisons.handler({ chainName: 'mvc' });
  assert.equal(empty.isError, undefined);
  assert.match(empty.content[0].text, /No open comparison evidence matched/);

  const { byName: unavailable } = makeHarness({
    control: {
      listPreferenceComparisons: async () => {
        throw new MetaAppValidatedBasisUnavailableError('preference_validated_basis_unavailable');
      },
    },
  });
  const result = await unavailable.search_preference_comparisons.handler({ chainName: 'mvc' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Validated preference aggregation is not yet available/);
});
